/**
 * Mock Telegram Bot API for tests (the real one is not reachable from CI or the build
 * environment). It speaks the same envelope as Telegram's Bot API server: `{ok, result}` or
 * `{ok: false, error_code, description}`, for sendMessage and getUpdates only.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface SentMessage {
  chat_id: string;
  text: string;
  reply_markup?: unknown;
  link_preview_options?: unknown;
  parse_mode?: unknown;
}

export interface MockTelegram {
  url: string;
  messages: SentMessage[];
  pushUpdate(update: Record<string, unknown>): void;
  waitForMessage(match: (m: SentMessage) => boolean, timeoutMs?: number): Promise<SentMessage>;
  close(): Promise<void>;
}

export async function startMockTelegram(token: string): Promise<MockTelegram> {
  const messages: SentMessage[] = [];
  const updates: Record<string, unknown>[] = [];
  let nextUpdateId = 1;
  let wake: (() => void) | null = null;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        const match = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
        if (!match || match[1] !== token) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;

        if (match[2] === "sendMessage") {
          messages.push(body as unknown as SentMessage);
          return send(200, { ok: true, result: { message_id: messages.length, chat: { id: Number(body.chat_id), type: "private" } } });
        }
        if (match[2] === "getUpdates") {
          const offset = Number(body.offset ?? 0);
          const pending = () => updates.filter((u) => Number(u.update_id) >= offset);
          if (pending().length === 0 && Number(body.timeout ?? 0) > 0) {
            // long poll: answer when an update arrives, or after a short wait to keep tests fast
            await new Promise<void>((resolve) => {
              wake = resolve;
              setTimeout(resolve, 1000);
            });
          }
          return send(200, { ok: true, result: pending() });
        }
        return send(404, { ok: false, error_code: 404, description: "Not Found: method not found" });
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    messages,
    pushUpdate(update) {
      updates.push({ update_id: nextUpdateId++, ...update });
      wake?.();
    },
    async waitForMessage(match, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no matching message; sent so far: ${JSON.stringify(messages.map((m) => m.text.slice(0, 60)))}`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
