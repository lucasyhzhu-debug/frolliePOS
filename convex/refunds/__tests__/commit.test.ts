import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";
import { describe, it, expect } from "vitest";

/**
 * Shared test fixture for B13–B17/B20: paid txn with N lines, voucher discount,
 * receipt_token populated so the cache-purge step inside _commitRefund_internal
 * doesn't trip the v0.5.1 PURGE_NO_TOKEN invariant.
 *
 * Returns the staff (requester), a manager (approver), the txn, and the line ids.
 */
async function seedPaidTxn(
  t: ReturnType<typeof convexTest>,
  opts: {
    subtotal: number;
    voucher: number;
    lines: Array<{ qty: number; unit_price: number }>;
    receiptToken?: string;
  },
) {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      code: "S-RC",
      name: "RC",
      role: "staff",
      active: true,
      pin_hash: "x",
      created_at: Date.now(),
    });
    const mgrId = await ctx.db.insert("staff", {
      code: "M-RC",
      name: "Mgr",
      role: "manager",
      active: true,
      pin_hash: "x",
      created_at: Date.now(),
    });
    const productId = await ctx.db.insert("pos_products", {
      sku_family: "dubai",
      code: "DUB1",
      name: "Dubai 1pc",
      pack_label: "1pc",
      price_idr: 50000,
      active: true,
      sort_order: 0,
      tax_rate: 0,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    const total = opts.subtotal - opts.voucher;
    const txnId = await ctx.db.insert("pos_transactions", {
      status: "paid",
      subtotal: opts.subtotal,
      voucher_discount: opts.voucher,
      total,
      flags: 0,
      staff_id: staffId,
      created_at: Date.now(),
      paid_at: Date.now(),
      receipt_number: "R-2026-0001",
      receipt_token: opts.receiptToken ?? "test-token-for-purge",
    });
    const lineIds: Id<"pos_transaction_lines">[] = [];
    for (const l of opts.lines) {
      const lineId = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId,
        product_id: productId,
        product_code_snapshot: "DUB1",
        product_name_snapshot: "Dubai 1pc",
        unit_price_snapshot: l.unit_price,
        tax_rate_snapshot: 0,
        qty: l.qty,
        line_subtotal: l.qty * l.unit_price,
      });
      lineIds.push(lineId);
    }
    return { staffId, mgrId, txnId, lineIds };
  });
}

describe("_commitRefund_internal", () => {
  it("commits a partial refund: inserts refund row, patches refunded_qty, total_refund correct", async () => {
    const t = convexTest(schema);
    // subtotal 150_000, voucher 20_000 → total 130_000; 3 × 50_000 line.
    // Refund 1pc of 3: refund_amount = floor(50_000 × 130_000 × 1 / (150_000 × 3))
    //                                = floor(6_500_000_000 / 450_000) = 14_444
    // (per-line subtotal here is 150_000 since qty=3 × 50_000)
    // Actually: line.line_subtotal = 150_000, txn.total = 130_000, refundQty = 1,
    // txn.subtotal = 150_000, line.qty = 3
    //   numerator = 150_000 × 130_000 × 1 = 19_500_000_000
    //   denominator = 150_000 × 3 = 450_000
    //   refund_amount = floor(19_500_000_000 / 450_000) = 43_333
    const { staffId, mgrId, txnId, lineIds } = await seedPaidTxn(t, {
      subtotal: 150000,
      voucher: 20000,
      lines: [{ qty: 3, unit_price: 50000 }],
    });

    const { refundId, total_refund } = await t.mutation(
      internal.refunds.internal._commitRefund_internal,
      {
        idempotencyKey: "commit-test-partial-1",
        transactionId: txnId,
        lines: [{ line_id: lineIds[0], qty: 1 }],
        reason: "wrong flavour",
        requestedBy: staffId,
        approverId: mgrId,
        approvalSource: "booth_inline",
      },
    );

    expect(total_refund).toBe(43333);

    await t.run(async (ctx) => {
      const refund = await ctx.db.get(refundId);
      expect(refund?.total_refund).toBe(43333);
      expect(refund?.settlement_status).toBe("pending");
      expect(refund?.approval_source).toBe("booth_inline");
      expect(refund?.requested_by).toBe(staffId);
      expect(refund?.approver_id).toBe(mgrId);
      expect(refund?.lines.length).toBe(1);
      expect(refund?.lines[0].qty).toBe(1);

      const line = await ctx.db.get(lineIds[0]);
      expect(line?.refunded_qty).toBe(1);
    });
  });

  it("rejects refund qty > refundable", async () => {
    const t = convexTest(schema);
    const { staffId, mgrId, txnId, lineIds } = await seedPaidTxn(t, {
      subtotal: 50000,
      voucher: 0,
      lines: [{ qty: 1, unit_price: 50000 }],
    });
    await expect(
      t.mutation(internal.refunds.internal._commitRefund_internal, {
        idempotencyKey: "commit-test-overrefund",
        transactionId: txnId,
        lines: [{ line_id: lineIds[0], qty: 2 }],
        reason: "x",
        requestedBy: staffId,
        approverId: mgrId,
        approvalSource: "booth_inline",
      }),
    ).rejects.toThrow(/REFUND_QTY_EXCEEDS_REFUNDABLE/);
  });

  it("rejects refund on awaiting_payment txn (TXN_NOT_REFUNDABLE)", async () => {
    const t = convexTest(schema);
    // Build awaiting_payment txn manually — seedPaidTxn is paid-only.
    const { staffId, mgrId, txnId, lineId } = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        code: "S-NP", name: "NP", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const mgrId = await ctx.db.insert("staff", {
        code: "M-NP", name: "Mgr", role: "manager", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const productId = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUB1", name: "Dubai 1pc", pack_label: "1pc",
        price_idr: 50000, active: true, sort_order: 0, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment",
        subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId, created_at: Date.now(),
      });
      const lineId = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "DUB1", product_name_snapshot: "Dubai 1pc",
        unit_price_snapshot: 50000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 50000,
      });
      return { staffId, mgrId, txnId, lineId };
    });

    await expect(
      t.mutation(internal.refunds.internal._commitRefund_internal, {
        idempotencyKey: "commit-test-not-paid",
        transactionId: txnId,
        lines: [{ line_id: lineId, qty: 1 }],
        reason: "x",
        requestedBy: staffId,
        approverId: mgrId,
        approvalSource: "booth_inline",
      }),
    ).rejects.toThrow(/TXN_NOT_REFUNDABLE/);
  });

  it("multiple partial refunds compose correctly (refunded_qty accumulates)", async () => {
    const t = convexTest(schema);
    // 3 units @ 50_000 = subtotal 150_000, no voucher → total 150_000.
    // Refund 1 then 2 = 3 total → refunded_qty 3 (line fully refunded).
    const { staffId, mgrId, txnId, lineIds } = await seedPaidTxn(t, {
      subtotal: 150000,
      voucher: 0,
      lines: [{ qty: 3, unit_price: 50000 }],
    });

    // First refund: 1 unit.
    const r1 = await t.mutation(internal.refunds.internal._commitRefund_internal, {
      idempotencyKey: "commit-test-multi-1",
      transactionId: txnId,
      lines: [{ line_id: lineIds[0], qty: 1 }],
      reason: "first",
      requestedBy: staffId,
      approverId: mgrId,
      approvalSource: "booth_inline",
    });
    expect(r1.total_refund).toBe(50000);

    // After first refund: refundable is 2. Receipt cache purge needs the txn
    // to still have receipt_token — set unchanged on the paid row.
    // Second refund: 2 units.
    const r2 = await t.mutation(internal.refunds.internal._commitRefund_internal, {
      idempotencyKey: "commit-test-multi-2",
      transactionId: txnId,
      lines: [{ line_id: lineIds[0], qty: 2 }],
      reason: "second",
      requestedBy: staffId,
      approverId: mgrId,
      approvalSource: "booth_inline",
    });
    expect(r2.total_refund).toBe(100000);

    await t.run(async (ctx) => {
      const line = await ctx.db.get(lineIds[0]);
      expect(line?.refunded_qty).toBe(3);

      // Two refund rows exist for this txn.
      const refunds = await ctx.db
        .query("pos_refunds")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", txnId))
        .collect();
      expect(refunds.length).toBe(2);
      expect(refunds.reduce((s, r) => s + r.total_refund, 0)).toBe(150000);
    });

    // A third refund attempt should fail — nothing left to refund.
    await expect(
      t.mutation(internal.refunds.internal._commitRefund_internal, {
        idempotencyKey: "commit-test-multi-3-overrefund",
        transactionId: txnId,
        lines: [{ line_id: lineIds[0], qty: 1 }],
        reason: "over",
        requestedBy: staffId,
        approverId: mgrId,
        approvalSource: "booth_inline",
      }),
    ).rejects.toThrow(/REFUND_QTY_EXCEEDS_REFUNDABLE/);
  });

  it("commits successfully when paid txn lacks receipt_token (pre-v0.5.1 legacy row)", async () => {
    // N3: pre-v0.5.1 paid txns don't have receipt_token (added in PR A). The
    // refund commit must NOT abort on the purge step — there's no cached
    // receipt HTML to invalidate. Verifies _purgeReceiptCache_internal returns
    // silently for the no-token case.
    const t = convexTest(schema);
    const { staffId, mgrId, txnId, lineIds } = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        code: "S-LG", name: "LG", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const mgrId = await ctx.db.insert("staff", {
        code: "M-LG", name: "Mgr", role: "manager", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const productId = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUB1", name: "Dubai 1pc", pack_label: "1pc",
        price_idr: 50000, active: true, sort_order: 0, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
      });
      // No receipt_token — simulates a paid txn from before v0.5.1.
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId, created_at: Date.now(), paid_at: Date.now(),
        receipt_number: "R-LEGACY-0001",
      });
      const lineId = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "DUB1", product_name_snapshot: "Dubai 1pc",
        unit_price_snapshot: 50000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 50000,
      });
      return { staffId, mgrId, txnId, lineIds: [lineId] };
    });

    const { refundId, total_refund } = await t.mutation(
      internal.refunds.internal._commitRefund_internal,
      {
        idempotencyKey: "commit-test-legacy-no-token",
        transactionId: txnId,
        lines: [{ line_id: lineIds[0], qty: 1 }],
        reason: "legacy refund",
        requestedBy: staffId,
        approverId: mgrId,
        approvalSource: "booth_inline",
      },
    );

    expect(total_refund).toBe(50000);
    await t.run(async (ctx) => {
      const refund = await ctx.db.get(refundId);
      expect(refund?.total_refund).toBe(50000);
    });
  });

  it("rejects duplicate line_id entries in args (REFUND_LINES_DUPLICATE)", async () => {
    // N1: a caller submitting [{A,1},{A,1}] against A.refundable=2 would have
    // each entry individually pass `qty <= refundable` while the AGGREGATE
    // exceeded it — double-commit + double stock credit. The dedup guard at
    // the top of the validation loop rejects this shape outright.
    const t = convexTest(schema);
    const { staffId, mgrId, txnId, lineIds } = await seedPaidTxn(t, {
      subtotal: 100000,
      voucher: 0,
      lines: [{ qty: 2, unit_price: 50000 }],
    });

    await expect(
      t.mutation(internal.refunds.internal._commitRefund_internal, {
        idempotencyKey: "commit-test-dup-line",
        transactionId: txnId,
        lines: [
          { line_id: lineIds[0], qty: 1 },
          { line_id: lineIds[0], qty: 1 },
        ],
        reason: "double-tap aggregator bypass",
        requestedBy: staffId,
        approverId: mgrId,
        approvalSource: "booth_inline",
      }),
    ).rejects.toThrow(/REFUND_LINES_DUPLICATE/);
  });
});
