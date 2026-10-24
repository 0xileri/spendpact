import {
  budgetViewSchema,
  configViewSchema,
  finalBlockTimestampNs,
  ftMetadataSchema,
  paymentRequestSchema,
  viewFunction,
  type BudgetView,
  type ConfigView,
  type FtMetadata,
  type PaymentRequest,
} from "@spact/shared";
import { z } from "zod";

import type { NotifierConfig } from "./config.js";

/** Read-only view of the vault. Every RPC answer is validated before use. */
export interface VaultReader {
  config(): Promise<ConfigView>;
  /** Newest first, as the vault returns them. */
  listRequests(fromIndex: number, limit: number): Promise<PaymentRequest[]>;
  getRequest(requestId: string): Promise<PaymentRequest | null>;
  budget(token: string): Promise<BudgetView | null>;
  tokenMetadata(token: string): Promise<FtMetadata | null>;
  nowNs(): Promise<bigint>;
}

export function createVaultReader(config: Pick<NotifierConfig, "rpcUrl" | "vaultId">): VaultReader {
  const { rpcUrl, vaultId } = config;
  const metadata = new Map<string, FtMetadata | null>();
  return {
    config: async () => configViewSchema.parse(await viewFunction(rpcUrl, vaultId, "get_config")),
    listRequests: async (fromIndex, limit) =>
      z.array(paymentRequestSchema).parse(await viewFunction(rpcUrl, vaultId, "list_requests", { from_index: fromIndex, limit })),
    getRequest: async (requestId) => {
      const raw = await viewFunction(rpcUrl, vaultId, "get_request", { request_id: requestId });
      return raw === null ? null : paymentRequestSchema.parse(raw);
    },
    budget: async (token) => {
      const raw = await viewFunction(rpcUrl, vaultId, "get_budget", { token });
      return raw === null ? null : budgetViewSchema.parse(raw);
    },
    tokenMetadata: async (token) => {
      if (!metadata.has(token)) {
        const parsed = ftMetadataSchema.safeParse(await viewFunction(rpcUrl, token, "ft_metadata").catch(() => null));
        metadata.set(token, parsed.success ? parsed.data : null);
      }
      return metadata.get(token) ?? null;
    },
    nowNs: () => finalBlockTimestampNs(rpcUrl),
  };
}
