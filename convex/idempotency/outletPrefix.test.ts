import { describe, it, expect } from "vitest";
import { assertOutletKeyPrefix } from "./outletPrefix";
import type { Id } from "../_generated/dataModel";

/**
 * Unit tests for the outlet-prefix assertion helper (v2.0 Stream 5).
 *
 * The helper is a pure function — no Convex context, no IDB.
 * Tests exercise all four leniency / rejection paths.
 */

// Fabricate a realistic outlet Id (Convex uses this string format at runtime)
const OUTLET_A = "k17abc1234" as unknown as Id<"outlets">;
const OUTLET_B = "k17xyz9999" as unknown as Id<"outlets">;

describe("assertOutletKeyPrefix", () => {
  it("passes: unprefixed key (no colon separator)", () => {
    // Pre-v2.0 key format has no colon — must never throw during rolling upgrade.
    expect(() =>
      assertOutletKeyPrefix("some-uuid-without-colon", OUTLET_A),
    ).not.toThrow();
  });

  it("passes: key prefix matches session outlet", () => {
    const key = `${OUTLET_A as string}:login:citra:uuid-here`;
    expect(() => assertOutletKeyPrefix(key, OUTLET_A)).not.toThrow();
  });

  it("throws OUTLET_KEY_MISMATCH: key prefix does NOT match session outlet", () => {
    const key = `${OUTLET_B as string}:commitCart:uuid-here`;
    expect(() => assertOutletKeyPrefix(key, OUTLET_A)).toThrow("OUTLET_KEY_MISMATCH");
  });

  it("passes: sessionOutletId is undefined (window session — no outlet to assert)", () => {
    // Window sessions (unstamped pre-v2.0 rows) have outlet_id=undefined.
    const key = `${OUTLET_A as string}:commitCart:uuid-here`;
    expect(() => assertOutletKeyPrefix(key, undefined)).not.toThrow();
  });

  it("passes: key with multiple colons — only the prefix before the FIRST colon is checked", () => {
    // Intent strings like "login:citra:staffId" contain colons too.
    const key = `${OUTLET_A as string}:login:citra:staffId:uuid`;
    expect(() => assertOutletKeyPrefix(key, OUTLET_A)).not.toThrow();
  });

  it("throws OUTLET_KEY_MISMATCH: prefix is an empty string (degenerate ':uuid' key)", () => {
    // If somehow a key starts with ':' the prefix is '' which won't match any outlet id.
    const key = `:uuid-here`;
    expect(() => assertOutletKeyPrefix(key, OUTLET_A)).toThrow("OUTLET_KEY_MISMATCH");
  });

  it("passes: both key is unprefixed AND sessionOutletId is undefined", () => {
    // Fully pre-v2.0 path — both undefined/unprefixed.
    expect(() => assertOutletKeyPrefix("plain-uuid", undefined)).not.toThrow();
  });
});
