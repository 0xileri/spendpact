import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { KeyPair, type KeyPairString } from "near-api-js";
import type { TestProject } from "vitest/node";

const ROOT = resolve(import.meta.dirname, "../../../..");

export interface SandboxInfo {
  rpcUrl: string;
  vaultId: string;
  tokenId: string;
  ownerId: string;
  agentId: string;
  apiId: string;
  malloryId: string;
  /** The agent's function-call key, in near-cli's file format, for making new requests. */
  agentKeyFile: string;
  /** The owner's full-access key, standing in for the owner's wallet when approving. */
  ownerKeyFile: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    sandbox: SandboxInfo;
  }
}

function waitForOutput(child: ChildProcess, marker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${marker}"`)), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(marker)) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`process exited with ${code} before "${marker}"`));
    });
  });
}

function writeKeyFile(path: string, secretKey: string) {
  const publicKey = KeyPair.fromString(secretKey as KeyPairString).getPublicKey().toString();
  writeFileSync(path, JSON.stringify({ public_key: publicKey, private_key: secretKey }), { mode: 0o600 });
}

export default async function globalSetup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), "spact-notifier-"));
  const fixturePath = join(dir, "fixture.json");

  // Builds the contracts on first run, so allow a while.
  const sandbox = spawn(join(ROOT, "scripts/start-demo-sandbox.sh"), [fixturePath], { stdio: ["ignore", "pipe", "inherit"] });
  await waitForOutput(sandbox, "READY", 900_000);
  const f = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, string>;

  const agentKeyFile = join(dir, "agent-key.json");
  const ownerKeyFile = join(dir, "owner-key.json");
  writeKeyFile(agentKeyFile, f.agent_secret_key ?? "");
  writeKeyFile(ownerKeyFile, f.owner_secret_key ?? "");
  project.provide("sandbox", {
    rpcUrl: f.rpc_url ?? "",
    vaultId: f.vault_id ?? "",
    tokenId: f.token_id ?? "",
    ownerId: f.owner_id ?? "",
    agentId: f.agent_id ?? "",
    apiId: f.api_id ?? "",
    malloryId: f.mallory_id ?? "",
    agentKeyFile,
    ownerKeyFile,
  });

  return async () => {
    if (sandbox.exitCode !== null) return;
    await new Promise<void>((done) => {
      sandbox.once("exit", () => done());
      sandbox.kill("SIGINT");
    });
  };
}
