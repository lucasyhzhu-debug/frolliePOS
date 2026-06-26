import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

setupTelegramStub();

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

test("loginContext reports outletOpen + current holder", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedOpen(t); // holder = Sisca

  const ctx0 = await t.query(api.shifts.shifts.loginContext, { deviceId: "d1" });
  expect(ctx0.outletOpen).toBe(true);
  expect(ctx0.holderName).toBe("Sisca");

  await t.mutation(api.shifts.shifts.handover, { idempotencyKey: "h1", sessionId, steps: [] });
  const ctx1 = await t.query(api.shifts.shifts.loginContext, { deviceId: "d1" });
  expect(ctx1.outletOpen).toBe(true);
  expect(ctx1.holderStaffId).toBeNull(); // released → next staffer may start
  await drainScheduled(t);
});

// ---------------------------------------------------------------------------
// I-A: unbound device (registered but no outlet_id) → safe defaults, no throw
// ---------------------------------------------------------------------------
test("loginContext: unbound device returns outletOpen:false without throwing", async () => {
  const t = convexTest(schema);

  // Register a device with no outlet binding (outlet_id absent)
  await t.run(async (ctx: any) => {
    await ctx.db.insert("registered_devices", {
      device_id: "unbound-d1",
      label: "Unbound Device",
      activated_at: Date.now(),
      active: true,
      // outlet_id intentionally omitted — simulates a freshly-activated device
    });
  });

  // Should return safe defaults instead of throwing DEVICE_HAS_NO_OUTLET
  const ctx0 = await t.query(api.shifts.shifts.loginContext, { deviceId: "unbound-d1" });
  expect(ctx0.outletOpen).toBe(false);
  expect(ctx0.holderStaffId).toBeNull();
  expect(ctx0.holderName).toBeNull();
});

