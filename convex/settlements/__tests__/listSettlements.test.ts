import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

describe("settlements.listSettlements", () => {
  it("returns rows newest-first for a valid session", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await t.run(async (ctx) => {
      for (const d of ["2026-06-05", "2026-06-06"]) {
        await ctx.db.insert("pos_settlements", { settlement_key: `settle-${d}`, settlement_date: d, gross_amount: 1, mdr_amount: 0, net_amount: 1, transaction_count: 1, source: "manual", created_at: 1 });
      }
    });
    const rows = await t.query(api.settlements.public.listSettlements, { sessionId });
    expect(rows.map((r) => r.settlement_date)).toEqual(["2026-06-06", "2026-06-05"]);
  });

  it("applies inclusive fromDate/toDate range bounds (each branch)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await t.run(async (ctx) => {
      for (const d of ["2026-06-04", "2026-06-05", "2026-06-06", "2026-06-07"]) {
        await ctx.db.insert("pos_settlements", { settlement_key: `settle-${d}`, settlement_date: d, gross_amount: 1, mdr_amount: 0, net_amount: 1, transaction_count: 1, source: "manual", created_at: 1 });
      }
    });
    // fromDate only (lower bound, inclusive)
    const fromOnly = await t.query(api.settlements.public.listSettlements, { sessionId, fromDate: "2026-06-06" });
    expect(fromOnly.map((r) => r.settlement_date)).toEqual(["2026-06-07", "2026-06-06"]);
    // toDate only (upper bound, inclusive)
    const toOnly = await t.query(api.settlements.public.listSettlements, { sessionId, toDate: "2026-06-05" });
    expect(toOnly.map((r) => r.settlement_date)).toEqual(["2026-06-05", "2026-06-04"]);
    // both bounds (inclusive window)
    const both = await t.query(api.settlements.public.listSettlements, { sessionId, fromDate: "2026-06-05", toDate: "2026-06-06" });
    expect(both.map((r) => r.settlement_date)).toEqual(["2026-06-06", "2026-06-05"]);
  });

  it("rejects an invalid session", async () => {
    const t = convexTest(schema);
    await expect(
      t.query(api.settlements.public.listSettlements, { sessionId: "staff_sessions:nope" as never }),
    ).rejects.toThrow();
  });
});
