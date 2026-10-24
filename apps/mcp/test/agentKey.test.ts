import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";

import { AGENT_METHODS, keyProblem, loadAgentKey } from "../src/agentKey.js";

const dir = mkdtempSync(join(tmpdir(), "spact-mcp-key-"));

function keyFile(name: string, contents: unknown, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  chmodSync(path, mode);
  return path;
}

describe("loadAgentKey", () => {
  const pair = KeyPair.fromRandom("ed25519");
  const publicKey = pair.getPublicKey().toString();

  it("reads a near-cli key file", () => {
    const path = keyFile("ok.json", { public_key: publicKey, private_key: pair.toString(), master_seed_phrase: "unused" });
    expect(loadAgentKey(path, "agent.test.near")).toEqual({
      accountId: "agent.test.near",
      publicKey,
      privateKey: pair.toString(),
    });
  });

  it("refuses files others can read, mismatched keys and junk", () => {
    expect(() => loadAgentKey(keyFile("open.json", { private_key: pair.toString() }, 0o644), "a.near")).toThrow(/chmod 600/);
    const other = KeyPair.fromRandom("ed25519").getPublicKey().toString();
    expect(() => loadAgentKey(keyFile("mismatch.json", { public_key: other, private_key: pair.toString() }), "a.near")).toThrow(
      /does not match/,
    );
    expect(() => loadAgentKey(keyFile("junk.json", "not json"), "a.near")).toThrow(/not JSON/);
    expect(() => loadAgentKey(keyFile("nokey.json", { public_key: publicKey }), "a.near")).toThrow(/no ed25519 private_key/);
    expect(() => loadAgentKey(join(dir, "missing.json"), "a.near")).toThrow(/cannot read/);
  });
});

describe("keyProblem", () => {
  const vault = "vault.test.near";
  const fc = (receiverId: string, methodNames: string[]) =>
    ({ kind: "FunctionCall", receiverId, methodNames, allowance: "1" }) as const;

  it("accepts a function-call key for the vault's agent methods", () => {
    expect(keyProblem(fc(vault, [...AGENT_METHODS]), vault)).toBeNull();
    expect(keyProblem(fc(vault, ["request_direct_payment"]), vault)).toBeNull();
  });

  it("refuses full-access keys and anything broader or elsewhere", () => {
    expect(keyProblem({ kind: "FullAccess" }, vault)).toMatch(/full-access/);
    expect(keyProblem(null, vault)).toMatch(/no such key/);
    expect(keyProblem({ kind: "Other", name: "GasKeyFullAccess" }, vault)).toMatch(/unsupported key type GasKeyFullAccess/);
    expect(keyProblem(fc("tusd.test.near", ["request_direct_payment"]), vault)).toMatch(/not the vault/);
    expect(keyProblem(fc(vault, []), vault)).toMatch(/every vault method/);
    expect(keyProblem(fc(vault, ["request_direct_payment", "approve_request"]), vault)).toMatch(/also call approve_request/);
  });
});
