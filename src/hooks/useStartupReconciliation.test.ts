import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useStartupReconciliation } from "./useStartupReconciliation";
import type { Id } from "../../convex/_generated/dataModel";

const fakeSessionId = "staff_sessions:abc" as Id<"staff_sessions">;

/**
 * ADR-026 reconciliation-on-reload was downgraded to a no-op (Decision F,
 * ADR-036). The QR Codes API never returns a "paid" status on a poll, so poll-
 * based reconciliation is architecturally impossible. These tests verify the
 * hook mounts without error and does nothing.
 */
describe("useStartupReconciliation (Decision F: no-op shell)", () => {
  it("mounts without error when sessionId is provided", () => {
    const { result } = renderHook(() => useStartupReconciliation(fakeSessionId));
    expect(result.error).toBeUndefined();
  });

  it("mounts without error when sessionId is undefined", () => {
    const { result } = renderHook(() => useStartupReconciliation(undefined));
    expect(result.error).toBeUndefined();
  });

  it("returns undefined (no-op)", () => {
    const { result } = renderHook(() => useStartupReconciliation(fakeSessionId));
    // The hook intentionally returns nothing.
    expect(result.current).toBeUndefined();
  });
});
