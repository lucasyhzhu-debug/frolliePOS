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

test("outletStatus defaults to every-device-is-outlet when none designated", async () => {
  const t = convexTest(schema);
  const s = await t.query(api.settings.public.outletStatus, { deviceId: "anything" });
  expect(s.outletDeviceId).toBeNull();
  expect(s.isOutlet).toBe(true); // backward compat — no outlet set
});

test("setOutletDevice designates the outlet; viewers report isOutlet=false", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedManagerSession(t);
  await seedDevice(t, "booth-phone", "Booth phone");

  await t.mutation(api.staff.public.setOutletDevice, {
    idempotencyKey: "k-set",
    sessionId,
    deviceId: "booth-phone",
  });

  // The outlet device sees isOutlet=true...
  const outlet = await t.query(api.settings.public.outletStatus, {
    deviceId: "booth-phone",
  });
  expect(outlet.outletDeviceId).toBe("booth-phone");
  expect(outlet.isOutlet).toBe(true);

  // ...a viewer (manager's PC) sees isOutlet=false.
  const viewer = await t.query(api.settings.public.outletStatus, {
    deviceId: "managers-pc",
  });
  expect(viewer.outletDeviceId).toBe("booth-phone");
  expect(viewer.isOutlet).toBe(false);
});

test("setOutletDevice rejects an unregistered device", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedManagerSession(t);
  await expect(
    t.mutation(api.staff.public.setOutletDevice, {
      idempotencyKey: "k-bad",
      sessionId,
      deviceId: "ghost-device",
    }),
  ).rejects.toThrow(/DEVICE_NOT_REGISTERED/);
});

test("setOutletDevice(null) clears the designation", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedManagerSession(t);
  await seedDevice(t, "booth-phone", "Booth phone");
  await t.mutation(api.staff.public.setOutletDevice, {
    idempotencyKey: "k1",
    sessionId,
    deviceId: "booth-phone",
  });
  await t.mutation(api.staff.public.setOutletDevice, {
    idempotencyKey: "k2",
    sessionId,
    deviceId: null,
  });
  const s = await t.query(api.settings.public.outletStatus, { deviceId: "x" });
  expect(s.outletDeviceId).toBeNull();
  expect(s.isOutlet).toBe(true);
});

test("listRegisteredDevices returns active devices + the current outlet id", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedManagerSession(t);
  await seedDevice(t, "booth-phone", "Booth phone");
  await seedDevice(t, "managers-pc", "Manager PC");
  await t.mutation(api.staff.public.setOutletDevice, {
    idempotencyKey: "k-set",
    sessionId,
    deviceId: "booth-phone",
  });

  const res = await t.query(api.staff.public.listRegisteredDevices, { sessionId });
  expect(res.outletDeviceId).toBe("booth-phone");
  expect(res.devices.map((d) => d.device_id).sort()).toEqual([
    "booth-phone",
    "managers-pc",
  ]);
});
