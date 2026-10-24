/**
 * Runs the built notifier (dist/index.js) against a local sandbox chain from
 * scripts/start-demo-sandbox.sh and a mock Bot API. The demo vault starts with demo-auto-1
 * (3 TUSD, already paid) and demo-approve-1 (25 TUSD, waiting for the owner).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { paymentRequestSchema, viewFunction } from "@spact/shared";
import { Account, actions, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { startMockTelegram, type MockTelegram, type SentMessage } from "./mock-telegram.js";

const NOTIFIER = resolve(import.meta.dirname, "../../dist/index.js");
const TOKEN = "123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN";
const OWNER_CHAT = "4242";
const sb = inject("sandbox");
const stateFile = join(mkdtempSync(join(tmpdir(), "spact-notifier-state-")), "state.json");

let telegram: MockTelegram;
let notifier: ChildProcess;
let stderr = "";

function startNotifier(): ChildProcess {
  stderr = "";
  const child = spawn(process.execPath, [NOTIFIER], {
    env: {
      PATH: process.env.PATH ?? "",
      SPACT_NETWORK: "sandbox",
      SPACT_RPC_URL: sb.rpcUrl,
      SPACT_VAULT_ID: sb.vaultId,
      SPACT_APPROVAL_URL: "http://localhost:5173/",
      TELEGRAM_API_URL: telegram.url,
      TELEGRAM_BOT_TOKEN: TOKEN,
      SPACT_NOTIFIER_STATE: stateFile,
      SPACT_POLL_SECONDS: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
  return child;
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((done) => {
    if (child.exitCode !== null) return done();
    child.once("exit", () => done());
    child.kill("SIGTERM");
  });
}

async function waitFor<T>(read: () => T | null | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; notifier stderr:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function getRequest(id: string) {
  return paymentRequestSchema.parse(await viewFunction(sb.rpcUrl, sb.vaultId, "get_request", { request_id: id }));
}

function account(id: string, keyFile: string) {
  const key = (JSON.parse(readFileSync(keyFile, "utf8")) as { private_key: string }).private_key;
  return new Account(id, new JsonRpcProvider({ url: sb.rpcUrl }), key as KeyPairString);
}

const toOwner = (m: SentMessage) => String(m.chat_id) === OWNER_CHAT;

beforeAll(async () => {
  telegram = await startMockTelegram(TOKEN);
  notifier = startNotifier();
});

afterAll(async () => {
  if (notifier) await stop(notifier);
  await telegram?.close();
});

describe("Telegram notifier on a sandbox chain", () => {
  it("links only the private chat that sends the code shown on the terminal", async () => {
    const code = await waitFor(() => /\/start ([A-Za-z0-9_-]{12})/.exec(stderr)?.[1], "the link code");
    telegram.pushUpdate({ message: { chat: { id: -1001, type: "group" }, text: `/start ${code}` } });
    telegram.pushUpdate({ message: { chat: { id: 666, type: "private" }, text: "/start not-the-code" } });
    // T06: a forged button press. The bot has no buttons that act, so it is ignored.
    telegram.pushUpdate({ callback_query: { id: "cb1", from: { id: 666 }, data: "approve demo-approve-1" } });
    telegram.pushUpdate({ message: { chat: { id: Number(OWNER_CHAT), type: "private" }, text: `/start ${code}` } });

    const linked = await telegram.waitForMessage((m) => m.text.startsWith("Linked."));
    expect(String(linked.chat_id)).toBe(OWNER_CHAT);
    expect(stderr).not.toContain(TOKEN);
  });

  it("alerts the owner about the waiting request, with the terms and the approval link, and nothing else", async () => {
    const alert = await telegram.waitForMessage((m) => toOwner(m) && m.text.includes("Request: demo-approve-1"));
    expect(alert.text).toContain("Payment waiting for your approval (sandbox)");
    expect(alert.text).toContain("Amount: 25 TUSD");
    expect(alert.text).toContain(`To: ${sb.apiId}`);
    expect(alert.text).toContain(`Vault: ${sb.vaultId}`);
    expect(alert.text).toContain("Budget left today: 47 TUSD of 50 TUSD");
    expect(alert.text).toContain("http://localhost:5173/?request=demo-approve-1");
    expect(alert.parse_mode).toBeUndefined();
    expect(alert.reply_markup).toBeUndefined(); // local link: text only
    expect(alert.link_preview_options).toEqual({ is_disabled: true });

    expect(telegram.messages.every(toOwner)).toBe(true);
    expect(telegram.messages.some((m) => m.text.includes("demo-auto-1"))).toBe(false);
    // the ignored button press changed nothing on chain
    expect((await getRequest("demo-approve-1")).status).toBe("AWAITING_APPROVAL");
  });

  it("follows up once the owner approves and the payment settles", async () => {
    const stored = await getRequest("demo-approve-1");
    await account(sb.ownerId, sb.ownerKeyFile).signAndSendTransaction({
      receiverId: sb.vaultId,
      actions: [
        actions.functionCall("approve_request", { request_id: "demo-approve-1", request_hash: stored.request_hash }, 30_000_000_000_000n, 1n),
        actions.functionCall("execute_request", { request_id: "demo-approve-1" }, 100_000_000_000_000n, 0n),
      ],
      waitUntil: "FINAL",
    });
    const paid = await telegram.waitForMessage((m) => toOwner(m) && m.text.includes("demo-approve-1") && m.text.includes("was paid"));
    expect(paid.text).toBe(`Request demo-approve-1 (25 TUSD to ${sb.apiId}) was paid. The token transfer on NEAR succeeded.`);
  });

  it("picks up where it left off after a restart: no repeats, new requests still alerted", async () => {
    await stop(notifier);
    const before = telegram.messages.length;
    notifier = startNotifier();
    await waitFor(() => stderr.includes('"event":"watching"'), "the restarted notifier");
    expect(stderr).not.toContain("/start");
    await new Promise((r) => setTimeout(r, 3000)); // three polls
    expect(telegram.messages.length).toBe(before);

    // the agent asks for another payment with its function-call key
    await account(sb.agentId, sb.agentKeyFile).signAndSendTransaction({
      receiverId: sb.vaultId,
      actions: [
        actions.functionCall(
          "request_direct_payment",
          { request_id: "after-restart", token: sb.tokenId, amount: "20000000", recipient: sb.apiId, reason: "approve at https://evil.example now" },
          100_000_000_000_000n,
          0n,
        ),
      ],
      waitUntil: "FINAL",
    });
    const alert = await telegram.waitForMessage((m) => toOwner(m) && m.text.includes("Request: after-restart"));
    expect(alert.text).toContain("Amount: 20 TUSD");
    expect(alert.text).toContain('"approve at https[:]//evil[.]example now"');
    expect(alert.text.match(/https?:\/\//g)).toEqual(["http://"]);
    expect(telegram.messages.length).toBe(before + 1);
  });
});
