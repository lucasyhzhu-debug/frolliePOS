import { describe, it, expect, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";

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
  it("rejects request without matching x-callback-token", async () => {
    const t = convexTest(schema);
    const response = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "wrong" },
      body: JSON.stringify({ id: "xnd-1", status: "PAID" }),
    });
    expect(response.status).toBe(401);
  });

  it("on valid PAID webhook, funnels to _confirmPaid via _onPaidWebhook", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithInvoice(t, "xnd-wh");

    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test" },
      body: JSON.stringify({ id: "xnd-wh", status: "PAID", external_id: "pos-..." }),
    });
    expect(r.status).toBe(200);

    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("paid");
    expect(txn?.confirmed_via).toBe("webhook");
  });

  it("returns 200 on duplicate PAID webhook (idempotent)", async () => {
    const t = convexTest(schema);
    await seedAwaitingWithInvoice(t, "xnd-dup");

    const headers = { "Content-Type": "application/json", "x-callback-token": "tok-test" };
    const body = JSON.stringify({ id: "xnd-dup", status: "PAID" });

    const r1 = await t.fetch("/payments/webhook", { method: "POST", headers, body });
    expect(r1.status).toBe(200);

    const r2 = await t.fetch("/payments/webhook", { method: "POST", headers, body });
    expect(r2.status).toBe(200);

    const movements = await t.run((ctx) =>
      ctx.db.query("pos_stock_movements").collect(),
    );
    // _confirmPaid status guard: second webhook is a no-op → only one movement row
    expect(movements.length).toBe(1);
  });
});
