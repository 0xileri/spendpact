import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils.js";

import { digestInputFromRequest, encodeRequest, requestHash, type DigestInput } from "../src/digest.js";
import type { PaymentRequest } from "../src/types.js";

// Same vector as `digest_matches_independent_test_vector` in the Rust vault tests, computed
// independently with Python's hashlib. Rust, TypeScript and Python must all agree.
const VECTOR: DigestInput = {
  network: "sandbox",
  vaultId: "vault.test.near",
  requestId: "req-001",
  agentId: "agent.test.near",
  route: "NEAR_DIRECT",
  token: "token.test.near",
  amount: 25_000_000n,
  recipient: "api.test.near",
  reason: "pay for weather API",
  expiresAtNs: 1_762_000_000_000_000_000n,
  policyVersion: 1n,
};
const VECTOR_BYTES =
  "1000000073706163742e726571756573742e76310700000073616e64626f780f0000007661756c742e746573742e" +
  "6e656172070000007265712d3030310f0000006167656e742e746573742e6e656172000f000000746f6b656e2e74" +
  "6573742e6e65617240787d010000000000000000000000000d0000006170692e746573742e6e6561721300000070" +
  "617920666f7220776561746865722041504900003d1eaae173180100000000000000";
const VECTOR_HASH = "2d4708a7e377bb80a417f78393fea4ac8c40e2a4a2710b0fc713971a7804186a";

describe("request digest", () => {
  it("matches the cross-language test vector byte for byte", () => {
    const bytes = encodeRequest(VECTOR);
    expect(bytes.length).toBe(172);
    expect(bytesToHex(bytes)).toBe(VECTOR_BYTES);
    expect(requestHash(VECTOR)).toBe(VECTOR_HASH);
  });

  it("binds every material field", () => {
    const changes: Partial<DigestInput>[] = [
      { network: "mainnet" },
      { vaultId: "other-vault.test.near" },
      { requestId: "req-002" },
      { agentId: "agent2.test.near" },
      { token: "token2.test.near" },
      { amount: 25_000_001n },
      { recipient: "mallory.test.near" },
      { reason: "pay for weather API!" },
      { expiresAtNs: 1_762_000_000_000_000_001n },
      { policyVersion: 2n },
    ];
    for (const change of changes) {
      expect(requestHash({ ...VECTOR, ...change })).not.toBe(VECTOR_HASH);
    }
  });

  it("builds the digest input from contract JSON", () => {
    const req: PaymentRequest = {
      request_id: "req-001",
      agent_id: "agent.test.near",
      route: "NEAR_DIRECT",
      token: "token.test.near",
      amount: "25000000",
      recipient: "api.test.near",
      reason: "pay for weather API",
      created_at_ns: "1761996400000000000",
      expires_at_ns: "1762000000000000000",
      policy_version: 1,
      request_hash: VECTOR_HASH,
      status: "AWAITING_APPROVAL",
      reason_code: "REQUIRES_OWNER_APPROVAL",
      approved_by: null,
      reserved_day: null,
      updated_at_ns: "1761996400000000000",
    };
    expect(requestHash(digestInputFromRequest("sandbox", "vault.test.near", req))).toBe(VECTOR_HASH);
  });

  it("rejects malformed numeric fields instead of guessing", () => {
    const base = { ...VECTOR };
    expect(() => encodeRequest({ ...base, amount: -1n })).toThrow(RangeError);
    expect(() => encodeRequest({ ...base, amount: 1n << 128n })).toThrow(RangeError);
    expect(() => encodeRequest({ ...base, expiresAtNs: 1n << 64n })).toThrow(RangeError);
  });
});
