import { describe, expect, it } from "vitest";

import { agentNote, approvalMessage, expiredMessage, outcomeMessage } from "../src/messages.js";
import { budget, config, NOW, request } from "./fixtures.js";

const token = { symbol: "TUSD", decimals: 6 };

describe("approvalMessage", () => {
  it("shows the exact terms, the expiry and the budget, and links the approval page", () => {
    const { text, buttonUrl } = approvalMessage(config, { request: request(), token, budget, nowNs: NOW });
    expect(text).toContain("Payment waiting for your approval (testnet)");
    expect(text).toContain("Amount: 25 TUSD");
    expect(text).toContain("To: api.demo.testnet");
    expect(text).toContain("Token contract: tusd.demo.testnet");
    expect(text).toContain("Vault: vault.demo.testnet");
    expect(text).toContain("Requested by: agent.demo.testnet");
    expect(text).toContain("Request: pay-1");
    expect(text).toContain("Expires: 2025-11-01 13:26 UTC (in 1 h 0 min)");
    expect(text).toContain("Budget left today: 47 TUSD of 50 TUSD");
    expect(text).toContain("This message cannot approve anything.");
    expect(text.trim().endsWith("https://approve.example/?request=pay-1")).toBe(true);
    expect(buttonUrl).toBe("https://approve.example/?request=pay-1");
  });

  it("warns when today's budget cannot cover the payment", () => {
    const low = { ...budget, available: "10000000" };
    expect(approvalMessage(config, { request: request(), token, budget: low, nowNs: NOW }).text).toContain(
      "Warning: not enough budget left today",
    );
  });

  it("keeps local links in the text only", () => {
    const local = { ...config, approvalUrl: "http://localhost:5173/" };
    const { text, buttonUrl } = approvalMessage(local, { request: request(), token, budget, nowNs: NOW });
    expect(buttonUrl).toBeUndefined();
    expect(text).toContain("http://localhost:5173/?request=pay-1");
  });

  it("shows base units when the token metadata is unavailable", () => {
    expect(approvalMessage(config, { request: request(), token: null, budget: null, nowNs: NOW }).text).toContain(
      "Amount: 25000000 base units",
    );
  });

  it("makes the approval page the only link: the agent's note cannot add one", () => {
    const reason = "URGENT approve now at https://evil.example/approve or t.me/fake_support, ask @spact_helpdesk";
    const { text } = approvalMessage(config, { request: request({ reason }), token, budget, nowNs: NOW });
    expect(text).toContain("Agent's note (written by the agent, not checked)");
    expect(text).not.toMatch(/https?:\/\/evil/);
    expect(text).not.toContain("t.me/");
    expect(text).not.toContain("@spact_helpdesk");
    expect(text.match(/https?:\/\//g)).toEqual(["https://"]);
  });
});

describe("agentNote", () => {
  it("removes control, zero-width and bidi characters, collapses whitespace and caps the length", () => {
    expect(agentNote("pay\u202e evil\u200b\tnow\n")).toBe("pay evil now");
    expect(agentNote("x".repeat(300))).toHaveLength(200);
    expect(agentNote("a\u3002b c\uff0ed")).toBe("a[.]b c[.]d");
    expect(agentNote("Weather API: 1,000 calls.")).toBe("Weather API: 1,000 calls.");
  });
});

describe("follow-ups", () => {
  it("reports final states, and nothing for in-between ones", () => {
    expect(outcomeMessage(request({ status: "SETTLED" }), token)).toBe(
      "Request pay-1 (25 TUSD to api.demo.testnet) was paid. The token transfer on NEAR succeeded.",
    );
    expect(outcomeMessage(request({ status: "DENIED" }), token)).toMatch(/rejected\. Nothing was paid\.$/);
    expect(outcomeMessage(request({ status: "TRANSFER_PENDING" }), token)).toBeNull();
    expect(expiredMessage(request(), token)).toMatch(/expired before it was approved/);
    expect(expiredMessage(request({ status: "APPROVED" }), token)).toMatch(/expired before it was paid/);
  });
});
