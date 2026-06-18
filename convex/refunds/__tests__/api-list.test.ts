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
});
