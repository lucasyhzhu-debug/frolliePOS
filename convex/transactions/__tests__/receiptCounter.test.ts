import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("_allocateReceiptNumber_internal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("first call in new WIB year allocates R-{wibYear}-0001", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 15, 12, 0, 0)));
    const t = convexTest(schema);
    const r = await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {});
    expect(r).toBe("R-2026-0001");
  });

  it("second call increments to NNNN+1", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 15, 12, 0, 0)));
    const t = convexTest(schema);
    await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {});
    const r2 = await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {});
    expect(r2).toBe("R-2026-0002");
  });

  it("staffreview Critical #2 regression: 23:30 WIB Dec 31 still old year; 00:01 WIB Jan 1 new year", async () => {
    const t = convexTest(schema);
    // 23:30 WIB = 16:30 UTC Dec 31 2025 → still WIB year 2025
    vi.setSystemTime(new Date(Date.UTC(2025, 11, 31, 16, 30, 0)));
    const a = await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {});
    expect(a).toBe("R-2025-0001");
    // 00:01 WIB Jan 1 2026 = 17:01 UTC Dec 31 2025 → WIB year flips to 2026
    vi.setSystemTime(new Date(Date.UTC(2025, 11, 31, 17, 1, 0)));
    const b = await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {});
    expect(b).toBe("R-2026-0001");
  });
});
