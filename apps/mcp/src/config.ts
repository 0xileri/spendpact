import { accountId } from "@spact/shared";

export type NetworkId = "sandbox" | "testnet" | "mainnet";

export interface McpConfig {
  /** Must match the network string stored in the vault. */
  network: NetworkId;
  rpcUrl: string;
  /** The only vault this server sends requests to. */
  vaultId: string;
  /** The agent account the key belongs to. */
  agentId: string;
  /** near-cli key file holding the agent's function-call key. */
  agentKeyFile: string;
  /** Base URL of the owner approval page, for `review_url`. null when not configured. */
  approvalUrl: string | null;
  /** Explorer URL template with a `{hash}` placeholder, or null when there is no explorer. */
  explorerTxUrl: string | null;
}

export class ConfigError extends Error {}

const DEFAULT_EXPLORERS: Record<NetworkId, string | null> = {
  sandbox: null,
  testnet: "https://testnet.nearblocks.io/txns/{hash}",
  mainnet: "https://nearblocks.io/txns/{hash}",
};

function parseUrl(value: string | undefined, name: string): URL {
  if (!value) throw new ConfigError(`${name} is required`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError(`${name} must be http(s)`);
  }
  return url;
}

function parseAccount(value: string | undefined, name: string): string {
  const parsed = accountId.safeParse(value);
  if (!parsed.success) throw new ConfigError(`${name} must be a NEAR account id`);
  return parsed.data;
}

export function parseConfig(env: Record<string, string | undefined>): McpConfig {
  const network = env.SPACT_NETWORK;
  if (network !== "sandbox" && network !== "testnet" && network !== "mainnet") {
    throw new ConfigError("SPACT_NETWORK must be sandbox, testnet or mainnet");
  }
  if (network === "mainnet" && env.ENABLE_MAINNET_TRANSFERS !== "true") {
    throw new ConfigError("mainnet moves real funds: set ENABLE_MAINNET_TRANSFERS=true to allow it");
  }

  const rpc = parseUrl(env.SPACT_RPC_URL, "SPACT_RPC_URL");
  if (network !== "sandbox" && rpc.protocol !== "https:") {
    throw new ConfigError("SPACT_RPC_URL must use https outside sandbox");
  }

  const vaultId = parseAccount(env.SPACT_VAULT_ID, "SPACT_VAULT_ID");
  const agentId = parseAccount(env.SPACT_AGENT_ID, "SPACT_AGENT_ID");
  if (agentId === vaultId) throw new ConfigError("SPACT_AGENT_ID must not be the vault");

  const agentKeyFile = env.SPACT_AGENT_KEY_FILE;
  if (!agentKeyFile) throw new ConfigError("SPACT_AGENT_KEY_FILE is required");

  let approvalUrl: string | null = null;
  if (env.SPACT_APPROVAL_URL) {
    const url = parseUrl(env.SPACT_APPROVAL_URL, "SPACT_APPROVAL_URL");
    if (url.search || url.hash) throw new ConfigError("SPACT_APPROVAL_URL must not have a query or fragment");
    approvalUrl = url.toString();
  }

  const explorerTxUrl = env.SPACT_EXPLORER_TX_URL || DEFAULT_EXPLORERS[network];
  if (explorerTxUrl !== null && !explorerTxUrl.includes("{hash}")) {
    throw new ConfigError("SPACT_EXPLORER_TX_URL must contain {hash}");
  }

  return { network, rpcUrl: rpc.toString(), vaultId, agentId, agentKeyFile, approvalUrl, explorerTxUrl };
}

/** The owner's approval page for one request, in the form the web app routes (`?request=<id>`). */
export function reviewLink(config: Pick<McpConfig, "approvalUrl">, requestId: string): string | null {
  if (!config.approvalUrl) return null;
  const url = new URL(config.approvalUrl);
  url.searchParams.set("request", requestId);
  return url.toString();
}

export function explorerTxLink(config: Pick<McpConfig, "explorerTxUrl">, txHash: string): string | null {
  if (!config.explorerTxUrl || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) return null;
  return config.explorerTxUrl.replace("{hash}", txHash);
}
