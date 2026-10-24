import type { PaymentRequest } from "@spact/shared";

import type { VaultReader } from "./chain.js";
import type { NotifierConfig } from "./config.js";
import { approvalMessage, expiredMessage, outcomeMessage } from "./messages.js";
import type { NotifierState } from "./state.js";
import type { Telegram } from "./telegram.js";

const PAGE = 50;
const FINAL = new Set<PaymentRequest["status"]>(["SETTLED", "DENIED", "EXPIRED", "TRANSFER_FAILED"]);

export interface WatcherDeps {
  config: Pick<NotifierConfig, "network" | "vaultId" | "approvalUrl">;
  vault: VaultReader;
  telegram: Telegram;
  chatId: string;
  state: NotifierState;
  save: (state: NotifierState) => void;
  log: (event: Record<string, unknown>) => void;
}

/**
 * One polling pass:
 *  1. alert about new requests that wait for the owner and have not expired by chain time
 *  2. follow up on alerted requests that changed state, or expired by chain time
 * State is saved after every message, so a restart does not repeat alerts. If a send fails, the
 * pass stops there and the next pass retries the same request.
 */
export async function tick(deps: WatcherDeps): Promise<void> {
  const { vault, telegram, chatId, state, save, log } = deps;
  const nowNs = await vault.nowNs();

  // list_requests is newest first, and the vault never removes requests. With `count` stored and
  // `nextIndex` already handled, the new ones are the newest count - nextIndex. The count is read
  // before and after listing: it only grows, so equal reads mean the list was taken at that count.
  const count = (await vault.config()).request_count;
  if (count < state.nextIndex) {
    throw new Error("the vault has fewer requests than the state file has seen; the state belongs to another chain");
  }
  const fresh: PaymentRequest[] = [];
  while (fresh.length < count - state.nextIndex) {
    const page = await vault.listRequests(fresh.length, Math.min(PAGE, count - state.nextIndex - fresh.length));
    if (page.length === 0) break;
    fresh.push(...page);
  }
  if ((await vault.config()).request_count !== count || fresh.length !== count - state.nextIndex) {
    log({ event: "scan_retry", reason: "new requests arrived while listing" });
  } else {
    for (const request of fresh.reverse()) {
      const id = request.request_id;
      if (request.status === "AWAITING_APPROVAL" && nowNs <= BigInt(request.expires_at_ns) && !(id in state.tracked)) {
        const [token, budget] = await Promise.all([vault.tokenMetadata(request.token), vault.budget(request.token)]);
        const { text, buttonUrl } = approvalMessage(deps.config, { request, token, budget, nowNs });
        await telegram.sendMessage(chatId, text, buttonUrl);
        state.tracked[id] = "AWAITING_APPROVAL";
        log({ event: "alert", request_id: id });
      }
      state.nextIndex += 1;
      save(state);
    }
  }

  for (const [id, last] of Object.entries(state.tracked)) {
    if (FINAL.has(last)) continue;
    const request = await vault.getRequest(id);
    // the vault never stores BLOCKED requests; anything else is a state we can report
    if (!request || request.status === "BLOCKED") continue;
    const alreadyExpired = state.expired.includes(id);
    if (request.status !== last) {
      const text = request.status === "EXPIRED" && alreadyExpired ? null : outcomeMessage(request, await vault.tokenMetadata(request.token));
      if (text) await telegram.sendMessage(chatId, text);
      state.tracked[id] = request.status;
      log({ event: "status", request_id: id, status: request.status });
      save(state);
    } else if (!alreadyExpired && (last === "AWAITING_APPROVAL" || last === "APPROVED") && nowNs > BigInt(request.expires_at_ns)) {
      await telegram.sendMessage(chatId, expiredMessage(request, await vault.tokenMetadata(request.token)));
      state.expired.push(id);
      log({ event: "expired", request_id: id });
      save(state);
    }
  }
}
