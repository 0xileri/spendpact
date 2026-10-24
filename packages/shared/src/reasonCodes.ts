/**
 * Reason codes emitted by the vault contract. Must stay identical to `ReasonCode::as_str` in
 * contracts/spact-vault/src/types.rs; test/reasonCodes.test.ts checks this.
 */
export const REASON_CODES = {
  AUTO_WITHIN_POLICY: "Within the auto-approval limit and today's budget.",
  REQUIRES_OWNER_APPROVAL: "Above the auto-approval limit. The owner must approve this exact payment.",
  OWNER_APPROVED: "The owner approved this exact payment with their wallet.",
  OWNER_DENIED: "The owner rejected this payment.",
  REQUEST_EXPIRED: "The request expired before it was approved or executed.",
  TRANSFER_PENDING: "Budget reserved and the token transfer was sent. Waiting for the result.",
  SETTLED: "The token transfer on NEAR succeeded.",
  SOURCE_TRANSFER_FAILED: "The token transfer failed on chain. The reserved budget was released.",
  VAULT_PAUSED: "The owner paused the vault.",
  DUPLICATE_REQUEST: "A request with this ID already exists.",
  INVALID_REQUEST_ID: "Request IDs are 1-64 characters of letters, digits, '-', '_', '.' or ':'.",
  INVALID_AMOUNT: "The amount must be a positive integer in the token's smallest unit.",
  INVALID_REASON: "The reason is too long or contains control characters.",
  TOKEN_NOT_ALLOWED: "This token is not in the vault policy.",
  RECIPIENT_NOT_ALLOWED: "This recipient is not on the allowlist.",
  HARD_CAP_EXCEEDED: "Above the per-payment hard cap. It cannot be approved.",
  DAILY_BUDGET_EXCEEDED: "Not enough budget left for today (UTC).",
  TOO_MANY_OPEN_APPROVALS: "Too many requests are already waiting for approval.",
  RATE_LIMITED: "The vault's daily request limit was reached.",
  POLICY_VERSION_CHANGED: "The policy changed after this request was created. Create a new request.",
  APPROVAL_EXPIRED: "The approval expired before execution.",
  AGENT_NOT_ALLOWED: "The requesting agent was removed from the vault.",
  HASH_MISMATCH: "The approved hash does not match the stored request.",
  INVALID_STATE: "The request is not in a state that allows this action.",
  REQUEST_NOT_FOUND: "No request with this ID.",
  NOT_EXPIRED: "The request has not expired yet.",
  NOT_OWNER: "Only the vault owner can do this.",
  NOT_AGENT: "Only an agent of this vault can request payments.",
  NOT_AUTHORIZED: "Only the owner or the requesting agent can execute this request.",
  INIT_NOT_SELF: "The vault can only be initialized by its own account.",
  INVALID_POLICY: "The policy is invalid.",
  INVALID_CONFIG: "The vault configuration is invalid.",
  INSUFFICIENT_GAS: "Attach at least 50 Tgas.",
  LEDGER_INVARIANT: "Internal accounting check failed. Nothing was changed.",
} as const;

export type ReasonCode = keyof typeof REASON_CODES;

export function isReasonCode(value: string): value is ReasonCode {
  return Object.hasOwn(REASON_CODES, value);
}

export function explainReason(code: ReasonCode): string {
  return REASON_CODES[code];
}
