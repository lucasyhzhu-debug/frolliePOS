// convex/api/v1/__tests__/conformance.test.ts
import { convexTest } from "convex-test";
import schema from "../../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../../_generated/api";

const RECEIPT = /^R-\d{4}-\d{4}$/, STAFF = /^S-\d{4}$/, PRODUCT = /^[A-Z][A-Z0-9_]*$/;

describe("stable-ID conformance", () => {
  it("every emitted receiptNumber/staffCode/productCode matches its contract format", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "staff", active: true, pin_hash: "x", created_at: 0 });
      const p = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "Eight", price_idr: 320000, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 });
      const x = await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 320000, voucher_discount: 0, total: 320000, flags: 0, staff_id: s, created_at: 1, paid_at: 2, receipt_number: "R-2026-0042" });
      await ctx.db.insert("pos_transaction_lines", { transaction_id: x, product_id: p, product_code_snapshot: "DUBAI_8PC", product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 320000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 320000 });
    });
    const { rawToken } = await t.mutation(internal.api.v1.internal._issueApiToken_internal, {
      label: "t", endpointAllowList: ["/api/v1/transactions"], rateLimitRpm: 1000 });
    const body = await (await t.fetch("/api/v1/transactions", { method: "GET", headers: { Authorization: `Bearer ${rawToken}` } })).json();
    for (const txn of body.data) {
      expect(RECEIPT.test(txn.receiptNumber)).toBe(true);
      expect(STAFF.test(txn.staffCode)).toBe(true);
      for (const l of txn.lines) expect(PRODUCT.test(l.productCode)).toBe(true);
    }
  });
});
