import { formatUnits, parseU128, type BudgetView, type FtMetadata, type PaymentRequest } from "@spact/shared";

import { reviewLink, type NotifierConfig } from "./config.js";

const MAX_NOTE = 200;

function amount(units: string, token: FtMetadata | null): string {
  return token ? `${formatUnits(parseU128(units), token.decimals)} ${token.symbol}` : `${units} base units`;
}

function utc(ns: bigint): string {
  return `${new Date(Number(ns / 1_000_000n)).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function remaining(fromNs: bigint, toNs: bigint): string {
  const minutes = Number((toNs - fromNs) / 60_000_000_000n);
  if (minutes < 1) return "less than a minute";
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h} h ${minutes % 60} min` : `${minutes} min`;
}

/**
 * The agent's note, made safe to show: control and invisible formatting characters removed,
 * whitespace collapsed, length capped. Links are defanged ("evil[.]com", "https[:]//", "(at)name")
 * so Telegram does not make them tappable: the approval link must be the only link in the
 * message. It is still text the agent chose, and the message says so.
 */
export function agentNote(reason: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = reason.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, " ");
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  const capped = collapsed.length > MAX_NOTE ? `${collapsed.slice(0, MAX_NOTE - 1)}…` : collapsed;
  return capped
    .replace(/:\/\//g, "[:]//")
    .replace(/([\p{L}\p{N}])[.\u3002\uff0e\uff61](?=[\p{L}\p{N}])/gu, "$1[.]")
    .replace(/@/g, "(at)");
}

export interface ApprovalContext {
  request: PaymentRequest;
  token: FtMetadata | null;
  budget: BudgetView | null;
  nowNs: bigint;
}

/** Message for a request that waits for the owner. Plain text; the link is the only action. */
export function approvalMessage(config: Pick<NotifierConfig, "network" | "vaultId" | "approvalUrl">, ctx: ApprovalContext) {
  const { request, token, budget, nowNs } = ctx;
  const link = reviewLink(config, request.request_id);
  const expires = BigInt(request.expires_at_ns);
  const lines = [
    `Payment waiting for your approval (${config.network})`,
    "",
    `Amount: ${amount(request.amount, token)}`,
    `To: ${request.recipient}`,
    `Token contract: ${request.token}`,
    `Vault: ${config.vaultId}`,
    `Requested by: ${request.agent_id}`,
    `Request: ${request.request_id}`,
    `Expires: ${utc(expires)} (in ${remaining(nowNs, expires)})`,
  ];
  if (budget) {
    const need = parseU128(request.amount);
    const left = parseU128(budget.available);
    lines.push(`Budget left today: ${amount(budget.available, token)} of ${amount(budget.daily_limit, token)}`);
    if (need > left) lines.push("Warning: not enough budget left today, so paying now would fail.");
  }
  const note = agentNote(request.reason);
  if (note) lines.push("", `Agent's note (written by the agent, not checked): "${note}"`);
  lines.push(
    "",
    "Nothing has been paid. To approve, open the approval page, check the terms there, and sign with your wallet. This message cannot approve anything.",
    link,
  );
  // Telegram may refuse URL buttons that are not public https links, so local links stay in the text only.
  const buttonUrl = new URL(link).protocol === "https:" ? link : undefined;
  return { text: lines.join("\n"), buttonUrl };
}

const OUTCOMES: Partial<Record<PaymentRequest["status"], string>> = {
  APPROVED: "approved. It is not paid yet: the owner or the agent still has to execute it.",
  SETTLED: "paid. The token transfer on NEAR succeeded.",
  DENIED: "rejected. Nothing was paid.",
  EXPIRED: "expired. Nothing was paid.",
  TRANSFER_FAILED: "approved, but the token transfer failed. Nothing was paid.",
};

/** Follow-up when a request we alerted about changes state. null for states that need no message. */
export function outcomeMessage(request: PaymentRequest, token: FtMetadata | null): string | null {
  const outcome = OUTCOMES[request.status];
  if (!outcome) return null;
  return `Request ${request.request_id} (${amount(request.amount, token)} to ${request.recipient}) was ${outcome}`;
}

/** For an open request whose expiry passed by chain time. On chain it stays open until someone calls expire_request. */
export function expiredMessage(request: PaymentRequest, token: FtMetadata | null): string {
  const before = request.status === "APPROVED" ? "paid" : "approved";
  return `Request ${request.request_id} (${amount(request.amount, token)} to ${request.recipient}) expired before it was ${before}. Nothing was paid.`;
}
