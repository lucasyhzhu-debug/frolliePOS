// convex/refunds/__tests__/api-list.test.ts
import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";

describe("_listRefundsForApi_internal", () => {
  it("resolves receiptNumber + per-line productCode (positive magnitudes)", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "manager", active: true, pin_hash: "x", created_at: 0 });
      const p = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "Eight", price_idr: 320000, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 });
      const x = await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 320000, voucher_discount: 0, total: 320000, flags: 0, staff_id: s, created_at: 1, paid_at: 2, receipt_number: "R-2026-0042" });
      const line = await ctx.db.insert("pos_transaction_lines", { transaction_id: x, product_id: p, product_code_snapshot: "DUBAI_8PC", product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 320000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 320000 });
      await ctx.db.insert("pos_refunds", { transaction_id: x, lines: [{ line_id: line, qty: 1, refund_amount: 320000 }], total_refund: 320000, reason: "damaged", requested_by: s, approver_id: s, approval_source: "booth_inline", settlement_status: "pending", created_at: 500 });
    });
    const out = await t.query(internal.refunds.internal._listRefundsForApi_internal, { limit: 100 });
    expect(out.rows[0]).toMatchObject({
      receiptNumber: "R-2026-0042", createdAt: 500, totalRefund: 320000, reason: "damaged",
      lines: [{ productCode: "DUBAI_8PC", qty: 1, refundAmount: 320000 }],
    });
    expect(out.nextCursor).toBeNull();
  });

  it("skips a corrupt refund (orphaned txn) without throwing — good rows still return", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "manager", active: true, pin_hash: "x", created_at: 0 });
      const p = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "Eight", price_idr: 320000, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 });

      // GOOD refund (created_at: 100) — txn + line stay intact.
      const goodTxn = await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 320000, voucher_discount: 0, total: 320000, flags: 0, staff_id: s, created_at: 1, paid_at: 2, receipt_number: "R-2026-0042" });
      const goodLine = await ctx.db.insert("pos_transaction_lines", { transaction_id: goodTxn, product_id: p, product_code_snapshot: "DUBAI_8PC", product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 320000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 320000 });
      await ctx.db.insert("pos_refunds", { transaction_id: goodTxn, lines: [{ line_id: goodLine, qty: 1, refund_amount: 320000 }], total_refund: 320000, reason: "damaged", requested_by: s, approver_id: s, approval_source: "booth_inline", settlement_status: "pending", created_at: 100 });

      // CORRUPT refund (created_at: 200) — insert txn + line + refund, then
      // delete the txn so the refund's transaction_id dangles.
      const corruptTxn = await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 160000, voucher_discount: 0, total: 160000, flags: 0, staff_id: s, created_at: 3, paid_at: 4, receipt_number: "R-2026-0099" });
      const corruptLine = await ctx.db.insert("pos_transaction_lines", { transaction_id: corruptTxn, product_id: p, product_code_snapshot: "DUBAI_8PC", product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 160000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 160000 });
      await ctx.db.insert("pos_refunds", { transaction_id: corruptTxn, lines: [{ line_id: corruptLine, qty: 1, refund_amount: 160000 }], total_refund: 160000, reason: "wrong item", requested_by: s, approver_id: s, approval_source: "booth_inline", settlement_status: "pending", created_at: 200 });
      // Orphan the refund by deleting the parent txn — simulates DB corruption /
      // accidental hard-delete. The refund row survives; its transaction_id now
      // points to a missing document.
      await ctx.db.delete(corruptTxn);
    });

    // Must NOT throw; corrupt refund is silently skipped.
    const out = await t.query(internal.refunds.internal._listRefundsForApi_internal, { limit: 100 });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].receiptNumber).toBe("R-2026-0042");
    expect(out.nextCursor).toBeNull();
  });
});
