import type { BudgetView, ConfigView, PaymentRequest } from "@spact/shared";
import { vi } from "vitest";

import type { VaultReader } from "../src/chain.js";
import type { NotifierState } from "../src/state.js";
import type { Telegram } from "../src/telegram.js";

export const NOW = 1_762_000_000_000_000_000n;
export const config = { network: "testnet" as const, vaultId: "vault.demo.testnet", approvalUrl: "https://approve.example/" };

export function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  return {
    request_id: "pay-1",
    agent_id: "agent.demo.testnet",
    route: "NEAR_DIRECT",
    token: "tusd.demo.testnet",
    amount: "25000000",
    recipient: "api.demo.testnet",
    reason: "Weather API: monthly plan upgrade",
    created_at_ns: (NOW - 60_000_000_000n).toString(),
    expires_at_ns: (NOW + 3_600_000_000_000n).toString(),
    policy_version: 1,
    request_hash: "a".repeat(64),
    status: "AWAITING_APPROVAL",
    reason_code: "REQUIRES_OWNER_APPROVAL",
    approved_by: null,
    reserved_day: null,
    updated_at_ns: NOW.toString(),
    ...overrides,
  };
}

export const budget: BudgetView = {
  token: "tusd.demo.testnet",
  day: 20393,
  daily_limit: "50000000",
  executed: "3000000",
  pending: "0",
  available: "47000000",
};

/** A vault whose requests the test edits in place. */
export function fakeVault(requests: PaymentRequest[]) {
  let now = NOW;
  const vault: VaultReader & { setNow(ns: bigint): void } = {
    config: async (): Promise<ConfigView> => ({
      vault_id: config.vaultId,
      owner: "owner.demo.testnet",
      network: "testnet",
      agents: ["agent.demo.testnet"],
      paused: false,
      policy_version: 1,
      open_approvals: 0,
      request_count: requests.length,
    }),
    // newest first, like the vault
    listRequests: async (from, limit) => [...requests].reverse().slice(from, from + limit).map((r) => ({ ...r })),
    getRequest: async (id) => {
      const found = requests.find((r) => r.request_id === id);
      return found ? { ...found } : null;
    },
    budget: async () => budget,
    tokenMetadata: async () => ({ symbol: "TUSD", decimals: 6 }),
    nowNs: async () => now,
    setNow: (ns) => {
      now = ns;
    },
  };
  return vault;
}

export function fakeTelegram() {
  const sent: { chatId: string; text: string; buttonUrl: string | undefined }[] = [];
  const telegram = {
    sendMessage: vi.fn(async (chatId: string, text: string, buttonUrl?: string) => {
      sent.push({ chatId, text, buttonUrl });
    }),
    getUpdates: vi.fn(async () => []),
  } satisfies Telegram;
  return { telegram, sent };
}

export function emptyState(): NotifierState {
  return { version: 1, network: "testnet", vaultId: config.vaultId, chatId: "42", nextIndex: 0, tracked: {}, expired: [] };
}
