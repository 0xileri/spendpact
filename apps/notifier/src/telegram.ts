/**
 * Minimal Telegram Bot API client: sendMessage and getUpdates only.
 *
 * Shapes follow Telegram's Bot API server source (tdlib/telegram-bot-api): every reply is
 * `{ok: true, result}` or `{ok: false, error_code, description, parameters?: {retry_after}}`,
 * and flood control answers 429 with `parameters.retry_after` in seconds.
 * The bot token is part of the request URL, so no error message here ever includes the URL.
 */
import { z } from "zod";

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

const errorEnvelope = z.object({
  ok: z.literal(false),
  error_code: z.number().int(),
  description: z.string().max(1000).optional(),
  parameters: z.object({ retry_after: z.number().int().nonnegative().optional() }).loose().optional(),
});

const chat = z.object({ id: z.number().int(), type: z.string() }).loose();
/** The update fields the notifier reads. Anything else (callback queries, edits, ...) is ignored. */
const update = z
  .object({
    update_id: z.number().int(),
    message: z.object({ chat, text: z.string().max(4096).optional() }).loose().optional(),
  })
  .loose();
export type Update = z.infer<typeof update>;

const sentMessage = z.object({ message_id: z.number().int(), chat }).loose();

export interface TelegramOptions {
  apiUrl: string;
  botToken: string;
  /** Minimum gap between sends, to stay well inside Telegram's flood limits. */
  minSendIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export interface Telegram {
  sendMessage(chatId: string, text: string, buttonUrl?: string): Promise<void>;
  getUpdates(offset: number, timeoutSec: number): Promise<Update[]>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createTelegram(options: TelegramOptions): Telegram {
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 4;
  const minGap = options.minSendIntervalMs ?? 1100;
  let lastSend = 0;

  async function call(method: string, body: object, timeoutMs: number): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      let status: number;
      let json: unknown;
      try {
        const res = await fetch(`${options.apiUrl}/bot${options.botToken}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        json = await res.json().catch(() => null);
      } catch {
        // network error or timeout; the message could carry the URL, so it is dropped
        if (attempt >= maxAttempts) throw new TelegramError(`${method}: Telegram did not answer`, null);
        await sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
      const record = json as { ok?: unknown; result?: unknown } | null;
      if (status === 200 && record?.ok === true) return record.result;

      const err = errorEnvelope.safeParse(json);
      const code = err.success ? err.data.error_code : status;
      const description = err.success ? (err.data.description ?? "") : `HTTP ${status}`;
      const retryAfter = err.success ? err.data.parameters?.retry_after : undefined;
      const retryable = code === 429 || code >= 500;
      if (!retryable || attempt >= maxAttempts) {
        throw new TelegramError(`${method} failed (${code}): ${description.slice(0, 200)}`, code);
      }
      await sleep(code === 429 && retryAfter !== undefined ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** (attempt - 1));
    }
  }

  return {
    async sendMessage(chatId, text, buttonUrl) {
      const wait = lastSend + minGap - Date.now();
      if (wait > 0) await sleep(wait);
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text,
        // plain text: no parse_mode, so nothing in the message can turn into formatting or hidden links
        link_preview_options: { is_disabled: true },
      };
      if (buttonUrl) body.reply_markup = { inline_keyboard: [[{ text: "Review in the approval page", url: buttonUrl }]] };
      try {
        sentMessage.parse(await call("sendMessage", body, 15_000));
      } finally {
        lastSend = Date.now();
      }
    },

    async getUpdates(offset, timeoutSec) {
      const result = await call(
        "getUpdates",
        { offset, timeout: timeoutSec, allowed_updates: ["message"] },
        (timeoutSec + 10) * 1000,
      );
      return z.array(update).parse(result);
    },
  };
}
