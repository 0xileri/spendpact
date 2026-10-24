//! Spact policy vault.
//!
//! Holds NEP-141 tokens for an owner and lets designated agent accounts request payments.
//! Every outgoing payment passes on-chain policy checks. Payments above the auto limit need the
//! owner to approve the exact stored request (by its hash) with a full-access-key transaction.
//!
//! Unaudited hackathon prototype. See AGENTS.md and docs/THREAT_MODEL.md.

mod digest;
mod events;
pub mod types;

#[cfg(test)]
mod tests;

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue,
};

pub use crate::digest::{encode_request, request_hash, DIGEST_DOMAIN};
use crate::events::VaultEvent;
use crate::types::*;

pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
pub const GAS_FOR_TRANSFER_CALLBACK: Gas = Gas::from_tgas(10);
/// Prepaid gas a dispatching call must carry: the transfer, its callback and this call itself.
/// Checked up front so a call cannot reserve budget and then run out of gas mid-dispatch.
pub const MIN_GAS_FOR_DISPATCH: Gas = Gas::from_tgas(50);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
/// `ft_transfer` returns nothing; anything longer is treated as an unexpected token contract.
const MAX_PROMISE_RESULT_LEN: usize = 256;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleTokenCore {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Requests,
    Ledgers,
    RequestCounts,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    network: String,
    agents: Vec<AccountId>,
    paused: bool,
    policy: Policy,
    policy_version: u64,
    open_approvals: u32,
    requests: IterableMap<String, PaymentRequest>,
    /// (token, UTC day) -> executed and in-flight amounts.
    ledgers: LookupMap<(AccountId, u64), DailyLedger>,
    /// UTC day -> number of stored requests.
    request_counts: LookupMap<u64, u32>,
}

#[near]
impl Vault {
    /// Must be called by the vault account itself, ideally in the same transaction as the
    /// deploy, so nobody else can initialize a freshly deployed vault with their own owner.
    #[init]
    pub fn new(owner: AccountId, agents: Vec<AccountId>, network: String, policy: Policy) -> Self {
        let vault_id = env::current_account_id();
        if env::predecessor_account_id() != vault_id {
            fail(ReasonCode::InitNotSelf, "initialize from the vault account");
        }
        if owner == vault_id {
            fail(ReasonCode::InvalidConfig, "owner must not be the vault");
        }
        if network.is_empty()
            || network.len() > MAX_NETWORK_LEN
            || !network.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            fail(ReasonCode::InvalidConfig, "network must be 1-32 chars of [a-z0-9-]");
        }
        if agents.len() > MAX_AGENTS {
            fail(ReasonCode::InvalidConfig, "too many agents");
        }
        let mut unique: Vec<AccountId> = Vec::with_capacity(agents.len());
        for agent in agents {
            check_agent_id(&agent, &owner, &vault_id);
            if unique.contains(&agent) {
                fail(ReasonCode::InvalidConfig, "duplicate agent");
            }
            unique.push(agent);
        }
        if let Err(e) = validate_policy(&policy, &vault_id) {
            fail(ReasonCode::InvalidPolicy, &e);
        }

        Self {
            owner,
            network,
            agents: unique,
            paused: false,
            policy,
            policy_version: 1,
            open_approvals: 0,
            requests: IterableMap::new(StorageKey::Requests),
            ledgers: LookupMap::new(StorageKey::Ledgers),
            request_counts: LookupMap::new(StorageKey::RequestCounts),
        }
    }

    // ---------------------------------------------------------------- owner methods
    //
    // All owner methods require exactly 1 yoctoNEAR. Function-call access keys cannot attach a
    // deposit, so these can only be signed with a full-access key (a wallet confirmation), never
    // with a limited key that a dApp or backend might hold for the owner account.

    /// Replaces the whole policy and bumps the version. Open requests created under the old
    /// version can no longer be approved or executed.
    #[payable]
    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        if let Err(e) = validate_policy(&policy, &env::current_account_id()) {
            fail(ReasonCode::InvalidPolicy, &e);
        }
        self.policy = policy;
        self.policy_version += 1;
        VaultEvent::PolicyUpdated { policy_version: self.policy_version }.emit();
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        VaultEvent::PauseChanged { paused }.emit();
    }

    #[payable]
    pub fn add_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        check_agent_id(&agent_id, &self.owner, &env::current_account_id());
        if self.agents.contains(&agent_id) {
            fail(ReasonCode::InvalidConfig, "agent already added");
        }
        if self.agents.len() >= MAX_AGENTS {
            fail(ReasonCode::InvalidConfig, "too many agents");
        }
        self.agents.push(agent_id.clone());
        VaultEvent::AgentAdded { agent_id }.emit();
    }

    /// Revokes an agent. Its approved-but-unexecuted requests can no longer execute.
    #[payable]
    pub fn remove_agent(&mut self, agent_id: AccountId) {
        self.assert_owner();
        let before = self.agents.len();
        self.agents.retain(|a| a != &agent_id);
        if self.agents.len() == before {
            fail(ReasonCode::InvalidConfig, "not an agent");
        }
        VaultEvent::AgentRemoved { agent_id }.emit();
    }

    /// Approves the exact stored request. `request_hash` must be the hash the owner's client
    /// computed from the request fields it displayed; a mismatch means the owner saw something
    /// other than what is stored, and the approval fails.
    #[payable]
    pub fn approve_request(&mut self, request_id: String, request_hash: String) -> PaymentOutcome {
        self.assert_owner();
        let now = env::block_timestamp();
        let expected = {
            let req = self.get_stored(&request_id);
            if req.status != Status::AwaitingApproval {
                fail(ReasonCode::InvalidState, "request is not awaiting approval");
            }
            if req.policy_version != self.policy_version {
                fail(ReasonCode::PolicyVersionChanged, "policy changed since request");
            }
            if now > req.expires_at_ns.0 {
                fail(ReasonCode::RequestExpired, "request expired");
            }
            digest::request_hash(&self.network, env::current_account_id().as_str(), req)
        };
        if request_hash != expected {
            fail(ReasonCode::HashMismatch, "approved hash does not match stored request");
        }
        let owner = self.owner.clone();
        let req = self.get_stored_mut(&request_id);
        req.status = Status::Approved;
        req.reason_code = ReasonCode::OwnerApproved;
        req.approved_by = Some(owner);
        req.updated_at_ns = U64(now);
        emit_status(req);
        outcome(req)
    }

    #[payable]
    pub fn reject_request(&mut self, request_id: String) -> PaymentOutcome {
        self.assert_owner();
        let req = self.get_stored_mut(&request_id);
        if !req.status.is_open_approval() {
            fail(ReasonCode::InvalidState, "request is not open");
        }
        req.status = Status::Denied;
        req.reason_code = ReasonCode::OwnerDenied;
        req.updated_at_ns = U64(env::block_timestamp());
        emit_status(req);
        let result = outcome(req);
        self.release_open_approval();
        result
    }

    /// Owner recovery path: moves tokens out of the vault without spending limits.
    /// Disclosed in docs/THREAT_MODEL.md. Never callable by agents.
    #[payable]
    pub fn owner_withdraw(&mut self, token: AccountId, amount: U128, receiver_id: AccountId) -> Promise {
        self.assert_owner();
        if amount.0 == 0 {
            fail(ReasonCode::InvalidAmount, "amount must be positive");
        }
        VaultEvent::OwnerWithdraw { token: token.clone(), amount, receiver_id: receiver_id.clone() }.emit();
        ext_ft::ext(token).with_attached_deposit(ONE_YOCTO).with_static_gas(GAS_FOR_FT_TRANSFER).ft_transfer(
            receiver_id,
            amount,
            Some("spact:owner_withdraw".to_string()),
        )
    }

    // ---------------------------------------------------------------- agent methods

    /// Requests a direct NEP-141 payment on NEAR.
    ///
    /// * Within the auto limit and budget: reserves budget and dispatches the transfer in this
    ///   call. The transaction result is the transfer callback's outcome.
    /// * Above the auto limit but within the hard cap and budget: stored as AWAITING_APPROVAL.
    /// * Anything else: BLOCKED with a reason code. Blocked requests are logged, not stored.
    pub fn request_direct_payment(
        &mut self,
        request_id: String,
        token: AccountId,
        amount: U128,
        recipient: AccountId,
        reason: String,
    ) -> PromiseOrValue<PaymentOutcome> {
        let agent_id = env::predecessor_account_id();
        if !self.agents.contains(&agent_id) {
            fail(ReasonCode::NotAgent, "caller is not an agent of this vault");
        }
        if env::prepaid_gas() < MIN_GAS_FOR_DISPATCH {
            fail(ReasonCode::InsufficientGas, "attach at least 50 Tgas");
        }
        if let Err(code) = self.check_new_request(&request_id, &token, amount.0, &recipient, &reason) {
            return PromiseOrValue::Value(blocked(&request_id, &agent_id, code));
        }
        let token_policy = self.policy.token_policy(&token).expect("checked above");
        let auto = amount.0 <= token_policy.auto_limit.0;
        if !auto && self.open_approvals >= self.policy.max_open_approvals {
            return PromiseOrValue::Value(blocked(&request_id, &agent_id, ReasonCode::TooManyOpenApprovals));
        }

        let now = env::block_timestamp();
        let day = now / NS_PER_DAY;
        let count = self.request_counts.get(&day).copied().unwrap_or(0);
        if count >= self.policy.max_requests_per_day {
            return PromiseOrValue::Value(blocked(&request_id, &agent_id, ReasonCode::RateLimited));
        }
        self.request_counts.insert(day, count + 1);

        let ttl_ns = u64::from(self.policy.approval_ttl_sec) * NS_PER_SEC;
        let mut req = PaymentRequest {
            request_id: request_id.clone(),
            agent_id,
            route: Route::NearDirect,
            token,
            amount,
            recipient,
            reason,
            created_at_ns: U64(now),
            expires_at_ns: U64(now + ttl_ns),
            policy_version: self.policy_version,
            request_hash: String::new(),
            status: Status::AwaitingApproval,
            reason_code: ReasonCode::RequiresOwnerApproval,
            approved_by: None,
            reserved_day: None,
            updated_at_ns: U64(now),
        };
        req.request_hash = digest::request_hash(&self.network, env::current_account_id().as_str(), &req);

        if auto {
            req.reason_code = ReasonCode::AutoWithinPolicy;
            self.requests.insert(request_id.clone(), req);
            PromiseOrValue::Promise(self.dispatch(&request_id))
        } else {
            self.open_approvals += 1;
            emit_status(&req);
            let result = outcome(&req);
            self.requests.insert(request_id, req);
            PromiseOrValue::Value(result)
        }
    }

    /// Executes an owner-approved request. Callable by the owner or the requesting agent.
    /// Re-checks pause, policy version, expiry, agent membership and budget.
    pub fn execute_request(&mut self, request_id: String) -> Promise {
        let caller = env::predecessor_account_id();
        if env::prepaid_gas() < MIN_GAS_FOR_DISPATCH {
            fail(ReasonCode::InsufficientGas, "attach at least 50 Tgas");
        }
        {
            let req = self.get_stored(&request_id);
            if caller != self.owner && caller != req.agent_id {
                fail(ReasonCode::NotAuthorized, "only the owner or the requesting agent may execute");
            }
            if req.status != Status::Approved {
                fail(ReasonCode::InvalidState, "request is not approved");
            }
            if self.paused {
                fail(ReasonCode::VaultPaused, "vault is paused");
            }
            if req.policy_version != self.policy_version {
                fail(ReasonCode::PolicyVersionChanged, "policy changed since approval");
            }
            if env::block_timestamp() > req.expires_at_ns.0 {
                fail(ReasonCode::ApprovalExpired, "approval expired");
            }
            if !self.agents.contains(&req.agent_id) {
                fail(ReasonCode::AgentNotAllowed, "requesting agent was removed");
            }
        }
        self.release_open_approval();
        self.dispatch(&request_id)
    }

    /// Moves an expired open request to EXPIRED and frees its approval slot. Anyone may call;
    /// it only succeeds once the expiry has really passed.
    pub fn expire_request(&mut self, request_id: String) -> PaymentOutcome {
        let now = env::block_timestamp();
        let req = self.get_stored_mut(&request_id);
        if !req.status.is_open_approval() {
            fail(ReasonCode::InvalidState, "request is not open");
        }
        if now <= req.expires_at_ns.0 {
            fail(ReasonCode::NotExpired, "request has not expired");
        }
        req.status = Status::Expired;
        req.reason_code = ReasonCode::RequestExpired;
        req.updated_at_ns = U64(now);
        emit_status(req);
        let result = outcome(req);
        self.release_open_approval();
        result
    }

    // ---------------------------------------------------------------- callback

    /// Resolves a dispatched transfer. Only the vault itself can call this (`#[private]`), and
    /// it only acts on a request still in TRANSFER_PENDING, so a reservation is released or
    /// consumed exactly once.
    #[private]
    pub fn on_transfer_result(&mut self, request_id: String) -> PaymentOutcome {
        let succeeded = env::promise_results_count() == 1
            && env::promise_result_checked(0, MAX_PROMISE_RESULT_LEN).is_ok();
        let now = env::block_timestamp();

        let (key, amount) = {
            let req = self.get_stored(&request_id);
            if req.status != Status::TransferPending {
                return outcome(req);
            }
            let day = req.reserved_day.unwrap_or_else(|| fail(ReasonCode::LedgerInvariant, "no reservation"));
            ((req.token.clone(), day), req.amount.0)
        };

        let mut ledger = self.ledgers.get(&key).cloned().unwrap_or_default();
        ledger.pending = ledger
            .pending
            .checked_sub(amount)
            .unwrap_or_else(|| fail(ReasonCode::LedgerInvariant, "pending underflow"));
        if succeeded {
            ledger.executed = ledger
                .executed
                .checked_add(amount)
                .unwrap_or_else(|| fail(ReasonCode::LedgerInvariant, "executed overflow"));
        }
        self.ledgers.insert(key, ledger);

        let req = self.get_stored_mut(&request_id);
        if succeeded {
            req.status = Status::Settled;
            req.reason_code = ReasonCode::Settled;
        } else {
            req.status = Status::TransferFailed;
            req.reason_code = ReasonCode::SourceTransferFailed;
        }
        req.updated_at_ns = U64(now);
        emit_status(req);
        outcome(req)
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            vault_id: env::current_account_id(),
            owner: self.owner.clone(),
            network: self.network.clone(),
            agents: self.agents.clone(),
            paused: self.paused,
            policy_version: self.policy_version,
            open_approvals: self.open_approvals,
            request_count: self.requests.len(),
        }
    }

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_request(&self, request_id: String) -> Option<PaymentRequest> {
        self.requests.get(&request_id).cloned()
    }

    /// Newest first.
    pub fn list_requests(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<PaymentRequest> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(20).min(MAX_LIST_LIMIT) as usize;
        self.requests.values().rev().skip(from).take(limit).cloned().collect()
    }

    /// Budget for `token` on UTC `day` (defaults to today).
    pub fn get_budget(&self, token: AccountId, day: Option<u64>) -> Option<BudgetView> {
        let day = day.unwrap_or_else(today);
        let token_policy = self.policy.token_policy(&token)?;
        let ledger = self.ledgers.get(&(token.clone(), day)).cloned().unwrap_or_default();
        Some(BudgetView {
            token,
            day,
            daily_limit: token_policy.daily_limit,
            executed: U128(ledger.executed),
            pending: U128(ledger.pending),
            available: U128(available(token_policy.daily_limit.0, &ledger)),
        })
    }

    pub fn current_day(&self) -> u64 {
        today()
    }
}

// -------------------------------------------------------------------- internals

impl Vault {
    fn assert_owner(&self) {
        assert_one_yocto();
        if env::predecessor_account_id() != self.owner {
            fail(ReasonCode::NotOwner, "owner only");
        }
    }

    fn get_stored(&self, request_id: &str) -> &PaymentRequest {
        self.requests.get(request_id).unwrap_or_else(|| fail(ReasonCode::RequestNotFound, "unknown request"))
    }

    fn get_stored_mut(&mut self, request_id: &str) -> &mut PaymentRequest {
        self.requests
            .get_mut(request_id)
            .unwrap_or_else(|| fail(ReasonCode::RequestNotFound, "unknown request"))
    }

    fn release_open_approval(&mut self) {
        self.open_approvals = self
            .open_approvals
            .checked_sub(1)
            .unwrap_or_else(|| fail(ReasonCode::LedgerInvariant, "open approvals underflow"));
    }

    /// Policy checks for a new request, cheapest first. Returns the first failing reason.
    fn check_new_request(
        &self,
        request_id: &str,
        token: &AccountId,
        amount: u128,
        recipient: &AccountId,
        reason: &str,
    ) -> Result<(), ReasonCode> {
        if self.paused {
            return Err(ReasonCode::VaultPaused);
        }
        if !is_valid_request_id(request_id) {
            return Err(ReasonCode::InvalidRequestId);
        }
        if self.requests.contains_key(request_id) {
            return Err(ReasonCode::DuplicateRequest);
        }
        if amount == 0 {
            return Err(ReasonCode::InvalidAmount);
        }
        if !is_valid_reason(reason) {
            return Err(ReasonCode::InvalidReason);
        }
        let token_policy = self.policy.token_policy(token).ok_or(ReasonCode::TokenNotAllowed)?;
        if !self.policy.allows_recipient(recipient) {
            return Err(ReasonCode::RecipientNotAllowed);
        }
        if amount > token_policy.hard_tx_limit.0 {
            return Err(ReasonCode::HardCapExceeded);
        }
        let ledger = self.ledgers.get(&(token.clone(), today())).cloned().unwrap_or_default();
        if amount > available(token_policy.daily_limit.0, &ledger) {
            return Err(ReasonCode::DailyBudgetExceeded);
        }
        Ok(())
    }

    /// The single point where budget is reserved and a transfer leaves the vault.
    /// Callers have already checked authorization and request state.
    fn dispatch(&mut self, request_id: &str) -> Promise {
        let day = today();
        let (token, amount, recipient) = {
            let req = self.get_stored(request_id);
            (req.token.clone(), req.amount.0, req.recipient.clone())
        };
        let daily_limit = self
            .policy
            .token_policy(&token)
            .unwrap_or_else(|| fail(ReasonCode::TokenNotAllowed, "token not in policy"))
            .daily_limit
            .0;

        let key = (token.clone(), day);
        let mut ledger = self.ledgers.get(&key).cloned().unwrap_or_default();
        if amount > available(daily_limit, &ledger) {
            fail(ReasonCode::DailyBudgetExceeded, "not enough budget left today");
        }
        ledger.pending = ledger
            .pending
            .checked_add(amount)
            .unwrap_or_else(|| fail(ReasonCode::LedgerInvariant, "pending overflow"));
        self.ledgers.insert(key, ledger);

        let req = self.get_stored_mut(request_id);
        req.status = Status::TransferPending;
        req.reason_code = ReasonCode::TransferPending;
        req.reserved_day = Some(day);
        req.updated_at_ns = U64(env::block_timestamp());
        emit_status(req);

        ext_ft::ext(token)
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(recipient, U128(amount), Some(format!("spact:{request_id}")))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_TRANSFER_CALLBACK)
                    .on_transfer_result(request_id.to_string()),
            )
    }
}

fn fail(code: ReasonCode, detail: &str) -> ! {
    env::panic_str(&format!("{}: {}", code.as_str(), detail))
}

fn today() -> u64 {
    env::block_timestamp() / NS_PER_DAY
}

fn available(daily_limit: u128, ledger: &DailyLedger) -> u128 {
    // A lowered daily limit can leave used > limit; that means nothing is available.
    let used = ledger.executed.saturating_add(ledger.pending);
    daily_limit.saturating_sub(used)
}

fn outcome(req: &PaymentRequest) -> PaymentOutcome {
    PaymentOutcome {
        request_id: req.request_id.clone(),
        status: req.status,
        reason_code: req.reason_code,
        request_hash: Some(req.request_hash.clone()),
    }
}

fn blocked(request_id: &str, agent_id: &AccountId, code: ReasonCode) -> PaymentOutcome {
    let logged_id = if is_valid_request_id(request_id) { request_id } else { "<invalid>" };
    VaultEvent::RequestBlocked {
        request_id: logged_id.to_string(),
        agent_id: agent_id.clone(),
        reason_code: code,
    }
    .emit();
    PaymentOutcome {
        request_id: logged_id.to_string(),
        status: Status::Blocked,
        reason_code: code,
        request_hash: None,
    }
}

fn emit_status(req: &PaymentRequest) {
    VaultEvent::RequestStatus {
        request_id: req.request_id.clone(),
        status: req.status,
        reason_code: req.reason_code,
    }
    .emit();
}

fn check_agent_id(agent: &AccountId, owner: &AccountId, vault_id: &AccountId) {
    if agent == owner {
        fail(ReasonCode::InvalidConfig, "agent must not be the owner");
    }
    if agent == vault_id {
        fail(ReasonCode::InvalidConfig, "agent must not be the vault");
    }
}

pub fn is_valid_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_REQUEST_ID_LEN
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

pub fn is_valid_reason(reason: &str) -> bool {
    reason.len() <= MAX_REASON_LEN && !reason.chars().any(char::is_control)
}

pub fn validate_policy(policy: &Policy, vault_id: &AccountId) -> Result<(), String> {
    if policy.tokens.len() > MAX_TOKENS {
        return Err(format!("at most {MAX_TOKENS} tokens"));
    }
    if policy.recipients.len() > MAX_RECIPIENTS {
        return Err(format!("at most {MAX_RECIPIENTS} recipients"));
    }
    for (i, t) in policy.tokens.iter().enumerate() {
        if policy.tokens[..i].iter().any(|o| o.token == t.token) {
            return Err(format!("duplicate token {}", t.token));
        }
        if &t.token == vault_id {
            return Err("token must not be the vault".into());
        }
        if t.hard_tx_limit.0 == 0 || t.daily_limit.0 == 0 {
            return Err(format!("{}: hard_tx_limit and daily_limit must be positive", t.token));
        }
        if t.auto_limit.0 > t.hard_tx_limit.0 {
            return Err(format!("{}: auto_limit must be <= hard_tx_limit", t.token));
        }
        if t.hard_tx_limit.0 > t.daily_limit.0 {
            return Err(format!("{}: hard_tx_limit must be <= daily_limit", t.token));
        }
    }
    for (i, r) in policy.recipients.iter().enumerate() {
        if policy.recipients[..i].contains(r) {
            return Err(format!("duplicate recipient {r}"));
        }
        if r == vault_id {
            return Err("recipient must not be the vault".into());
        }
    }
    if policy.max_open_approvals == 0 || policy.max_open_approvals > MAX_OPEN_APPROVALS {
        return Err(format!("max_open_approvals must be 1..={MAX_OPEN_APPROVALS}"));
    }
    if policy.max_requests_per_day == 0 || policy.max_requests_per_day > MAX_REQUESTS_PER_DAY {
        return Err(format!("max_requests_per_day must be 1..={MAX_REQUESTS_PER_DAY}"));
    }
    if policy.approval_ttl_sec < MIN_APPROVAL_TTL_SEC || policy.approval_ttl_sec > MAX_APPROVAL_TTL_SEC {
        return Err(format!("approval_ttl_sec must be {MIN_APPROVAL_TTL_SEC}..={MAX_APPROVAL_TTL_SEC}"));
    }
    Ok(())
}
