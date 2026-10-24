import { readFileSync, statSync } from "node:fs";

import type { AccessKeyPermission } from "@spact/shared";
import { KeyPair, type KeyPairString } from "near-api-js";

/** The vault methods the agent's key may be scoped to. Nothing else is accepted. */
export const AGENT_METHODS: readonly string[] = ["request_direct_payment", "execute_request"];

export interface AgentKey {
  accountId: string;
  publicKey: string;
  privateKey: KeyPairString;
}

export class AgentKeyError extends Error {}

/**
 * Reads a near-cli key file (`public_key`, `private_key`, as written by `near account add-key ...
 * save-to-legacy-keychain`). Refuses files other users can read, and files whose public key does
 * not match the private key.
 */
export function loadAgentKey(path: string, accountId: string): AgentKey {
  let text: string;
  try {
    if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
      throw new AgentKeyError(`${path} is readable by other users; run: chmod 600 ${path}`);
    }
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof AgentKeyError) throw e;
    throw new AgentKeyError(`cannot read the agent key file ${path}`);
  }
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch {
    throw new AgentKeyError(`${path} is not JSON`);
  }
  const { private_key: privateKey, public_key: listed } = (file ?? {}) as Record<string, unknown>;
  if (typeof privateKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(privateKey)) {
    throw new AgentKeyError(`${path} has no ed25519 private_key`);
  }
  let publicKey: string;
  try {
    publicKey = KeyPair.fromString(privateKey as KeyPairString).getPublicKey().toString();
  } catch {
    throw new AgentKeyError(`${path} has an invalid private_key`);
  }
  if (listed !== undefined && listed !== publicKey) {
    throw new AgentKeyError(`${path}: public_key does not match private_key`);
  }
  return { accountId, publicKey, privateKey: privateKey as KeyPairString };
}

/**
 * Returns why the key must not be used, or null when it is a function-call key for this vault
 * limited to AGENT_METHODS. A full-access key is always refused: whoever holds it controls the
 * whole agent account.
 */
export function keyProblem(permission: AccessKeyPermission | null, vaultId: string): string | null {
  if (permission === null) return "the agent account has no such key";
  switch (permission.kind) {
    case "FullAccess":
      return "refusing to run with a full-access key; give the agent a function-call key instead (scripts/deploy-testnet.sh does)";
    case "Other":
      return `unsupported key type ${permission.name}; use a plain function-call key`;
    case "FunctionCall": {
      if (permission.receiverId !== vaultId) return `the key is for ${permission.receiverId}, not the vault ${vaultId}`;
      if (permission.methodNames.length === 0) {
        return `the key may call every vault method; limit it to ${AGENT_METHODS.join(", ")}`;
      }
      const extra = permission.methodNames.filter((m) => !AGENT_METHODS.includes(m));
      if (extra.length > 0) return `the key may also call ${extra.join(", ")}; limit it to ${AGENT_METHODS.join(", ")}`;
      return null;
    }
  }
}
