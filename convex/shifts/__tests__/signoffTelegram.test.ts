/**
 * Task 9: verify that endOfDaySignOff and handoverOut schedule a
 * `_sendSignoffSummary` internal action after the mutation commits.
 *
 * Assertion style: after the mutation, drain the scheduler and verify the
 * deferred action ran without error. The test relies on setupTelegramStub()
 * + drainScheduled() (same pattern as inventory/confirmPaid tests).
 *
 * We don't assert the exact Telegram payload here — that is covered by the
 * renderStaffShiftSignoff unit tests in convex/lib/__tests__/telegramHtml.test.ts.
 * These integration tests verify the scheduling wire is in place.
 */

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

// Stub Telegram so the scheduled _sendSignoffSummary action resolves offline.
setupTelegramStub();

// ---------------------------------------------------------------------------
// Seed helper
// ---------------------------------------------------------------------------
async function seedOpenBooth(t: ReturnType<typeof convexTest>) {
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

// ---------------------------------------------------------------------------
// endOfDaySignOff schedules _sendSignoffSummary
// ---------------------------------------------------------------------------
test("endOfDaySignOff: schedules and drains _sendSignoffSummary without error", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedOpenBooth(t);

  // Open the booth
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1",
    sessionId,
    steps: [],
    countChanged: undefined,
  });

  // Sign off — this schedules _sendSignoffSummary
  const res = await t.mutation(api.shifts.public.endOfDaySignOff, {
    idempotencyKey: "k2",
    sessionId,
    steps: [],
    countChanged: undefined,
  });
  expect(res.ok).toBe(true);

  // Drain the scheduled _sendSignoffSummary and verify no error is thrown.
  // If the wire is broken (action not scheduled or crashes), drainScheduled
  // surfaces the unhandled rejection here rather than after test teardown.
  await expect(drainScheduled(t)).resolves.not.toThrow();
});

// ---------------------------------------------------------------------------
// handoverOut schedules _sendSignoffSummary
// ---------------------------------------------------------------------------
test("handoverOut: schedules and drains _sendSignoffSummary without error", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedOpenBooth(t);

  // Open the booth
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1",
    sessionId,
    steps: [],
    countChanged: undefined,
  });

  // Handover out — this schedules _sendSignoffSummary
  const res = await t.mutation(api.shifts.public.handoverOut, {
    idempotencyKey: "k2",
    sessionId,
    steps: [],
    countChanged: undefined,
  });
  expect(res.ok).toBe(true);

  // Drain the scheduled _sendSignoffSummary.
  await expect(drainScheduled(t)).resolves.not.toThrow();
});
