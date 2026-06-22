/**
 * outlet-scope.test.ts
 *
 * Cross-outlet denial: a session from outlet A should only see outlet A's
 * transactions when querying listDayTransactions / dashboardSummary.
 *
 * Tests the by_outlet_status_paid_at migration in _fetchDayWindow_internal.
 */
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { wibDayWindow } from "../../lib/time";
import type { Id } from "../../_generated/dataModel";

async function seedOutlet(
  t: ReturnType<typeof convexTest>,
  code: string,
): Promise<Id<"outlets">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("outlets", {
      code,
      name: code,
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    } as any),
  );
}

async function seedStaff(
  t: ReturnType<typeof convexTest>,
  args: { name: string; role: "staff" | "manager"; code: string },
): Promise<Id<"staff">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("staff", {
      name: args.name,
      code: args.code,
      pin_hash: "x",
      role: args.role,
      active: true,
      created_at: Date.now(),
    } as any),
  );
}

async function seedSessionWithOutlet(
  t: ReturnType<typeof convexTest>,
  staffId: Id<"staff">,
  outletId: Id<"outlets">,
): Promise<Id<"staff_sessions">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: "d1",
      started_at: 0,
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    } as any),
  );
}

async function seedPaidTxnForOutlet(
  t: ReturnType<typeof convexTest>,
  args: { staffId: Id<"staff">; outletId: Id<"outlets">; total: number; paidAt: number },
): Promise<Id<"pos_transactions">> {
  return await t.run(async (ctx) => {
    const txnId = await ctx.db.insert("pos_transactions", {
      status: "paid",
      subtotal: args.total,
      voucher_discount: 0,
      total: args.total,
      flags: 0,
      staff_id: args.staffId,
      created_at: args.paidAt,
      paid_at: args.paidAt,
      outlet_id: args.outletId,
    } as any);
    const productId = await ctx.db.insert("pos_products", {
      sku_family: "x",
      code: `X_${args.total}`,
      name: "X",
      pack_label: "1pc",
      price_idr: args.total,
      active: true,
      sort_order: 1,
      tax_rate: 0,
      created_at: 0,
      updated_at: 0,
      outlet_id: args.outletId,
    } as any);
    await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txnId,
      product_id: productId,
      product_code_snapshot: `X_${args.total}`,
      product_name_snapshot: "X",
      unit_price_snapshot: args.total,
      tax_rate_snapshot: 0,
      qty: 1,
      line_subtotal: args.total,
      outlet_id: args.outletId,
    } as any);
    return txnId;
  });
}

describe("outlet-scope isolation", () => {
  it("listDayTransactions: session A only sees outlet A txns, not outlet B", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "AAA");
    const outletB = await seedOutlet(t, "BBB");

    const staffA = await seedStaff(t, { name: "StaffA", role: "manager", code: "SA" });
    const staffB = await seedStaff(t, { name: "StaffB", role: "manager", code: "SB" });

    const sessionA = await seedSessionWithOutlet(t, staffA, outletA);

    const todayWin = wibDayWindow(Date.now());
    const paidAt = todayWin.dayStartMs + 3_600_000;

    await seedPaidTxnForOutlet(t, { staffId: staffA, outletId: outletA, total: 10_000, paidAt });
    await seedPaidTxnForOutlet(t, { staffId: staffB, outletId: outletB, total: 20_000, paidAt });

    const result = await t.query(api.transactions.public.listDayTransactions, {
      sessionId: sessionA,
    });

    // Only outlet A's txn (10_000) should appear
    expect(result).toHaveLength(1);
    expect(result[0].total).toBe(10_000);
  });

  it("dashboardSummary: session A only aggregates outlet A sales", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "CCC");
    const outletB = await seedOutlet(t, "DDD");

    const staffA = await seedStaff(t, { name: "MgrA", role: "manager", code: "MA" });
    const staffB = await seedStaff(t, { name: "MgrB", role: "manager", code: "MB" });

    const sessionA = await seedSessionWithOutlet(t, staffA, outletA);

    const todayWin = wibDayWindow(Date.now());
    const paidAt = todayWin.dayStartMs + 3_600_000;

    await seedPaidTxnForOutlet(t, { staffId: staffA, outletId: outletA, total: 15_000, paidAt });
    await seedPaidTxnForOutlet(t, { staffId: staffB, outletId: outletB, total: 25_000, paidAt });

    const summary = await t.query(api.transactions.public.dashboardSummary, {
      sessionId: sessionA,
    });

    // Only outlet A's sale (15_000) counted; outlet B (25_000) excluded
    expect(summary.gross).toBe(15_000);
    expect(summary.count).toBe(1);
  });
});
