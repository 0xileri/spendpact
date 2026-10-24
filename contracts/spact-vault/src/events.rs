use near_sdk::json_types::U128;
use near_sdk::{near, AccountId};

use crate::types::{ReasonCode, Status};

/// NEP-297 events. Indexers read these; contract state stays the source of truth.
#[near(event_json(standard = "spact"))]
pub enum VaultEvent {
    #[event_version("1.0.0")]
    PolicyUpdated { policy_version: u64 },

    #[event_version("1.0.0")]
    PauseChanged { paused: bool },

    #[event_version("1.0.0")]
    AgentAdded { agent_id: AccountId },

    #[event_version("1.0.0")]
    AgentRemoved { agent_id: AccountId },

    /// A request that failed policy checks. Blocked requests are not stored, only logged.
    #[event_version("1.0.0")]
    RequestBlocked { request_id: String, agent_id: AccountId, reason_code: ReasonCode },

    #[event_version("1.0.0")]
    RequestStatus { request_id: String, status: Status, reason_code: ReasonCode },

    /// Owner recovery path. Bypasses spending limits by design and is owner-only.
    #[event_version("1.0.0")]
    OwnerWithdraw { token: AccountId, amount: U128, receiver_id: AccountId },
}
