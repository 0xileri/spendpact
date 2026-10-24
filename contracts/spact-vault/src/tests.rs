//! Unit tests: authorization, policy validation, state machine and budget accounting.
//! Test IDs (T01..T18) refer to the Security Lab table in AGENTS.md section 10.
//! Cross-contract behavior (real token transfers, `#[private]`, concurrency, gas) is covered by
//! the sandbox tests in `contracts/integration-tests`.

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{test_vm_config, testing_env, PromiseResult, RuntimeFeesConfig};

const UNIT: u128 = 1_000_000; // 6-decimal test token
const DAY: u64 = 20_000;
const NOW: u64 = DAY * NS_PER_DAY + 12 * 3600 * NS_PER_SEC; // midday UTC
const TTL_SEC: u32 = 3600;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("owner.test.near")
}
fn agent() -> AccountId {
    acc("agent.test.near")
}
fn vault() -> AccountId {
    acc("vault.test.near")
}
fn token() -> AccountId {
    acc("token.test.near")
}
fn api() -> AccountId {
    acc("api.test.near")
}
fn mallory() -> AccountId {
    acc("mallory.test.near")
}

fn token_policy() -> TokenPolicy {
    TokenPolicy {
        token: token(),
        auto_limit: U128(10 * UNIT),
        hard_tx_limit: U128(30 * UNIT),
        daily_limit: U128(50 * UNIT),
    }
}

fn policy() -> Policy {
    Policy {
        tokens: vec![token_policy()],
        recipients: vec![api()],
        max_open_approvals: 5,
        max_requests_per_day: 50,
        approval_ttl_sec: TTL_SEC,
    }
}

fn set_ctx(predecessor: AccountId, deposit_yocto: u128, now: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .prepaid_gas(Gas::from_tgas(300))
        .block_timestamp(now)
        .build());
}

fn set_callback_ctx(now: u64, result: PromiseResult) {
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(vault())
            .predecessor_account_id(vault())
            .prepaid_gas(Gas::from_tgas(300))
            .block_timestamp(now)
            .build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result],
    );
}

fn setup() -> Vault {
    set_ctx(vault(), 0, NOW);
    Vault::new(owner(), vec![agent()], "sandbox".into(), policy())
}

/// Agent requests a payment at `now`. Returns the immediate outcome, or the stored request's
/// state when the call dispatched a transfer.
fn request_at(v: &mut Vault, id: &str, amount: u128, now: u64) -> (Status, ReasonCode) {
    set_ctx(agent(), 0, now);
    match v.request_direct_payment(id.into(), token(), U128(amount), api(), "test payment".into()) {
        PromiseOrValue::Value(o) => (o.status, o.reason_code),
        PromiseOrValue::Promise(_) => {
            let r = v.get_request(id.into()).expect("dispatched request is stored");
            (r.status, r.reason_code)
        }
    }
}

fn request(v: &mut Vault, id: &str, amount: u128) -> (Status, ReasonCode) {
    request_at(v, id, amount, NOW)
}

fn approve(v: &mut Vault, id: &str) -> PaymentOutcome {
    let hash = v.get_request(id.into()).unwrap().request_hash;
    set_ctx(owner(), 1, NOW);
    v.approve_request(id.into(), hash)
}

fn budget(v: &Vault, day: u64) -> BudgetView {
    v.get_budget(token(), Some(day)).unwrap()
}

fn resolve(v: &mut Vault, id: &str, ok: bool, now: u64) -> PaymentOutcome {
    let result = if ok { PromiseResult::Successful(vec![]) } else { PromiseResult::Failed };
    set_callback_ctx(now, result);
    v.on_transfer_result(id.into())
}

fn expect_value(p: PromiseOrValue<PaymentOutcome>) -> PaymentOutcome {
    match p {
        PromiseOrValue::Value(o) => o,
        PromiseOrValue::Promise(_) => panic!("expected an immediate outcome, got a dispatch"),
    }
}

// ------------------------------------------------------------------ init and config

#[test]
fn init_sets_config() {
    let v = setup();
    let c = v.get_config();
    assert_eq!(c.owner, owner());
    assert_eq!(c.agents, vec![agent()]);
    assert_eq!(c.network, "sandbox");
    assert_eq!(c.policy_version, 1);
    assert!(!c.paused);
    assert_eq!(v.get_policy(), policy());
}

#[test]
#[should_panic(expected = "INIT_NOT_SELF")]
fn init_by_third_party_fails() {
    set_ctx(mallory(), 0, NOW);
    Vault::new(mallory(), vec![agent()], "sandbox".into(), policy());
}

#[test]
#[should_panic(expected = "INVALID_CONFIG: agent must not be the owner")]
fn agent_cannot_be_owner() {
    set_ctx(vault(), 0, NOW);
    Vault::new(owner(), vec![owner()], "sandbox".into(), policy());
}

#[test]
#[should_panic(expected = "INVALID_CONFIG: network")]
fn init_rejects_bad_network() {
    set_ctx(vault(), 0, NOW);
    Vault::new(owner(), vec![agent()], "Main Net".into(), policy());
}

#[test]
fn policy_validation_rejects_unsafe_limits() {
    let v = vault();
    let with = |f: fn(&mut Policy)| {
        let mut p = policy();
        f(&mut p);
        validate_policy(&p, &v)
    };
    assert!(with(|_| {}).is_ok());
    assert!(with(|p| p.tokens[0].auto_limit = U128(31 * UNIT)).is_err());
    assert!(with(|p| p.tokens[0].hard_tx_limit = U128(51 * UNIT)).is_err());
    assert!(with(|p| p.tokens[0].hard_tx_limit = U128(0)).is_err());
    assert!(with(|p| p.tokens[0].daily_limit = U128(0)).is_err());
    assert!(with(|p| p.tokens.push(token_policy())).is_err());
    assert!(with(|p| p.recipients.push(api())).is_err());
    assert!(with(|p| p.recipients.push("vault.test.near".parse().unwrap())).is_err());
    assert!(with(|p| p.tokens[0].token = "vault.test.near".parse().unwrap()).is_err());
    assert!(with(|p| p.max_open_approvals = 0).is_err());
    assert!(with(|p| p.max_requests_per_day = 0).is_err());
    assert!(with(|p| p.approval_ttl_sec = 59).is_err());
    assert!(with(|p| p.approval_ttl_sec = MAX_APPROVAL_TTL_SEC + 1).is_err());
    // auto_limit 0 is allowed: every payment then needs approval
    assert!(with(|p| p.tokens[0].auto_limit = U128(0)).is_ok());
}

// ------------------------------------------------------------------ T05 owner-only methods

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn t05_agent_cannot_set_policy() {
    let mut v = setup();
    set_ctx(agent(), 1, NOW);
    v.set_policy(policy());
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn t05_agent_cannot_pause_or_unpause() {
    let mut v = setup();
    set_ctx(agent(), 1, NOW);
    v.set_paused(false);
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn t05_agent_cannot_add_agent() {
    let mut v = setup();
    set_ctx(agent(), 1, NOW);
    v.add_agent(mallory());
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn t05_agent_cannot_approve_own_request() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    let hash = v.get_request("r1".into()).unwrap().request_hash;
    set_ctx(agent(), 1, NOW);
    v.approve_request("r1".into(), hash);
}

#[test]
#[should_panic(expected = "NOT_OWNER")]
fn t05_agent_cannot_withdraw() {
    let mut v = setup();
    set_ctx(agent(), 1, NOW);
    v.owner_withdraw(token(), U128(UNIT), agent()).detach();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_methods_require_full_access_key_deposit() {
    let mut v = setup();
    set_ctx(owner(), 0, NOW);
    v.set_paused(true);
}

#[test]
#[should_panic(expected = "NOT_AGENT")]
fn stranger_cannot_request_payment() {
    let mut v = setup();
    set_ctx(mallory(), 0, NOW);
    v.request_direct_payment("r1".into(), token(), U128(UNIT), api(), String::new()).detach();
}

#[test]
#[should_panic(expected = "NOT_AGENT")]
fn owner_is_not_an_agent() {
    let mut v = setup();
    set_ctx(owner(), 0, NOW);
    v.request_direct_payment("r1".into(), token(), U128(UNIT), api(), String::new()).detach();
}

#[test]
#[should_panic(expected = "INSUFFICIENT_GAS")]
fn request_without_enough_gas_fails_before_state_changes() {
    let mut v = setup();
    testing_env!(VMContextBuilder::new()
        .current_account_id(vault())
        .predecessor_account_id(agent())
        .prepaid_gas(Gas::from_tgas(20))
        .block_timestamp(NOW)
        .build());
    v.request_direct_payment("r1".into(), token(), U128(UNIT), api(), String::new()).detach();
}

// ------------------------------------------------------------------ S1 auto payment

#[test]
fn s1_auto_payment_reserves_and_dispatches_transfer() {
    let mut v = setup();
    assert_eq!(request(&mut v, "r1", 3 * UNIT), (Status::TransferPending, ReasonCode::TransferPending));
    let b = budget(&v, DAY);
    assert_eq!(b.pending.0, 3 * UNIT);
    assert_eq!(b.executed.0, 0);
    assert_eq!(b.available.0, 47 * UNIT);

    // exactly one ft_transfer to the token contract with 1 yocto, then the private callback
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, token());
    match &receipts[0].actions[0] {
        MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
            assert_eq!(method_name, b"ft_transfer");
            assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
            let args: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(args).unwrap();
            assert_eq!(args["receiver_id"], "api.test.near");
            assert_eq!(args["amount"], (3 * UNIT).to_string());
        }
        other => panic!("unexpected action {other:?}"),
    }
    assert_eq!(receipts[1].receiver_id, vault());
    match &receipts[1].actions[0] {
        MockAction::FunctionCallWeight { method_name, .. } => {
            assert_eq!(method_name, b"on_transfer_result")
        }
        other => panic!("unexpected action {other:?}"),
    }

    let o = resolve(&mut v, "r1", true, NOW);
    assert_eq!(o.status, Status::Settled);
    let b = budget(&v, DAY);
    assert_eq!((b.executed.0, b.pending.0), (3 * UNIT, 0));
}

#[test]
fn auto_limit_is_inclusive() {
    let mut v = setup();
    assert_eq!(request(&mut v, "r1", 10 * UNIT).0, Status::TransferPending);
    assert_eq!(request(&mut v, "r2", 10 * UNIT + 1).0, Status::AwaitingApproval);
}

// ------------------------------------------------------------------ T01, T11, T12 blocked requests

#[test]
fn t01_over_hard_cap_is_blocked_without_reservation() {
    let mut v = setup();
    assert_eq!(request(&mut v, "r1", 30 * UNIT + 1), (Status::Blocked, ReasonCode::HardCapExceeded));
    assert!(v.get_request("r1".into()).is_none(), "blocked requests are not stored");
    assert_eq!(budget(&v, DAY).pending.0, 0);
    assert!(get_created_receipts().is_empty());
    assert!(get_logs()[0].contains("request_blocked"));
}

#[test]
fn t11_invalid_inputs_are_blocked() {
    let mut v = setup();
    assert_eq!(request(&mut v, "r1", 0).1, ReasonCode::InvalidAmount);
    assert_eq!(request(&mut v, "", UNIT).1, ReasonCode::InvalidRequestId);
    assert_eq!(request(&mut v, "has space", UNIT).1, ReasonCode::InvalidRequestId);
    assert_eq!(request(&mut v, &"x".repeat(65), UNIT).1, ReasonCode::InvalidRequestId);

    for reason in ["a".repeat(MAX_REASON_LEN + 1), "line\nbreak".to_string()] {
        set_ctx(agent(), 0, NOW);
        let o = expect_value(v.request_direct_payment("r2".into(), token(), U128(UNIT), api(), reason));
        assert_eq!(o.reason_code, ReasonCode::InvalidReason);
    }
    assert_eq!(v.get_config().request_count, 0);
}

#[test]
fn t12_unlisted_token_or_recipient_is_blocked() {
    let mut v = setup();
    set_ctx(agent(), 0, NOW);
    let scam = acc("scam-token.test.near");
    let o = expect_value(v.request_direct_payment("r1".into(), scam, U128(UNIT), api(), String::new()));
    assert_eq!(o.reason_code, ReasonCode::TokenNotAllowed);
    let o =
        expect_value(v.request_direct_payment("r2".into(), token(), U128(UNIT), mallory(), String::new()));
    assert_eq!(o.reason_code, ReasonCode::RecipientNotAllowed);
    assert!(get_created_receipts().is_empty());
}

#[test]
fn paused_vault_blocks_new_requests() {
    let mut v = setup();
    set_ctx(owner(), 1, NOW);
    v.set_paused(true);
    assert_eq!(request(&mut v, "r1", UNIT), (Status::Blocked, ReasonCode::VaultPaused));
}

// ------------------------------------------------------------------ S2 approval flow

#[test]
fn s2_large_payment_needs_exact_owner_approval() {
    let mut v = setup();
    assert_eq!(
        request(&mut v, "r1", 25 * UNIT),
        (Status::AwaitingApproval, ReasonCode::RequiresOwnerApproval)
    );
    assert_eq!(v.get_config().open_approvals, 1);
    assert!(get_created_receipts().is_empty(), "nothing moves before approval");

    let o = approve(&mut v, "r1");
    assert_eq!(o.status, Status::Approved);
    assert_eq!(v.get_request("r1".into()).unwrap().approved_by, Some(owner()));
    assert_eq!(budget(&v, DAY).pending.0, 0, "approval alone reserves nothing");

    set_ctx(agent(), 0, NOW);
    v.execute_request("r1".into()).detach();
    assert_eq!(v.get_request("r1".into()).unwrap().status, Status::TransferPending);
    assert_eq!(budget(&v, DAY).pending.0, 25 * UNIT);
    assert_eq!(v.get_config().open_approvals, 0);

    resolve(&mut v, "r1", true, NOW);
    assert_eq!(budget(&v, DAY).executed.0, 25 * UNIT);
}

#[test]
#[should_panic(expected = "HASH_MISMATCH")]
fn t02_approval_of_a_different_request_body_fails() {
    // The owner's client hashes what it displayed. If a compromised backend showed recipient B
    // while the stored request pays recipient A, the hashes differ and approval fails.
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    let mut shown = v.get_request("r1".into()).unwrap();
    shown.recipient = mallory();
    let shown_hash = request_hash("sandbox", "vault.test.near", &shown);
    set_ctx(owner(), 1, NOW);
    v.approve_request("r1".into(), shown_hash);
}

#[test]
fn t02_resubmitting_an_approved_id_with_new_terms_is_a_duplicate() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    approve(&mut v, "r1");
    set_ctx(agent(), 0, NOW);
    let o = expect_value(v.request_direct_payment(
        "r1".into(),
        token(),
        U128(25 * UNIT),
        mallory(),
        String::new(),
    ));
    assert_eq!(o.reason_code, ReasonCode::DuplicateRequest);
    assert_eq!(v.get_request("r1".into()).unwrap().recipient, api());
}

#[test]
#[should_panic(expected = "INVALID_STATE")]
fn t03_approved_request_executes_once() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    approve(&mut v, "r1");
    set_ctx(agent(), 0, NOW);
    v.execute_request("r1".into()).detach();
    set_ctx(agent(), 0, NOW);
    v.execute_request("r1".into()).detach();
}

#[test]
fn t03_duplicate_request_id_is_blocked() {
    let mut v = setup();
    request(&mut v, "r1", 3 * UNIT);
    assert_eq!(request(&mut v, "r1", 3 * UNIT), (Status::Blocked, ReasonCode::DuplicateRequest));
    assert_eq!(budget(&v, DAY).pending.0, 3 * UNIT);
}

#[test]
#[should_panic(expected = "INVALID_STATE")]
fn approve_twice_fails() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    approve(&mut v, "r1");
    approve(&mut v, "r1");
}

#[test]
#[should_panic(expected = "NOT_AUTHORIZED")]
fn stranger_cannot_execute_approved_request() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    approve(&mut v, "r1");
    set_ctx(mallory(), 0, NOW);
    v.execute_request("r1".into()).detach();
}

#[test]
fn owner_can_execute_approved_request() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    approve(&mut v, "r1");
    set_ctx(owner(), 0, NOW);
    v.execute_request("r1".into()).detach();
    assert_eq!(v.get_request("r1".into()).unwrap().status, Status::TransferPending);
}

#[test]
fn reject_denies_and_frees_slot() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    set_ctx(owner(), 1, NOW);
    let o = v.reject_request("r1".into());
    assert_eq!((o.status, o.reason_code), (Status::Denied, ReasonCode::OwnerDenied));
    assert_eq!(v.get_config().open_approvals, 0);
}

#[test]
#[should_panic(expected = "INVALID_STATE")]
fn denied_request_cannot_be_approved() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    set_ctx(owner(), 1, NOW);
    v.reject_request("r1".into());
    approve(&mut v, "r1");
}

// ------------------------------------------------------------------ T04 budget

#[test]
fn t04_split_requests_cannot_exceed_daily_budget() {
    let mut v = setup();
    let mut dispatched = 0;
    for i in 0..6 {
        match request(&mut v, &format!("split-{i}"), 10 * UNIT) {
            (Status::TransferPending, _) => dispatched += 1,
            (Status::Blocked, ReasonCode::DailyBudgetExceeded) => {}
            other => panic!("unexpected {other:?}"),
        }
    }
    assert_eq!(dispatched, 5);
    let b = budget(&v, DAY);
    assert_eq!(b.pending.0 + b.executed.0, 50 * UNIT);
    assert_eq!(b.available.0, 0);
}

#[test]
#[should_panic(expected = "DAILY_BUDGET_EXCEEDED")]
fn approvals_never_bypass_daily_budget() {
    let mut v = setup();
    request(&mut v, "a", 30 * UNIT);
    request(&mut v, "b", 30 * UNIT);
    approve(&mut v, "a");
    approve(&mut v, "b");
    set_ctx(agent(), 0, NOW);
    v.execute_request("a".into()).detach();
    set_ctx(agent(), 0, NOW);
    v.execute_request("b".into()).detach();
}

#[test]
fn request_that_cannot_fit_todays_budget_is_blocked_not_queued() {
    let mut v = setup();
    for i in 0..4 {
        request(&mut v, &format!("s{i}"), 10 * UNIT);
    }
    assert_eq!(request(&mut v, "big", 25 * UNIT), (Status::Blocked, ReasonCode::DailyBudgetExceeded));
}

#[test]
fn lowering_the_daily_limit_leaves_zero_available() {
    let mut v = setup();
    request(&mut v, "r1", 10 * UNIT);
    let mut p = policy();
    p.tokens[0] = TokenPolicy {
        auto_limit: U128(UNIT),
        hard_tx_limit: U128(5 * UNIT),
        daily_limit: U128(5 * UNIT),
        ..token_policy()
    };
    set_ctx(owner(), 1, NOW);
    v.set_policy(p);
    assert_eq!(budget(&v, DAY).available.0, 0);
    assert_eq!(request(&mut v, "r2", UNIT).1, ReasonCode::DailyBudgetExceeded);
}

// ------------------------------------------------------------------ T07 expiry

#[test]
#[should_panic(expected = "REQUEST_EXPIRED")]
fn t07_expired_request_cannot_be_approved() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    let hash = v.get_request("r1".into()).unwrap().request_hash;
    set_ctx(owner(), 1, NOW + u64::from(TTL_SEC) * NS_PER_SEC + 1);
    v.approve_request("r1".into(), hash);
}

#[test]
#[should_panic(expected = "APPROVAL_EXPIRED")]
fn t07_expired_approval_cannot_execute() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    approve(&mut v, "r1");
    set_ctx(agent(), 0, NOW + u64::from(TTL_SEC) * NS_PER_SEC + 1);
    v.execute_request("r1".into()).detach();
}

#[test]
fn expire_request_only_after_expiry() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    let later = NOW + u64::from(TTL_SEC) * NS_PER_SEC + 1;
    set_ctx(mallory(), 0, later);
    let o = v.expire_request("r1".into());
    assert_eq!(o.status, Status::Expired);
    assert_eq!(v.get_config().open_approvals, 0);
}

#[test]
#[should_panic(expected = "NOT_EXPIRED")]
fn expire_request_before_expiry_fails() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    set_ctx(mallory(), 0, NOW + 1);
    v.expire_request("r1".into());
}

// ------------------------------------------------------------------ T08, T17 transfer results

#[test]
fn t08_failed_transfer_releases_reservation_once() {
    let mut v = setup();
    request(&mut v, "r1", 10 * UNIT);
    let o = resolve(&mut v, "r1", false, NOW);
    assert_eq!((o.status, o.reason_code), (Status::TransferFailed, ReasonCode::SourceTransferFailed));
    let b = budget(&v, DAY);
    assert_eq!((b.pending.0, b.executed.0, b.available.0), (0, 0, 50 * UNIT));

    // a second callback (or a retry) changes nothing
    let again = resolve(&mut v, "r1", true, NOW);
    assert_eq!(again.status, Status::TransferFailed);
    let b = budget(&v, DAY);
    assert_eq!((b.pending.0, b.executed.0), (0, 0));
}

#[test]
fn t17_settled_request_ignores_repeated_callbacks() {
    let mut v = setup();
    request(&mut v, "r1", 10 * UNIT);
    resolve(&mut v, "r1", true, NOW);
    resolve(&mut v, "r1", false, NOW);
    resolve(&mut v, "r1", true, NOW);
    let b = budget(&v, DAY);
    assert_eq!((b.pending.0, b.executed.0), (0, 10 * UNIT));
    assert_eq!(v.get_request("r1".into()).unwrap().status, Status::Settled);
}

// ------------------------------------------------------------------ T09 pause

#[test]
#[should_panic(expected = "VAULT_PAUSED")]
fn t09_pause_blocks_approved_execution() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    approve(&mut v, "r1");
    set_ctx(owner(), 1, NOW);
    v.set_paused(true);
    set_ctx(agent(), 0, NOW);
    v.execute_request("r1".into()).detach();
}

// ------------------------------------------------------------------ T10 day boundary

#[test]
fn t10_reservation_stays_on_its_original_day() {
    let mut v = setup();
    let last_ns_of_day = (DAY + 1) * NS_PER_DAY - 1;
    assert_eq!(request_at(&mut v, "late", 10 * UNIT, last_ns_of_day).0, Status::TransferPending);
    assert_eq!(v.get_request("late".into()).unwrap().reserved_day, Some(DAY));

    // callback lands after midnight
    resolve(&mut v, "late", true, (DAY + 1) * NS_PER_DAY + 5);
    let today = budget(&v, DAY);
    let tomorrow = budget(&v, DAY + 1);
    assert_eq!((today.executed.0, today.pending.0), (10 * UNIT, 0));
    assert_eq!((tomorrow.executed.0, tomorrow.pending.0), (0, 0));
    assert_eq!(tomorrow.available.0, 50 * UNIT);
}

// ------------------------------------------------------------------ T15 version / domain binding

#[test]
#[should_panic(expected = "POLICY_VERSION_CHANGED")]
fn t15_policy_change_invalidates_pending_approval() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    let hash = v.get_request("r1".into()).unwrap().request_hash;
    set_ctx(owner(), 1, NOW);
    v.set_policy(policy());
    set_ctx(owner(), 1, NOW);
    v.approve_request("r1".into(), hash);
}

#[test]
#[should_panic(expected = "POLICY_VERSION_CHANGED")]
fn t15_policy_change_invalidates_approved_request() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    approve(&mut v, "r1");
    set_ctx(owner(), 1, NOW);
    v.set_policy(policy());
    set_ctx(agent(), 0, NOW);
    v.execute_request("r1".into()).detach();
}

#[test]
fn t15_hash_is_bound_to_vault_network_and_policy_version() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    let req = v.get_request("r1".into()).unwrap();
    let here = request_hash("sandbox", "vault.test.near", &req);
    assert_eq!(here, req.request_hash);
    assert_ne!(here, request_hash("sandbox", "other-vault.test.near", &req));
    assert_ne!(here, request_hash("mainnet", "vault.test.near", &req));
    let mut bumped = req.clone();
    bumped.policy_version += 1;
    assert_ne!(here, request_hash("sandbox", "vault.test.near", &bumped));
}

#[test]
#[should_panic(expected = "AGENT_NOT_ALLOWED")]
fn removed_agent_requests_cannot_execute() {
    let mut v = setup();
    request(&mut v, "r1", 25 * UNIT);
    approve(&mut v, "r1");
    set_ctx(owner(), 1, NOW);
    v.remove_agent(agent());
    set_ctx(owner(), 0, NOW);
    v.execute_request("r1".into()).detach();
}

// ------------------------------------------------------------------ storage / spam bounds

#[test]
fn open_approvals_are_capped() {
    let mut v = setup();
    for i in 0..5 {
        assert_eq!(request(&mut v, &format!("big-{i}"), 11 * UNIT).0, Status::AwaitingApproval);
    }
    assert_eq!(request(&mut v, "big-5", 11 * UNIT), (Status::Blocked, ReasonCode::TooManyOpenApprovals));
}

#[test]
fn stored_requests_per_day_are_capped() {
    let mut v = setup();
    let mut p = policy();
    p.max_requests_per_day = 2;
    set_ctx(owner(), 1, NOW);
    v.set_policy(p);
    request(&mut v, "a", UNIT);
    request(&mut v, "b", UNIT);
    assert_eq!(request(&mut v, "c", UNIT), (Status::Blocked, ReasonCode::RateLimited));
    // a new UTC day resets the counter
    assert_eq!(request_at(&mut v, "d", UNIT, NOW + NS_PER_DAY).0, Status::TransferPending);
}

// ------------------------------------------------------------------ owner recovery

#[test]
fn owner_withdraw_sends_one_transfer() {
    let mut v = setup();
    set_ctx(owner(), 1, NOW);
    v.owner_withdraw(token(), U128(5 * UNIT), owner()).detach();
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].receiver_id, token());
    assert!(get_logs().iter().any(|l| l.contains("owner_withdraw")));
}

// ------------------------------------------------------------------ views

#[test]
fn list_requests_is_newest_first() {
    let mut v = setup();
    request(&mut v, "first", UNIT);
    request(&mut v, "second", 25 * UNIT);
    let ids: Vec<String> = v.list_requests(None, None).into_iter().map(|r| r.request_id).collect();
    assert_eq!(ids, vec!["second", "first"]);
    assert_eq!(v.list_requests(Some(1), Some(1))[0].request_id, "first");
}

// ------------------------------------------------------------------ digest test vector

/// Independent vector computed with Python's hashlib (recorded in docs/INTEGRATIONS.md). The TS
/// client in packages/shared checks the same bytes and hash.
#[test]
fn digest_matches_independent_test_vector() {
    let req = PaymentRequest {
        request_id: "req-001".into(),
        agent_id: agent(),
        route: Route::NearDirect,
        token: token(),
        amount: U128(25_000_000),
        recipient: api(),
        reason: "pay for weather API".into(),
        created_at_ns: U64(0),
        expires_at_ns: U64(1_762_000_000_000_000_000),
        policy_version: 1,
        request_hash: String::new(),
        status: Status::AwaitingApproval,
        reason_code: ReasonCode::RequiresOwnerApproval,
        approved_by: None,
        reserved_day: None,
        updated_at_ns: U64(0),
    };
    set_ctx(vault(), 0, NOW);
    let bytes = encode_request("sandbox", "vault.test.near", &req);
    assert_eq!(bytes.len(), 172);
    assert_eq!(
        request_hash("sandbox", "vault.test.near", &req),
        "2d4708a7e377bb80a417f78393fea4ac8c40e2a4a2710b0fc713971a7804186a"
    );
}
