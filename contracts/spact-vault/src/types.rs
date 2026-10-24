use near_sdk::json_types::{U128, U64};
use near_sdk::{near, AccountId};

/// Bounds that keep every call's storage reads and gas use small and predictable.
pub const MAX_AGENTS: usize = 8;
pub const MAX_TOKENS: usize = 8;
pub const MAX_RECIPIENTS: usize = 64;
pub const MAX_REQUEST_ID_LEN: usize = 64;
pub const MAX_REASON_LEN: usize = 256;
pub const MAX_NETWORK_LEN: usize = 32;
pub const MIN_APPROVAL_TTL_SEC: u32 = 60;
pub const MAX_APPROVAL_TTL_SEC: u32 = 7 * 24 * 60 * 60;
pub const MAX_OPEN_APPROVALS: u32 = 100;
pub const MAX_REQUESTS_PER_DAY: u32 = 1_000;
pub const MAX_LIST_LIMIT: u32 = 100;

pub const NS_PER_SEC: u64 = 1_000_000_000;
/// Budget window is the UTC calendar day: `day_id = floor(block_timestamp_ns / NS_PER_DAY)`.
pub const NS_PER_DAY: u64 = 86_400 * NS_PER_SEC;

/// Limits for one allowlisted NEP-141 token, in that token's smallest unit.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenPolicy {
    pub token: AccountId,
    /// Payments at or below this amount execute without owner approval. `0` disables auto-approval.
    pub auto_limit: U128,
    /// No single payment may exceed this amount, approved or not.
    pub hard_tx_limit: U128,
    /// Executed plus in-flight payments per UTC day may not exceed this amount.
    pub daily_limit: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub tokens: Vec<TokenPolicy>,
    /// Allowlisted payees for direct NEAR payments.
    pub recipients: Vec<AccountId>,
    /// Requests waiting for (or holding) an owner approval at the same time.
    pub max_open_approvals: u32,
    /// Stored requests per UTC day across all agents. Bounds storage the vault pays for.
    pub max_requests_per_day: u32,
    /// How long a request may wait for approval and then execution.
    pub approval_ttl_sec: u32,
}

impl Policy {
    pub fn token_policy(&self, token: &AccountId) -> Option<&TokenPolicy> {
        self.tokens.iter().find(|t| &t.token == token)
    }

    pub fn allows_recipient(&self, recipient: &AccountId) -> bool {
        self.recipients.iter().any(|r| r == recipient)
    }
}

/// Payment route. Only direct NEP-141 transfers on NEAR exist in P0; the cross-chain
/// 1Click route is deliberately absent until it is designed and tested (AGENTS.md section 8).
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Route {
    NearDirect,
}

impl Route {
    /// Stable tag used in the request digest.
    pub fn tag(self) -> u8 {
        match self {
            Route::NearDirect => 0,
        }
    }
}

/// Lifecycle of a payment request. `Blocked` is only ever returned, never stored.
///
/// The spec's intermediate states AUTO_AUTHORIZED, RESERVED and SOURCE_CONFIRMED happen inside
/// a single receipt here, so they are never observable and are not stored separately.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    Blocked,
    AwaitingApproval,
    Approved,
    Denied,
    Expired,
    TransferPending,
    Settled,
    TransferFailed,
}

impl Status {
    /// Statuses that hold one of the `max_open_approvals` slots.
    pub fn is_open_approval(self) -> bool {
        matches!(self, Status::AwaitingApproval | Status::Approved)
    }
}

/// Stable, machine-readable reason codes. Panics use the same strings as their message prefix.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReasonCode {
    // decisions
    AutoWithinPolicy,
    RequiresOwnerApproval,
    OwnerApproved,
    OwnerDenied,
    RequestExpired,
    TransferPending,
    Settled,
    SourceTransferFailed,
    // request rejections
    VaultPaused,
    DuplicateRequest,
    InvalidRequestId,
    InvalidAmount,
    InvalidReason,
    TokenNotAllowed,
    RecipientNotAllowed,
    HardCapExceeded,
    DailyBudgetExceeded,
    TooManyOpenApprovals,
    RateLimited,
    // execution / approval failures
    PolicyVersionChanged,
    ApprovalExpired,
    AgentNotAllowed,
    HashMismatch,
    InvalidState,
    RequestNotFound,
    NotExpired,
    // authorization and configuration
    NotOwner,
    NotAgent,
    NotAuthorized,
    InitNotSelf,
    InvalidPolicy,
    InvalidConfig,
    InsufficientGas,
    LedgerInvariant,
}

impl ReasonCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ReasonCode::AutoWithinPolicy => "AUTO_WITHIN_POLICY",
            ReasonCode::RequiresOwnerApproval => "REQUIRES_OWNER_APPROVAL",
            ReasonCode::OwnerApproved => "OWNER_APPROVED",
            ReasonCode::OwnerDenied => "OWNER_DENIED",
            ReasonCode::RequestExpired => "REQUEST_EXPIRED",
            ReasonCode::TransferPending => "TRANSFER_PENDING",
            ReasonCode::Settled => "SETTLED",
            ReasonCode::SourceTransferFailed => "SOURCE_TRANSFER_FAILED",
            ReasonCode::VaultPaused => "VAULT_PAUSED",
            ReasonCode::DuplicateRequest => "DUPLICATE_REQUEST",
            ReasonCode::InvalidRequestId => "INVALID_REQUEST_ID",
            ReasonCode::InvalidAmount => "INVALID_AMOUNT",
            ReasonCode::InvalidReason => "INVALID_REASON",
            ReasonCode::TokenNotAllowed => "TOKEN_NOT_ALLOWED",
            ReasonCode::RecipientNotAllowed => "RECIPIENT_NOT_ALLOWED",
            ReasonCode::HardCapExceeded => "HARD_CAP_EXCEEDED",
            ReasonCode::DailyBudgetExceeded => "DAILY_BUDGET_EXCEEDED",
            ReasonCode::TooManyOpenApprovals => "TOO_MANY_OPEN_APPROVALS",
            ReasonCode::RateLimited => "RATE_LIMITED",
            ReasonCode::PolicyVersionChanged => "POLICY_VERSION_CHANGED",
            ReasonCode::ApprovalExpired => "APPROVAL_EXPIRED",
            ReasonCode::AgentNotAllowed => "AGENT_NOT_ALLOWED",
            ReasonCode::HashMismatch => "HASH_MISMATCH",
            ReasonCode::InvalidState => "INVALID_STATE",
            ReasonCode::RequestNotFound => "REQUEST_NOT_FOUND",
            ReasonCode::NotExpired => "NOT_EXPIRED",
            ReasonCode::NotOwner => "NOT_OWNER",
            ReasonCode::NotAgent => "NOT_AGENT",
            ReasonCode::NotAuthorized => "NOT_AUTHORIZED",
            ReasonCode::InitNotSelf => "INIT_NOT_SELF",
            ReasonCode::InvalidPolicy => "INVALID_POLICY",
            ReasonCode::InvalidConfig => "INVALID_CONFIG",
            ReasonCode::InsufficientGas => "INSUFFICIENT_GAS",
            ReasonCode::LedgerInvariant => "LEDGER_INVARIANT",
        }
    }
}

/// A persisted payment request. Every field above `status` is immutable once stored and is
/// covered by `request_hash`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentRequest {
    pub request_id: String,
    pub agent_id: AccountId,
    pub route: Route,
    pub token: AccountId,
    pub amount: U128,
    pub recipient: AccountId,
    pub reason: String,
    pub created_at_ns: U64,
    pub expires_at_ns: U64,
    pub policy_version: u64,
    /// Hex sha256 of the canonical request digest (see `digest.rs`).
    pub request_hash: String,

    pub status: Status,
    pub reason_code: ReasonCode,
    pub approved_by: Option<AccountId>,
    /// UTC day the budget reservation was charged to. Set once, at dispatch.
    pub reserved_day: Option<u64>,
    pub updated_at_ns: U64,
}

/// What a state-changing call reports back to the caller.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaymentOutcome {
    pub request_id: String,
    pub status: Status,
    pub reason_code: ReasonCode,
    pub request_hash: Option<String>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DailyLedger {
    pub executed: u128,
    pub pending: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetView {
    pub token: AccountId,
    pub day: u64,
    pub daily_limit: U128,
    pub executed: U128,
    pub pending: U128,
    pub available: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigView {
    pub vault_id: AccountId,
    pub owner: AccountId,
    pub network: String,
    pub agents: Vec<AccountId>,
    pub paused: bool,
    pub policy_version: u64,
    pub open_approvals: u32,
    pub request_count: u32,
}
