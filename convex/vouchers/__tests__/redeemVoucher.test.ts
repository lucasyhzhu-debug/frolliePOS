import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

/** Insert a minimal staff row so pos_transactions.staff_id validates. */
async function seedStaffId(ctx: any) {
  return ctx.db.insert("staff", {
    name: "Test Staff",
    code: "S-0001",
    pin_hash: "$argon2id$dummy",
    role: "staff",
    active: true,
    created_at: Date.now(),
  });
}

async function seedOutletId(ctx: any) {
  return ctx.db.insert("outlets", { is_open: false,
    code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
    created_at: Date.now(), created_by: null,
  });
}

describe("vouchers/internal._redeemVoucher_internal", () => {
  it("happy path: increments used_count, writes redemption row, returns { overRedeemed: false }", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const staffId = await seedStaffId(ctx);
      const outletId = await seedOutletId(ctx);
      const vId = await ctx.db.insert("pos_vouchers", {
        code: "WELCOME10", type: "percentage", value: 10,
        max_redemptions: 100, used_count: 0,
        active: true, created_at: Date.now(), outlet_id: outletId,
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment", subtotal: 100_000, voucher_discount: 10_000,
        total: 90_000, flags: 0, staff_id: staffId,
        created_at: Date.now(), outlet_id: outletId,
      });
      return { vId, txnId, outletId };
    });

    const result = await t.mutation(internal.vouchers.internal._redeemVoucher_internal, {
      voucher_id: setup.vId, transaction_id: setup.txnId,
      code_snapshot: "WELCOME10", discount_amount: 10_000,
      outletId: setup.outletId,
    });

    expect(result.overRedeemed).toBe(false);
    expect(result.alreadyRedeemed).toBe(false);
    const after = await t.run(async (ctx) => {
      const v = await ctx.db.get(setup.vId);
      const r = await ctx.db.query("pos_voucher_redemptions").collect();
      return { v, r };
    });
    expect(after.v?.used_count).toBe(1);
    expect(after.r.length).toBe(1);
    expect(after.r[0].discount_amount).toBe(10_000);
  });

  it("over-redeem: when used_count >= max_redemptions, returns { overRedeemed: true } and does NOT increment", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const staffId = await seedStaffId(ctx);
      const outletId = await seedOutletId(ctx);
      const vId = await ctx.db.insert("pos_vouchers", {
        code: "ONESHOT", type: "amount", value: 5_000,
        max_redemptions: 1, used_count: 1,
        active: true, created_at: Date.now(), outlet_id: outletId,
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment", subtotal: 20_000, voucher_discount: 5_000,
        total: 15_000, flags: 0, staff_id: staffId,
        created_at: Date.now(), outlet_id: outletId,
      });
      return { vId, txnId, outletId };
    });

    const result = await t.mutation(internal.vouchers.internal._redeemVoucher_internal, {
      voucher_id: setup.vId, transaction_id: setup.txnId,
      code_snapshot: "ONESHOT", discount_amount: 5_000,
      outletId: setup.outletId,
    });

    expect(result.overRedeemed).toBe(true);
    expect(result.alreadyRedeemed).toBe(false);
    const v = await t.run((ctx) => ctx.db.get(setup.vId));
    expect(v?.used_count).toBe(1);
    const rs = await t.run((ctx) => ctx.db.query("pos_voucher_redemptions").collect());
    expect(rs.length).toBe(0);
  });

  it("idempotent re-fire: same transaction_id called twice returns alreadyRedeemed without double-counting", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const staffId = await seedStaffId(ctx);
      const outletId = await seedOutletId(ctx);
      const vId = await ctx.db.insert("pos_vouchers", {
        code: "FLAT20K", type: "amount", value: 20_000,
        max_redemptions: 1, used_count: 0, active: true, created_at: Date.now(), outlet_id: outletId,
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "awaiting_payment", subtotal: 100_000, voucher_discount: 20_000,
        total: 80_000, flags: 0, staff_id: staffId,
        created_at: Date.now(), outlet_id: outletId,
      });
      return { vId, txnId, outletId };
    });

    const r1 = await t.mutation(internal.vouchers.internal._redeemVoucher_internal, {
      voucher_id: setup.vId, transaction_id: setup.txnId,
      code_snapshot: "FLAT20K", discount_amount: 20_000,
      outletId: setup.outletId,
    });
    const r2 = await t.mutation(internal.vouchers.internal._redeemVoucher_internal, {
      voucher_id: setup.vId, transaction_id: setup.txnId,
      code_snapshot: "FLAT20K", discount_amount: 20_000,
      outletId: setup.outletId,
    });

    expect(r1).toEqual({ overRedeemed: false, alreadyRedeemed: false });
    expect(r2).toEqual({ overRedeemed: false, alreadyRedeemed: true });

    const after = await t.run(async (ctx) => ({
      v: await ctx.db.get(setup.vId),
      r: await ctx.db.query("pos_voucher_redemptions").collect(),
    }));
    expect(after.v?.used_count).toBe(1);
    expect(after.r.length).toBe(1);
  });
});
