import { McpServer } from "@modelcontextprotocol/server";
import { accountId, explainReason, type PaymentOutcome, type Status } from "@spact/shared";
import { z } from "zod";

import { explorerTxLink, reviewLink, type McpConfig } from "./config.js";
import type { SubmitResult, VaultClient } from "./vault.js";

export const SERVER_NAME = "spact";
export const SERVER_VERSION = "0.1.0";

const U128_MAX = (1n << 128n) - 1n;
const STATUSES = [
  "BLOCKED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "DENIED",
  "EXPIRED",
  "TRANSFER_PENDING",
  "SETTLED",
  "TRANSFER_FAILED",
] as const satisfies readonly Status[];

// Same rules as is_valid_request_id / is_valid_reason in the vault. The vault checks them again;
// checking here gives a clear error without spending gas.
const requestId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, "1-64 characters: letters, digits, '.', '_', '-' or ':'");
const amountUnits = z
  .string()
  .regex(/^[1-9]\d*$/, "a positive integer in the token's smallest unit, without leading zeros")
  .refine((s) => !/^[1-9]\d*$/.test(s) || BigInt(s) <= U128_MAX, "too large");
const reason = z
  .string()
  .refine((s) => new TextEncoder().encode(s).length <= 256, "at most 256 bytes")
  // eslint-disable-next-line no-control-regex
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f]/.test(s), "no control characters");

export const requestPaymentInput = z.object({
  token: accountId.describe("NEP-141 token contract on the vault's allowlist"),
  amount_units: amountUnits.describe(
    'Amount in the token\'s smallest unit, as a string. With 6 decimals, 3 tokens is "3000000".',
  ),
  recipient: accountId.describe("NEAR account to pay. Must be on the vault's recipient allowlist."),
  reason: reason.describe("Why you are paying. The owner sees this text, word for word, when approving."),
  request_id: requestId.describe(
    "Your unique id for this payment. To retry, reuse the same id: the vault never pays one id twice. Never retry with a new id.",
  ),
});

const policyDecision = z.enum(["AUTO_APPROVED", "OWNER_APPROVAL_REQUIRED", "BLOCKED"]);
type PolicyDecision = z.infer<typeof policyDecision>;

export const requestPaymentOutput = z.object({
  request_id: z.string(),
  policy_decision: policyDecision,
  onchain_status: z.enum(STATUSES),
  reason_code: z.string(),
  explanation: z.string(),
  tx_hash: z.string(),
  review_url: z.string().optional(),
  explorer_url: z.string().optional(),
});
type RequestPaymentOutput = z.infer<typeof requestPaymentOutput>;

export const getPaymentStatusOutput = z.object({
  request_id: z.string(),
  source_status: z.enum([...STATUSES, "NOT_FOUND"]),
  reason_code: z.string(),
  explanation: z.string(),
  token: z.string().optional(),
  amount_units: z.string().optional(),
  recipient: z.string().optional(),
  agent_id: z.string().optional(),
  approved_by: z.string().optional(),
  expires_at: z.string().optional(),
  /** An open request whose expiry has passed by chain time. It can no longer be approved or paid. */
  expired: z.boolean().optional(),
  updated_at: z.string().optional(),
  review_url: z.string().optional(),
  explorer_url: z.string().optional(),
});
type GetPaymentStatusOutput = z.infer<typeof getPaymentStatusOutput>;

export function policyDecisionOf(outcome: PaymentOutcome): PolicyDecision {
  if (outcome.status === "BLOCKED") return "BLOCKED";
  if (outcome.status === "AWAITING_APPROVAL") return "OWNER_APPROVAL_REQUIRED";
  return "AUTO_APPROVED";
}

function isoFromNs(ns: string): string {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}

function text(summary: string, data: object) {
  return [{ type: "text" as const, text: `${summary}\n${JSON.stringify(data, null, 2)}` }];
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** One JSON line per tool call on stderr (stdout carries the protocol). Never includes key material. */
function log(event: Record<string, unknown>) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

/** Fixed sentences only: nothing here repeats text an outside party could have written. */
function summarize(out: RequestPaymentOutput, amount: string, token: string, recipient: string): string {
  switch (out.onchain_status) {
    case "SETTLED":
      return `Paid ${amount} units of ${token} to ${recipient} (request ${out.request_id}).`;
    case "AWAITING_APPROVAL":
      return `Not paid yet: request ${out.request_id} is waiting for the owner to approve it in their wallet${out.review_url ? ` (${out.review_url})` : ""}. Check later with get_payment_status.`;
    case "BLOCKED":
      return out.reason_code === "DUPLICATE_REQUEST"
        ? `A request with id ${out.request_id} already exists. Nothing new was paid. Use get_payment_status to see it.`
        : `Blocked by the vault policy (${out.reason_code}): ${out.explanation} Nothing was paid.`;
    case "TRANSFER_FAILED":
      return `The policy allowed request ${out.request_id}, but the token transfer failed. Nothing was paid.`;
    default:
      return `Request ${out.request_id} is ${out.onchain_status}. Check later with get_payment_status.`;
  }
}

export interface ServerDeps {
  vault: VaultClient;
  config: Pick<McpConfig, "network" | "vaultId" | "agentId" | "approvalUrl" | "explorerTxUrl">;
}

export function createSpactServer({ vault, config }: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { maxToolInputElements: 100 });
  // tx hashes of requests this process submitted, for explorer links in get_payment_status
  const txHashes = new Map<string, string>();

  server.registerTool(
    "request_payment",
    {
      title: "Request a Spact payment",
      description:
        `Ask the Spact vault ${config.vaultId} on NEAR ${config.network} to pay an allowlisted recipient. ` +
        "The vault's on-chain policy decides: small payments are paid at once, larger ones wait for the owner to approve them in their wallet, and anything outside the policy is blocked. " +
        "This tool cannot change the policy, approve payments, or move funds any other way.",
      inputSchema: requestPaymentInput,
      outputSchema: requestPaymentOutput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      try {
        await vault.preflight();
      } catch (e) {
        log({ tool: "request_payment", request_id: input.request_id, refused: (e as Error).message });
        return errorResult(`Refused before sending anything: ${(e as Error).message}`);
      }
      const result: SubmitResult = await vault.requestPayment({
        request_id: input.request_id,
        token: input.token,
        amount: input.amount_units,
        recipient: input.recipient,
        reason: input.reason,
      });

      if (result.kind === "unknown") {
        log({ tool: "request_payment", request_id: input.request_id, unknown: result.message, tx_hash: result.txHash });
        return errorResult(
          `The result of request ${input.request_id} is unknown (${result.message}). It may or may not have been sent. ` +
            "Call get_payment_status with the same request_id, and only retry with that same id.",
        );
      }
      if (result.kind === "rejected") {
        log({ tool: "request_payment", request_id: input.request_id, rejected: result.reasonCode, tx_hash: result.txHash });
        const why = result.reasonCode ? `${result.reasonCode}: ${explainReason(result.reasonCode)}` : result.message;
        return errorResult(`The vault refused request ${input.request_id} (${why}). Nothing was paid. Transaction ${result.txHash}.`);
      }

      const { outcome, txHash } = result;
      // the outcome must describe the request we sent; anything else is not trusted
      if (outcome.request_id !== input.request_id && outcome.request_id !== "<invalid>") {
        return errorResult(`The vault answered for a different request id. Check get_payment_status for ${input.request_id}.`);
      }
      // only stored requests get a link; a blocked duplicate must not replace the original's
      if (outcome.status !== "BLOCKED") {
        txHashes.set(input.request_id, txHash);
        if (txHashes.size > 1000) txHashes.delete(txHashes.keys().next().value as string);
      }
      const out: RequestPaymentOutput = {
        request_id: input.request_id,
        policy_decision: policyDecisionOf(outcome),
        onchain_status: outcome.status,
        reason_code: outcome.reason_code,
        explanation: explainReason(outcome.reason_code),
        tx_hash: txHash,
      };
      const review = outcome.status === "AWAITING_APPROVAL" ? reviewLink(config, input.request_id) : null;
      if (review) out.review_url = review;
      const explorer = explorerTxLink(config, txHash);
      if (explorer) out.explorer_url = explorer;

      log({ tool: "request_payment", request_id: input.request_id, status: out.onchain_status, reason_code: out.reason_code, tx_hash: txHash });
      return {
        content: text(summarize(out, input.amount_units, input.token, input.recipient), out),
        structuredContent: out,
      };
    },
  );

  server.registerTool(
    "get_payment_status",
    {
      title: "Get a Spact payment's status",
      description:
        `Read the current on-chain status of a payment request in the Spact vault ${config.vaultId}. ` +
        "Blocked requests are not stored, so they read as NOT_FOUND.",
      inputSchema: z.object({ request_id: requestId.describe("The request_id you used with request_payment") }),
      outputSchema: getPaymentStatusOutput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ request_id }) => {
      const [request, nowNs] = await Promise.all([vault.getRequest(request_id), vault.nowNs()]);
      if (request === null) {
        const out: GetPaymentStatusOutput = {
          request_id,
          source_status: "NOT_FOUND",
          reason_code: "REQUEST_NOT_FOUND",
          explanation: `${explainReason("REQUEST_NOT_FOUND")} Blocked requests are not stored.`,
        };
        return { content: text(`No stored request with id ${request_id}.`, out), structuredContent: out };
      }

      const code = request.reason_code;
      const open = request.status === "AWAITING_APPROVAL" || request.status === "APPROVED";
      const expired = open && nowNs > BigInt(request.expires_at_ns);
      const out: GetPaymentStatusOutput = {
        request_id: request.request_id,
        source_status: request.status,
        reason_code: code,
        explanation: expired ? explainReason("REQUEST_EXPIRED") : explainReason(code),
        token: request.token,
        amount_units: request.amount,
        recipient: request.recipient,
        agent_id: request.agent_id,
        expires_at: isoFromNs(request.expires_at_ns),
        updated_at: isoFromNs(request.updated_at_ns),
      };
      if (open) out.expired = expired;
      if (request.approved_by) out.approved_by = request.approved_by;
      const review = request.status === "AWAITING_APPROVAL" && !expired ? reviewLink(config, request_id) : null;
      if (review) out.review_url = review;
      const hash = txHashes.get(request_id);
      const explorer = hash ? explorerTxLink(config, hash) : null;
      if (explorer) out.explorer_url = explorer;

      const summary = expired
        ? `Request ${request_id} expired before it was ${request.status === "APPROVED" ? "paid" : "approved"}. Nothing was paid.`
        : `Request ${request_id} is ${request.status} (${code}).`;
      return { content: text(summary, out), structuredContent: out };
    },
  );

  return server;
}
