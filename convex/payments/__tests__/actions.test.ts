import { describe, it, expect, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import {
  installFetchMock,
  _xenditMockReset,
  _xenditMockNextResponse,
  _xenditMockCalls,
} from "./_xenditMock";

beforeEach(() => {
  _xenditMockReset();
  installFetchMock();
  process.env.XENDIT_SECRET_KEY = "xnd_test_fake";
  process.env.XENDIT_CALLBACK_TOKEN = "tok-fake";
});

async function seedAwaiting(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const staff = await ctx.db.insert("staff", {
      name: "L", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
    });
    const session = await ctx.db.insert("staff_sessions", {
      staff_id: staff, device_id: "d", started_at: Date.now(),
      ended_at: null, end_reason: null,
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
    return { staff, session, txn };
  });
}

describe("payments/actions.requestPayment", () => {
  it("QRIS: posts to Xendit with X-IDEMPOTENCY-KEY, persists invoice, returns qrString", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    _xenditMockNextResponse({
      id: "xnd-real-1",
      qr_string: "00020101021126...",
      status: "ACTIVE",
    });
    const key = `pay-${Date.now()}`;
    const r = await t.action(api.payments.actions.requestPayment, {
      sessionId: s.session,
      txnId: s.txn,
      method: "QRIS",
      idempotencyKey: key,
    });
    expect(r.invoiceId).toBeDefined();
    expect(r.qrString).toBe("00020101021126...");

    const calls = _xenditMockCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/qr_codes");
    expect(calls[0].headers["api-version"]).toBe("2022-07-31");
    expect(calls[0].headers["X-IDEMPOTENCY-KEY"]).toBe(key);
    expect(calls[0].body.type).toBe("DYNAMIC");
    expect(calls[0].body.reference_id).toBe(`pos-${s.txn}`);
  });

  it("staffreview Critical #1: retry with same idempotencyKey forwards same X-IDEMPOTENCY-KEY to Xendit AND deduplicates Convex-side", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    _xenditMockNextResponse({
      id: "xnd-dedup",
      qr_string: "qr-dedup",
      status: "ACTIVE",
    });
    const key = "pay-critical-1";
    const r1 = await t.action(api.payments.actions.requestPayment, {
      sessionId: s.session, txnId: s.txn, method: "QRIS", idempotencyKey: key,
    });
    // Re-arm mock — if action actually re-calls Xendit, the new response would be served
    _xenditMockNextResponse({
      id: "xnd-WRONG",
      qr_string: "qr-WRONG",
      status: "ACTIVE",
    });
    const r2 = await t.action(api.payments.actions.requestPayment, {
      sessionId: s.session, txnId: s.txn, method: "QRIS", idempotencyKey: key,
    });
    expect(r1.invoiceId).toBe(r2.invoiceId);
    expect(r2.qrString).toBe("qr-dedup"); // cached, not "qr-WRONG"

    // The second attempt never reaches Xendit — the Convex-side idempotency
    // cache hit short-circuits before any HTTP. The single call that DID reach
    // Xendit carried the key. This is the stronger guarantee: one invoice on
    // both sides.
    const calls = _xenditMockCalls();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/qr_codes");
    expect(calls[0].headers["X-IDEMPOTENCY-KEY"]).toBe(key);

    const invoices = await t.run((ctx) =>
      ctx.db.query("pos_xendit_invoices").collect(),
    );
    expect(invoices.length).toBe(1);
  });

  it("BCA_VA: posts to Xendit FVA endpoint, returns vaNumber", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    _xenditMockNextResponse({ id: "va_real_1", account_number: "1080099887", status: "PENDING" });
    const r = await t.action(api.payments.actions.requestPayment, {
      sessionId: s.session, txnId: s.txn, method: "BCA_VA", idempotencyKey: "k-bca",
    });
    expect(r.vaNumber).toBe("1080099887");
    const calls = _xenditMockCalls();
    expect(calls[0].url).toContain("/callback_virtual_accounts");
    expect(calls[0].body.bank_code).toBe("BCA");
    expect(calls[0].body.is_closed).toBe(true);
    expect(calls[0].body.is_single_use).toBe(true);
    expect(calls[0].body.expected_amount).toBe(25_000);
  });

  it("BCA_VA: a Xendit 4xx surfaces as XENDIT_VA_FAILED and persists nothing", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    _xenditMockNextResponse({ error_code: "BAD" }, 400);
    await expect(
      t.action(api.payments.actions.requestPayment, {
        sessionId: s.session, txnId: s.txn, method: "BCA_VA",
        idempotencyKey: `va-fail-${Date.now()}`,
      }),
    ).rejects.toThrow(/XENDIT_VA_FAILED/);
    const invoices = await t.run((ctx) => ctx.db.query("pos_xendit_invoices").collect());
    expect(invoices.length).toBe(0);
  });

  it("QRIS: a Xendit 4xx surfaces as XENDIT_QR_FAILED and persists nothing", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    _xenditMockNextResponse({ error_code: "BAD" }, 400);
    await expect(
      t.action(api.payments.actions.requestPayment, {
        sessionId: s.session, txnId: s.txn, method: "QRIS",
        idempotencyKey: `pay-fail-${Date.now()}`,
      }),
    ).rejects.toThrow(/XENDIT_QR_FAILED/);
    const invoices = await t.run((ctx) => ctx.db.query("pos_xendit_invoices").collect());
    expect(invoices.length).toBe(0);
  });

  it("throws SESSION_INVALID when the session has ended (C3 — no invoice for a terminated session)", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.session, { ended_at: Date.now(), end_reason: "manual_lock" });
    });
    await expect(
      t.action(api.payments.actions.requestPayment, {
        sessionId: s.session, txnId: s.txn, method: "QRIS", idempotencyKey: "k-sess-ended",
      }),
    ).rejects.toThrow("SESSION_INVALID");
    // And it never reached Xendit.
    expect(_xenditMockCalls().length).toBe(0);
  });
});

describe("payments/actions.retryWithFreshInvoice", () => {
  it("retryWithFreshInvoice throws PREV_INVOICE_MISSING when no prior invoice exists", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    await expect(
      t.action(api.payments.actions.retryWithFreshInvoice, {
        sessionId: s.session, txnId: s.txn, method: "QRIS", idempotencyKey: "k-noprev",
      }),
    ).rejects.toThrow("PREV_INVOICE_MISSING");
  });

  it("throws SESSION_INVALID when the session has ended (C3)", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.session, { ended_at: Date.now(), end_reason: "manual_lock" });
    });
    await expect(
      t.action(api.payments.actions.retryWithFreshInvoice, {
        sessionId: s.session, txnId: s.txn, method: "QRIS", idempotencyKey: "k-retry-ended",
      }),
    ).rejects.toThrow("SESSION_INVALID");
  });

  it("retryWithFreshInvoice: QRIS mints a fresh QR with a unique ref and no expire call", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    _xenditMockNextResponse({ id: "qr_first", qr_string: "qr1", status: "ACTIVE" });
    await t.action(api.payments.actions.requestPayment, {
      sessionId: s.session, txnId: s.txn, method: "QRIS", idempotencyKey: "init-1",
    });
    _xenditMockReset(); // clears recorded calls; the fetch mock from beforeEach stays installed
    _xenditMockNextResponse({ id: "qr_second", qr_string: "qr2", status: "ACTIVE" });
    const r = await t.action(api.payments.actions.retryWithFreshInvoice, {
      sessionId: s.session, txnId: s.txn, method: "QRIS", idempotencyKey: "retry-1",
    });
    expect(r.qrString).toBe("qr2");
    const calls = _xenditMockCalls();
    expect(calls.every((c) => !c.url.includes("expire"))).toBe(true);
    expect(calls[0].url).toContain("/qr_codes");
    expect(calls[0].body.reference_id).toContain("-r-");

    // Decision E: the prior invoice is superseded LOCALLY (no remote expire).
    const rows = await t.run((ctx) => ctx.db.query("pos_xendit_invoices").collect());
    expect(rows.length).toBe(2);
    const prior = rows.find((row) => row.xendit_invoice_id === "qr_first")!;
    const fresh = rows.find((row) => row.xendit_invoice_id === "qr_second")!;
    expect(prior.cancelled_at).toBeDefined();
    expect(prior.replaced_by_invoice_id).toBe(fresh._id);
  });
});

describe("payments/actions.manuallyConfirmPayment", () => {
  it("argon2id-verifies manager PIN and funnels to _confirmPaid with source=manual", async () => {
    const t = convexTest(schema);
    const s = await seedAwaiting(t);
    // Need a real hash on staff for this test, and that staff must own the
    // session used by manuallyConfirmPayment (the actor is resolved from the
    // session, not from the seeded "L" staff). Seed a manager with a real
    // argon2id hash, then point the session at that staff.
    const realStaffId = await t.action(
      internal.auth.actions._seedHashedStaff_internal,
      { name: "Lucas", pin: "9999", role: "manager" },
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(s.session, { staff_id: realStaffId });
    });
    const r = await t.action(api.payments.actions.manuallyConfirmPayment, {
      sessionId: s.session, txnId: s.txn, managerPin: "9999",
      reason: "Customer showed BCA app paid screen", idempotencyKey: "k-mc",
    });
    expect(r.confirmed).toBe(true);
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.confirmed_via).toBe("manual");
    expect(txn?.confirmed_mgr_approver_id).toBe(realStaffId);
  });
});
