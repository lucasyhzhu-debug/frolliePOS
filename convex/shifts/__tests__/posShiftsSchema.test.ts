import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";

test("pos_shifts: active holder = the row with ended_at == null", async () => {
  const t = convexTest(schema);
  const { outletId } = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: true,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Sisca", code: "S-1", role: "staff", pin_hash: "x",
      active: true, must_change_pin: false, created_at: 0,
    });
    await ctx.db.insert("pos_shifts", {
      outlet_id: outletId, device_id: "d1", staff_id: staffId,
      started_at: Date.now(), started_via: "sop", ended_at: null, ended_via: null,
      open_count: null, close_count: null, outgoing_uncounted: null,
      steps: [], summary: null, prev_shift_id: null, created_at: Date.now(),
    });
    return { outletId };
  });
  const active = await t.run((ctx: any) =>
    ctx.db.query("pos_shifts")
      .withIndex("by_outlet_active", (q: any) => q.eq("outlet_id", outletId).eq("ended_at", null))
      .unique()) as any;
  expect(active).not.toBeNull();
  expect(active.started_via).toBe("sop");
});
