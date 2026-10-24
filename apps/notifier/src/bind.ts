import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Telegram } from "./telegram.js";

export const BIND_TTL_MS = 10 * 60_000;

/** One-time code printed only on the terminal that runs the notifier. */
export function newBindCode(): string {
  return randomBytes(9).toString("base64url");
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Waits for "/start <code>" in a private chat with the bot and returns that chat's id. Messages
 * from groups or channels, wrong codes, and every other kind of update are ignored. The challenge
 * starts on the operator's terminal, never from an unauthenticated message (AGENTS.md section 7).
 */
export async function bindChat(
  telegram: Telegram,
  code: string,
  deadlineMs: number,
  now: () => number = Date.now,
): Promise<{ chatId: string; offset: number }> {
  const expected = `/start ${code}`;
  let offset = 0;
  while (now() < deadlineMs) {
    const wait = Math.max(0, Math.min(25, Math.floor((deadlineMs - now()) / 1000)));
    for (const update of await telegram.getUpdates(offset, wait)) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (message?.chat.type !== "private" || typeof message.text !== "string") continue;
      if (sameText(message.text.trim(), expected)) return { chatId: String(message.chat.id), offset };
    }
  }
  throw new Error("no /start message with the code arrived in time; restart the notifier for a new code");
}
