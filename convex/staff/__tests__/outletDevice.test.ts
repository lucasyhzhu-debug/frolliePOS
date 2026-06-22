/**
 * Outlet-device binding tests (v2.0 Task 10).
 *
 * PR#124 hotfix (outletStatus / setOutletDevice / pos_settings.outlet_device_id)
 * has been retired. The v2.0 approach binds devices via registered_devices.outlet_id
 * (set by staff.actions.assignDeviceOutlet) and exposes the outlet gate via
 * auth.public.isDeviceOutlet (migration-tolerant during Task 10 window).
 *
 * These tests verify:
 *   - isDeviceOutlet returns false for unregistered/inactive devices
 *   - isDeviceOutlet returns true for registered, active devices (migration window:
 *     every registered device is an outlet until Task 12 enforces hard binding)
 *   - listRegisteredDevices no longer returns outletDeviceId
 */
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "./_helpers";

async function seedDevice(
  t: ReturnType<typeof convexTest>,
  device_id: string,
  label: string,
) {
  return t.run((ctx) =>
    ctx.db.insert("registered_devices", {
      device_id,
      label,
      activated_at: Date.now(),
      active: true,
    }),
  );
}

test("isDeviceOutlet returns false for an unknown device", async () => {
  const t = convexTest(schema);
  const result = await t.query(api.auth.public.isDeviceOutlet, { deviceId: "ghost" });
  expect(result).toBe(false);
});

test("isDeviceOutlet returns true for a registered, active device (migration window: unbound = outlet)", async () => {
  const t = convexTest(schema);
  await seedDevice(t, "booth-phone", "Booth phone");
  const result = await t.query(api.auth.public.isDeviceOutlet, { deviceId: "booth-phone" });
  expect(result).toBe(true);
});

test("isDeviceOutlet returns false for a deactivated device", async () => {
  const t = convexTest(schema);
  await t.run((ctx) =>
    ctx.db.insert("registered_devices", {
      device_id: "stale-tablet",
      label: "Stale tablet",
      activated_at: Date.now() - 1_000_000,
      active: false,
    }),
  );
  const result = await t.query(api.auth.public.isDeviceOutlet, { deviceId: "stale-tablet" });
  expect(result).toBe(false);
});

test("listRegisteredDevices returns devices without outletDeviceId (PR#124 field retired)", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedManagerSession(t);
  await seedDevice(t, "booth-phone", "Booth phone");
  await seedDevice(t, "managers-pc", "Manager PC");

  const res = await t.query(api.staff.public.listRegisteredDevices, { sessionId });
  expect(res.devices.map((d: { device_id: string }) => d.device_id).sort()).toEqual([
    "booth-phone",
    "managers-pc",
  ]);
  // outletDeviceId is retired — v2.0 uses registered_devices.outlet_id instead.
  expect((res as Record<string, unknown>).outletDeviceId).toBeUndefined();
});
