import { describe, it, expect } from "vitest";
import { assertOutletKeyPrefix } from "./outletPrefix";
import type { Id } from "../_generated/dataModel";

/**
 * Unit tests for the outlet-prefix assertion helper (v2.0 Stream 5).
 *
 * The helper is a pure function — no Convex context, no IDB.
 *
 * Regression anchor: the original helper distinguished prefixed vs legacy keys
 * by "has a colon", but EVERY real key is `"${intent}:${uuid}"` (has a colon),
 * so it read the intent name as the outlet id and threw OUTLET_KEY_MISMATCH on
 * every charge — the 2026-06-23 booth-down incident. These tests use the REAL
 * legacy key shape (`"charge:..."`, `"draft:..."`) to lock that out.
 */

// Fabricate a realistic outlet Id (Convex uses this string format at runtime)
const OUTLET_A = "k17abc1234" as unknown as Id<"outlets">;
const OUTLET_B = "k17xyz9999" as unknown as Id<"outlets">;

describe("assertOutletKeyPrefix", () => {
  it("passes: REAL legacy key shape (intent:uuid — has colons, no sentinel)", () => {
    // This is the exact shape the deployed FE sends. Must never throw.
    expect(() =>
      assertOutletKeyPrefix("charge:sess123:uuid-here", OUTLET_A),
    ).not.toThrow();
    expect(() =>
      assertOutletKeyPrefix("draft:sess123:uuid-here", OUTLET_A),
    ).not.toThrow();
    expect(() =>
      assertOutletKeyPrefix("mgr.assignDeviceOutlet:uuid", OUTLET_A),
    ).not.toThrow();
  });

  it("passes: unprefixed key with no colon at all", () => {
    expect(() =>
      assertOutletKeyPrefix("some-uuid-without-colon", OUTLET_A),
    ).not.toThrow();
  });

  it("passes: sentinel-prefixed key whose outlet matches the session", () => {
    const key = `o:${OUTLET_A as string}:charge:uuid-here`;
    expect(() => assertOutletKeyPrefix(key, OUTLET_A)).not.toThrow();
  });

  it("throws OUTLET_KEY_MISMATCH: sentinel outlet does NOT match the session", () => {
    const key = `o:${OUTLET_B as string}:charge:uuid-here`;
    expect(() => assertOutletKeyPrefix(key, OUTLET_A)).toThrow("OUTLET_KEY_MISMATCH");
  });

  it("passes: sessionOutletId undefined (window session — nothing to assert)", () => {
    const key = `o:${OUTLET_A as string}:charge:uuid-here`;
    expect(() => assertOutletKeyPrefix(key, undefined)).not.toThrow();
  });

  it("passes: sentinel key with extra colons in the intent — only the outlet segment is checked", () => {
    // Intents like "shift:handover:in:complete" contain colons too.
    const key = `o:${OUTLET_A as string}:shift:handover:in:complete:uuid`;
    expect(() => assertOutletKeyPrefix(key, OUTLET_A)).not.toThrow();
  });

  it("passes: sentinel key with no trailing colon (degenerate 'o:outletId')", () => {
    const key = `o:${OUTLET_A as string}`;
    expect(() => assertOutletKeyPrefix(key, OUTLET_A)).not.toThrow();
  });

  it("throws OUTLET_KEY_MISMATCH: sentinel with empty outlet segment ('o::uuid')", () => {
    expect(() => assertOutletKeyPrefix("o::uuid-here", OUTLET_A)).toThrow(
      "OUTLET_KEY_MISMATCH",
    );
  });

  it("passes: both key unprefixed AND sessionOutletId undefined (fully pre-v2.0)", () => {
    expect(() => assertOutletKeyPrefix("plain-uuid", undefined)).not.toThrow();
  });
});
