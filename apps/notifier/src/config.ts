import { homedir } from "node:os";
import { join } from "node:path";

import { accountId } from "@spact/shared";

export type NetworkId = "sandbox" | "testnet" | "mainnet";

export interface NotifierConfig {
  /** Must match the network string stored in the vault. */
  network: NetworkId;
  rpcUrl: string;
  vaultId: string;
  /** Base URL of the owner approval page; each message links `?request=<id>` on it. */
  approvalUrl: string;
  /** Bot API base URL. Only tests point this somewhere else. */
  telegramApiUrl: string;
  /** Never logged or included in error messages. */
  botToken: string;
  /** The one chat that receives messages. null until bound with /start <code>. */
  chatId: string | null;
  stateFile: string;
  pollMs: number;
}

export class ConfigError extends Error {}

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
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError(`${name} must be http(s)`);
  return url;
}

export function parseConfig(env: Record<string, string | undefined>): NotifierConfig {
  const network = env.SPACT_NETWORK;
  if (network !== "sandbox" && network !== "testnet" && network !== "mainnet") {
    throw new ConfigError("SPACT_NETWORK must be sandbox, testnet or mainnet");
  }
  const rpc = parseUrl(env.SPACT_RPC_URL, "SPACT_RPC_URL");
  if (network !== "sandbox" && rpc.protocol !== "https:") {
    throw new ConfigError("SPACT_RPC_URL must use https outside sandbox");
  }
  const vault = accountId.safeParse(env.SPACT_VAULT_ID);
  if (!vault.success) throw new ConfigError("SPACT_VAULT_ID must be a NEAR account id");

  const approval = parseUrl(env.SPACT_APPROVAL_URL, "SPACT_APPROVAL_URL");
  if (approval.search || approval.hash) throw new ConfigError("SPACT_APPROVAL_URL must not have a query or fragment");
  if (network !== "sandbox" && approval.protocol !== "https:") {
    throw new ConfigError("SPACT_APPROVAL_URL must use https outside sandbox");
  }

  const telegram = parseUrl(env.TELEGRAM_API_URL || "https://api.telegram.org", "TELEGRAM_API_URL");
  if (telegram.protocol !== "https:" && !isLocalHost(telegram)) {
    throw new ConfigError("TELEGRAM_API_URL must use https");
  }

  const botToken = env.TELEGRAM_BOT_TOKEN ?? "";
  // "<bot id>:<secret>"; checked only for shape so a typo fails here, not on the first alert
  if (!/^\d{1,20}:[A-Za-z0-9_-]{20,100}$/.test(botToken)) {
    throw new ConfigError("TELEGRAM_BOT_TOKEN is missing or malformed");
  }

  const chatId = env.TELEGRAM_CHAT_ID || null;
  if (chatId !== null && !/^-?\d{1,20}$/.test(chatId)) throw new ConfigError("TELEGRAM_CHAT_ID must be a numeric chat id");

  const pollSeconds = Number(env.SPACT_POLL_SECONDS ?? "5");
  if (!Number.isFinite(pollSeconds) || pollSeconds < 1 || pollSeconds > 300) {
    throw new ConfigError("SPACT_POLL_SECONDS must be between 1 and 300");
  }

  return {
    network,
    rpcUrl: rpc.toString(),
    vaultId: vault.data,
    approvalUrl: approval.toString(),
    telegramApiUrl: telegram.toString().replace(/\/$/, ""),
    botToken,
    chatId,
    stateFile: env.SPACT_NOTIFIER_STATE || join(homedir(), ".spact", `notifier-${network}-${vault.data}.json`),
    pollMs: Math.round(pollSeconds * 1000),
  };
}

/** The owner's approval page for one request, in the form the web app routes (`?request=<id>`). */
export function reviewLink(config: Pick<NotifierConfig, "approvalUrl">, requestId: string): string {
  const url = new URL(config.approvalUrl);
  url.searchParams.set("request", requestId);
  return url.toString();
}
