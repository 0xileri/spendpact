/**
 * Minimal NEAR JSON-RPC client for read-only calls. Responses are untrusted: callers validate the
 * decoded JSON with the schemas in @spact/shared.
 */

import { parseAccessKeyPermission, type AccessKeyPermission } from "./schemas.js";

export class RpcError extends Error {
  constructor(
    message: string,
    /** Contract-level error text (e.g. a panic message), when the RPC reported one. */
    readonly contractError?: string,
    /** The RPC's error cause name, e.g. UNKNOWN_ACCESS_KEY. */
    readonly causeName?: string,
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBase64Utf8(text: string): string {
  let binary = "";
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function call(rpcUrl: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "spact", method, params }),
  });
  if (!res.ok) throw new RpcError(`RPC returned HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body)) throw new RpcError("RPC returned a non-object response");
  if (body.error !== undefined) {
    const err = isRecord(body.error) ? body.error : {};
    const detail = typeof err.data === "string" ? err.data : JSON.stringify(err.cause ?? err.message ?? err);
    const causeName = isRecord(err.cause) && typeof err.cause.name === "string" ? err.cause.name : undefined;
    throw new RpcError(`RPC error: ${detail}`, typeof err.data === "string" ? err.data : undefined, causeName);
  }
  return body.result;
}

/** Calls a contract view method and returns its decoded JSON result. */
export async function viewFunction(
  rpcUrl: string,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await call(rpcUrl, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: methodName,
    args_base64: toBase64Utf8(JSON.stringify(args)),
  });
  if (isRecord(result) && typeof result.error === "string") {
    throw new RpcError(`${methodName} failed`, result.error);
  }
  if (!isRecord(result) || !Array.isArray(result.result)) {
    throw new RpcError(`${methodName}: unexpected RPC response shape`);
  }
  const raw = result.result;
  if (!raw.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new RpcError(`${methodName}: result is not a byte array`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(raw as number[]));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RpcError(`${methodName}: result is not JSON`);
  }
}

/** Permission of one access key, or null when the account has no such key. */
export async function viewAccessKey(
  rpcUrl: string,
  accountId: string,
  publicKey: string,
): Promise<AccessKeyPermission | null> {
  let result: unknown;
  try {
    result = await call(rpcUrl, "query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
  } catch (e) {
    if (e instanceof RpcError && e.causeName === "UNKNOWN_ACCESS_KEY") return null;
    throw e;
  }
  // older nodes report a missing key as a result with an error string
  if (isRecord(result) && typeof result.error === "string") {
    if (/does not exist|never been observed/i.test(result.error)) return null;
    throw new RpcError("view_access_key failed", result.error);
  }
  if (!isRecord(result) || !("permission" in result)) {
    throw new RpcError("view_access_key: unexpected RPC response shape");
  }
  return parseAccessKeyPermission(result.permission);
}

/** Timestamp of the latest final block, in nanoseconds. Used instead of the local clock. */
export async function finalBlockTimestampNs(rpcUrl: string): Promise<bigint> {
  const result = await call(rpcUrl, "block", { finality: "final" });
  const header = isRecord(result) && isRecord(result.header) ? result.header : null;
  const ts = header?.timestamp_nanosec;
  if (typeof ts !== "string" || !/^\d+$/.test(ts)) {
    throw new RpcError("block header has no timestamp_nanosec");
  }
  return BigInt(ts);
}
