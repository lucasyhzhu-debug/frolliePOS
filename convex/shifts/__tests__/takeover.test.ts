/**
 * Task 8: managerTakeover action tests.
 *
 * PIN hashing: mirrors convex/auth/__tests__/auth.test.ts seedStaff helper —
 * routes through the Node internalAction _seedHashedStaff_internal so jsdom
 * doesn't evaluate argon2; the production hashing routine is used.
 *
 * Telegram: Task 9 wires the deferred summary scheduler. This file stubs fetch
 * to keep tests offline + deterministic.
 */

import { convexTest } from "convex-test";
import { expect, test, beforeEach, afterEach } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

// ---------------------------------------------------------------------------
// Telegram fetch stub (matches auth.test.ts pattern)
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.TELEGRAM_CHAT_ID = "-1001234567";
  process.env.POS_BASE_URL = "https://pos.dev";
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes("telegram")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return realFetch(url as RequestInfo);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Seed a staff member with a REAL argon2id hash via the Node internalAction.
 * Mirrors auth.test.ts `seedStaff` so we don't maintain a parallel hashing impl.
 */
async function seedStaff(
  t: ReturnType<typeof convexTest>,
  name: string,
  pin: string,
  role: "staff" | "manager" = "staff",
): Promise<Id<"staff">> {
  return t.action(internal.auth.actions._seedHashedStaff_internal, {
    name,
    pin,
    role,
  });
}

// ---------------------------------------------------------------------------
// Happy-path: manager PIN takeover
// ---------------------------------------------------------------------------
test("managerTakeover: correct manager PIN starts a takeover, force-ends locked staff session, flags outgoing_uncounted", async () => {
  const t = convexTest(schema);

  // Seed: staff A (locked) and manager M with known PIN "9999"
  const staffA = await seedStaff(t, "Budi", "1234", "staff");
  const managerM = await seedStaff(t, "Manager", "9999", "manager");

  // Give staff A a session + open the booth
  const staffSession = await t.run(async (ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: staffA,
      device_id: "d1",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
    }),
  );
  await t.mutation(api.shifts.public.completeStartOfDay, {
    idempotencyKey: "startday-1",
    sessionId: staffSession,
    steps: [],
    countChanged: undefined,
  });

  // Lock the shift (staff A steps away)
  await t.mutation(api.shifts.public.lockShift, {
    idempotencyKey: "lock-1",
    sessionId: staffSession,
  });

  // Verify booth is locked
  expect(
    (await t.query(api.shifts.public.boothState, { deviceId: "d1" })).state,
  ).toBe("locked");

  // Manager takeover: manager M proves PIN "9999"
  const result = await t.action(api.shifts.actions.managerTakeover, {
    idempotencyKey: "takeover-1",
    deviceId: "d1",
    managerStaffId: managerM,
    managerPin: "9999",
  });

  expect(result).toHaveProperty("sessionId");
  expect(result).toHaveProperty("eventId");

  // Booth should be open (manager)
  const booth = await t.query(api.shifts.public.boothState, { deviceId: "d1" });
  expect(booth.state).toBe("open");
  expect(String(booth.staffId)).toBe(String(managerM));

  // Staff A's original session should still be ended (force_logout from lockShift)
  const aSess = await t.run((ctx) =>
    ctx.db.get(staffSession as Id<"staff_sessions">),
  );
  expect(aSess?.ended_at).not.toBeNull();

  // The new manager session should be active
  const mgrSess = await t.run((ctx) =>
    ctx.db.get(result.sessionId as Id<"staff_sessions">),
  );
  expect(mgrSess?.ended_at).toBeNull();
  expect(String(mgrSess?.staff_id)).toBe(String(managerM));
  expect(mgrSess?.device_id).toBe("d1");

  // The manager_takeover shift event must have outgoing_uncounted = true + takeover = true
  const takeoverEvent = await t.run((ctx) =>
    ctx.db.get(result.eventId as Id<"pos_shift_events">),
  );
  expect(takeoverEvent?.type).toBe("manager_takeover");
  expect(takeoverEvent?.outgoing_uncounted).toBe(true);
  expect(takeoverEvent?.takeover).toBe(true);
  expect(String(takeoverEvent?.staff_id)).toBe(String(managerM));

  // Audit row should exist
  const audits = await t.query(internal.audit.internal._list_internal, {
    action: "shift.manager_takeover",
  });
  expect(audits.length).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Rejection: non-manager staff is rejected
// ---------------------------------------------------------------------------
test("managerTakeover: non-manager staff is rejected with NOT_MANAGER", async () => {
  const t = convexTest(schema);

  const staffA = await seedStaff(t, "Budi", "1234", "staff");

  await expect(
    t.action(api.shifts.actions.managerTakeover, {
      idempotencyKey: "takeover-reject-1",
      deviceId: "d1",
      managerStaffId: staffA,
      managerPin: "1234",
    }),
  ).rejects.toThrow(/NOT_MANAGER/);
});

// ---------------------------------------------------------------------------
// Rejection: wrong PIN is rejected
// ---------------------------------------------------------------------------
test("managerTakeover: wrong PIN is rejected with INVALID_PIN", async () => {
  const t = convexTest(schema);

  const managerM = await seedStaff(t, "Manager", "9999", "manager");

  await expect(
    t.action(api.shifts.actions.managerTakeover, {
      idempotencyKey: "takeover-wrongpin-1",
      deviceId: "d1",
      managerStaffId: managerM,
      managerPin: "0000",
    }),
  ).rejects.toThrow(/INVALID_PIN/);
});

// ---------------------------------------------------------------------------
// Force-end any existing active session on the device
// ---------------------------------------------------------------------------
test("managerTakeover: force-ends any active session left on the device", async () => {
  const t = convexTest(schema);

  const managerM = await seedStaff(t, "Manager", "9999", "manager");

  // Insert a dangling active session on d1 (simulates a session that was never ended)
  const danglingSession = await t.run(async (ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: managerM,
      device_id: "d1",
      started_at: Date.now() - 1000,
      ended_at: null,
      end_reason: null,
    }),
  );

  // Takeover should force-end the dangling session
  await t.action(api.shifts.actions.managerTakeover, {
    idempotencyKey: "takeover-forceend-1",
    deviceId: "d1",
    managerStaffId: managerM,
    managerPin: "9999",
  });

  const dangling = await t.run((ctx) =>
    ctx.db.get(danglingSession as Id<"staff_sessions">),
  );
  expect(dangling?.ended_at).not.toBeNull();
  expect(dangling?.end_reason).toBe("force_logout");
});
