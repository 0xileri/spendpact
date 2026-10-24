#!/usr/bin/env node
/**
 * Spact Telegram notifier. Polls one vault over NEAR RPC and messages one Telegram chat when a
 * payment waits for the owner, then again when it is paid, rejected or expires. It holds no NEAR
 * keys and the bot has no buttons that act: approval only happens in the owner's wallet.
 *
 * It uses long polling (getUpdates) only while linking a chat, so there is no webhook to secure.
 * Configuration comes from environment variables; see apps/notifier/README.md.
 */
import { createVaultReader } from "./chain.js";
import { BIND_TTL_MS, bindChat, newBindCode } from "./bind.js";
import { parseConfig } from "./config.js";
import { loadState, saveState } from "./state.js";
import { createTelegram } from "./telegram.js";
import { tick } from "./watcher.js";

/** One JSON line per event on stderr. Never includes the bot token or message text. */
function log(event: Record<string, unknown>) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), ...event }));
}

async function main() {
  const config = parseConfig(process.env);
  const vault = createVaultReader(config);
  const onChain = await vault.config();
  if (onChain.network !== config.network) {
    throw new Error(`the vault is on network "${onChain.network}", not "${config.network}"`);
  }
  const state = loadState(config.stateFile, config.network, config.vaultId);
  const save = (s: typeof state) => saveState(config.stateFile, s);
  const telegram = createTelegram({ apiUrl: config.telegramApiUrl, botToken: config.botToken });

  if (config.chatId && state.chatId !== config.chatId) {
    state.chatId = config.chatId;
    save(state);
  }
  if (!state.chatId) {
    const code = newBindCode();
    console.error(`spact-notifier: to link your Telegram chat, send this to your bot within ${BIND_TTL_MS / 60_000} minutes:\n\n  /start ${code}\n`);
    const { chatId, offset } = await bindChat(telegram, code, Date.now() + BIND_TTL_MS);
    await telegram.getUpdates(offset, 0); // acknowledge, so old updates are not delivered again
    state.chatId = chatId;
    save(state);
    await telegram.sendMessage(
      chatId,
      `Linked. This chat gets Spact alerts for vault ${config.vaultId} on ${config.network}. The bot can only notify; approvals happen in your wallet.`,
    );
    log({ event: "linked", chat: `…${chatId.slice(-3)}` });
  }

  const chatId = state.chatId;
  log({ event: "watching", vault: config.vaultId, network: config.network, poll_ms: config.pollMs });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => process.exit(0));
  for (;;) {
    try {
      await tick({ config, vault, telegram, chatId, state, save, log });
    } catch (e) {
      log({ event: "error", message: e instanceof Error ? e.message.slice(0, 300) : String(e) });
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollMs));
  }
}

main().catch((e: unknown) => {
  console.error(`spact-notifier: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
