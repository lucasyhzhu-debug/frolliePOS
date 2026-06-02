import { describe, it, expect } from "vitest";
import { shouldBlockNavigation } from "../usePathChangeBlocker";

/**
 * Pure-predicate tests for the navigation guard. The hook itself wraps
 * react-router's useBlocker (needs a data router), so the blockable decision
 * is extracted here as a pure function and tested directly.
 *
 * Regression: pressing "Charge" / "Save draft" navigates from /sale to an
 * in-flow /sale/* route. The cart is cleared just before navigating, but the
 * guard's `when` is captured from the prior render, so it was still `true` at
 * navigate time and blocked the in-flow hop — popping the abandon dialog on a
 * legitimate charge. The `allowWithin` prefix short-circuits that regardless of
 * the stale `when`.
 */
describe("shouldBlockNavigation", () => {
  it("never blocks when the guard is off", () => {
    expect(shouldBlockNavigation(false, "/sale", "/history")).toBe(false);
  });

  it("never blocks a same-path navigation", () => {
    expect(shouldBlockNavigation(true, "/sale", "/sale")).toBe(false);
  });

  it("blocks leaving the sale flow with an armed guard", () => {
    expect(shouldBlockNavigation(true, "/sale", "/history")).toBe(true);
    expect(shouldBlockNavigation(true, "/sale", "/")).toBe(true);
    expect(shouldBlockNavigation(true, "/sale", "/mgr/dashboard")).toBe(true);
  });

  it("does NOT block in-flow /sale/* navigation when allowWithin is set (the charge/draft fix)", () => {
    expect(shouldBlockNavigation(true, "/sale", "/sale/charge/txn_123", "/sale/")).toBe(false);
    expect(shouldBlockNavigation(true, "/sale", "/sale/drafts", "/sale/")).toBe(false);
    expect(shouldBlockNavigation(true, "/sale", "/sale/voucher", "/sale/")).toBe(false);
  });

  it("still blocks leaving the flow even when allowWithin is set", () => {
    expect(shouldBlockNavigation(true, "/sale", "/history", "/sale/")).toBe(true);
    expect(shouldBlockNavigation(true, "/sale", "/", "/sale/")).toBe(true);
  });

  it("without allowWithin, preserves the original block-any-path-change behavior (charge.tsx)", () => {
    // charge.tsx relies on its own `when` flip + success-race handling, not the
    // prefix allowance — so the no-allowWithin path must be unchanged.
    expect(shouldBlockNavigation(true, "/sale/charge/x", "/sale/charge/x/success")).toBe(true);
    expect(shouldBlockNavigation(true, "/sale/charge/x", "/sale")).toBe(true);
  });
});
