import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { describe, it, expect } from "vitest";

/**
 * C1 (v0.5.1 PR B post-review): _commitRefund_internal MUST be idempotent on
 * its `:commit`-derived idempotency key. Without the withIdempotency wrap,
 * an action-level retry after the funnel committed but before the action-level
 * cache row was written would double-insert: 2 pos_refunds rows, 2 sets of
 * stock movements, 2 audit rows, and double-patch refunded_qty.
 *
 * This test exercises that exact replay scenario directly by calling the
 * internal mutation twice with the same idempotencyKey and asserting all
 * downstream state is single-shot.
 */

describe("_commitRefund_internal idempotency replay (C1)", () => {
  it("same-key second call returns cached response without double-writing state", async () => {
    const t = convexTest(schema);

    const seed = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        code: "S-IDM", name: "IDM", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const mgrId = await ctx.db.insert("staff", {
        code: "M-IDM", name: "Mgr", role: "manager", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const skuId = await ctx.db.insert("pos_inventory_skus", {
        sku: "dubai-idm",
        code: "DUB-IDM",
        name: "Dubai IDM",
        unit: "piece" as const,
        low_threshold: 0,
        active: true,
        created_at: Date.now(),
      });
      const productId = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUBIDM", name: "Dubai IDM 1pc", pack_label: "1pc",
        price_idr: 50000, active: true, sort_order: 0, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
      });
      await ctx.db.insert("pos_product_components", {
        product_id: productId,
        inventory_sku_id: skuId,
        qty: 1,
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 50000, voucher_discount: 0, total: 50000,
        flags: 0, staff_id: staffId, created_at: Date.now(), paid_at: Date.now(),
        receipt_number: "R-2026-IDM1", receipt_token: "tok-idem-replay",
      });
      const lineId = await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "DUBIDM", product_name_snapshot: "Dubai IDM 1pc",
        unit_price_snapshot: 50000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 50000,
      });
      return { staffId, mgrId, txnId, lineId, skuId };
    });

    const key = "test-c1-replay-1:commit";

    const first = await t.mutation(internal.refunds.internal._commitRefund_internal, {
      idempotencyKey: key,
      transactionId: seed.txnId,
      lines: [{ line_id: seed.lineId, qty: 1 }],
      reason: "C1 replay test",
      requestedBy: seed.staffId,
      approverId: seed.mgrId,
      approvalSource: "booth_inline",
    });

    // Same key → withIdempotency cache replay. The wrapper returns the EXACT
    // stored blob, so refundId must match — proves no second insert.
    const second = await t.mutation(internal.refunds.internal._commitRefund_internal, {
      idempotencyKey: key,
      transactionId: seed.txnId,
      lines: [{ line_id: seed.lineId, qty: 1 }],
      reason: "C1 replay test",
      requestedBy: seed.staffId,
      approverId: seed.mgrId,
      approvalSource: "booth_inline",
    });

    expect(second.refundId).toBe(first.refundId);
    expect(second.total_refund).toBe(first.total_refund);

    await t.run(async (ctx) => {
      // Exactly 1 pos_refunds row.
      const refunds = await ctx.db
        .query("pos_refunds")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", seed.txnId))
        .collect();
      expect(refunds.length).toBe(1);

      // Exactly 1 refund stock movement for this line.
      const movements = await ctx.db
        .query("pos_stock_movements")
        .withIndex("by_line_and_sku", (q) =>
          q.eq("source_transaction_line_id", seed.lineId).eq("inventory_sku_id", seed.skuId),
        )
        .collect();
      const refundMovements = movements.filter((m) => m.source === "refund");
      expect(refundMovements.length).toBe(1);

      // Exactly 1 refund.committed audit row.
      const auditRows = await ctx.db
        .query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "refund.committed"))
        .collect();
      expect(auditRows.length).toBe(1);

      // refunded_qty patched exactly once (= 1, not 2).
      const line = await ctx.db.get(seed.lineId);
      expect(line?.refunded_qty).toBe(1);
    });
  });
});
