import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { setupTelegramStub } from "../../__tests__/_helpers";

setupTelegramStub();

async function seedOpen(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: false,
    });
    await ctx.db.insert("registered_devices", {
      device_id: "d1", label: "T", activated_at: Date.now(), active: true, outlet_id: outletId,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Sisca", code: "S-1", role: "staff", pin_hash: "x",
      active: true, must_change_pin: false, created_at: 0,
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d1", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: outletId,
    });
    return { outletId, staffId, sessionId };
  });
  await t.mutation(api.shifts.shifts.openBooth, { idempotencyKey: "open", sessionId: ids.sessionId, steps: [] });
  return ids;
}

test("lock just ends the session; outlet stays open, holder unchanged", async () => {
  const t = convexTest(schema);
  const { outletId, sessionId } = await seedOpen(t);
  const holderBefore = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });

  const res = await t.mutation(api.shifts.shifts.lock, { idempotencyKey: "l1", sessionId });
  expect(res.ok).toBe(true);

  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(true);
  const holderAfter = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(holderAfter?._id).toBe(holderBefore?._id); // same shift still active
  const sess = await t.run((ctx) => ctx.db.get(sessionId as Id<"staff_sessions">));
  expect(sess?.end_reason).toBe("manual_lock");
});
