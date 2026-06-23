import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

async function seedVoucher(
  t: ReturnType<typeof convexTest>,
  outletId: Id<"outlets">,
  patch: Partial<{
    used_count: number;
    max_redemptions: number;
    expires_at: number;
    active: boolean;
    min_cart_value: number;
  }> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("pos_vouchers", {
      code: "V",
      type: "amount",
      value: 1000,
      used_count: patch.used_count ?? 0,
      active: patch.active ?? true,
      created_at: Date.now(),
      outlet_id: outletId,
      ...(patch.max_redemptions !== undefined
        ? { max_redemptions: patch.max_redemptions }
        : {}),
      ...(patch.expires_at !== undefined ? { expires_at: patch.expires_at } : {}),
      ...(patch.min_cart_value !== undefined
        ? { min_cart_value: patch.min_cart_value }
        : {}),
    }),
  );
}

describe("vouchers.updateVoucherMeta", () => {
  it("patches only present fields; absent fields untouched", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    const vid = await seedVoucher(t, outletId, { max_redemptions: 50 });
    const newExp = Date.now() + 86_400_000;
    await t.mutation(api.vouchers.public.updateVoucherMeta, {
      idempotencyKey: "k1",
      sessionId,
      voucherId: vid,
      expires_at: newExp,
    });
    const row = await t.run(async (ctx) => ctx.db.get(vid));
    expect(row?.max_redemptions).toBe(50); // unchanged
    expect(row?.expires_at).toBe(newExp);
    expect(row?.active).toBe(true); // unchanged
  });

  it("rejects max_redemptions < used_count with MAX_BELOW_USED", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    const vid = await seedVoucher(t, outletId, { used_count: 10, max_redemptions: 50 });
    await expect(
      t.mutation(api.vouchers.public.updateVoucherMeta, {
        idempotencyKey: "k",
        sessionId,
        voucherId: vid,
        max_redemptions: 5,
      }),
    ).rejects.toThrow(/MAX_BELOW_USED/);
  });

  it("rejects non-manager session", async () => {
    const t = convexTest(schema);
    const outletId = await t.run((ctx) =>
      ctx.db.insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as never),
    );
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
    const sid = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staff,
        device_id: "dev",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      }),
    );
    const vid = await seedVoucher(t, outletId);
    await expect(
      t.mutation(api.vouchers.public.updateVoucherMeta, {
        idempotencyKey: "k",
        sessionId: sid,
        voucherId: vid,
        active: false,
      }),
    ).rejects.toThrow(/NOT_MANAGER|MANAGER_ONLY|FORBIDDEN/);
  });

  it("idempotency replay is a no-op (single audit row)", async () => {
    const t = convexTest(schema);
    const { sessionId, outletId } = await seedManagerSession(t);
    const vid = await seedVoucher(t, outletId);
    const args = {
      idempotencyKey: "kk",
      sessionId,
      voucherId: vid,
      active: false,
    };
    await t.mutation(api.vouchers.public.updateVoucherMeta, args);
    await t.mutation(api.vouchers.public.updateVoucherMeta, args);
    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "voucher.edited"))
        .collect(),
    );
    expect(audits.length).toBe(1);
  });
});
