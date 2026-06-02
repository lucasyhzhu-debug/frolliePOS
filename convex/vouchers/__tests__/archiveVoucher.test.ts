import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

describe("vouchers.archiveVoucher", () => {
  it("sets active:false; preserves redemption rows; audits voucher.deactivated", async () => {
    const t = convexTest(schema);
    const { managerId, sessionId: sid } = await seedManagerSession(t);
    const vid = await t.run(async (ctx) =>
      ctx.db.insert("pos_vouchers", {
        code: "V",
        type: "amount",
        value: 1000,
        used_count: 1,
        active: true,
        created_at: Date.now(),
      }),
    );
    const txn = await t.run(async (ctx) =>
      ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 5000,
        total: 4000,
        flags: 0,
        voucher_code_snapshot: "V",
        voucher_discount: 1000,
        paid_at: Date.now(),
        created_at: Date.now(),
        staff_id: managerId,
      }),
    );
    const red = await t.run(async (ctx) =>
      ctx.db.insert("pos_voucher_redemptions", {
        voucher_id: vid,
        transaction_id: txn,
        code_snapshot: "V",
        discount_amount: 1000,
        redeemed_at: Date.now(),
      }),
    );

    await t.mutation(api.vouchers.public.archiveVoucher, {
      idempotencyKey: "k1",
      sessionId: sid,
      voucherId: vid,
    });
    const row = await t.run(async (ctx) => ctx.db.get(vid));
    expect(row?.active).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.get(red))).toBeTruthy(); // redemption intact

    // Double-archive no-op — different idempotencyKey to force handler entry.
    await t.mutation(api.vouchers.public.archiveVoucher, {
      idempotencyKey: "k2",
      sessionId: sid,
      voucherId: vid,
    });
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "voucher.deactivated"))
        .collect(),
    );
    expect(audits.length).toBe(1);
  });

  it("throws VOUCHER_NOT_FOUND for non-existent id", async () => {
    const t = convexTest(schema);
    const { sessionId: sid } = await seedManagerSession(t);
    const fakeId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("pos_vouchers", {
        code: "TEMP",
        type: "amount",
        value: 1,
        used_count: 0,
        active: true,
        created_at: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    await expect(
      t.mutation(api.vouchers.public.archiveVoucher, {
        idempotencyKey: "k",
        sessionId: sid,
        voucherId: fakeId,
      }),
    ).rejects.toThrow(/VOUCHER_NOT_FOUND/);
  });
});
