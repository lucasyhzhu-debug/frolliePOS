// convex/api/v1/__tests__/transactions.test.ts
import { convexTest } from "convex-test";
import schema from "../../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../../_generated/api";

async function token(t: any) {
  const { rawToken } = await t.mutation(internal.api.v1.internal._issueApiToken_internal, {
    label: "t", endpointAllowList: ["/api/v1/transactions"], rateLimitRpm: 1000 });
  return rawToken;
}

describe("GET /api/v1/transactions", () => {
  it("returns the contract envelope for a paid sale", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "staff", active: true, pin_hash: "x", created_at: 0 });
      const p = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "Eight", price_idr: 320000, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 });
      const x = await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 320000, voucher_discount: 0, total: 320000, flags: 0, staff_id: s, created_at: 1, paid_at: 2, receipt_number: "R-2026-0042" });
      await ctx.db.insert("pos_transaction_lines", { transaction_id: x, product_id: p, product_code_snapshot: "DUBAI_8PC", product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 320000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 320000 });
    });
    const res = await t.fetch("/api/v1/transactions", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].receiptNumber).toBe("R-2026-0042");
    expect(body.data[0].lines[0].productCode).toBe("DUBAI_8PC");
    expect(body).toHaveProperty("nextCursor");
  });

  it("400 BAD_CURSOR on a malformed cursor", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/api/v1/transactions?cursor=@@@", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_CURSOR");
  });

  // CONTRACT §6a — optional from/to window bounds.
  async function seed3(t: any) {
    await t.run(async (ctx: any) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "staff", active: true, pin_hash: "x", created_at: 0 });
      const mk = async (rn: string, paidAt: number) =>
        ctx.db.insert("pos_transactions", { status: "paid", subtotal: 1, voucher_discount: 0, total: 1, flags: 0, staff_id: s, created_at: 0, paid_at: paidAt, receipt_number: rn });
      await mk("R-2026-0001", 100);
      await mk("R-2026-0002", 200);
      await mk("R-2026-0003", 300);
    });
  }

  it("from/to clamps to a [from, to) window — inclusive lower, exclusive upper", async () => {
    const t = convexTest(schema);
    await seed3(t);
    const res = await t.fetch("/api/v1/transactions?from=200&to=300", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: any) => r.receiptNumber)).toEqual(["R-2026-0002"]);
  });

  it("from alone returns rows at or after the bound", async () => {
    const t = convexTest(schema);
    await seed3(t);
    const res = await t.fetch("/api/v1/transactions?from=200", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    const body = await res.json();
    expect(body.data.map((r: any) => r.receiptNumber)).toEqual(["R-2026-0002", "R-2026-0003"]);
  });

  it("400 BAD_RANGE when from > to", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/api/v1/transactions?from=500&to=100", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_RANGE");
  });

  it("400 BAD_RANGE on a non-integer bound", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/api/v1/transactions?from=notanumber", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_RANGE");
  });
});
