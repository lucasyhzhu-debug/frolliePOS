/**
 * Triple-review FIX 3 (C-2): write-side booth-state guards on the shift
 * lifecycle mutations. Each mutation asserts (via the pure deriveBoothState) that
 * the booth is in the allowed source state, throwing a stable error otherwise.
 */

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

setupTelegramStub();

async function seedSession(
  t: ReturnType<typeof convexTest>,
  device = "d1",
): Promise<{ staffId: Id<"staff">; sessionId: Id<"staff_sessions"> }> {
  return t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any);
    await ctx.db.insert("registered_devices", {
      device_id: device,
      label: "Test Device",
      activated_at: Date.now(),
      active: true,
      outlet_id: outletId,
    } as any);
    const staffId = await ctx.db.insert("staff", {
      name: "Budi",
      code: "S-0002",
      role: "staff",
      pin_hash: "x",
      active: true,
      must_change_pin: false,
      created_at: 0,
    } as any);
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: device,
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    } as any);
    return { staffId, sessionId };
  });
}

test("endOfDaySignOff on a CLOSED booth → idempotent no-op (v1.2)", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedSession(t);
  // Booth is fresh/closed — no start_of_day recorded. v1.2: closing an
  // already-closed booth is a safe no-op (ends the session, durationMs: 0, no
  // duplicate signoff event) instead of throwing BOOTH_NOT_OPEN — covers the
  // accidental re-close and the manager-skip state. Full behavioural coverage
  // (event log stays empty, session ends) lives in signoff.test.ts.
  const res = await t.mutation(api.shifts.public.endOfDaySignOff, {
    idempotencyKey: "k1",
    sessionId,
    steps: [],
    countChanged: undefined,
  });
  expect(res.ok).toBe(true);
  expect(res.durationMs).toBe(0);
});

test("endOfDaySignOff from a LOCKED booth still closes — staff not stranded (#138)", async () => {
  const t = convexTest(schema);
  const { staffId, sessionId } = await seedSession(t);
  // Open, then lock (lock ends the session).
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1", sessionId, steps: [], countChanged: undefined,
  });
  await t.mutation(api.shifts.public.lockShift, { idempotencyKey: "k2", sessionId });

  // Staff returns and logs in again → fresh active session on the SAME device,
  // but the booth is still "locked" (no same-staff resume fired). Previously this
  // stranded them: endOfDaySignOff threw BOOTH_NOT_OPEN. Now it closes.
  const session2 = await t.run(async (ctx: any) => {
    const dev = await ctx.db
      .query("registered_devices")
      .withIndex("by_device_id", (q: any) => q.eq("device_id", "d1"))
      .first();
    return ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: "d1",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: dev.outlet_id,
    } as any);
  });

  const res = await t.mutation(api.shifts.public.endOfDaySignOff, {
    idempotencyKey: "k3", sessionId: session2, steps: [], countChanged: undefined,
  });
  expect(res.ok).toBe(true);

  // A signoff_close event was recorded (booth → closed), tagged with the source
  // state for traceability.
  const events = (await t.run((ctx: any) => ctx.db.query("pos_shift_events").collect())) as any[];
  expect(events.some((e: any) => e.type === "signoff_close")).toBe(true);
  const audit = (await t.run((ctx: any) => ctx.db.query("audit_log").collect())) as any[];
  const signoff = audit.find((r: any) => r.action === "shift.signoff");
  expect(JSON.parse(signoff!.metadata as string)).toMatchObject({ closed_from: "locked" });
  await drainScheduled(t);
});

test("lockShift from a LOCKED booth → idempotent no-op, session ended, no dup event (#138/#139)", async () => {
  const t = convexTest(schema);
  const { staffId, sessionId } = await seedSession(t);
  // Open, then lock (lock ends the first session).
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1", sessionId, steps: [], countChanged: undefined,
  });
  await t.mutation(api.shifts.public.lockShift, { idempotencyKey: "k2", sessionId });

  const lockEventsBefore = ((await t.run((ctx: any) =>
    ctx.db.query("pos_shift_events").collect())) as any[]).filter((e: any) => e.type === "lock").length;

  // Staff returns and re-logs in (fresh session), but the booth is still "locked"
  // (same-staff resume never fired — the prod race). Tapping Lock again must NOT
  // throw BOOTH_NOT_OPEN; it cleanly logs them out instead.
  const session2 = await t.run(async (ctx: any) => {
    const dev = await ctx.db
      .query("registered_devices")
      .withIndex("by_device_id", (q: any) => q.eq("device_id", "d1"))
      .first();
    return ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d1", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: dev.outlet_id,
    } as any);
  });

  const res = await t.mutation(api.shifts.public.lockShift, {
    idempotencyKey: "k3", sessionId: session2,
  });
  expect(res.ok).toBe(true);

  // No duplicate lock event; booth still locked.
  const lockEventsAfter = ((await t.run((ctx: any) =>
    ctx.db.query("pos_shift_events").collect())) as any[]).filter((e: any) => e.type === "lock").length;
  expect(lockEventsAfter).toBe(lockEventsBefore);
  expect(
    (await t.query(api.shifts.public.boothState, { deviceId: "d1" })).state,
  ).toBe("locked");
  // Caller's session is ended with manual_lock (Lock still logs them out).
  const s2 = (await t.run((ctx: any) => ctx.db.get(session2))) as any;
  expect(s2?.ended_at).not.toBeNull();
  expect(s2?.end_reason).toBe("manual_lock");
});

test("handoverOut from a LOCKED booth still hands over — staff not stranded (#138/#139)", async () => {
  const t = convexTest(schema);
  const { staffId, sessionId } = await seedSession(t);
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1", sessionId, steps: [], countChanged: undefined,
  });
  await t.mutation(api.shifts.public.lockShift, { idempotencyKey: "k2", sessionId });

  // Returning staffer, fresh session, booth still "locked" → hand over to next shift.
  const session2 = await t.run(async (ctx: any) => {
    const dev = await ctx.db
      .query("registered_devices")
      .withIndex("by_device_id", (q: any) => q.eq("device_id", "d1"))
      .first();
    return ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d1", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: dev.outlet_id,
    } as any);
  });

  const res = await t.mutation(api.shifts.public.handoverOut, {
    idempotencyKey: "k3", sessionId: session2, steps: [], countChanged: undefined,
  });
  expect(res.ok).toBe(true);

  // Booth → handover_pending; audit row tags the source state.
  expect(
    (await t.query(api.shifts.public.boothState, { deviceId: "d1" })).state,
  ).toBe("handover_pending");
  const audit = (await t.run((ctx: any) => ctx.db.query("audit_log").collect())) as any[];
  const ho = audit.find((r: any) => r.action === "shift.handover_out");
  expect(JSON.parse(ho!.metadata as string)).toMatchObject({ handover_from: "locked" });
  await drainScheduled(t);
});

test("completeStartOfDay on an already-OPEN same-day booth → BOOTH_NOT_CLOSED", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedSession(t);
  // Open the booth.
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1",
    sessionId,
    steps: [],
    countChanged: undefined,
  });
  // Second start-of-day same day → rejected.
  await expect(
    t.mutation(api.shifts.public.completeStartOfDay, {
      idempotencyKey: "k2",
      sessionId,
      steps: [],
      countChanged: undefined,
    }),
  ).rejects.toThrow(/BOOTH_NOT_CLOSED/);
});

test("recordResume on a non-LOCKED (open) booth → BOOTH_NOT_LOCKED", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedSession(t);
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1",
    sessionId,
    steps: [],
    countChanged: undefined,
  });
  await expect(
    t.mutation(api.shifts.public.recordResume, {
      idempotencyKey: "k2",
      sessionId,
    }),
  ).rejects.toThrow(/BOOTH_NOT_LOCKED/);
});

test("lockShift on a CLOSED booth → BOOTH_NOT_OPEN", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedSession(t);
  await expect(
    t.mutation(api.shifts.public.lockShift, {
      idempotencyKey: "k1",
      sessionId,
    }),
  ).rejects.toThrow(/BOOTH_NOT_OPEN/);
});

test("completeHandoverIn with no pending handover (open booth) → NO_HANDOVER_PENDING", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedSession(t);
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1",
    sessionId,
    steps: [],
    countChanged: undefined,
  });
  await expect(
    t.mutation(api.shifts.public.completeHandoverIn, {
      idempotencyKey: "k2",
      sessionId,
      steps: [],
      countChanged: undefined,
    }),
  ).rejects.toThrow(/NO_HANDOVER_PENDING/);
  await drainScheduled(t);
});
