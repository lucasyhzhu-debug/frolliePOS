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
