import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

describe("vouchers admin queries", () => {
  it("listAllVouchers includes archived; rejects non-manager", async () => {
    const t = convexTest(schema);
    const { sessionId: mSid, outletId } = await seedManagerSession(t);
    await t.run(async (ctx) =>
      ctx.db.insert("pos_vouchers", {
        code: "A",
        type: "amount",
        value: 1,
        used_count: 0,
        active: true,
        created_at: 1,
        outlet_id: outletId,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("pos_vouchers", {
        code: "B",
        type: "amount",
        value: 1,
        used_count: 0,
        active: false,
        created_at: 2,
        outlet_id: outletId,
      }),
    );
    const rows = await t.query(api.vouchers.public.listAllVouchers, { sessionId: mSid });
    expect(rows.map((r) => r.code).sort()).toEqual(["A", "B"]);

    // Non-manager rejected
    const staff = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "S",
        code: "S-0002",
        role: "staff",
        active: true,
        pin_hash: "x",
        created_at: Date.now(),
      }),
    );
    const sSid = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staff,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      }),
    );
    await expect(
      t.query(api.vouchers.public.listAllVouchers, { sessionId: sSid }),
    ).rejects.toThrow();
  });

  it("getVoucherRedemptions annotates receipt_number; limit bounded", async () => {
    const t = convexTest(schema);
    const { managerId, sessionId: sid, outletId } = await seedManagerSession(t);
    const vid = await t.run(async (ctx) =>
      ctx.db.insert("pos_vouchers", {
        code: "V",
        type: "amount",
        value: 1000,
        used_count: 1,
        active: true,
        created_at: Date.now(),
        outlet_id: outletId,
      }),
    );
    const txn = await t.run(async (ctx) =>
      ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 5000,
        total: 4000,
        flags: 0,
        receipt_number: "R-2026-0001",
        voucher_discount: 1000,
        paid_at: Date.now(),
        created_at: Date.now(),
        staff_id: managerId,
        outlet_id: outletId,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("pos_voucher_redemptions", {
        voucher_id: vid,
        transaction_id: txn,
        code_snapshot: "V",
        discount_amount: 1000,
        redeemed_at: Date.now(),
        outlet_id: outletId,
      }),
    );

    const rows = await t.query(api.vouchers.public.getVoucherRedemptions, {
      sessionId: sid,
      voucherId: vid,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].receipt_number).toBe("R-2026-0001");
    expect(rows[0].discount_amount).toBe(1000);

    // Limit bound
    await expect(
      t.query(api.vouchers.public.getVoucherRedemptions, {
        sessionId: sid,
        voucherId: vid,
        limit: 501,
      }),
    ).rejects.toThrow(/LIMIT/);
  });
});
