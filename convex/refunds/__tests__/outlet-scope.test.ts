/**
 * outlet-scope.test.ts — v2.0 Stream 5 chunk C
 *
 * Cross-outlet isolation for refunds module:
 *   1. listTodaysRefundable: outlet A session sees only outlet A paid txns.
 *   2. listPendingSettlement: outlet A session sees only outlet A pending refunds.
 *   3. _commitRefund_internal stamps the txn's outlet_id onto the new refund row.
 */
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { wibDayWindow } from "../../lib/time";
import type { Id } from "../../_generated/dataModel";

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedOutlet(
  t: ReturnType<typeof convexTest>,
  code: string,
): Promise<Id<"outlets">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("outlets", { is_open: false,
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
  deviceId = "dev-test",
): Promise<Id<"staff_sessions">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: deviceId,
      started_at: 0,
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    } as any),
  );
}

/**
 * Seed a paid txn for an outlet with a receipt_token so the cache-purge step
 * inside _commitRefund_internal doesn't blow up.
 */
async function seedPaidTxnForOutlet(
  t: ReturnType<typeof convexTest>,
  args: {
    staffId: Id<"staff">;
    outletId: Id<"outlets">;
    total: number;
    paidAt?: number;
    productCode?: string;
  },
): Promise<{ txnId: Id<"pos_transactions">; lineId: Id<"pos_transaction_lines"> }> {
  return await t.run(async (ctx) => {
    const paidAt = args.paidAt ?? Date.now();
    const code = args.productCode ?? `P_${args.total}_${args.outletId}`;
    const productId = await ctx.db.insert("pos_products", {
      sku_family: "dubai",
      code,
      name: "Dubai 1pc",
      pack_label: "1pc",
      price_idr: args.total,
      active: true,
      sort_order: 0,
      tax_rate: 0,
      created_at: 0,
      updated_at: 0,
      outlet_id: args.outletId,
    } as any);
    const txnId = await ctx.db.insert("pos_transactions", {
      status: "paid",
      subtotal: args.total,
      voucher_discount: 0,
      total: args.total,
      flags: 0,
      staff_id: args.staffId,
      created_at: paidAt,
      paid_at: paidAt,
      receipt_number: `R-${code}-001`,
      receipt_token: `tok-${code}`,
      outlet_id: args.outletId,
    } as any);
    const lineId = await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txnId,
      product_id: productId,
      product_code_snapshot: code,
      product_name_snapshot: "Dubai 1pc",
      unit_price_snapshot: args.total,
      tax_rate_snapshot: 0,
      qty: 1,
      line_subtotal: args.total,
      outlet_id: args.outletId,
    } as any);
    return { txnId, lineId };
  });
}

async function seedPendingRefundForOutlet(
  t: ReturnType<typeof convexTest>,
  args: {
    txnId: Id<"pos_transactions">;
    lineId: Id<"pos_transaction_lines">;
    outletId: Id<"outlets">;
    staffId: Id<"staff">;
    mgrId: Id<"staff">;
    total: number;
  },
): Promise<Id<"pos_refunds">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("pos_refunds", {
      transaction_id: args.txnId,
      lines: [{ line_id: args.lineId, qty: 1, refund_amount: args.total }],
      total_refund: args.total,
      reason: "test",
      requested_by: args.staffId,
      approver_id: args.mgrId,
      approval_source: "booth_inline",
      settlement_status: "pending",
      created_at: Date.now(),
      outlet_id: args.outletId,
    } as any),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refunds outlet-scope isolation", () => {
  it("listTodaysRefundable: session A only sees outlet A paid txns", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "REFA");
    const outletB = await seedOutlet(t, "REFB");

    const staffA = await seedStaff(t, { name: "StaffA", role: "manager", code: "RSA" });
    const staffB = await seedStaff(t, { name: "StaffB", role: "manager", code: "RSB" });

    const sessionA = await seedSessionWithOutlet(t, staffA, outletA);

    const todayWin = wibDayWindow(Date.now());
    const paidAt = todayWin.dayStartMs + 3_600_000;

    // Txn in outlet A (total 11_000) and outlet B (total 22_000)
    await seedPaidTxnForOutlet(t, {
      staffId: staffA,
      outletId: outletA,
      total: 11_000,
      paidAt,
      productCode: "PA1",
    });
    await seedPaidTxnForOutlet(t, {
      staffId: staffB,
      outletId: outletB,
      total: 22_000,
      paidAt,
      productCode: "PB1",
    });

    const result = await t.query(api.refunds.public.listTodaysRefundable, {
      sessionId: sessionA,
    });

    // Only outlet A's txn (11_000) — not outlet B's (22_000)
    expect(result).toHaveLength(1);
    expect(result[0].total).toBe(11_000);
  });

  it("listPendingSettlement: session A only sees outlet A pending refunds", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "REFC");
    const outletB = await seedOutlet(t, "REFD");

    const mgrA = await seedStaff(t, { name: "MgrA", role: "manager", code: "RMA" });
    const mgrB = await seedStaff(t, { name: "MgrB", role: "manager", code: "RMB" });
    const staffA = await seedStaff(t, { name: "StaffA", role: "staff", code: "RSC" });
    const staffB = await seedStaff(t, { name: "StaffB", role: "staff", code: "RSD" });

    const sessionA = await seedSessionWithOutlet(t, mgrA, outletA, "dev-mgr-a");

    const todayWin = wibDayWindow(Date.now());
    const paidAt = todayWin.dayStartMs + 7_200_000;

    const { txnId: txnA, lineId: lineA } = await seedPaidTxnForOutlet(t, {
      staffId: staffA,
      outletId: outletA,
      total: 30_000,
      paidAt,
      productCode: "PC1",
    });
    const { txnId: txnB, lineId: lineB } = await seedPaidTxnForOutlet(t, {
      staffId: staffB,
      outletId: outletB,
      total: 40_000,
      paidAt,
      productCode: "PD1",
    });

    // Pending refund in each outlet
    await seedPendingRefundForOutlet(t, {
      txnId: txnA,
      lineId: lineA,
      outletId: outletA,
      staffId: staffA,
      mgrId: mgrA,
      total: 30_000,
    });
    await seedPendingRefundForOutlet(t, {
      txnId: txnB,
      lineId: lineB,
      outletId: outletB,
      staffId: staffB,
      mgrId: mgrB,
      total: 40_000,
    });

    const result = await t.query(api.refunds.public.listPendingSettlement, {
      sessionId: sessionA,
    });

    // Only outlet A's pending refund (30_000) — not outlet B's (40_000)
    expect(result).toHaveLength(1);
    expect(result[0].total_refund).toBe(30_000);
  });

  it("_commitRefund_internal stamps txn outlet_id onto the new refund row", async () => {
    const t = convexTest(schema);

    const outletA = await seedOutlet(t, "REFE");

    const mgr = await seedStaff(t, { name: "Mgr", role: "manager", code: "RME" });
    const staff = await seedStaff(t, { name: "Staff", role: "staff", code: "RSE" });

    const todayWin = wibDayWindow(Date.now());
    const paidAt = todayWin.dayStartMs + 1_000;

    const { txnId, lineId } = await seedPaidTxnForOutlet(t, {
      staffId: staff,
      outletId: outletA,
      total: 50_000,
      paidAt,
      productCode: "PE1",
    });

    const { refundId } = await t.mutation(
      internal.refunds.internal._commitRefund_internal,
      {
        idempotencyKey: "outlet-scope-test-commit-1",
        transactionId: txnId,
        lines: [{ line_id: lineId, qty: 1 }],
        reason: "outlet stamp test",
        requestedBy: staff,
        approverId: mgr,
        approvalSource: "booth_inline",
      },
    );

    // Verify the refund row carries the txn's outlet_id
    await t.run(async (ctx) => {
      const refund = await ctx.db.get(refundId);
      expect(refund?.outlet_id).toBe(outletA);
    });
  });
});
