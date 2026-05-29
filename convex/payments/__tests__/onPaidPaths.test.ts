import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

async function seedAwaiting(t: ReturnType<typeof convexTest>) {
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
    return { staff, txn };
  });
}

describe("payments/internal", () => {
  it("_persistInvoiceCommit_internal writes pos_xendit_invoices and sets txn.xendit_invoice_id_current", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    await t.mutation(internal.payments.internal._persistInvoiceCommit_internal, {
      idempotencyKey: `k-${Date.now()}`,
      txnId: s.txn,
      xendit_invoice_id: "xnd-123",
      xendit_idempotency_key: `k-${Date.now()}`,
      method: "QRIS",
      qr_string: "fake-qr",
      status_at_create: "PENDING",
    });
    const inv = await t.run((ctx) =>
      ctx.db.query("pos_xendit_invoices")
        .withIndex("by_xendit_invoice_id", (q) => q.eq("xendit_invoice_id", "xnd-123"))
        .first(),
    );
    expect(inv).not.toBeNull();
    expect(inv?.qr_string).toBe("fake-qr");
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.xendit_invoice_id_current).toBe("xnd-123");
  });

  it("_onPaidWebhook_internal funnels to _confirmPaid with source=webhook", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    await t.mutation(internal.payments.internal._persistInvoiceCommit_internal, {
      idempotencyKey: `k-${Date.now()}-1`,
      txnId: s.txn, xendit_invoice_id: "xnd-w",
      xendit_idempotency_key: "k-w", method: "QRIS",
      qr_string: "qr", status_at_create: "PENDING",
    });
    await t.mutation(internal.payments.internal._onPaidWebhook_internal, {
      xendit_invoice_id: "xnd-w",
    });
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("paid");
    expect(txn?.confirmed_via).toBe("webhook");
  });

  it("_onPaidManual_internal records mgr_approver_id + reason and source=manual", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    const r = await t.mutation(internal.payments.internal._onPaidManual_internal, {
      idempotencyKey: "k-manual-onpaid",
      txnId: s.txn, reason: "BCA cleared manually", mgr_approver_id: s.staff,
    });
    expect(r.confirmed).toBe(true);
    expect(r.receiptNumber).toMatch(/^R-\d{4}-\d{4}$/);
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.confirmed_via).toBe("manual");
    expect(txn?.confirmed_mgr_approver_id).toBe(s.staff);
    expect(txn?.confirmed_manual_reason).toBe("BCA cleared manually");
  });

  it("getCurrentInvoice returns the most recently created invoice for the txn", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    await t.mutation(internal.payments.internal._persistInvoiceCommit_internal, {
      idempotencyKey: "k-a", txnId: s.txn, xendit_invoice_id: "xnd-a",
      xendit_idempotency_key: "k-a", method: "QRIS", qr_string: "qr-a",
      status_at_create: "PENDING",
    });
    await new Promise((r) => setTimeout(r, 5));
    await t.mutation(internal.payments.internal._persistInvoiceCommit_internal, {
      idempotencyKey: "k-b", txnId: s.txn, xendit_invoice_id: "xnd-b",
      xendit_idempotency_key: "k-b", method: "BCA_VA", va_number: "1234567890",
      status_at_create: "PENDING",
    });
    const inv = await t.query(api.payments.public.getCurrentInvoice, { txnId: s.txn });
    expect(inv?.xendit_invoice_id).toBe("xnd-b");
  });

  it("getCurrentInvoice skips a superseded (cancelled) invoice even when it is newest", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    await t.mutation(internal.payments.internal._persistInvoiceCommit_internal, {
      idempotencyKey: "k-act", txnId: s.txn, xendit_invoice_id: "xnd-active",
      xendit_idempotency_key: "k-act", method: "QRIS", qr_string: "qr-act",
      status_at_create: "ACTIVE",
    });
    await new Promise((r) => setTimeout(r, 5));
    // A NEWER row that has been superseded (cancelled_at set). getCurrentInvoice
    // must skip it and return the older still-active row — proving it filters on
    // cancelled_at, not merely "newest wins".
    await t.run((ctx) =>
      ctx.db.insert("pos_xendit_invoices", {
        transaction_id: s.txn, xendit_invoice_id: "xnd-cancelled",
        xendit_idempotency_key: "k-cancel", method: "QRIS", qr_string: "qr-cancel",
        status_at_create: "ACTIVE", created_at: Date.now(), cancelled_at: Date.now(),
      }),
    );
    const inv = await t.query(api.payments.public.getCurrentInvoice, { txnId: s.txn });
    expect(inv?.xendit_invoice_id).toBe("xnd-active");
  });

  it("webhook dedup: same xendit_invoice_id called twice — second is no-op (status guard inside _confirmPaid)", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    await t.mutation(internal.payments.internal._persistInvoiceCommit_internal, {
      idempotencyKey: `k-${Date.now()}-d`,
      txnId: s.txn, xendit_invoice_id: "xnd-d",
      xendit_idempotency_key: "k-d", method: "QRIS",
      qr_string: "qr", status_at_create: "PENDING",
    });
    await t.mutation(internal.payments.internal._onPaidWebhook_internal, {
      xendit_invoice_id: "xnd-d",
    });
    const before = await t.run((ctx) => ctx.db.get(s.txn));
    await t.mutation(internal.payments.internal._onPaidWebhook_internal, {
      xendit_invoice_id: "xnd-d",
    });
    const after = await t.run(async (ctx) => ({
      txn: await ctx.db.get(s.txn),
      movements: await ctx.db.query("pos_stock_movements").collect(),
    }));
    expect(after.txn?.receipt_number).toBe(before?.receipt_number);
    expect(after.movements.length).toBe(1);
  });
});
