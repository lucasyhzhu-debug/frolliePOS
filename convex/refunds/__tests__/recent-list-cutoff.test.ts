import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { wibDayWindow } from "../../lib/time";

/**
 * Q1=B recent-list cutoff: listTodaysRefundable surfaces ONLY transactions paid
 * since 00:00 WIB today. A txn paid 23:59:59 WIB yesterday is intentionally
 * unreachable; one paid 00:00:01 WIB today is reachable.
 *
 * WIB is UTC+7. The boundary is computed via wibDayWindow(Date.now()).dayStartMs,
 * which is the epoch ms for "00:00 WIB today". We seed two paid_at timestamps
 * straddling that boundary by 1s.
 */
describe("listTodaysRefundable WIB-day cutoff", () => {
  it("includes a paid_at at the WIB-day boundary +1s, excludes one at boundary -1s", async () => {
    const t = convexTest(schema);
    const now = Date.now();
    const { dayStartMs } = wibDayWindow(now);

    const { sessionId, todayTxnId } = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
      const staffId = await ctx.db.insert("staff", {
        code: "S-CUT", name: "C", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const sessionId = await ctx.db.insert("staff_sessions", {
        staff_id: staffId, device_id: "d", started_at: Date.now(),
        ended_at: null, end_reason: null, outlet_id: outletId,
      } as any);

      // Yesterday: paid_at = dayStartMs - 1000ms → 23:59:59 WIB yesterday.
      // We must mark created_at < paid_at so the row is consistent. Use a stable
      // older created_at — seed both txns with paid_at-1000 / paid_at-1000.
      await ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId,
        created_at: dayStartMs - 2000,
        paid_at: dayStartMs - 1000,
        receipt_number: "R-YESTERDAY",
        receipt_token: "tok-yesterday",
        outlet_id: outletId,
      } as any);

      // Today: paid_at = dayStartMs + 1000ms → 00:00:01 WIB today.
      const todayTxnId = await ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId,
        created_at: dayStartMs,
        paid_at: dayStartMs + 1000,
        receipt_number: "R-TODAY",
        receipt_token: "tok-today",
        outlet_id: outletId,
      } as any);

      return { sessionId, todayTxnId };
    });

    const list = await t.query(api.refunds.public.listTodaysRefundable, {
      sessionId,
    });

    // Only the today txn should surface.
    expect(list.length).toBe(1);
    expect(list[0]._id).toBe(todayTxnId);
    expect(list[0].receipt_number).toBe("R-TODAY");
  });

  it("excludes a paid_at exactly at dayStartMs - 1 (strict < boundary)", async () => {
    const t = convexTest(schema);
    const { dayStartMs } = wibDayWindow(Date.now());

    const sessionId = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null } as any);
      const staffId = await ctx.db.insert("staff", {
        code: "S-CUT2", name: "C2", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const sId = await ctx.db.insert("staff_sessions", {
        staff_id: staffId, device_id: "d", started_at: Date.now(),
        ended_at: null, end_reason: null, outlet_id: outletId,
      } as any);
      // Right at the previous-day side of the boundary.
      await ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId,
        created_at: dayStartMs - 100,
        paid_at: dayStartMs - 1,
        receipt_number: "R-BOUNDARY",
        receipt_token: "tok-boundary",
        outlet_id: outletId,
      } as any);
      return sId;
    });

    const list = await t.query(api.refunds.public.listTodaysRefundable, {
      sessionId,
    });
    expect(list.length).toBe(0);
  });
});
