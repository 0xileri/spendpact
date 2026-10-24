import { formatUnits, parseU128, type FtMetadata } from "@spact/shared";

/** "25 TUSD", or the raw base units when token metadata is unavailable. */
export function formatAmount(units: string, token: FtMetadata | null): string {
  if (!token) return `${units} base units`;
  return `${formatUnits(parseU128(units), token.decimals)} ${token.symbol}`;
}

export function formatRelative(seconds: number): string {
  const abs = Math.abs(seconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const span = h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min` : `${abs} s`;
  return seconds >= 0 ? `in ${span}` : `${span} ago`;
}

/** Nanosecond timestamp string -> "2026-11-02 14:05 UTC". */
export function formatUtc(ns: string): string {
  const ms = Number(parseU128(ns) / 1_000_000n);
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
