// convex/transactions/__tests__/api-list.test.ts
import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";
import { seedDefaultOutlet } from "./_helpers";

describe("_listPaidTxnsForApi_internal", () => {
  it("returns paid rows ascending with resolved stable IDs + lines", async () => {
    const t = convexTest(schema);
    const outletId = await seedDefaultOutlet(t);
    await t.run(async (ctx) => {
      const staff = await ctx.db.insert("staff", {
        name: "L", code: "S-0001", role: "staff", active: true, pin_hash: "x", created_at: 0 });
      const prod = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "Eight",
        price_idr: 320000, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0,
        outlet_id: outletId } as any);
      const txn = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 320000, voucher_discount: 0, total: 320000, flags: 0,
        staff_id: staff, created_at: 100, paid_at: 200, receipt_number: "R-2026-0042",
        outlet_id: outletId } as any);
      await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txn, product_id: prod, product_code_snapshot: "DUBAI_8PC",
        product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 320000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 320000, outlet_id: outletId } as any);
    });
    const out = await t.query(internal.transactions.internal._listPaidTxnsForApi_internal, { limit: 100 });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      receiptNumber: "R-2026-0042", staffCode: "S-0001", total: 320000, voucherCode: null,
      lines: [{ productCode: "DUBAI_8PC", qty: 1, unitPrice: 320000, lineSubtotal: 320000, taxRate: 0 }],
    });
    expect(out.nextCursor).toBeNull();
  });

  it("excludes non-paid rows", async () => {
    const t = convexTest(schema);
    const outletId = await seedDefaultOutlet(t);
    await t.run(async (ctx) => {
      const staff = await ctx.db.insert("staff", {
        name: "X", code: "S-0002", role: "staff", active: true, pin_hash: "x", created_at: 0 });
      await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment", subtotal: 1, voucher_discount: 0, total: 1, flags: 0,
        staff_id: staff, created_at: 0, outlet_id: outletId } as any);
    });
    const out = await t.query(internal.transactions.internal._listPaidTxnsForApi_internal, { limit: 100 });
    expect(out.rows).toHaveLength(0);
  });
});
