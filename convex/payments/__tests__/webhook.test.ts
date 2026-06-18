import { describe, it, expect, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { PAYMENT_AMOUNT_MISMATCH } from "../../transactions/flags";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

// v1.0.1: webhook now triggers _confirmPaid which schedules sendTxnTicker.
// Stub Telegram + drain to avoid "Write outside of transaction" errors.
setupTelegramStub();

beforeEach(() => {
  process.env.XENDIT_CALLBACK_TOKEN = "tok-test-1234567890";
});

async function seedAwaitingWithInvoice(
  t: ReturnType<typeof convexTest>,
  xendit_invoice_id: string,
  method: "QRIS" | "BCA_VA" = "QRIS",
) {
  return await t.run(async (ctx) => {
    const staff = await ctx.db.insert("staff", {
      name: "L", code: "S-0001", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
    });
    const sku = await ctx.db.insert("pos_inventory_skus", {
      sku: "x", name: "X", unit: "piece", low_threshold: 0,
      active: true, created_at: Date.now(),
    });
    const product = await ctx.db.insert("pos_products", {
      sku_family: "x", code: "X_1PC", name: "X", pack_label: "1pc", price_idr: 25_000,
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
      method,
      qr_string: method === "QRIS" ? "qr" : undefined,
      va_number: method === "BCA_VA" ? "1080099887" : undefined,
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
    process.env.XENDIT_CALLBACK_TOKEN = "tok-test-1234567890"; // restore for later tests
  });

  it("valid QRIS SUCCEEDED webhook funnels to paid + records receipt_id/source", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithInvoice(t, "qr_wh");
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test-1234567890" },
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
    await drainScheduled(t);
  });

  it("mismatched webhook amount threads through → PAYMENT_AMOUNT_MISMATCH flag set", async () => {
    const t = convexTest(schema);
    const s = await seedAwaitingWithInvoice(t, "qr_mismatch");
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test-1234567890" },
      body: JSON.stringify({
        event: "qr.payment",
        data: { qr_id: "qr_mismatch", status: "SUCCEEDED", amount: 24_000 },
      }),
    });
    expect(r.status).toBe(200);
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("paid");
    expect(txn!.flags & PAYMENT_AMOUNT_MISMATCH).toBe(PAYMENT_AMOUNT_MISMATCH);
    await drainScheduled(t);
  });

  it("bad JSON → 200 no-op (avoids Xendit retry loop)", async () => {
    const t = convexTest(schema);
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test-1234567890" },
      body: "{not json",
    });
    expect(r.status).toBe(200);
  });

  it("unmatched matchKey → 200 (silent drop)", async () => {
    const t = convexTest(schema);
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test-1234567890" },
      body: JSON.stringify({ event: "qr.payment", data: { qr_id: "nope", status: "SUCCEEDED" } }),
    });
    expect(r.status).toBe(200);
  });

  it("valid BCA flat-FVA callback funnels to paid (live-unverified discriminator guard)", async () => {
    // BCA is LIVE-UNVERIFIED (Decision C): the flat callback shape (no `event`,
    // match on callback_virtual_account_id) is asserted from docs, not a real
    // callback. This end-to-end test guards the discriminator against regression.
    const t = convexTest(schema);
    const s = await seedAwaitingWithInvoice(t, "va_456", "BCA_VA");
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test-1234567890" },
      body: JSON.stringify({
        callback_virtual_account_id: "va_456",
        external_id: `pos-${s.txn}`,
        account_number: "1080099887",
        amount: 25_000,
        payment_id: "pay_77",
      }),
    });
    expect(r.status).toBe(200);
    const after = await t.run(async (ctx) => {
      const txn = await ctx.db.get(s.txn);
      const inv = await ctx.db
        .query("pos_xendit_invoices")
        .withIndex("by_xendit_invoice_id", (q) => q.eq("xendit_invoice_id", "va_456"))
        .first();
      return { txn, inv };
    });
    expect(after.txn?.status).toBe("paid");
    expect(after.txn?.confirmed_via).toBe("webhook");
    expect(after.inv?.receipt_id).toBe("pay_77");
    await drainScheduled(t);
  });

  it("webhook for a cancelled txn does NOT flip it + logs payment.confirmed_on_terminal", async () => {
    // Pay-after-cancel: money moved with no sale record. The funnel must NOT
    // auto-flip; it emits an alert audit row for manager reconciliation.
    const t = convexTest(schema);
    const s = await seedAwaitingWithInvoice(t, "qr_cancel");
    await t.run((ctx) => ctx.db.patch(s.txn, { status: "cancelled" }));
    const r = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-callback-token": "tok-test-1234567890" },
      body: JSON.stringify({
        event: "qr.payment",
        data: { qr_id: "qr_cancel", status: "SUCCEEDED", amount: 25_000 },
      }),
    });
    expect(r.status).toBe(200);
    const { txn, alerts } = await t.run(async (ctx) => {
      const txn = await ctx.db.get(s.txn);
      const alerts = await ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "payment.confirmed_on_terminal"))
        .collect();
      return { txn, alerts };
    });
    expect(txn?.status).toBe("cancelled");
    expect(alerts.length).toBe(1);
  });

  // v1.0.1 Task 11: bad-token → 401 AND zero pos_error_reports rows (no bot-scanner noise)
  it("bad-token webhook returns 401 and writes NO error report", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/payments/webhook", {
      method: "POST",
      headers: { "x-callback-token": "wrong", "content-type": "application/json" },
      body: JSON.stringify({ event: "qr.payment", data: { qr_id: "x" } }),
    });
    expect(res.status).toBe(401);
    const rows = await t.run(async (ctx) => ctx.db.query("pos_error_reports").collect());
    // auth-path must NOT emit reports — noise from bot scanners
    expect(rows).toHaveLength(0);
  });

  it("duplicate webhook delivery through the HTTP handler is an idempotent no-op", async () => {
    // Xendit retries on non-2xx; a second identical delivery must not double-confirm.
    const t = convexTest(schema);
    const s = await seedAwaitingWithInvoice(t, "qr_dupe");
    const body = JSON.stringify({
      event: "qr.payment",
      data: { qr_id: "qr_dupe", status: "SUCCEEDED", amount: 25_000 },
    });
    const headers = { "Content-Type": "application/json", "x-callback-token": "tok-test-1234567890" };
    const r1 = await t.fetch("/payments/webhook", { method: "POST", headers, body });
    const r2 = await t.fetch("/payments/webhook", { method: "POST", headers, body });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const { txn, movements } = await t.run(async (ctx) => {
      const txn = await ctx.db.get(s.txn);
      // Fresh convexTest DB per test, so all movements belong to this txn.
      const movements = await ctx.db.query("pos_stock_movements").collect();
      return { txn, movements };
    });
    expect(txn?.status).toBe("paid");
    // One sale movement only — the second delivery hit the status guard and no-op'd.
    expect(movements.length).toBe(1);
    await drainScheduled(t);
  });
});
