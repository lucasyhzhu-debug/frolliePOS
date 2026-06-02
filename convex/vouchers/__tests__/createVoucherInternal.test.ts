import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

/** Insert a minimal manager staff row. */
async function seedManagerId(ctx: any) {
  return ctx.db.insert("staff", {
    name: "Test Manager",
    pin_hash: "$argon2id$dummy",
    role: "manager",
    active: true,
    created_at: Date.now(),
  });
}

describe("vouchers/internal._createVoucher_internal", () => {
  it("inserts pos_vouchers row with used_count:0, active:true; audits voucher.created", async () => {
    const t = convexTest(schema);
    const mgrId = await t.run(async (ctx) => seedManagerId(ctx));

    const expiresAt = Date.now() + 30 * 86_400_000;
    const id = await t.mutation(internal.vouchers.internal._createVoucher_internal, {
      code: "WELCOME10",
      type: "percentage",
      value: 10,
      min_cart_value: 50_000,
      max_redemptions: 100,
      expires_at: expiresAt,
      createdBy: mgrId,
      deviceId: "dev-booth",
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row).toMatchObject({
      code: "WELCOME10",
      type: "percentage",
      value: 10,
      min_cart_value: 50_000,
      max_redemptions: 100,
      expires_at: expiresAt,
      used_count: 0,
      active: true,
      created_by_staff_id: mgrId,
    });
    expect(typeof row?.created_at).toBe("number");

    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "voucher.created"))
        .collect(),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_id: mgrId,
      action: "voucher.created",
      entity_type: "pos_vouchers",
      entity_id: id,
      source: "booth_inline",
      device_id: "dev-booth",
    });
  });

  it("omits optional fields when not supplied (no min_cart_value/max_redemptions/expires_at)", async () => {
    const t = convexTest(schema);
    const mgrId = await t.run(async (ctx) => seedManagerId(ctx));

    const id = await t.mutation(internal.vouchers.internal._createVoucher_internal, {
      code: "FLAT5K",
      type: "amount",
      value: 5_000,
      createdBy: mgrId,
      deviceId: "dev-booth",
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row).toMatchObject({
      code: "FLAT5K",
      type: "amount",
      value: 5_000,
      used_count: 0,
      active: true,
      created_by_staff_id: mgrId,
    });
    // Optional fields must NOT be persisted as undefined values.
    expect(row?.min_cart_value).toBeUndefined();
    expect(row?.max_redemptions).toBeUndefined();
    expect(row?.expires_at).toBeUndefined();
  });
});
