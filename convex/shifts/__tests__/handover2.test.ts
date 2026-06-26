import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

setupTelegramStub();

// (reuse seedClosed from openBooth.test.ts pattern; inline here)
async function seedOpen(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: false,
    });
    await ctx.db.insert("registered_devices", { device_id: "d1", label: "T", activated_at: Date.now(), active: true, outlet_id: outletId });
    const staffId = await ctx.db.insert("staff", { name: "Sisca", code: "S-1", role: "staff", pin_hash: "x", active: true, must_change_pin: false, created_at: 0 });
    const sessionId = await ctx.db.insert("staff_sessions", { staff_id: staffId, device_id: "d1", started_at: Date.now(), ended_at: null, end_reason: null, outlet_id: outletId });
    return { outletId, staffId, sessionId };
  });
  await t.mutation(api.shifts.shifts.openBooth, { idempotencyKey: "open", sessionId: ids.sessionId, steps: [] });
  return ids;
}

test("handover ends the shift but leaves the outlet OPEN", async () => {
  const t = convexTest(schema);
  const { outletId, sessionId } = await seedOpen(t);

  const res = await t.mutation(api.shifts.shifts.handover, {
    idempotencyKey: "h1", sessionId, steps: [], closeCount: 9,
  });
  expect(res.ok).toBe(true);

  // Outlet still open (Level 1 untouched), but no active holder (Level 2 released).
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(true);
  expect(await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId })).toBeNull();
  await drainScheduled(t);
});
