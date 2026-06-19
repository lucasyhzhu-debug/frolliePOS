import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

// endOfDaySignOff now schedules _sendSignoffSummary (Task 9). Stub Telegram +
// drain the scheduler so the deferred action resolves cleanly in tests.
setupTelegramStub();

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

test("endOfDaySignOff ends the session, closes the booth, returns duration", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedActiveSession(t);
  // First open the booth
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1",
    sessionId,
    steps: [],
    countChanged: undefined,
  });
  // Now sign off
  const res = await t.mutation(api.shifts.public.endOfDaySignOff, {
    idempotencyKey: "k2",
    sessionId,
    steps: [],
    countChanged: undefined,
  });
  expect(res.ok).toBe(true);
  expect(res.durationMs).toBeGreaterThanOrEqual(0);
  // Booth should now be closed
  expect(
    (await t.query(api.shifts.public.boothState, { deviceId: "d1" })).state,
  ).toBe("closed");
  // Session should be ended
  const sess = await t.run((ctx) =>
    ctx.db.get(sessionId as Id<"staff_sessions">),
  );
  expect(sess?.ended_at).not.toBeNull();
  // Drain the _sendSignoffSummary scheduled action so it doesn't fire after teardown.
  await drainScheduled(t);
});

test("endOfDaySignOff rejects an already-ended session", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedActiveSession(t);
  await t.run((ctx) =>
    ctx.db.patch(sessionId as Id<"staff_sessions">, {
      ended_at: Date.now(),
      end_reason: "manual_lock",
    }),
  );
  await expect(
    t.mutation(api.shifts.public.endOfDaySignOff, {
      idempotencyKey: "k3",
      sessionId,
      steps: [],
      countChanged: undefined,
    }),
  ).rejects.toThrow(/NO_SESSION/);
  // No scheduler drain needed — the mutation throws before scheduling.
});
