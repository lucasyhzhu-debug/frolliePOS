import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

test("boothState reflects the latest event", async () => {
  const t = convexTest(schema);
  const staffId = await t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "Budi",
      code: "S-0002",
      role: "staff",
      pin_hash: "x",
      active: true,
      must_change_pin: false,
      created_at: 0,
    } as any),
  );
  // no events → closed
  expect((await t.query(api.shifts.public.boothState, { deviceId: "d1" })).state).toBe("closed");
  await t.mutation(internal.shifts.internal._recordShiftEvent_internal, {
    device_id: "d1",
    type: "start_of_day",
    staff_id: staffId,
    shift_started_at: Date.now(),
    shift_ended_at: null,
    steps: [],
    count_changed: null,
    takeover: null,
    outgoing_uncounted: null,
    stale_autoclose: null,
    linked_event_id: null,
    summary: null,
  });
  const s = await t.query(api.shifts.public.boothState, { deviceId: "d1" });
  expect(s.state).toBe("open");
  expect(s.staffName).toBe("Budi");
});

test("boothState stale-autoclose: prior-WIB-day event → closed + staleAutoclose=true", async () => {
  const t = convexTest(schema);
  const staffId = await t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "Rina",
      code: "S-0003",
      role: "staff",
      pin_hash: "x",
      active: true,
      must_change_pin: false,
      created_at: 0,
    } as any),
  );
  // Insert a start_of_day event from 2 days ago directly (bypassing _recordShiftEvent_internal
  // which overwrites created_at with Date.now()).
  const priorDay = Date.now() - 2 * 24 * 60 * 60 * 1000;
  await t.run((ctx) =>
    ctx.db.insert("pos_shift_events", {
      device_id: "d2",
      type: "start_of_day",
      staff_id: staffId,
      shift_started_at: priorDay,
      shift_ended_at: null,
      steps: [],
      count_changed: null,
      takeover: null,
      outgoing_uncounted: null,
      stale_autoclose: null,
      linked_event_id: null,
      summary: null,
      created_at: priorDay,
    } as any),
  );
  const s = await t.query(api.shifts.public.boothState, { deviceId: "d2" });
  expect(s.state).toBe("closed");
  expect(s.staleAutoclose).toBe(true);
});
