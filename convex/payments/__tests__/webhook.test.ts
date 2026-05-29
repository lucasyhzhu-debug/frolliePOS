import { describe, it, expect, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { PAYMENT_AMOUNT_MISMATCH } from "../../transactions/flags";

beforeEach(() => {
  process.env.XENDIT_CALLBACK_TOKEN = "tok-test";
});

async function seedAwaitingWithInvoice(
  t: ReturnType<typeof convexTest>,
  xendit_invoice_id: string,
) {
  return await t.run(async (ctx) => {
    const staff = await ctx.db.insert("staff", {
      name: "L", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
    });
    const sku = await ctx.db.insert("pos_inventory_skus", {
      sku: "x", name: "X", unit: "piece", low_threshold: 0,
      active: true, created_at: Date.now(),
    });
    const product = await ctx.db.insert("pos_products", {
      sku_family: "x", name: "X", pack_label: "1pc", price_idr: 25_000,
      active: true, sort_order: 1, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(),
    });
    await ctx.db.insert("pos_product_components", {
      product_id: product, inventory_sku_id: sku, qty: 1,
    });
    await ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: sku, on_hand: 100, updated_at: Date.now(),
    });
    const txn = await ctx.db.insert("pos_transactions", {
      status: "awaiting_payment", subtotal: 25_000, voucher_discount: 0,
      total: 25_000, flags: 0, staff_id: staff, created_at: Date.now(),
    });
    await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txn, product_id: product,
      product_code_snapshot: "X", product_name_snapshot: "X",
      unit_price_snapshot: 25_000, tax_rate_snapshot: 0,
      qty: 1, line_subtotal: 25_000,
    });
    await ctx.db.insert("pos_xendit_invoices", {
      transaction_id: txn,
      xendit_invoice_id,
      xendit_idempotency_key: "k",
      method: "QRIS",
      qr_string: "qr",
      status_at_create: "PENDING",
      created_at: Date.now(),
    });
    return { txn };
  });
}

describe("payments/webhook", () => {
  it("rejects request without matching x-callback-token (401)", async () => {
    const t = convexTest(schema);
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "wrong" },
      body: JSON.stringify({ event: "qr.payment", data: { qr_id: "x", status: "SUCCEEDED" } }),
    });
    expect(r.status).toBe(401);
  });

  it("missing token config → 401 (behavior change from 500)", async () => {
    const t = convexTest(schema);
    delete process.env.XENDIT_CALLBACK_TOKEN;
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "anything" },
      body: JSON.stringify({ event: "qr.payment", data: { qr_id: "x", status: "SUCCEEDED" } }),
    });
    expect(r.status).toBe(401);
    process.env.XENDIT_CALLBACK_TOKEN = "tok-test"; // restore for later tests
  });

  it("valid QRIS SUCCEEDED webhook funnels to paid + records receipt_id/source", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithInvoice(t, "qr_wh");
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test" },
      body: JSON.stringify({
        event: "qr.payment",
        data: {
          qr_id: "qr_wh", status: "SUCCEEDED", amount: 25_000,
          payment_detail: { receipt_id: "RRN-9", source: "OVO" },
        },
      }),
    });
    expect(r.status).toBe(200);
    const after = await t.run(async (ctx) => {
      const txn = await ctx.db.get(s.txn);
      const inv = await ctx.db
        .query("pos_xendit_invoices")
        .withIndex("by_xendit_invoice_id", (q) => q.eq("xendit_invoice_id", "qr_wh"))
        .first();
      return { txn, inv };
    });
    expect(after.txn?.status).toBe("paid");
    expect(after.txn?.confirmed_via).toBe("webhook");
    expect(after.inv?.receipt_id).toBe("RRN-9");
    expect(after.inv?.payment_source).toBe("OVO");
  });

  it("mismatched webhook amount threads through → PAYMENT_AMOUNT_MISMATCH flag set", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithInvoice(t, "qr_mismatch");
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test" },
      body: JSON.stringify({
        event: "qr.payment",
        data: { qr_id: "qr_mismatch", status: "SUCCEEDED", amount: 24_000 },
      }),
    });
    expect(r.status).toBe(200);
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("paid");
    expect(txn!.flags & PAYMENT_AMOUNT_MISMATCH).toBe(PAYMENT_AMOUNT_MISMATCH);
  });

  it("bad JSON → 200 no-op (avoids Xendit retry loop)", async () => {
    const t = convexTest(schema);
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test" },
      body: "{not json",
    });
    expect(r.status).toBe(200);
  });

  it("unmatched matchKey → 200 (silent drop)", async () => {
    const t = convexTest(schema);
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test" },
      body: JSON.stringify({ event: "qr.payment", data: { qr_id: "nope", status: "SUCCEEDED" } }),
    });
    expect(r.status).toBe(200);
  });
});
