import { accountId } from "@spact/shared";

export type NetworkId = "sandbox" | "testnet" | "mainnet";

export interface AppConfig {
  network: NetworkId;
  rpcUrl: string;
  /** The only vault this deployment approves payments for. */
  vaultId: string;
  /** Explorer URL template with a `{hash}` placeholder, or null when there is no explorer. */
  explorerTxUrl: string | null;
  /** Local dev signer, sandbox only. */
  devSignerUrl: string | null;
}

export class ConfigError extends Error {}

const DEFAULT_EXPLORERS: Record<NetworkId, string | null> = {
  sandbox: null,
  testnet: "https://testnet.nearblocks.io/txns/{hash}",
  mainnet: "https://nearblocks.io/txns/{hash}",
};

function isLocalHost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

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

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const network = env.VITE_NEAR_NETWORK;
  if (network !== "sandbox" && network !== "testnet" && network !== "mainnet") {
    throw new ConfigError("VITE_NEAR_NETWORK must be sandbox, testnet or mainnet");
  }

  const rpc = parseUrl(env.VITE_NEAR_RPC_URL, "VITE_NEAR_RPC_URL");
  if (network !== "sandbox" && rpc.protocol !== "https:") {
    throw new ConfigError("VITE_NEAR_RPC_URL must use https outside sandbox");
  }

  const vault = accountId.safeParse(env.VITE_VAULT_ID);
  if (!vault.success) throw new ConfigError("VITE_VAULT_ID must be a NEAR account id");

  let devSignerUrl: string | null = null;
  if (env.VITE_DEV_SIGNER_URL) {
    if (network !== "sandbox") {
      throw new ConfigError("VITE_DEV_SIGNER_URL is only allowed with VITE_NEAR_NETWORK=sandbox");
    }
    const url = parseUrl(env.VITE_DEV_SIGNER_URL, "VITE_DEV_SIGNER_URL");
    if (!isLocalHost(url)) throw new ConfigError("VITE_DEV_SIGNER_URL must point at localhost");
    devSignerUrl = url.toString().replace(/\/$/, "");
  }

  const explorerTxUrl = env.VITE_EXPLORER_TX_URL || DEFAULT_EXPLORERS[network];
  if (explorerTxUrl !== null && !explorerTxUrl.includes("{hash}")) {
    throw new ConfigError("VITE_EXPLORER_TX_URL must contain {hash}");
  }

  return { network, rpcUrl: rpc.toString(), vaultId: vault.data, explorerTxUrl, devSignerUrl };
}

export function explorerTxLink(config: AppConfig, txHash: string): string | null {
  if (!config.explorerTxUrl || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(txHash)) return null;
  return config.explorerTxUrl.replace("{hash}", txHash);
}
