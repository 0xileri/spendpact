import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelegram, TelegramError } from "../src/telegram.js";

const TOKEN = "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function mockFetch(...responses: (Response | Error)[]) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const sentOk = { ok: true, result: { message_id: 7, chat: { id: 42, type: "private" } } };
afterEach(() => vi.unstubAllGlobals());

function client() {
  const sleeps: number[] = [];
  const telegram = createTelegram({
    apiUrl: "http://127.0.0.1:9",
    botToken: TOKEN,
    minSendIntervalMs: 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { telegram, sleeps };
}

describe("sendMessage", () => {
  it("sends plain text with previews off and one URL button", async () => {
    const fetchMock = mockFetch(reply(200, sentOk));
    await client().telegram.sendMessage("42", "hello", "https://approve.example/?request=pay-1");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:9/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "42",
      text: "hello",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "Review in the approval page", url: "https://approve.example/?request=pay-1" }]] },
    });
  });

  it("waits as long as Telegram asks on 429, and backs off on server errors", async () => {
    mockFetch(
      reply(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } }),
      reply(502, { ok: false, error_code: 502, description: "Bad Gateway" }),
      reply(200, sentOk),
    );
    const { telegram, sleeps } = client();
    await telegram.sendMessage("42", "hello");
    expect(sleeps).toEqual([3000, 2000]);
  });

  it("does not retry client errors, and never puts the token in an error", async () => {
    mockFetch(reply(400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }));
    const error = await client()
      .telegram.sendMessage("42", "hello")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TelegramError);
    expect((error as TelegramError).code).toBe(400);
    expect((error as Error).message).toBe("sendMessage failed (400): Bad Request: chat not found");

    mockFetch(new Error(`connect ECONNREFUSED http://127.0.0.1:9/bot${TOKEN}/sendMessage`), new Error("again"), new Error("again"), new Error("again"));
    const network = await client()
      .telegram.sendMessage("42", "hello")
      .catch((e: unknown) => e);
    expect((network as Error).message).toBe("sendMessage: Telegram did not answer");
    expect((network as Error).message).not.toContain(TOKEN);
  });

  it("rejects an answer that is not a sent message", async () => {
    mockFetch(reply(200, { ok: true, result: true }));
    await expect(client().telegram.sendMessage("42", "hello")).rejects.toThrow();
  });
});

describe("getUpdates", () => {
  it("long-polls for messages only and validates the updates", async () => {
    const fetchMock = mockFetch(
      reply(200, { ok: true, result: [{ update_id: 5, message: { chat: { id: 42, type: "private" }, text: "/start abc" } }, { update_id: 6, callback_query: { id: "x" } }] }),
    );
    const updates = await client().telegram.getUpdates(5, 25);
    expect(updates.map((u) => u.update_id)).toEqual([5, 6]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ offset: 5, timeout: 25, allowed_updates: ["message"] });
  });
});
