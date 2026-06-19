// convex/api/v1/__tests__/refunds.test.ts
import { convexTest } from "convex-test";
import schema from "../../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../../_generated/api";

async function token(t: any) {
  const { rawToken } = await t.mutation(internal.api.v1.internal._issueApiToken_internal, {
    label: "t", endpointAllowList: ["/api/v1/refunds"], rateLimitRpm: 1000 });
  return rawToken;
}

describe("GET /api/v1/refunds", () => {
  it("returns the contract envelope for a refund", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "manager", active: true, pin_hash: "x", created_at: 0 });
      const p = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "Eight", price_idr: 320000, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 });
      const x = await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 320000, voucher_discount: 0, total: 320000, flags: 0, staff_id: s, created_at: 1, paid_at: 2, receipt_number: "R-2026-0042" });
      const line = await ctx.db.insert("pos_transaction_lines", { transaction_id: x, product_id: p, product_code_snapshot: "DUBAI_8PC", product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 320000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 320000 });
      await ctx.db.insert("pos_refunds", { transaction_id: x, lines: [{ line_id: line, qty: 1, refund_amount: 320000 }], total_refund: 320000, reason: "damaged", requested_by: s, approver_id: s, approval_source: "booth_inline", settlement_status: "pending", created_at: 500 });
    });
    const res = await t.fetch("/api/v1/refunds", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].receiptNumber).toBe("R-2026-0042");
    expect(body.data[0].lines[0].productCode).toBe("DUBAI_8PC");
    expect(body.data[0].totalRefund).toBe(320000);
    expect(body).toHaveProperty("nextCursor");
  });

  it("400 BAD_CURSOR on a malformed cursor", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/api/v1/refunds?cursor=@@@", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_CURSOR");
  });

  // CONTRACT §6a — optional from/to window bounds (filter on createdAt).
  it("from/to clamps refunds to a [from, to) window", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "manager", active: true, pin_hash: "x", created_at: 0 });
      const p = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "Eight", price_idr: 320000, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 });
      const mk = async (rn: string, createdAt: number) => {
        const x = await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 320000, voucher_discount: 0, total: 320000, flags: 0, staff_id: s, created_at: 1, paid_at: 2, receipt_number: rn });
        const line = await ctx.db.insert("pos_transaction_lines", { transaction_id: x, product_id: p, product_code_snapshot: "DUBAI_8PC", product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 320000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 320000 });
        await ctx.db.insert("pos_refunds", { transaction_id: x, lines: [{ line_id: line, qty: 1, refund_amount: 320000 }], total_refund: 320000, reason: "r", requested_by: s, approver_id: s, approval_source: "booth_inline", settlement_status: "pending", created_at: createdAt });
      };
      await mk("R-2026-0001", 100);
      await mk("R-2026-0002", 300);
    });
    const res = await t.fetch("/api/v1/refunds?from=200&to=400", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: any) => r.receiptNumber)).toEqual(["R-2026-0002"]);
  });

  it("400 BAD_RANGE when from > to", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/api/v1/refunds?from=500&to=100", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_RANGE");
  });
});
