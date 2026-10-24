import {
  configViewSchema,
  finalBlockTimestampNs,
  isReasonCode,
  paymentOutcomeSchema,
  paymentRequestSchema,
  viewAccessKey,
  viewFunction,
  type PaymentOutcome,
  type PaymentRequest,
  type ReasonCode,
} from "@spact/shared";
import { Account, actions, JsonRpcProvider } from "near-api-js";

import { AgentKeyError, keyProblem, type AgentKey } from "./agentKey.js";
import type { McpConfig } from "./config.js";

export interface PaymentArgs {
  request_id: string;
  token: string;
  amount: string;
  recipient: string;
  reason: string;
}

export type SubmitResult =
  /** The vault answered: the request was blocked, stored for approval, or paid (or failed to pay). */
  | { kind: "outcome"; outcome: PaymentOutcome; txHash: string }
  /** The transaction ran and the vault refused it with a panic (e.g. NOT_AGENT). Nothing changed. */
  | { kind: "rejected"; reasonCode: ReasonCode | null; message: string; txHash: string }
  /** Sending failed or the answer was unreadable. The transaction may or may not have run. */
  | { kind: "unknown"; message: string; txHash: string | null };

/** Everything the MCP tools need from the chain. Injected so the tools can be tested without one. */
export interface VaultClient {
  /** Fails unless the key, the vault's network and the agent's membership all check out. */
  preflight(): Promise<void>;
  requestPayment(args: PaymentArgs): Promise<SubmitResult>;
  getRequest(requestId: string): Promise<PaymentRequest | null>;
  /** Timestamp of the latest final block, so expiry is judged by chain time, not the local clock. */
  nowNs(): Promise<bigint>;
}

/** Enough for request_direct_payment plus the token transfer and its callback (~7 Tgas measured). */
const REQUEST_GAS = 100_000_000_000_000n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finds the contract's panic text inside a NEAR transaction failure, e.g. "NOT_AGENT: caller is ...". */
export function panicMessage(failure: unknown): string | null {
  const kind = isRecord(failure) && isRecord(failure.ActionError) ? failure.ActionError.kind : undefined;
  const fnError = isRecord(kind) ? kind.FunctionCallError : undefined;
  const text = isRecord(fnError) ? fnError.ExecutionError : undefined;
  if (typeof text !== "string") return null;
  return text.replace(/^Smart contract panicked: /, "").slice(0, 300);
}

export function reasonCodeOf(message: string): ReasonCode | null {
  const code = /^([A-Z][A-Z_]+):/.exec(message)?.[1];
  return code && isReasonCode(code) ? code : null;
}

export function decodeSuccessValue(value: string): PaymentOutcome {
  const text = Buffer.from(value, "base64").toString("utf8");
  return paymentOutcomeSchema.parse(JSON.parse(text));
}

export function createVaultClient(config: McpConfig, key: AgentKey): VaultClient {
  const account = new Account(key.accountId, new JsonRpcProvider({ url: config.rpcUrl }), key.privateKey);

  return {
    async preflight() {
      const problem = keyProblem(await viewAccessKey(config.rpcUrl, key.accountId, key.publicKey), config.vaultId);
      if (problem) throw new AgentKeyError(`${key.accountId} key ${key.publicKey}: ${problem}`);
      const vault = configViewSchema.parse(await viewFunction(config.rpcUrl, config.vaultId, "get_config"));
      if (vault.network !== config.network) {
        throw new AgentKeyError(`the vault is on network "${vault.network}", not "${config.network}"`);
      }
      if (!vault.agents.includes(key.accountId)) {
        throw new AgentKeyError(`${key.accountId} is not an agent of ${config.vaultId}`);
      }
    },

    async requestPayment(args) {
      let result: unknown;
      try {
        result = await account.signAndSendTransaction({
          receiverId: config.vaultId,
          actions: [actions.functionCall("request_direct_payment", { ...args }, REQUEST_GAS, 0n)],
          throwOnFailure: false,
          // wait until the transfer and its callback are in final blocks, so SETTLED is never optimistic
          waitUntil: "FINAL",
        });
      } catch (e) {
        return { kind: "unknown", message: (e as Error).message.slice(0, 300), txHash: null };
      }
      const txHash = isRecord(result) && isRecord(result.transaction) ? result.transaction.hash : undefined;
      const status = isRecord(result) ? result.status : undefined;
      if (typeof txHash !== "string" || !isRecord(status)) {
        return { kind: "unknown", message: "unexpected transaction result shape", txHash: null };
      }
      if (typeof status.SuccessValue === "string") {
        try {
          return { kind: "outcome", outcome: decodeSuccessValue(status.SuccessValue), txHash };
        } catch {
          return { kind: "unknown", message: "the vault's answer could not be read", txHash };
        }
      }
      const message = panicMessage(status.Failure) ?? `transaction failed: ${JSON.stringify(status.Failure).slice(0, 300)}`;
      return { kind: "rejected", reasonCode: reasonCodeOf(message), message, txHash };
    },

    async getRequest(requestId) {
      const raw = await viewFunction(config.rpcUrl, config.vaultId, "get_request", { request_id: requestId });
      return raw === null ? null : paymentRequestSchema.parse(raw);
    },

    nowNs: () => finalBlockTimestampNs(config.rpcUrl),
  };
}
