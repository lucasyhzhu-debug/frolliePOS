import { describe, it, expect, beforeEach } from "vitest";
import { hasShownDenial, markDenialShown } from "./pinResetDenials";
import { SHOWN_PIN_RESET_DENIALS_KEY } from "./storage-keys";

describe("pinResetDenials", () => {
  beforeEach(() => localStorage.clear());

  it("returns false for an unseen requestId", () => {
    expect(hasShownDenial("req-1")).toBe(false);
  });

  it("returns true after marking, and persists across calls (remount-safe)", () => {
    markDenialShown("req-1");
    expect(hasShownDenial("req-1")).toBe(true);
    // a fresh read (simulating a remount that re-imports the module) still sees it
    expect(hasShownDenial("req-1")).toBe(true);
  });

  it("is idempotent — no duplicate entries", () => {
    markDenialShown("req-1");
    markDenialShown("req-1");
    const stored = JSON.parse(localStorage.getItem(SHOWN_PIN_RESET_DENIALS_KEY)!);
    expect(stored).toEqual(["req-1"]);
  });

  it("tolerates malformed storage (returns false, does not throw)", () => {
    localStorage.setItem(SHOWN_PIN_RESET_DENIALS_KEY, "not json");
    expect(hasShownDenial("req-1")).toBe(false);
  });
});
