import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

async function seedOutlet(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as never),
  );
}

describe("vouchers/public", () => {
  it("getActiveVouchers excludes inactive + expired", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("pos_vouchers", {
        code: "ACTIVE", type: "percentage", value: 10, used_count: 0,
        active: true, expires_at: now + 86400_000, created_at: now, outlet_id: outletId,
      });
      await ctx.db.insert("pos_vouchers", {
        code: "EXPIRED", type: "amount", value: 5_000, used_count: 0,
        active: true, expires_at: now - 1000, created_at: now, outlet_id: outletId,
      });
      await ctx.db.insert("pos_vouchers", {
        code: "INACTIVE", type: "amount", value: 5_000, used_count: 0,
        active: false, created_at: now, outlet_id: outletId,
      });
    });
    const result = await t.query(api.vouchers.public.getActiveVouchers, {});
    expect(result.map((v) => v.code).sort()).toEqual(["ACTIVE"]);
  });

  it("validateVoucher: percentage type computes floor(subtotal * value / 100)", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_vouchers", {
        code: "WELCOME10", type: "percentage", value: 10, used_count: 0,
        active: true, created_at: Date.now(), outlet_id: outletId,
      });
    });
    const result = await t.query(api.vouchers.public.validateVoucher, {
      code: "WELCOME10", cartSubtotal: 95_000,
    });
    expect(result.valid).toBe(true);
    expect(result.discountAmount).toBe(9_500);
  });

  it("validateVoucher: amount type capped at subtotal", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_vouchers", {
        code: "FLAT50K", type: "amount", value: 50_000, used_count: 0,
        active: true, created_at: Date.now(), outlet_id: outletId,
      });
    });
    const result = await t.query(api.vouchers.public.validateVoucher, {
      code: "FLAT50K", cartSubtotal: 30_000,
    });
    expect(result.valid).toBe(true);
    expect(result.discountAmount).toBe(30_000);
  });

  it("validateVoucher: rejects expired", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_vouchers", {
        code: "OLD", type: "amount", value: 5_000, used_count: 0,
        active: true, expires_at: Date.now() - 1000, created_at: Date.now(), outlet_id: outletId,
      });
    });
    const result = await t.query(api.vouchers.public.validateVoucher, {
      code: "OLD", cartSubtotal: 50_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("EXPIRED");
  });

  it("validateVoucher: rejects below min_cart_value", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_vouchers", {
        code: "MIN50K", type: "amount", value: 10_000, used_count: 0,
        min_cart_value: 50_000, active: true, created_at: Date.now(), outlet_id: outletId,
      });
    });
    const result = await t.query(api.vouchers.public.validateVoucher, {
      code: "MIN50K", cartSubtotal: 30_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("MIN_CART_VALUE");
  });

  it("validateVoucher: rejects code not found", async () => {
    const t = convexTest(schema);
    const result = await t.query(api.vouchers.public.validateVoucher, {
      code: "NOPE", cartSubtotal: 50_000,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("NOT_FOUND");
  });
});
