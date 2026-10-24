import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfig, reviewLink } from "../src/config.js";
import { loadState, saveState } from "../src/state.js";

const base = {
  SPACT_NETWORK: "testnet",
  SPACT_RPC_URL: "https://rpc.example",
  SPACT_VAULT_ID: "vault.demo.testnet",
  SPACT_APPROVAL_URL: "https://approve.example/",
  TELEGRAM_BOT_TOKEN: "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

describe("parseConfig", () => {
  it("reads a testnet setup with defaults", () => {
    const cfg = parseConfig(base);
    expect(cfg).toMatchObject({
      network: "testnet",
      vaultId: "vault.demo.testnet",
      telegramApiUrl: "https://api.telegram.org",
      chatId: null,
      pollMs: 5000,
    });
    expect(cfg.stateFile).toMatch(/\.spact\/notifier-testnet-vault\.demo\.testnet\.json$/);
    expect(reviewLink(cfg, "pay:1")).toBe("https://approve.example/?request=pay%3A1");
  });

  it("refuses unsafe or malformed setups", () => {
    expect(() => parseConfig({ ...base, SPACT_NETWORK: "devnet" })).toThrow(/SPACT_NETWORK/);
    expect(() => parseConfig({ ...base, SPACT_RPC_URL: "http://rpc.example" })).toThrow(/https/);
    expect(() => parseConfig({ ...base, SPACT_APPROVAL_URL: "http://approve.example/" })).toThrow(/APPROVAL_URL must use https/);
    expect(() => parseConfig({ ...base, SPACT_APPROVAL_URL: "https://a.example/?request=x" })).toThrow(/query/);
    expect(() => parseConfig({ ...base, TELEGRAM_API_URL: "http://telegram.example" })).toThrow(/TELEGRAM_API_URL/);
    expect(parseConfig({ ...base, TELEGRAM_API_URL: "http://127.0.0.1:8081/" }).telegramApiUrl).toBe("http://127.0.0.1:8081");
    expect(() => parseConfig({ ...base, TELEGRAM_BOT_TOKEN: "" })).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => parseConfig({ ...base, TELEGRAM_BOT_TOKEN: "not a token" })).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => parseConfig({ ...base, TELEGRAM_CHAT_ID: "@me" })).toThrow(/TELEGRAM_CHAT_ID/);
    expect(() => parseConfig({ ...base, SPACT_POLL_SECONDS: "0" })).toThrow(/SPACT_POLL_SECONDS/);
  });

  it("allows local links only in sandbox", () => {
    const local = { ...base, SPACT_NETWORK: "sandbox", SPACT_RPC_URL: "http://127.0.0.1:3030", SPACT_APPROVAL_URL: "http://localhost:5173/" };
    expect(parseConfig(local).approvalUrl).toBe("http://localhost:5173/");
  });
});

describe("state file", () => {
  it("round-trips, is private, and refuses another vault's file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "spact-notifier-")), "nested", "state.json");
    const state = loadState(path, "testnet", "vault.demo.testnet");
    expect(state).toEqual({ version: 1, network: "testnet", vaultId: "vault.demo.testnet", chatId: null, nextIndex: 0, tracked: {}, expired: [] });
    saveState(path, { ...state, chatId: "42", nextIndex: 3, tracked: { "pay-1": "SETTLED" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadState(path, "testnet", "vault.demo.testnet")).toMatchObject({ chatId: "42", nextIndex: 3 });
    expect(() => loadState(path, "testnet", "other.demo.testnet")).toThrow(/belongs to vault.demo.testnet/);
    expect(JSON.parse(readFileSync(path, "utf8"))).not.toHaveProperty("botToken");
  });
});
