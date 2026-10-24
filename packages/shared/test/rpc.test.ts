import { afterEach, describe, expect, it, vi } from "vitest";

import { finalBlockTimestampNs, RpcError, viewAccessKey, viewFunction } from "../src/rpc.js";

function mockFetch(body: unknown, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const fn = vi.fn(async () => new Response(text, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const bytes = (value: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(value)));

describe("viewFunction", () => {
  it("sends a call_function query and decodes the JSON result", async () => {
    const fetchMock = mockFetch({ jsonrpc: "2.0", id: "spact", result: { result: bytes({ ok: 1 }), logs: [], block_height: 1 } });
    await expect(viewFunction("http://rpc", "vault.test.near", "get_request", { request_id: "r1" })).resolves.toEqual({ ok: 1 });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent.params).toMatchObject({ request_type: "call_function", finality: "final", account_id: "vault.test.near", method_name: "get_request" });
    expect(JSON.parse(atob(sent.params.args_base64))).toEqual({ request_id: "r1" });
  });

  it("surfaces contract errors and malformed responses as RpcError", async () => {
    mockFetch({ jsonrpc: "2.0", id: "x", result: { error: "wasm execution failed: MethodNotFound" } });
    await expect(viewFunction("http://rpc", "v", "nope")).rejects.toBeInstanceOf(RpcError);
    mockFetch({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", data: "account does not exist" } });
    await expect(viewFunction("http://rpc", "v", "get_config")).rejects.toThrow(/account does not exist/);
    mockFetch({ jsonrpc: "2.0", id: "x", result: { result: [300] } });
    await expect(viewFunction("http://rpc", "v", "get_config")).rejects.toThrow(/byte array/);
    mockFetch({}, 502);
    await expect(viewFunction("http://rpc", "v", "get_config")).rejects.toThrow(/HTTP 502/);
  });
});

describe("finalBlockTimestampNs", () => {
  it("reads the nanosecond string, not the lossy number", async () => {
    // raw JSON: the numeric timestamp cannot survive JSON.parse exactly, the string can
    mockFetch('{"jsonrpc":"2.0","id":"x","result":{"header":{"timestamp":1761996400123456789,"timestamp_nanosec":"1761996400123456789"}}}');
    await expect(finalBlockTimestampNs("http://rpc")).resolves.toBe(1_761_996_400_123_456_789n);
  });
});

describe("viewAccessKey", () => {
  const fc = { FunctionCall: { allowance: "250000000000000000000000", receiver_id: "vault.test.near", method_names: ["request_direct_payment"] } };

  it("describes function-call keys and reports other kinds by name", async () => {
    const fetchMock = mockFetch({ jsonrpc: "2.0", id: "x", result: { nonce: 5, permission: fc, block_height: 1 } });
    await expect(viewAccessKey("http://rpc", "agent.test.near", "ed25519:abc")).resolves.toEqual({
      kind: "FunctionCall",
      receiverId: "vault.test.near",
      methodNames: ["request_direct_payment"],
      allowance: "250000000000000000000000",
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).params).toMatchObject({ request_type: "view_access_key", account_id: "agent.test.near", public_key: "ed25519:abc" });

    mockFetch({ jsonrpc: "2.0", id: "x", result: { nonce: 5, permission: "FullAccess" } });
    await expect(viewAccessKey("http://rpc", "a.near", "ed25519:abc")).resolves.toEqual({ kind: "FullAccess" });
    mockFetch({ jsonrpc: "2.0", id: "x", result: { nonce: 5, permission: { GasKeyFunctionCall: { ...fc.FunctionCall, balance: "1", num_nonces: 8 } } } });
    await expect(viewAccessKey("http://rpc", "a.near", "ed25519:abc")).resolves.toEqual({ kind: "Other", name: "GasKeyFunctionCall" });
    mockFetch({ jsonrpc: "2.0", id: "x", result: { nonce: 5, permission: { FunctionCall: { ...fc.FunctionCall, receiver_id: "NOT AN ACCOUNT" } } } });
    await expect(viewAccessKey("http://rpc", "a.near", "ed25519:abc")).resolves.toEqual({ kind: "Other", name: "FunctionCall" });
  });

  it("returns null for a key the account does not have", async () => {
    mockFetch({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY", info: {} }, data: "Access key for public key ed25519:abc has never been observed on the node" } });
    await expect(viewAccessKey("http://rpc", "a.near", "ed25519:abc")).resolves.toBeNull();
    mockFetch({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, data: "account a.near does not exist" } });
    await expect(viewAccessKey("http://rpc", "a.near", "ed25519:abc")).rejects.toBeInstanceOf(RpcError);
  });
});
