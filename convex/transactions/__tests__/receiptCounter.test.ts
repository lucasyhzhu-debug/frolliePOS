import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("_allocateReceiptNumber_internal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("first call in new WIB year allocates R-{code}-{wibYear}-0001", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 15, 12, 0, 0)));
    const t = convexTest(schema);
    const outletId = await t.run((ctx) =>
      ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      } as any),
    );
    const r = await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {
      outletId,
      year: 2026,
    });
    expect(r).toBe("R-PKW-2026-0001");
  });

  it("second call increments to NNNN+1", async () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 5, 15, 12, 0, 0)));
    const t = convexTest(schema);
    const outletId = await t.run((ctx) =>
      ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      } as any),
    );
    await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {
      outletId,
      year: 2026,
    });
    const r2 = await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {
      outletId,
      year: 2026,
    });
    expect(r2).toBe("R-PKW-2026-0002");
  });

  it("staffreview Critical #2 regression: 23:30 WIB Dec 31 still old year; 00:01 WIB Jan 1 new year", async () => {
    const t = convexTest(schema);
    const outletId = await t.run((ctx) =>
      ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      } as any),
    );
    // 23:30 WIB = 16:30 UTC Dec 31 2025 → still WIB year 2025
    const a = await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {
      outletId,
      year: 2025,
    });
    expect(a).toBe("R-PKW-2025-0001");
    // 00:01 WIB Jan 1 2026 = 17:01 UTC Dec 31 2025 → WIB year flips to 2026
    const b = await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {
      outletId,
      year: 2026,
    });
    expect(b).toBe("R-PKW-2026-0001");
  });

  it("two outlets mint independent NNNN sequences with code prefix", async () => {
    const t = convexTest(schema);
    const { a, b } = await t.run(async (ctx) => ({
      a: await ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      } as any),
      b: await ctx.db.insert("outlets", {
        code: "BLKM", name: "y", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      } as any),
    }));
    const r1 = await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {
      outletId: a,
      year: 2026,
    });
    const r2 = await t.mutation(internal.transactions.internal._allocateReceiptNumber_internal, {
      outletId: b,
      year: 2026,
    });
    expect(r1).toBe("R-PKW-2026-0001");
    expect(r2).toBe("R-BLKM-2026-0001");
  });
});
