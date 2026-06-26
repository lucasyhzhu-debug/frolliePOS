// convex/migrations/__tests__/backfillOutletStatus.test.ts
//
// TDD test for backfillOutletStatus + assertOutletStatusBackfilled.
//
// Scenarios:
//   A) Outlet with a same-day "lock" event -> is_open=true, one active pos_shifts holder
//   B) Outlet with a same-day "signoff_close" event -> is_open=false, no holder
//   C) Idempotent re-run: outlet already has is_open set -> skip
//   D) assertOutletStatusBackfilled -> no throw after backfill; throws before if unset

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

const shiftEventBase = {
  shift_ended_at: null as null,
  steps: [] as [],
  count_changed: null as null,
  takeover: null as null,
  outgoing_uncounted: null as null,
  stale_autoclose: null as null,
  linked_event_id: null as null,
  summary: null as null,
};

async function seedOutletWithLock(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "A01", name: "Outlet A", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    });
    const deviceId = "dev-a1";
    await ctx.db.insert("registered_devices", {
      device_id: deviceId, label: "Device A", activated_at: Date.now(),
      active: true, outlet_id: outletId,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Budi", code: "S-A1", role: "staff", active: true,
      pin_hash: "x", must_change_pin: false, created_at: 0,
    });
    const now = Date.now();
    const shiftStartedAt = now - 4 * 60 * 60 * 1000;
    await ctx.db.insert("pos_shift_events", {
      ...shiftEventBase,
      device_id: deviceId,
      type: "start_of_day",
      staff_id: staffId,
      shift_started_at: shiftStartedAt,
      // created_at must sit inside today's WIB window so the backfill's
      // anchor-find (gte dayStartMs) sees it — otherwise a run in the early
      // WIB morning would push `now - 4h` into yesterday and drop the holder.
      // shift_started_at stays 4h ago for a realistic shift duration.
      created_at: now - 120_000,
      outlet_id: outletId,
    });
    await ctx.db.insert("pos_shift_events", {
      ...shiftEventBase,
      device_id: deviceId,
      type: "lock",
      staff_id: staffId,
      shift_started_at: shiftStartedAt,
      created_at: now - 60_000,
      outlet_id: outletId,
    });
    return { outletId, deviceId, staffId, shiftStartedAt };
  });
}

async function seedOutletWithClose(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "B01", name: "Outlet B", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    });
    const deviceId = "dev-b1";
    await ctx.db.insert("registered_devices", {
      device_id: deviceId, label: "Device B", activated_at: Date.now(),
      active: true, outlet_id: outletId,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Rina", code: "S-B1", role: "staff", active: true,
      pin_hash: "x", must_change_pin: false, created_at: 0,
    });
    const now = Date.now();
    const shiftStartedAt = now - 8 * 60 * 60 * 1000;
    await ctx.db.insert("pos_shift_events", {
      ...shiftEventBase,
      device_id: deviceId,
      type: "signoff_close",
      staff_id: staffId,
      shift_started_at: shiftStartedAt,
      created_at: now - 5_000,
      outlet_id: outletId,
    });
    return { outletId, deviceId, staffId };
  });
}

test("backfillOutletStatus: lock event => is_open=true + one active holder row", async () => {
  const t = convexTest(schema);
  const { outletId, staffId } = await seedOutletWithLock(t);
  const result = await t.action(internal.migrations.internal.backfillOutletStatus, {});
  expect(result.ok).toBe(true);
  expect(result.outletsProcessed).toBeGreaterThanOrEqual(1);
  expect(result.opened).toBeGreaterThanOrEqual(1);
  const outlet = await t.run((ctx: any) => ctx.db.get(outletId)) as any;
  expect(outlet.is_open).toBe(true);
  const holders = await t.run((ctx: any) =>
    ctx.db
      .query("pos_shifts")
      .withIndex("by_outlet_active", (q: any) => q.eq("outlet_id", outletId).eq("ended_at", null))
      .collect(),
  ) as any[];
  expect(holders).toHaveLength(1);
  expect(holders[0].staff_id).toBe(staffId);
  expect(holders[0].started_via).toBe("sop");
  expect(holders[0].ended_at).toBeNull();
});

test("backfillOutletStatus: signoff_close event => is_open=false + no holder", async () => {
  const t = convexTest(schema);
  const { outletId } = await seedOutletWithClose(t);
  await t.action(internal.migrations.internal.backfillOutletStatus, {});
  const outlet = await t.run((ctx: any) => ctx.db.get(outletId)) as any;
  expect(outlet.is_open).toBe(false);
  const holders = await t.run((ctx: any) =>
    ctx.db
      .query("pos_shifts")
      .withIndex("by_outlet_active", (q: any) => q.eq("outlet_id", outletId).eq("ended_at", null))
      .collect(),
  ) as any[];
  expect(holders).toHaveLength(0);
});

test("backfillOutletStatus: idempotent - already-set is_open skips outlet", async () => {
  const t = convexTest(schema);
  const { outletId } = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "C01", name: "Outlet C", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: true,
    });
    const deviceId = "dev-c1";
    await ctx.db.insert("registered_devices", {
      device_id: deviceId, label: "Device C", activated_at: Date.now(),
      active: true, outlet_id: outletId,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Cici", code: "S-C1", role: "staff", active: true,
      pin_hash: "x", must_change_pin: false, created_at: 0,
    });
    await ctx.db.insert("pos_shifts", {
      outlet_id: outletId,
      device_id: deviceId,
      staff_id: staffId,
      started_at: Date.now() - 3_600_000,
      started_via: "sop",
      ended_at: null,
      ended_via: null,
      open_count: null,
      close_count: null,
      outgoing_uncounted: null,
      steps: [],
      summary: null,
      prev_shift_id: null,
      created_at: Date.now() - 3_600_000,
    });
    return { outletId };
  });
  const result = await t.action(internal.migrations.internal.backfillOutletStatus, {});
  expect(result.ok).toBe(true);
  const holders = await t.run((ctx: any) =>
    ctx.db
      .query("pos_shifts")
      .withIndex("by_outlet_active", (q: any) => q.eq("outlet_id", outletId).eq("ended_at", null))
      .collect(),
  );
  expect(holders).toHaveLength(1);
});

test("assertOutletStatusBackfilled: no throw after backfill", async () => {
  const t = convexTest(schema);
  await seedOutletWithLock(t);
  await seedOutletWithClose(t);
  await t.action(internal.migrations.internal.backfillOutletStatus, {});
  const res = await t.query(internal.migrations.internal.assertOutletStatusBackfilled, {});
  expect(res.ok).toBe(true);
});

test("assertOutletStatusBackfilled: throws when an active outlet has is_open unset", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx: any) => {
    await ctx.db.insert("outlets", {
      code: "D01", name: "Outlet D", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    });
  });
  await expect(
    t.query(internal.migrations.internal.assertOutletStatusBackfilled, {}),
  ).rejects.toThrow();
});
