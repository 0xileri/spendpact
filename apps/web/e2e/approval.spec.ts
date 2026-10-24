import { expect, test, type Page } from "@playwright/test";

import { digestInputFromRequest, requestHash, type PaymentRequest } from "@spact/shared";

import { chain, fixture, UNIT } from "./chain.ts";

const f = fixture();
const near = chain(f);

/** Rewrites what the RPC says about one request on its way to the page (a compromised RPC or proxy). */
async function tamperWithRequest(page: Page, requestId: string, forge: (real: PaymentRequest) => PaymentRequest) {
  const rpcOrigin = new URL(f.rpc_url).origin;
  await page.route(
    (url) => url.origin === rpcOrigin,
    async (route) => {
      const body = route.request().postDataJSON() as { method?: string; params?: { method_name?: string; args_base64?: string } } | null;
      if (body?.method !== "query" || body.params?.method_name !== "get_request") return route.continue();
      const args = JSON.parse(Buffer.from(body.params.args_base64 ?? "", "base64").toString("utf8")) as { request_id?: string };
      if (args.request_id !== requestId) return route.continue();
      const response = await route.fetch();
      const json = (await response.json()) as { result: { result: number[] } };
      const real = JSON.parse(Buffer.from(json.result.result).toString("utf8")) as PaymentRequest;
      json.result.result = Array.from(Buffer.from(JSON.stringify(forge(real))));
      await route.fulfill({ response, json });
    },
  );
}

async function openAndConnect(page: Page, requestId: string) {
  await page.goto(`/?request=${requestId}`);
  await expect(page.getByTestId("amount")).toBeVisible();
  await page.getByTestId("connect").click();
  await expect(page.getByTestId("wallet")).toContainText(f.owner_id);
}

test("owner approves and pays the exact request", async ({ page }) => {
  await near.agentRequests("e2e-pay", 12n * UNIT, f.api_id, "Geocoding API credits");
  const before = await near.balance(f.api_id);

  await openAndConnect(page, "e2e-pay");
  await expect(page.getByTestId("amount")).toHaveText("12 TUSD");
  await expect(page.getByTestId("recipient")).toHaveText(f.api_id);
  await expect(page.getByTestId("reason")).toContainText("Geocoding API credits");
  await expect(page.getByTestId("hash-check")).toHaveAttribute("data-ok", "true");

  await page.getByTestId("approve").click();
  await expect(page.getByTestId("phase")).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  await expect(page.getByTestId("phase")).toContainText("approved and paid");
  await expect(page.getByTestId("request-status")).toHaveAttribute("data-status", "SETTLED");

  // The page's claim matches the chain.
  expect((await near.request("e2e-pay"))?.status).toBe("SETTLED");
  expect(await near.balance(f.api_id)).toBe(before + 12n * UNIT);
});

test("owner rejects and nothing moves", async ({ page }) => {
  await near.agentRequests("e2e-reject", 15n * UNIT, f.api_id, "Premium tier, annual");
  const before = await near.balance(f.api_id);

  await openAndConnect(page, "e2e-reject");
  await page.getByTestId("reject").click();
  await expect(page.getByTestId("phase")).toHaveAttribute("data-phase", "done", { timeout: 60_000 });
  await expect(page.getByTestId("request-status")).toHaveAttribute("data-status", "DENIED");

  expect((await near.request("e2e-reject"))?.status).toBe("DENIED");
  expect(await near.balance(f.api_id)).toBe(before);
});

test("altered recipient is caught by the browser's hash check", async ({ page }) => {
  await near.agentRequests("e2e-tamper-a", 11n * UNIT, f.api_id, "Map tiles");
  await tamperWithRequest(page, "e2e-tamper-a", (real) => ({ ...real, recipient: f.mallory_id }));

  await openAndConnect(page, "e2e-tamper-a");
  await expect(page.getByTestId("recipient")).toHaveText(f.mallory_id); // what the attacker shows
  await expect(page.getByTestId("hash-check")).toHaveAttribute("data-ok", "false");
  await expect(page.getByTestId("hash-check")).toContainText("do not approve");
  await expect(page.getByTestId("approve")).toBeDisabled();

  expect((await near.request("e2e-tamper-a"))?.status).toBe("AWAITING_APPROVAL");
});

test("forged terms with a matching forged hash are refused by the vault", async ({ page }) => {
  await near.agentRequests("e2e-tamper-b", 11n * UNIT, f.api_id, "Map tiles");
  const apiBefore = await near.balance(f.api_id);
  // A smarter attacker also recomputes the hash, so the page's check passes...
  await tamperWithRequest(page, "e2e-tamper-b", (real) => {
    const forged = { ...real, recipient: f.mallory_id };
    return { ...forged, request_hash: requestHash(digestInputFromRequest("sandbox", f.vault_id, forged)) };
  });

  await openAndConnect(page, "e2e-tamper-b");
  await expect(page.getByTestId("recipient")).toHaveText(f.mallory_id);
  await expect(page.getByTestId("hash-check")).toHaveAttribute("data-ok", "true");

  // ...but the owner signs the hash of what they saw, and the vault compares it to what it stored.
  await page.getByTestId("approve").click();
  await expect(page.getByTestId("phase")).toHaveAttribute("data-phase", "failed", { timeout: 60_000 });
  await expect(page.getByTestId("phase")).toContainText("HASH_MISMATCH");

  const onChain = await near.request("e2e-tamper-b");
  expect(onChain?.status).toBe("AWAITING_APPROVAL");
  expect(onChain?.recipient).toBe(f.api_id);
  expect(await near.balance(f.mallory_id)).toBe(0n);
  expect(await near.balance(f.api_id)).toBe(apiBefore);
});

test("an account that is not the owner cannot decide", async ({ page }) => {
  // just over the 10 TUSD auto limit, so it waits for the owner
  await near.agentRequests("e2e-not-owner", 10n * UNIT + 1n, f.api_id, "Small top-up");
  // Pretend the connected wallet is the agent's.
  await page.route("http://127.0.0.1:8799/account", (route) => route.fulfill({ json: { accountId: f.agent_id } }));

  await page.goto("/?request=e2e-not-owner");
  await page.getByTestId("connect").click();
  await expect(page.getByTestId("problems")).toContainText(`only the owner ${f.owner_id} can decide`);
  await expect(page.getByTestId("approve")).toBeDisabled();
  await expect(page.getByTestId("reject")).toBeDisabled();
});

test("links for another vault are refused", async ({ page }) => {
  await page.goto(`/?vault=evil.test.near&request=${f.demo_request_id}`);
  await expect(page.getByText("This link is for a different vault")).toBeVisible();
  await expect(page.getByTestId("amount")).toHaveCount(0);
});

test("open requests are listed and link to their approval page", async ({ page }) => {
  await page.goto("/");
  const list = page.getByTestId("pending-list");
  await expect(list).toContainText(f.demo_request_id);
  await list.getByText(f.demo_request_id).click();
  await expect(page.getByTestId("amount")).toHaveText("25 TUSD");
});
