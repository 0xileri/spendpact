import { requestHash, digestInputFromRequest, type PaymentRequest } from "@spact/shared";
import { describe, expect, it } from "vitest";

import { assess, buildApproveActions, buildRejectActions, reasonFromError, type ProblemCode } from "../src/approval.js";
import type { AppConfig } from "../src/config.js";
import type { VaultSnapshot } from "../src/near/vault.js";

const CONFIG: AppConfig = {
  network: "sandbox",
  rpcUrl: "http://127.0.0.1:3030/",
  vaultId: "vault.test.near",
  explorerTxUrl: null,
  devSignerUrl: "http://127.0.0.1:8788",
};
const NOW = 1_761_996_400_000_000_000n;

function request(overrides: Partial<PaymentRequest> = {}): PaymentRequest {
  const base: PaymentRequest = {
    request_id: "req-001",
    agent_id: "agent.test.near",
    route: "NEAR_DIRECT",
    token: "token.test.near",
    amount: "25000000",
    recipient: "api.test.near",
    reason: "pay for weather API",
    created_at_ns: NOW.toString(),
    expires_at_ns: (NOW + 3_600_000_000_000n).toString(),
    policy_version: 1,
    request_hash: "",
    status: "AWAITING_APPROVAL",
    reason_code: "REQUIRES_OWNER_APPROVAL",
    approved_by: null,
    reserved_day: null,
    updated_at_ns: NOW.toString(),
  };
  const r = { ...base, ...overrides };
  // the vault's stored hash covers the real stored fields
  if (!overrides.request_hash) r.request_hash = requestHash(digestInputFromRequest("sandbox", "vault.test.near", r));
  return r;
}

function snapshot(overrides: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    config: {
      vault_id: "vault.test.near",
      owner: "owner.test.near",
      network: "sandbox",
      agents: ["agent.test.near"],
      paused: false,
      policy_version: 1,
      open_approvals: 1,
      request_count: 1,
    },
    policy: { tokens: [], recipients: [], max_open_approvals: 5, max_requests_per_day: 50, approval_ttl_sec: 3600 },
    request: request(),
    budget: { token: "token.test.near", day: 1, daily_limit: "50000000", executed: "0", pending: "0", available: "50000000" },
    token: { symbol: "TUSD", decimals: 6 },
    nowNs: NOW,
    ...overrides,
  };
}

function codes(a: ReturnType<typeof assess>): ProblemCode[] {
  return a.problems.map((p) => p.code);
}

const OWNER = { signerAvailable: true, signerAccountId: "owner.test.near", executeNow: true };

describe("assess", () => {
  it("lets the owner approve a valid request whose hash matches", () => {
    const a = assess({ config: CONFIG, snapshot: snapshot(), ...OWNER });
    expect(a.problems).toEqual([]);
    expect(a.hashMatches).toBe(true);
    expect(a.canApprove).toBe(true);
    expect(a.canReject).toBe(true);
    expect(a.expiresInSec).toBe(3600);
  });

  it("blocks approval when the displayed terms do not hash to the stored hash (tampered RPC)", () => {
    const real = request();
    const tampered = { ...real, recipient: "mallory.test.near" }; // hash left as stored
    const a = assess({ config: CONFIG, snapshot: snapshot({ request: tampered }), ...OWNER });
    expect(a.hashMatches).toBe(false);
    expect(codes(a)).toContain("HASH_MISMATCH");
    expect(a.canApprove).toBe(false);
    expect(a.canReject).toBe(true);
  });

  it("hashes with this page's network and vault, not what the RPC claims", () => {
    const otherVault = snapshot({ config: { ...snapshot().config, vault_id: "other.test.near", network: "testnet" } });
    const a = assess({ config: CONFIG, snapshot: otherVault, ...OWNER });
    expect(codes(a)).toEqual(expect.arrayContaining(["VAULT_MISMATCH", "NETWORK_MISMATCH"]));
    expect(a.canApprove).toBe(false);
    expect(a.canReject).toBe(false);
  });

  it("only the owner can decide", () => {
    expect(codes(assess({ config: CONFIG, snapshot: snapshot(), ...OWNER, signerAccountId: "agent.test.near" }))).toContain("NOT_OWNER");
    expect(codes(assess({ config: CONFIG, snapshot: snapshot(), ...OWNER, signerAccountId: null }))).toContain("NOT_CONNECTED");
    expect(codes(assess({ config: CONFIG, snapshot: snapshot(), ...OWNER, signerAvailable: false }))).toContain("NO_SIGNER");
  });

  it("refuses expired, stale-policy and closed requests", () => {
    const expired = assess({ config: CONFIG, snapshot: snapshot({ nowNs: NOW + 3_601_000_000_000n }), ...OWNER });
    expect(codes(expired)).toContain("EXPIRED");
    expect(expired.canApprove).toBe(false);

    const stale = assess({ config: CONFIG, snapshot: snapshot({ config: { ...snapshot().config, policy_version: 2 } }), ...OWNER });
    expect(codes(stale)).toContain("POLICY_CHANGED");

    // A settled request reports only that it is closed, not budget or wallet problems.
    const spent = { ...snapshot().budget, token: "token.test.near", day: 1, daily_limit: "50000000", executed: "50000000", pending: "0", available: "0" };
    const settled = assess({
      config: CONFIG,
      snapshot: snapshot({ request: request({ status: "SETTLED", reason_code: "SETTLED" }), budget: spent }),
      ...OWNER,
      signerAccountId: null,
    });
    expect(codes(settled)).toEqual(["NOT_OPEN"]);
    expect(settled.canApprove).toBe(false);
    expect(settled.canReject).toBe(false);

    const missing = assess({ config: CONFIG, snapshot: snapshot({ request: null }), ...OWNER });
    expect(codes(missing)).toContain("NOT_FOUND");
  });

  it("blocks paying now when paused or out of budget, but allows approve-only", () => {
    const paused = snapshot({ config: { ...snapshot().config, paused: true } });
    expect(assess({ config: CONFIG, snapshot: paused, ...OWNER }).canApprove).toBe(false);
    expect(assess({ config: CONFIG, snapshot: paused, ...OWNER, executeNow: false }).canApprove).toBe(true);

    const broke = snapshot({
      budget: { token: "token.test.near", day: 1, daily_limit: "50000000", executed: "49999999", pending: "0", available: "1" },
    });
    expect(codes(assess({ config: CONFIG, snapshot: broke, ...OWNER }))).toContain("BUDGET_INSUFFICIENT");
    expect(assess({ config: CONFIG, snapshot: broke, ...OWNER, executeNow: false }).canApprove).toBe(true);
  });

  it("warns without blocking when token metadata is missing", () => {
    const a = assess({ config: CONFIG, snapshot: snapshot({ token: null }), ...OWNER });
    expect(codes(a)).toEqual(["TOKEN_METADATA_MISSING"]);
    expect(a.canApprove).toBe(true);
  });
});

describe("transaction building", () => {
  it("approves with 1 yocto and executes with enough gas in the same transaction", () => {
    const actions = buildApproveActions("req-001", "ab".repeat(32), true);
    expect(actions).toEqual([
      {
        type: "FunctionCall",
        params: { methodName: "approve_request", args: { request_id: "req-001", request_hash: "ab".repeat(32) }, gas: "30000000000000", deposit: "1" },
      },
      { type: "FunctionCall", params: { methodName: "execute_request", args: { request_id: "req-001" }, gas: "100000000000000", deposit: "0" } },
    ]);
    expect(buildApproveActions("req-001", "ab".repeat(32), false)).toHaveLength(1);
  });

  it("rejects with 1 yocto", () => {
    expect(buildRejectActions("req-001")[0]?.params).toMatchObject({ methodName: "reject_request", deposit: "1" });
  });

  it("extracts vault reason codes from failure messages", () => {
    expect(reasonFromError('{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: HASH_MISMATCH: approved hash"}}}}')).toBe(
      "HASH_MISMATCH",
    );
    expect(reasonFromError("User rejected the request")).toBeNull();
  });
});
