import { describe, expect, it, vi } from "vitest";

import { bindChat, newBindCode } from "../src/bind.js";
import type { Telegram, Update } from "../src/telegram.js";

function telegramWith(batches: Update[][]) {
  const getUpdates = vi.fn<Telegram["getUpdates"]>(async () => batches.shift() ?? []);
  return { telegram: { sendMessage: vi.fn(async () => {}), getUpdates } satisfies Telegram, getUpdates };
}

const msg = (update_id: number, chat: { id: number; type: string }, text?: string): Update => ({
  update_id,
  message: { chat, ...(text === undefined ? {} : { text }) },
});

describe("bindChat", () => {
  it("binds only a private chat that sends exactly /start <code>", async () => {
    const code = newBindCode();
    expect(code).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const { telegram, getUpdates } = telegramWith([
      [
        msg(10, { id: -100, type: "group" }, `/start ${code}`),
        msg(11, { id: 7, type: "private" }, "/start wrong-code"),
        msg(12, { id: 8, type: "private" }, `/start ${code} extra`),
        { update_id: 13, callback_query: { id: "cb", data: "approve" } } as Update,
        msg(14, { id: 9, type: "private" }),
      ],
      [msg(15, { id: 42, type: "private" }, `  /start ${code}  `)],
    ]);
    await expect(bindChat(telegram, code, Date.now() + 60_000)).resolves.toEqual({ chatId: "42", offset: 16 });
    expect(getUpdates.mock.calls.map((c) => c[0])).toEqual([0, 15]);
  });

  it("gives up when the code expires", async () => {
    let now = 0;
    const telegram: Telegram = {
      sendMessage: async () => {},
      getUpdates: async () => {
        now += 30_000;
        return [];
      },
    };
    await expect(bindChat(telegram, "code", 60_000, () => now)).rejects.toThrow(/in time/);
  });
});
