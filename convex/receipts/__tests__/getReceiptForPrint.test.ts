import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

async function seedStaff(t: ReturnType<typeof convexTest>, role: "staff" | "manager") {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "Ali", code: "S-0001", pin_hash: "x", role, active: true, created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "dev-1",
      started_at: Date.now(), ended_at: null, end_reason: null,
    });
    return { staffId, sessionId };
  });
}

async function seedPaidTxn(t: ReturnType<typeof convexTest>, staffId: Id<"staff">, createdAt: number) {
  return await t.run(async (ctx) => {
    // convex-test validates Id<> references on insert, so a real pos_products
    // row is required (the prior "px" cast fails reference validation, not the
    // query under test).
    const productId = await ctx.db.insert("pos_products", {
      sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "8pcs", price_idr: 25_000,
      active: true, sort_order: 0, tax_rate: 0, created_at: createdAt, updated_at: createdAt,
    });
    const txnId = await ctx.db.insert("pos_transactions", {
      status: "paid", subtotal: 25_000, voucher_discount: 0, total: 25_000,
      flags: 0, staff_id: staffId, created_at: createdAt, paid_at: createdAt,
      receipt_number: "R-2026-0042", receipt_token: "tok_" + "a".repeat(40),
    });
    await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txnId, product_id: productId,
      product_code_snapshot: "DUB8", product_name_snapshot: "Dubai 8pcs",
      unit_price_snapshot: 25_000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 25_000,
    });
    await ctx.db.insert("pos_xendit_invoices", {
      transaction_id: txnId, xendit_invoice_id: "qr-1", xendit_idempotency_key: "ik-1",
      method: "QRIS", qr_string: "0002...", status_at_create: "PENDING", created_at: createdAt,
    });
    return txnId;
  });
}

describe("getReceiptForPrint", () => {
  it("defaults the receipt footer to the English 'Thank you!' when no pos_settings row exists", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seedStaff(t, "staff");
    const txnId = await seedPaidTxn(t, staffId, Date.now());
    const res = await t.query(api.receipts.public.getReceiptForPrint, { sessionId, txnId });
    expect(res!.viewModel.settings.footer_text).toBe("Thank you!");
    expect(res!.viewModel.settings.business_name).toBe("FROLLIE");
  });

  it("returns view-model + status label for a paid txn (staff, today)", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seedStaff(t, "staff");
    const txnId = await seedPaidTxn(t, staffId, Date.now());
    const res = await t.query(api.receipts.public.getReceiptForPrint, { sessionId, txnId });
    expect(res).not.toBeNull();
    expect(res!.viewModel.receipt_number).toBe("R-2026-0042");
    expect(res!.status).toBe("paid");
    expect(res!.statusLabel).toBe("LUNAS");
    expect(JSON.stringify(res)).not.toContain("tok_");
  });

  it("returns null for an invalid session", async () => {
    const t = convexTest(schema);
    const { staffId } = await seedStaff(t, "staff");
    const txnId = await seedPaidTxn(t, staffId, Date.now());
    const fake = await t.run(async (ctx) => {
      const id = await ctx.db.insert("staff_sessions", {
        staff_id: staffId, device_id: "d", started_at: Date.now(),
        ended_at: Date.now(), end_reason: "manual_lock",
      });
      return id;
    });
    const res = await t.query(api.receipts.public.getReceiptForPrint, { sessionId: fake, txnId });
    expect(res).toBeNull();
  });

  it("returns null for a staff member reading a txn outside server-today", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seedStaff(t, "staff");
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const txnId = await seedPaidTxn(t, staffId, twoDaysAgo);
    const res = await t.query(api.receipts.public.getReceiptForPrint, { sessionId, txnId });
    expect(res).toBeNull();
  });

  it("allows a manager to read an older txn", async () => {
    const t = convexTest(schema);
    const { staffId } = await seedStaff(t, "staff");
    const { sessionId: mgrSession } = await seedStaff(t, "manager");
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const txnId = await seedPaidTxn(t, staffId, twoDaysAgo);
    const res = await t.query(api.receipts.public.getReceiptForPrint, { sessionId: mgrSession, txnId });
    expect(res).not.toBeNull();
  });
});
