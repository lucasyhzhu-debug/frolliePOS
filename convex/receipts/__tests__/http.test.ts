import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";

// Test seed: a paid txn with a known receipt_token + a single transaction line.
async function seedPaidTxnWithToken(
  t: ReturnType<typeof convexTest>,
  token: string,
  opts: { status?: "paid" | "cancelled" } = {},
) {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      code: "S-HTTP",
      name: "H",
      role: "staff",
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
    const txnId = await ctx.db.insert("pos_transactions", {
      status: opts.status ?? "paid",
      subtotal: 50000,
      voucher_discount: 0,
      total: 50000,
      flags: 0,
      staff_id: staffId,
      created_at: Date.now(),
      paid_at: Date.now(),
      receipt_number: "R-2026-0001",
      receipt_token: token,
    });
    await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txnId,
      product_id: productId,
      product_code_snapshot: "DUB1",
      product_name_snapshot: "Dubai 1pc",
      unit_price_snapshot: 50000,
      tax_rate_snapshot: 0,
      qty: 1,
      line_subtotal: 50000,
    });
    return txnId;
  });
}

describe("GET /r/:token httpAction", () => {
  it("returns 200 + html for a valid token", async () => {
    const t = convexTest(schema);
    await seedPaidTxnWithToken(t, "tok-valid-12345");
    const res = await t.fetch("/r/tok-valid-12345", { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("R-2026-0001");
    // v1.2 #13: paid receipts no longer show the LUNAS badge.
    expect(body).not.toContain("LUNAS");
  });

  it("returns 404 for unknown token", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/r/nonexistent-token-9876543", { method: "GET" });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("Struk tidak ditemukan");
  });

  it("status guard: 404 for non-paid txn even with matching token", async () => {
    const t = convexTest(schema);
    const token = "tok-cancelled-xyz1234";
    await seedPaidTxnWithToken(t, token, { status: "cancelled" });
    const res = await t.fetch(`/r/${token}`, { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for tokens shorter than 10 chars (fast path)", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/r/abc", { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for empty token segment", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/r/", { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("receipt still shows payment method + RRN when paying invoice was later cancelled (refund scenario)", async () => {
    const t = convexTest(schema);
    const token = "tok-cancelled-invoice-1";
    const txnId = await seedPaidTxnWithToken(t, token);
    // Seed an invoice that has been cancelled (PR B refund scenario) — receipt
    // must still surface the method + RRN.
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: txnId,
        xendit_invoice_id: "qr_test_cancelled_1",
        xendit_idempotency_key: "idemp_test_cancelled_1",
        method: "QRIS",
        qr_string: "00020101...",
        receipt_id: "RRN1234567",
        payment_source: "GoPay",
        status_at_create: "ACTIVE",
        created_at: Date.now() - 1000,
        cancelled_at: Date.now(),
        cancelled_reason: "refund",
      });
    });
    const res = await t.fetch(`/r/${token}`, { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.text();
    // method label survives invoice cancellation
    expect(body).toContain("QRIS");
    // RRN surfaces
    expect(body).toContain("RRN1234567");
    // sanity: no em-dash placeholder for the method line
    expect(body).not.toContain("Dibayar via —");
  });

  it("returns 200 for token with trailing slash (/r/tok-valid-12345/)", async () => {
    const t = convexTest(schema);
    await seedPaidTxnWithToken(t, "tok-trailing-slash");
    const res = await t.fetch("/r/tok-trailing-slash/", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.text();
    // v1.2 #13: paid receipts no longer show the LUNAS badge.
    expect(body).not.toContain("LUNAS");
  });

  it("cache hit on second call returns identical bytes", async () => {
    const t = convexTest(schema);
    await seedPaidTxnWithToken(t, "tok-cache-hit-001");
    const r1 = await t.fetch("/r/tok-cache-hit-001", { method: "GET" });
    const b1 = await r1.text();
    const r2 = await t.fetch("/r/tok-cache-hit-001", { method: "GET" });
    const b2 = await r2.text();
    expect(b1).toBe(b2);
  });
});
