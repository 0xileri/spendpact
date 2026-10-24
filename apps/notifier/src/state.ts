import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

const STATUSES = ["AWAITING_APPROVAL", "APPROVED", "DENIED", "EXPIRED", "TRANSFER_PENDING", "SETTLED", "TRANSFER_FAILED"] as const;

const stateSchema = z.object({
  version: z.literal(1),
  network: z.string(),
  vaultId: z.string(),
  /** The bound chat. Set once by /start <code> (or TELEGRAM_CHAT_ID). */
  chatId: z.string().regex(/^-?\d{1,20}$/).nullable(),
  /** How many of the vault's requests (in list_requests order) have been looked at. */
  nextIndex: z.number().int().nonnegative(),
  /** Requests the owner was alerted about, with the last state they were told about. */
  tracked: z.record(z.string().max(64), z.enum(STATUSES)),
  /** Open requests already reported as expired by chain time. */
  expired: z.array(z.string().max(64)).default([]),
});
export type NotifierState = z.infer<typeof stateSchema>;

export class StateError extends Error {}

export function loadState(path: string, network: string, vaultId: string): NotifierState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { version: 1, network, vaultId, chatId: null, nextIndex: 0, tracked: {}, expired: [] };
  }
  const parsed = stateSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new StateError(`${path} is not a notifier state file`);
  if (parsed.data.network !== network || parsed.data.vaultId !== vaultId) {
    throw new StateError(`${path} belongs to ${parsed.data.vaultId} on ${parsed.data.network}; use another SPACT_NOTIFIER_STATE`);
  }
  return parsed.data;
}

/** Writes atomically (temp file + rename), readable only by the owner of the process. */
export function saveState(path: string, state: NotifierState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
