import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedOutlet(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Sisca", code: "S-1", role: "staff", pin_hash: "x",
      active: true, must_change_pin: false, created_at: 0,
    });
    return { outletId, staffId };
  });
}

test("outlet status: default closed, open then close", async () => {
  const t = convexTest(schema);
  const { outletId, staffId } = await seedOutlet(t);
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(false);

  await t.mutation(internal.outlets.status._setOutletOpen_internal, { outletId, staffId, via: "sop" });
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(true);

  await t.mutation(internal.outlets.status._setOutletClosed_internal, { outletId, staffId });
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(false);
});
