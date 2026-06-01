import { convexTest } from "convex-test";
import { describe, it, expect } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

/**
 * ADR-039 end-to-end refund-projection contract:
 *  - GET /r/<token> before any refund → "LUNAS"
 *  - Commit a partial refund → status flips to "SEBAGIAN DIKEMBALIKAN"; original
 *    line qty + unit_price preserved; "↳ N dari M dikembalikan" annotation shown;
 *    NET DIBAYAR reduced by refund amount; token still works (cache purged).
 *  - Full refund → "DIKEMBALIKAN".
 *  - Customer-facing HTML never leaks "settlement_status", "pending", "settled".
 */

async function seedPaidTxn(
  t: ReturnType<typeof convexTest>,
  opts: {
    token: string;
    subtotal: number;
    voucher: number;
    qty: number;
    unit_price: number;
  },
) {
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      code: "S-RP", name: "RP", role: "staff", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    const mgrId = await ctx.db.insert("staff", {
      code: "M-RP", name: "M", role: "manager", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    const productId = await ctx.db.insert("pos_products", {
      sku_family: "dubai", code: "DUB1", name: "Dubai 1pc", pack_label: "1pc",
      price_idr: opts.unit_price, active: true, sort_order: 0, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(),
    });
    const total = opts.subtotal - opts.voucher;
    const txnId = await ctx.db.insert("pos_transactions", {
      status: "paid",
      subtotal: opts.subtotal, voucher_discount: opts.voucher, total,
      flags: 0, staff_id: staffId,
      created_at: Date.now(), paid_at: Date.now(),
      receipt_number: "R-2026-PROJ",
      receipt_token: opts.token,
    });
    const lineId = await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txnId, product_id: productId,
      product_code_snapshot: "DUB1", product_name_snapshot: "Dubai 1pc",
      unit_price_snapshot: opts.unit_price, tax_rate_snapshot: 0,
      qty: opts.qty, line_subtotal: opts.qty * opts.unit_price,
    });
    return { staffId, mgrId, txnId, lineId };
  });
}

describe("receipt refund-projection (ADR-039)", () => {
  it("partial refund: status header flips paid → SEBAGIAN DIKEMBALIKAN; net retained correct; token stable", async () => {
    const t = convexTest(schema);
    const token = "tok-projection-partial";
    // 3 × Rp50_000 = 150_000, no voucher → total 150_000.
    const { txnId, staffId, mgrId, lineId } = await seedPaidTxn(t, {
      token,
      subtotal: 150000,
      voucher: 0,
      qty: 3,
      unit_price: 50000,
    });

    // Step 1: pre-refund render → status "LUNAS".
    const r1 = await t.fetch(`/r/${token}`, { method: "GET" });
    expect(r1.status).toBe(200);
    const body1 = await r1.text();
    expect(body1).toContain("LUNAS");
    expect(body1).not.toContain("SEBAGIAN DIKEMBALIKAN");

    // Step 2: commit a partial refund (1 of 3 units).
    await t.mutation(internal.refunds.internal._commitRefund_internal, {
      idempotencyKey: "receipts-refund-projection-1",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 1 }],
      reason: "wrong order",
      requestedBy: staffId,
      approverId: mgrId,
      approvalSource: "booth_inline",
    });

    // Step 3: post-refund render → status flips.
    const r2 = await t.fetch(`/r/${token}`, { method: "GET" });
    expect(r2.status).toBe(200);
    const body2 = await r2.text();

    expect(body2).toContain("SEBAGIAN DIKEMBALIKAN");
    expect(body2).not.toContain("LUNAS");

    // Original line preserved: "3 ×" + product name + per-unit price.
    expect(body2).toContain("3 ×");
    expect(body2).toContain("Dubai 1pc");
    // Refund annotation: "↳ 1 dari 3 dikembalikan"
    expect(body2).toContain("1 dari 3 dikembalikan");

    // Net retained: total 150_000 - refund 50_000 = 100_000 ("Rp 100.000").
    expect(body2).toContain("NET DIBAYAR");
    expect(body2).toContain("Rp 100.000");
    // Original total still shown as "Total awal".
    expect(body2).toContain("Total awal");

    // Token stable: same /r/<token> still works.
    const r3 = await t.fetch(`/r/${token}`, { method: "GET" });
    expect(r3.status).toBe(200);

    // Customer receipt MUST NOT leak settlement bookkeeping.
    expect(body2).not.toMatch(/settlement_status|settled/);
    // "pending" word check: we allow false positives only if the substring
    // never appears at all — net retained block uses "NET DIBAYAR", refund
    // block uses "Pengembalian", neither uses "pending".
    expect(body2.toLowerCase()).not.toContain("pending");
  });

  it("full refund (all units): status flips → DIKEMBALIKAN; token still resolves", async () => {
    const t = convexTest(schema);
    const token = "tok-projection-full";
    const { txnId, staffId, mgrId, lineId } = await seedPaidTxn(t, {
      token,
      subtotal: 100000,
      voucher: 0,
      qty: 2,
      unit_price: 50000,
    });

    // Pre-render to seed cache.
    const r1 = await t.fetch(`/r/${token}`, { method: "GET" });
    expect(r1.status).toBe(200);
    expect(await r1.text()).toContain("LUNAS");

    // Full refund: both units.
    await t.mutation(internal.refunds.internal._commitRefund_internal, {
      idempotencyKey: "receipts-refund-projection-full-1",
      transactionId: txnId,
      lines: [{ line_id: lineId, qty: 2 }],
      reason: "all wrong",
      requestedBy: staffId,
      approverId: mgrId,
      approvalSource: "booth_inline",
    });

    const r2 = await t.fetch(`/r/${token}`, { method: "GET" });
    expect(r2.status).toBe(200);
    const body2 = await r2.text();
    // Exact label: DIKEMBALIKAN (not SEBAGIAN DIKEMBALIKAN).
    expect(body2).toContain("DIKEMBALIKAN");
    expect(body2).not.toContain("SEBAGIAN DIKEMBALIKAN");
    expect(body2).not.toContain("LUNAS");
    // Annotation shows full count: 2 dari 2.
    expect(body2).toContain("2 dari 2 dikembalikan");
    // NET DIBAYAR = 0.
    expect(body2).toContain("Rp 0");
    // Settlement words still absent.
    expect(body2).not.toMatch(/settlement_status|settled/);
    expect(body2.toLowerCase()).not.toContain("pending");
  });
});
