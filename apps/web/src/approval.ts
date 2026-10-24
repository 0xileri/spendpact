import { digestInputFromRequest, isReasonCode, parseU128, requestHash, type ReasonCode } from "@spact/shared";

import type { AppConfig } from "./config.js";
import type { VaultSnapshot } from "./near/vault.js";

/** Same shape near-connect accepts, so every signer can take it unchanged. */
export interface FunctionCallAction {
  type: "FunctionCall";
  params: { methodName: string; args: Record<string, string>; gas: string; deposit: string };
}

export const APPROVE_GAS = "30000000000000"; // 30 Tgas
export const EXECUTE_GAS = "100000000000000"; // 100 Tgas; the vault requires at least 50
export const REJECT_GAS = "30000000000000";
const ONE_YOCTO = "1";

export type ProblemCode =
  | "VAULT_MISMATCH"
  | "NETWORK_MISMATCH"
  | "NOT_FOUND"
  | "NOT_OPEN"
  | "NOT_AWAITING"
  | "EXPIRED"
  | "POLICY_CHANGED"
  | "HASH_MISMATCH"
  | "VAULT_PAUSED"
  | "BUDGET_INSUFFICIENT"
  | "NO_SIGNER"
  | "NOT_CONNECTED"
  | "NOT_OWNER"
  | "TOKEN_METADATA_MISSING";

export interface Problem {
  code: ProblemCode;
  message: string;
  blocksApprove: boolean;
  blocksReject: boolean;
}

export interface Assessment {
  /** Hash of the displayed terms, computed in this browser. null when there is no request. */
  computedHash: string | null;
  hashMatches: boolean;
  expiresInSec: number | null;
  problems: Problem[];
  canApprove: boolean;
  canReject: boolean;
}

export interface AssessInput {
  config: AppConfig;
  snapshot: VaultSnapshot;
  signerAvailable: boolean;
  signerAccountId: string | null;
  /** Approve and execute in one transaction. */
  executeNow: boolean;
}

/**
 * Decides whether the connected account may approve or reject the request, and why not.
 * The hash uses the network and vault this page is configured for (what the owner believes
 * they are approving), not the values reported by the RPC.
 */
export function assess({ config, snapshot, signerAvailable, signerAccountId, executeNow }: AssessInput): Assessment {
  const problems: Problem[] = [];
  const add = (code: ProblemCode, message: string, blocksApprove: boolean, blocksReject: boolean) =>
    problems.push({ code, message, blocksApprove, blocksReject });
  const { config: vault, request } = snapshot;

  if (vault.vault_id !== config.vaultId) {
    add("VAULT_MISMATCH", `The RPC answered for ${vault.vault_id}, not ${config.vaultId}.`, true, true);
  }
  if (vault.network !== config.network) {
    add("NETWORK_MISMATCH", `The vault says it is on "${vault.network}" but this page is set up for "${config.network}".`, true, true);
  }

  let computedHash: string | null = null;
  let hashMatches = false;
  let expiresInSec: number | null = null;

  if (!request) {
    add("NOT_FOUND", "This vault has no request with that ID.", true, true);
  } else {
    computedHash = requestHash(digestInputFromRequest(config.network, config.vaultId, request));
    hashMatches = computedHash === request.request_hash;
    expiresInSec = Number((parseU128(request.expires_at_ns) - snapshot.nowNs) / 1_000_000_000n);

    const open = request.status === "AWAITING_APPROVAL" || request.status === "APPROVED";
    if (!open) {
      // Decided already: nothing below applies, and the status badge says what happened.
      add("NOT_OPEN", "This request is closed. There is nothing left to decide.", true, true);
      return { computedHash, hashMatches, expiresInSec, problems, canApprove: false, canReject: false };
    }
    if (request.status !== "AWAITING_APPROVAL") {
      add("NOT_AWAITING", "Already approved. It can still be rejected until it executes.", true, false);
    }
    if (expiresInSec < 0) add("EXPIRED", "The request has expired. Nothing can execute it.", true, false);
    if (request.policy_version !== vault.policy_version) {
      add("POLICY_CHANGED", "The policy changed after this request was made. The agent must create a new request.", true, false);
    }
    if (!hashMatches) {
      add(
        "HASH_MISMATCH",
        "The terms shown here do not hash to the value the vault stores. Do not approve: the data may have been altered on its way to you.",
        true,
        false,
      );
    }
    if (executeNow && vault.paused) {
      add("VAULT_PAUSED", "The vault is paused, so payment would fail. Unpause it or approve without paying now.", true, false);
    }
    if (executeNow && snapshot.budget && parseU128(request.amount) > parseU128(snapshot.budget.available)) {
      add("BUDGET_INSUFFICIENT", "Not enough of today's budget is left to pay this now.", true, false);
    }
    if (!snapshot.token) {
      add("TOKEN_METADATA_MISSING", "Could not read the token's symbol and decimals. Amounts are shown in base units only.", false, false);
    }
  }

  if (!signerAvailable) add("NO_SIGNER", "No wallet is configured for this network.", true, true);
  else if (!signerAccountId) add("NOT_CONNECTED", "Connect the owner's wallet to decide.", true, true);
  else if (signerAccountId !== vault.owner) {
    add("NOT_OWNER", `Connected as ${signerAccountId}, but only the owner ${vault.owner} can decide.`, true, true);
  }

  return {
    computedHash,
    hashMatches,
    expiresInSec,
    problems,
    canApprove: problems.every((p) => !p.blocksApprove),
    canReject: problems.every((p) => !p.blocksReject),
  };
}

/** approve_request with the locally computed hash, optionally followed by execute_request. */
export function buildApproveActions(requestId: string, hash: string, executeNow: boolean): FunctionCallAction[] {
  const actions: FunctionCallAction[] = [
    {
      type: "FunctionCall",
      params: { methodName: "approve_request", args: { request_id: requestId, request_hash: hash }, gas: APPROVE_GAS, deposit: ONE_YOCTO },
    },
  ];
  if (executeNow) {
    actions.push({
      type: "FunctionCall",
      params: { methodName: "execute_request", args: { request_id: requestId }, gas: EXECUTE_GAS, deposit: "0" },
    });
  }
  return actions;
}

export function buildRejectActions(requestId: string): FunctionCallAction[] {
  return [
    {
      type: "FunctionCall",
      params: { methodName: "reject_request", args: { request_id: requestId }, gas: REJECT_GAS, deposit: ONE_YOCTO },
    },
  ];
}

/** Finds the vault reason code in an error message such as "Smart contract panicked: HASH_MISMATCH: ...". */
export function reasonFromError(message: string): ReasonCode | null {
  for (const match of message.matchAll(/\b[A-Z][A-Z_]{3,}\b/g)) {
    if (isReasonCode(match[0])) return match[0];
  }
  return null;
}
