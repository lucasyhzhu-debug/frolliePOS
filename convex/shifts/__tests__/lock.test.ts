import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

async function seedActiveSession(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
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
      device_id: "d1",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
    });
    return { staffId, sessionId };
  });
}

test("lockShift → locked + session ended; resume after re-login → open", async () => {
  const t = convexTest(schema);
  const { staffId, sessionId } = await seedActiveSession(t);

  // Open the booth
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1",
    sessionId,
    steps: [],
    countChanged: undefined,
  });

  // Lock the shift
  const lockRes = await t.mutation(api.shifts.public.lockShift, {
    idempotencyKey: "k2",
    sessionId,
  });
  expect(lockRes.ok).toBe(true);

  // Booth should be locked
  expect(
    (await t.query(api.shifts.public.boothState, { deviceId: "d1" })).state,
  ).toBe("locked");

  // Session should be ended with manual_lock
  const sess1 = await t.run((ctx) =>
    ctx.db.get(sessionId as Id<"staff_sessions">),
  );
  expect(sess1?.ended_at).not.toBeNull();
  expect(sess1?.end_reason).toBe("manual_lock");

  // fresh session (simulating re-login as same staff)
  const s2 = await t.run((ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: "d1",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
    }),
  );

  // Resume the shift
  const resumeRes = await t.mutation(api.shifts.public.recordResume, {
    idempotencyKey: "k3",
    sessionId: s2,
  });
  expect(resumeRes.ok).toBe(true);

  // Booth should be open
  expect(
    (await t.query(api.shifts.public.boothState, { deviceId: "d1" })).state,
  ).toBe("open");

  // The resume event's shift_started_at must equal the original start_of_day shift_started_at
  // (proving accumulated hours survive the lock/resume cycle)
  const startEvent = await t.run((ctx) =>
    ctx.db
      .query("pos_shift_events")
      .withIndex("by_device_created", (q) => q.eq("device_id", "d1"))
      .order("asc")
      .first(),
  );
  const resumeEvent = await t.run((ctx) =>
    ctx.db
      .query("pos_shift_events")
      .withIndex("by_device_created", (q) => q.eq("device_id", "d1"))
      .order("desc")
      .first(),
  );
  expect(resumeEvent?.type).toBe("resume");
  expect(resumeEvent?.shift_started_at).toBe(startEvent?.shift_started_at);
});

test("lockShift rejects an already-ended session", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedActiveSession(t);
  await t.run((ctx) =>
    ctx.db.patch(sessionId as Id<"staff_sessions">, {
      ended_at: Date.now(),
      end_reason: "manual_lock",
    }),
  );
  await expect(
    t.mutation(api.shifts.public.lockShift, {
      idempotencyKey: "k1",
      sessionId,
    }),
  ).rejects.toThrow(/NO_SESSION/);
});
