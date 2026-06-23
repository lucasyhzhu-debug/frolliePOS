import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

// handoverOut now schedules _sendSignoffSummary (Task 9). Stub Telegram +
// drain the scheduler so the deferred action resolves cleanly in tests.
setupTelegramStub();

test("handoverOut closes outgoing session → handover_pending; handoverIn → open(new staff)", async () => {
  const t = convexTest(schema);
  const { aSession, bSession } = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any);
    // Bind device so boothState can resolve outletId
    await ctx.db.insert("registered_devices", {
      device_id: "d1",
      label: "Test Device",
      activated_at: Date.now(),
      active: true,
      outlet_id: outletId,
    } as any);
    const a = await ctx.db.insert("staff", {
      name: "Budi",
      code: "S-0002",
      role: "staff",
      pin_hash: "x",
      active: true,
      must_change_pin: false,
      created_at: 0,
    } as any);
    const b = await ctx.db.insert("staff", {
      name: "Sari",
      code: "S-0003",
      role: "staff",
      pin_hash: "x",
      active: true,
      must_change_pin: false,
      created_at: 0,
    } as any);
    const aSession = await ctx.db.insert("staff_sessions", {
      staff_id: a,
      device_id: "d1",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    });
    const bSession = await ctx.db.insert("staff_sessions", {
      staff_id: b,
      device_id: "d1",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    });
    return { aSession, bSession };
  });

  // Open the booth as staff A
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "k1",
    sessionId: aSession,
    steps: [],
    countChanged: undefined,
  });

  // Handover out — should end A's session and move booth → handover_pending
  const handoverRes = await t.mutation(api.shifts.public.handoverOut, {
    idempotencyKey: "k2",
    sessionId: aSession,
    steps: [],
    countChanged: 1,
  });
  expect(handoverRes.ok).toBe(true);
  expect(handoverRes.durationMs).toBeGreaterThanOrEqual(0);

  // Booth should be in handover_pending state
  expect(
    (await t.query(api.shifts.public.boothState, { deviceId: "d1" })).state,
  ).toBe("handover_pending");

  // A's session should be ended
  const aSess = await t.run((ctx) =>
    ctx.db.get(aSession as Id<"staff_sessions">),
  );
  expect(aSess?.ended_at).not.toBeNull();
  expect(aSess?.end_reason).toBe("force_logout");

  // Complete handover in as staff B
  const inRes = await t.mutation(api.shifts.public.completeHandoverIn, {
    idempotencyKey: "k3",
    sessionId: bSession,
    steps: [],
    countChanged: 1,
  });
  expect(inRes.ok).toBe(true);
  expect(inRes.eventId).toBeTruthy();

  // Booth should be open with Sari
  const s = await t.query(api.shifts.public.boothState, { deviceId: "d1" });
  expect(s.state).toBe("open");
  expect(s.staffName).toBe("Sari");

  // B's session should NOT be ended
  const bSess = await t.run((ctx) =>
    ctx.db.get(bSession as Id<"staff_sessions">),
  );
  expect(bSess?.ended_at).toBeNull();
  // Drain the _sendSignoffSummary scheduled action from handoverOut.
  await drainScheduled(t);
});

test("handoverOut rejects an already-ended session", async () => {
  const t = convexTest(schema);
  const { sessionId } = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
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
      device_id: "d1",
      started_at: Date.now(),
      ended_at: Date.now(),
      end_reason: "manual_lock",
      outlet_id: outletId,
    });
    return { sessionId };
  });
  await expect(
    t.mutation(api.shifts.public.handoverOut, {
      idempotencyKey: "k1",
      sessionId,
      steps: [],
      countChanged: undefined,
    }),
  ).rejects.toThrow(/NO_SESSION/);
});
