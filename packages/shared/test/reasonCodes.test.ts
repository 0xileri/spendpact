import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { REASON_CODES } from "../src/reasonCodes.js";

const RUST_TYPES = fileURLToPath(new URL("../../../contracts/spact-vault/src/types.rs", import.meta.url));

describe("reason codes", () => {
  it("match the contract's ReasonCode::as_str strings exactly", () => {
    const source = readFileSync(RUST_TYPES, "utf8");
    const rust = [...source.matchAll(/ReasonCode::\w+ => "([A-Z_]+)"/g)].map((m) => m[1]);
    expect(rust.length).toBeGreaterThan(20);
    expect(Object.keys(REASON_CODES).sort()).toEqual([...rust].sort());
  });
});
