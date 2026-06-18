import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { VOUCHER_OVER_REDEEMED, PAYMENT_AMOUNT_MISMATCH } from "../flags";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

// v1.0.1: task 10 — ticker hook test uses drainScheduled to flush ticker
// after asserting the scheduled count, so setupTelegramStub is also needed here.

// _checkLowStock_internal schedules a Telegram dispatch via runAfter(0) when
// on_hand crosses below low_threshold. setupTelegramStub() stubs fetch + env so
// the scheduled action is offline + deterministic. drainScheduled() flushes any
// pending dispatches before teardown.
setupTelegramStub();

async function seedTxnAwaiting(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const dubai = await ctx.db.insert("pos_inventory_skus", {
      sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 0,
      active: true, created_at: Date.now(),
    });
    const p = await ctx.db.insert("pos_products", {
      sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pc", pack_label: "8pc",
      price_idr: 200_000, active: true, sort_order: 1, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(),
    });
    await ctx.db.insert("pos_product_components", {
      product_id: p, inventory_sku_id: dubai, qty: 8,
    });
    await ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: dubai, on_hand: 100, updated_at: Date.now(),
    });
    const staff = await ctx.db.insert("staff", {
      name: "Lucas", code: "S-0001", pin_hash: "$argon2id$x", role: "manager", active: true, created_at: Date.now(),
    });
    const txn = await ctx.db.insert("pos_transactions", {
      status: "awaiting_payment", subtotal: 200_000, voucher_discount: 0,
      total: 200_000, flags: 0, staff_id: staff, created_at: Date.now(),
    });
    const line = await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txn, product_id: p,
      product_code_snapshot: "DBP8", product_name_snapshot: "Dubai 8pc",
      unit_price_snapshot: 200_000, tax_rate_snapshot: 0,
      qty: 1, line_subtotal: 200_000,
    });
    return { txn, line, p, dubai, staff };
  });
}

/**
 * Like seedTxnAwaiting, but also seeds a voucher row and stamps the txn's
 * voucher_code_snapshot + voucher_discount so the funnel's step-6 voucher
 * coordination is exercised end-to-end. The snapshot code is uppercase to
 * match the stored voucher.code (the funnel uppercases before lookup).
 */
async function seedTxnAwaitingWithVoucher(
  t: ReturnType<typeof convexTest>,
  voucher: {
    code: string;
    type: "percentage" | "amount";
    value: number;
    max_redemptions: number;
    used_count: number;
  },
  voucherDiscount: number,
) {
  return await t.run(async (ctx) => {
    const dubai = await ctx.db.insert("pos_inventory_skus", {
      sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 0,
      active: true, created_at: Date.now(),
    });
    const p = await ctx.db.insert("pos_products", {
      sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pc", pack_label: "8pc",
      price_idr: 200_000, active: true, sort_order: 1, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(),
    });
    await ctx.db.insert("pos_product_components", {
      product_id: p, inventory_sku_id: dubai, qty: 8,
    });
    await ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: dubai, on_hand: 100, updated_at: Date.now(),
    });
    const staff = await ctx.db.insert("staff", {
      name: "Lucas", code: "S-0001", pin_hash: "$argon2id$x", role: "manager", active: true, created_at: Date.now(),
    });
    const voucherId = await ctx.db.insert("pos_vouchers", {
      code: voucher.code,
      type: voucher.type,
      value: voucher.value,
      max_redemptions: voucher.max_redemptions,
      used_count: voucher.used_count,
      active: true,
      created_at: Date.now(),
    });
    const total = 200_000 - voucherDiscount;
    const txn = await ctx.db.insert("pos_transactions", {
      status: "awaiting_payment", subtotal: 200_000,
      voucher_code_snapshot: voucher.code, voucher_discount: voucherDiscount,
      total, flags: 0, staff_id: staff, created_at: Date.now(),
    });
    await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txn, product_id: p,
      product_code_snapshot: "DBP8", product_name_snapshot: "Dubai 8pc",
      unit_price_snapshot: 200_000, tax_rate_snapshot: 0,
      qty: 1, line_subtotal: 200_000,
    });
    return { txn, p, dubai, staff, voucherId };
  });
}

describe("_confirmPaid_internal funnel", () => {
  it("source=webhook: flips to paid, allocates receipt_number, writes movement, sets confirmed_via", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaiting(t);
    await t.mutation(internal.transactions.internal._confirmPaid_internal, { txnId: s.txn, source: "webhook" });
    const after = await t.run(async (ctx) => {
      const txn = await ctx.db.get(s.txn);
      const movements = await ctx.db.query("pos_stock_movements").collect();
      return { txn, movements };
    });
    expect(after.txn?.status).toBe("paid");
    expect(after.txn?.receipt_number).toMatch(/^R-\d{4}-\d{4}$/);
    expect(after.txn?.confirmed_via).toBe("webhook");
    expect(after.txn?.paid_at).toBeGreaterThan(0);
    expect(after.movements.length).toBe(1);
    expect(after.movements[0].qty).toBe(-8);
    // v1.0.1: drain the scheduled sendTxnTicker to avoid post-test write errors
    await drainScheduled(t);
  });

  it("source=manual: records mgr_approver_id + manual_reason", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaiting(t);
    await t.mutation(internal.transactions.internal._confirmPaid_internal, {
      txnId: s.txn, source: "manual", mgr_approver_id: s.staff,
      manual_reason: "BCA transferred but webhook lost",
    });
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.confirmed_via).toBe("manual");
    expect(txn?.confirmed_mgr_approver_id).toBe(s.staff);
    expect(txn?.confirmed_manual_reason).toBe("BCA transferred but webhook lost");
    await drainScheduled(t);
  });

  it("idempotent re-fire: second _confirmPaid call is a no-op (status guard)", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaiting(t);
    await t.mutation(internal.transactions.internal._confirmPaid_internal, { txnId: s.txn, source: "webhook" });
    const r1 = await t.run((ctx) => ctx.db.get(s.txn));
    await t.mutation(internal.transactions.internal._confirmPaid_internal, { txnId: s.txn, source: "polling" });
    const r2 = await t.run(async (ctx) => ({
      txn: await ctx.db.get(s.txn),
      movements: await ctx.db.query("pos_stock_movements").collect(),
    }));
    expect(r2.txn?.confirmed_via).toBe("webhook");
    expect(r2.txn?.receipt_number).toBe(r1?.receipt_number);
    expect(r2.movements.length).toBe(1);
    await drainScheduled(t);
  });

  it("re-checks NEG_STOCK at confirm: between commit and confirm, stock drained → flag fires", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaiting(t);
    // Drain stock to 5; transaction needs 8 → after decrement on_hand = -3
    await t.run(async (ctx) => {
      const lvl = await ctx.db.query("pos_stock_levels")
        .withIndex("by_sku", (q) => q.eq("inventory_sku_id", s.dubai)).first();
      await ctx.db.patch(lvl!._id, { on_hand: 5 });
    });
    await t.mutation(internal.transactions.internal._confirmPaid_internal, { txnId: s.txn, source: "webhook" });
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.flags).toBe(1);
    // on_hand drains from 5 → -3, threshold 0 → -3 < 0 schedules low-stock dispatch.
    await drainScheduled(t);
  });

  it("voucher redeemed through funnel: redemption row written, used_count incremented, no over-redeem flag", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaitingWithVoucher(
      t,
      { code: "WELCOME10", type: "percentage", value: 10, max_redemptions: 100, used_count: 0 },
      20_000,
    );
    await t.mutation(internal.transactions.internal._confirmPaid_internal, { txnId: s.txn, source: "webhook" });
    const after = await t.run(async (ctx) => {
      const txn = await ctx.db.get(s.txn);
      const voucher = await ctx.db.get(s.voucherId);
      const redemption = await ctx.db
        .query("pos_voucher_redemptions")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", s.txn))
        .first();
      return { txn, voucher, redemption };
    });
    expect(after.txn?.status).toBe("paid");
    expect(after.redemption).not.toBeNull();
    expect(after.redemption?.discount_amount).toBe(20_000);
    expect(after.voucher?.used_count).toBe(1);
    expect(after.txn!.flags & VOUCHER_OVER_REDEEMED).toBe(0);
    await drainScheduled(t);
  });

  it("paid_amount mismatch: honors payment but sets PAYMENT_AMOUNT_MISMATCH flag", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaiting(t); // seeds total = 200_000
    await t.mutation(internal.transactions.internal._confirmPaid_internal, {
      txnId: s.txn, source: "webhook", paid_amount: 199_000,
    });
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("paid");
    expect(txn!.flags & PAYMENT_AMOUNT_MISMATCH).toBe(PAYMENT_AMOUNT_MISMATCH);
    await drainScheduled(t);
  });

  it("paid_amount matching total: no mismatch flag", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaiting(t);
    await t.mutation(internal.transactions.internal._confirmPaid_internal, {
      txnId: s.txn, source: "webhook", paid_amount: 200_000,
    });
    const txn = await t.run((ctx) => ctx.db.get(s.txn));
    expect(txn?.status).toBe("paid");
    expect(txn!.flags & PAYMENT_AMOUNT_MISMATCH).toBe(0);
    await drainScheduled(t);
  });

  it("over-redeemed voucher through funnel: VOUCHER_OVER_REDEEMED flag set, no redemption row", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaitingWithVoucher(
      t,
      { code: "ONESHOT", type: "amount", value: 5_000, max_redemptions: 1, used_count: 1 },
      5_000,
    );
    await t.mutation(internal.transactions.internal._confirmPaid_internal, { txnId: s.txn, source: "webhook" });
    const after = await t.run(async (ctx) => {
      const txn = await ctx.db.get(s.txn);
      const redemption = await ctx.db
        .query("pos_voucher_redemptions")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", s.txn))
        .first();
      return { txn, redemption };
    });
    expect(after.txn?.status).toBe("paid");
    expect(after.txn!.flags & VOUCHER_OVER_REDEEMED).toBe(VOUCHER_OVER_REDEEMED);
    expect(after.redemption).toBeNull();
    await drainScheduled(t);
  });

  // v1.0.1 Task 10: ticker hook — exactly one scheduled sendTxnTicker per paid
  // transition; re-fire (status guard) does NOT schedule a second one.
  it("schedules exactly one ticker on paid transition, none on re-fire", async () => {
    const t = convexTest(schema);
    const s = await seedTxnAwaiting(t);

    // First confirm → paid transition
    await t.mutation(internal.transactions.internal._confirmPaid_internal, {
      txnId: s.txn, source: "webhook",
    });

    // Re-fire — status guard makes this a no-op (no new ticker scheduled)
    await t.mutation(internal.transactions.internal._confirmPaid_internal, {
      txnId: s.txn, source: "webhook",
    });

    // Assert exactly one sendTxnTicker scheduled via the _scheduled_functions system table
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const tickers = scheduled.filter((s) =>
      (s.name as string).includes("sendTxnTicker"),
    );
    expect(tickers).toHaveLength(1);

    // Drain to avoid unhandled-rejection after teardown
    await drainScheduled(t);
  });
});
