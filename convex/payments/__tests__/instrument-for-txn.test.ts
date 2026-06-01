import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedTxn(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Sari", role: "staff", active: true, pin_hash: "x", code: "S1", created_at: 0,
    } as any);
    return await ctx.db.insert("pos_transactions", {
      status: "paid", subtotal: 1000, voucher_discount: 0, total: 1000,
      flags: 0, staff_id: staffId, created_at: 0, paid_at: 1,
    } as any);
  });
}

describe("_instrumentForTxn_internal", () => {
  it("returns 'unknown' when there are no invoice rows", async () => {
    const t = convexTest(schema);
    const txnId = await seedTxn(t);
    const r = await t.query(internal.payments.internal._instrumentForTxn_internal, { txnId });
    expect(r).toBe("unknown");
  });

  it("returns 'qris' for a non-cancelled QRIS invoice", async () => {
    const t = convexTest(schema);
    const txnId = await seedTxn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: txnId, xendit_invoice_id: "qr_1", xendit_idempotency_key: "k1",
        method: "QRIS", status_at_create: "ACTIVE", created_at: 100,
      } as any);
    });
    const r = await t.query(internal.payments.internal._instrumentForTxn_internal, { txnId });
    expect(r).toBe("qris");
  });

  it("returns 'bca_va' for a non-cancelled BCA_VA invoice", async () => {
    const t = convexTest(schema);
    const txnId = await seedTxn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: txnId, xendit_invoice_id: "va_1", xendit_idempotency_key: "k2",
        method: "BCA_VA", status_at_create: "PENDING", created_at: 100,
      } as any);
    });
    const r = await t.query(internal.payments.internal._instrumentForTxn_internal, { txnId });
    expect(r).toBe("bca_va");
  });

  it("still returns 'qris' even if the invoice was later cancelled", async () => {
    // I3: matches receipt semantics (_getPaidInvoiceForTxn_internal also
    // ignores cancelled_at). The customer paid via this instrument regardless
    // of whether refunds later stamp cancelled_at on the paying invoice.
    const t = convexTest(schema);
    const txnId = await seedTxn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: txnId, xendit_invoice_id: "qr_old", xendit_idempotency_key: "k3",
        method: "QRIS", status_at_create: "ACTIVE", created_at: 50,
        cancelled_at: 60, cancelled_reason: "superseded",
      } as any);
    });
    const r = await t.query(internal.payments.internal._instrumentForTxn_internal, { txnId });
    expect(r).toBe("qris");
  });

  it("picks the most recently created invoice (cancelled state ignored — matches receipt semantics)", async () => {
    const t = convexTest(schema);
    const txnId = await seedTxn(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: txnId, xendit_invoice_id: "qr_old", xendit_idempotency_key: "k1",
        method: "QRIS", status_at_create: "ACTIVE", created_at: 50,
        cancelled_at: 60, cancelled_reason: "superseded",
      } as any);
      await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: txnId, xendit_invoice_id: "va_new", xendit_idempotency_key: "k2",
        method: "BCA_VA", status_at_create: "PENDING", created_at: 100,
      } as any);
    });
    const r = await t.query(internal.payments.internal._instrumentForTxn_internal, { txnId });
    expect(r).toBe("bca_va");
  });
});
