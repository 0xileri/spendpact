import { describe, expect, it } from "vitest";

import type { NotifierState } from "../src/state.js";
import { tick } from "../src/watcher.js";
import { config, emptyState, fakeTelegram, fakeVault, NOW, request } from "./fixtures.js";

function setup(requests = [request({ request_id: "auto-1", status: "SETTLED", reason_code: "SETTLED" }), request()]) {
  const vault = fakeVault(requests);
  const { telegram, sent } = fakeTelegram();
  const state = emptyState();
  const saved: NotifierState[] = [];
  const run = () => tick({ config, vault, telegram, chatId: "42", state, save: (s) => saved.push(structuredClone(s)), log: () => {} });
  return { requests, vault, telegram, sent, state, saved, run };
}

describe("tick", () => {
  it("alerts once about a request waiting for approval, and not about paid ones", async () => {
    const t = setup();
    await t.run();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]?.chatId).toBe("42");
    expect(t.sent[0]?.text).toContain("Request: pay-1");
    expect(t.state).toMatchObject({ nextIndex: 2, tracked: { "pay-1": "AWAITING_APPROVAL" } });
    await t.run();
    expect(t.sent).toHaveLength(1);
  });

  it("follows up when the request is paid, then stops", async () => {
    const t = setup();
    await t.run();
    Object.assign(t.requests[1] ?? {}, { status: "TRANSFER_PENDING" });
    await t.run();
    expect(t.sent).toHaveLength(1);
    Object.assign(t.requests[1] ?? {}, { status: "SETTLED", approved_by: "owner.demo.testnet" });
    await t.run();
    await t.run();
    expect(t.sent.map((m) => m.text)).toEqual([expect.stringContaining("waiting for your approval"), expect.stringMatching(/was paid/)]);
    expect(t.state.tracked["pay-1"]).toBe("SETTLED");
  });

  it("says so once when a request expires by chain time, and not again when it is marked EXPIRED", async () => {
    const t = setup();
    await t.run();
    t.vault.setNow(NOW + 3_600_000_000_001n);
    await t.run();
    await t.run();
    Object.assign(t.requests[1] ?? {}, { status: "EXPIRED", reason_code: "REQUEST_EXPIRED" });
    await t.run();
    expect(t.sent.map((m) => m.text)).toEqual([expect.stringContaining("waiting"), expect.stringMatching(/expired before it was approved/)]);
  });

  it("alerts about requests that arrive after earlier passes, oldest first", async () => {
    const t = setup();
    await t.run();
    t.requests.push(request({ request_id: "pay-2" }), request({ request_id: "auto-2", status: "SETTLED" }), request({ request_id: "pay-3" }));
    await t.run();
    expect(t.sent.map((m) => /Request: (\S+)/.exec(m.text)?.[1])).toEqual(["pay-1", "pay-2", "pay-3"]);
    expect(t.state.nextIndex).toBe(5);
  });

  it("leaves the scan for the next pass when a request lands while listing", async () => {
    const t = setup();
    const config = t.vault.config.bind(t.vault);
    let calls = 0;
    t.vault.config = async () => {
      const c = await config();
      return calls++ === 1 ? { ...c, request_count: c.request_count + 1 } : c;
    };
    await t.run();
    expect(t.sent).toHaveLength(0);
    expect(t.state.nextIndex).toBe(0);
    await t.run();
    expect(t.sent).toHaveLength(1);
  });

  it("refuses a state file that has seen more requests than the vault holds", async () => {
    const t = setup();
    t.state.nextIndex = 5;
    await expect(t.run()).rejects.toThrow(/another chain/);
  });

  it("does not alert about requests that already expired when first seen", async () => {
    const t = setup([request({ expires_at_ns: (NOW - 1n).toString() })]);
    await t.run();
    expect(t.sent).toHaveLength(0);
    expect(t.state.nextIndex).toBe(1);
  });

  it("retries a failed send on the next pass, without skipping the request", async () => {
    const t = setup();
    t.telegram.sendMessage.mockRejectedValueOnce(new Error("sendMessage failed (502)"));
    await expect(t.run()).rejects.toThrow(/502/);
    expect(t.state).toMatchObject({ nextIndex: 1, tracked: {} });
    await t.run();
    expect(t.sent).toHaveLength(1);
    expect(t.state.nextIndex).toBe(2);
  });

  it("does not repeat alerts after a restart with saved state", async () => {
    const t = setup();
    await t.run();
    const restored = structuredClone(t.saved.at(-1)) as NotifierState;
    const again = fakeTelegram();
    await tick({ config, vault: t.vault, telegram: again.telegram, chatId: "42", state: restored, save: () => {}, log: () => {} });
    expect(again.sent).toHaveLength(0);
  });
});
