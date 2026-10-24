import {
  budgetViewSchema,
  configViewSchema,
  finalBlockTimestampNs,
  ftMetadataSchema,
  paymentRequestSchema,
  policySchema,
  viewFunction,
  type BudgetView,
  type ConfigView,
  type FtMetadata,
  type PaymentRequest,
  type Policy,
} from "@spact/shared";

import type { AppConfig } from "../config.js";

/** Everything the approval page needs, read from chain in one go. */
export interface VaultSnapshot {
  config: ConfigView;
  policy: Policy;
  request: PaymentRequest | null;
  budget: BudgetView | null;
  /** null when the token's metadata could not be read or validated. */
  token: FtMetadata | null;
  nowNs: bigint;
}

export async function loadSnapshot(cfg: AppConfig, requestId: string): Promise<VaultSnapshot> {
  const [configRaw, policyRaw, requestRaw, nowNs] = await Promise.all([
    viewFunction(cfg.rpcUrl, cfg.vaultId, "get_config"),
    viewFunction(cfg.rpcUrl, cfg.vaultId, "get_policy"),
    viewFunction(cfg.rpcUrl, cfg.vaultId, "get_request", { request_id: requestId }),
    finalBlockTimestampNs(cfg.rpcUrl),
  ]);
  const config = configViewSchema.parse(configRaw);
  const policy = policySchema.parse(policyRaw);
  const request = requestRaw === null ? null : paymentRequestSchema.parse(requestRaw);

  let budget: BudgetView | null = null;
  let token: FtMetadata | null = null;
  if (request) {
    const [budgetRaw, metadataRaw] = await Promise.all([
      viewFunction(cfg.rpcUrl, cfg.vaultId, "get_budget", { token: request.token }),
      viewFunction(cfg.rpcUrl, request.token, "ft_metadata").catch(() => null),
    ]);
    budget = budgetRaw === null ? null : budgetViewSchema.parse(budgetRaw);
    const parsed = ftMetadataSchema.safeParse(metadataRaw);
    token = parsed.success ? parsed.data : null;
  }
  return { config, policy, request, budget, token, nowNs };
}

/** Requests that still need an owner decision, newest first. */
export async function listOpenRequests(cfg: AppConfig): Promise<PaymentRequest[]> {
  const raw = await viewFunction(cfg.rpcUrl, cfg.vaultId, "list_requests", { from_index: 0, limit: 100 });
  if (!Array.isArray(raw)) throw new Error("list_requests did not return an array");
  return raw
    .map((r) => paymentRequestSchema.parse(r))
    .filter((r) => r.status === "AWAITING_APPROVAL" || r.status === "APPROVED");
}

export async function getRequest(cfg: AppConfig, requestId: string): Promise<PaymentRequest | null> {
  const raw = await viewFunction(cfg.rpcUrl, cfg.vaultId, "get_request", { request_id: requestId });
  return raw === null ? null : paymentRequestSchema.parse(raw);
}

/** Polls get_request until `done` accepts the request or the timeout passes. Returns the last state seen. */
export async function waitForRequest(
  cfg: AppConfig,
  requestId: string,
  done: (r: PaymentRequest) => boolean,
  timeoutMs = 60_000,
  intervalMs = 1_000,
): Promise<PaymentRequest | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await getRequest(cfg, requestId);
    if ((last && done(last)) || Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
