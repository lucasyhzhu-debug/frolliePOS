/**
 * Task 8: managerOverride action tests.
 *
 * PIN hashing: mirrors takeover.test.ts seedStaff helper — routes through the
 * Node internalAction _seedHashedStaff_internal so jsdom doesn't evaluate
 * argon2; the production hashing routine is used.
 *
 * Telegram: fetch is stubbed to keep tests offline + deterministic.
 */

import { convexTest } from "convex-test";
import { expect, test, beforeEach, afterEach } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { drainScheduled } from "../../__tests__/_helpers";

// ---------------------------------------------------------------------------
// Telegram fetch stub (matches takeover.test.ts pattern)
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
 * Mirrors takeover.test.ts `seedStaff`.
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

/**
 * Seed an outlet and bind a device to it. Returns outletId.
 * Mirrors takeover.test.ts `seedOutletWithDevice`.
 */
async function seedOutletWithDevice(
  t: ReturnType<typeof convexTest>,
  deviceId: string,
): Promise<Id<"outlets">> {
  return t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any);
    await ctx.db.insert("registered_devices", {
      device_id: deviceId,
      label: "Test Device",
      activated_at: Date.now(),
      active: true,
      outlet_id: outletId,
    } as any);
    return outletId;
  });
}

// ---------------------------------------------------------------------------
// Happy-path: manager override force-ends a stranded shift
// ---------------------------------------------------------------------------
test("managerOverride: correct manager PIN force-ends stranded holder, outlet stays open", async () => {
  const t = convexTest(schema);

  // Seed outlet + bind device
  const outletId = await seedOutletWithDevice(t, "d1");

  // Seed: stranded holder Sisca (staff) + manager M with known PIN "9999"
  const sisca = await seedStaff(t, "Sisca", "1234", "staff");
  const managerM = await seedStaff(t, "Manager", "9999", "manager");

  // Open the outlet
  await t.run(async (ctx: any) => {
    await ctx.db.patch(outletId, { is_open: true } as any);
  });

  // Insert an active shift for Sisca (stranded — no session needed)
  const strandedShiftId = await t.run(async (ctx: any) =>
    ctx.db.insert("pos_shifts", {
      outlet_id: outletId,
      device_id: "d1",
      staff_id: sisca,
      started_at: Date.now() - 60_000,
      started_via: "sop",
      ended_at: null,
      ended_via: null,
      open_count: null,
      close_count: null,
      outgoing_uncounted: null,
      steps: [],
      summary: null,
      prev_shift_id: null,
      created_at: Date.now() - 60_000,
    } as any),
  );

  // Call managerOverride
  const result = await t.action(api.shifts.actions.managerOverride, {
    idempotencyKey: "override-1",
    deviceId: "d1",
    managerStaffId: managerM,
    managerPin: "9999",
  });

  expect(result).toEqual({ ok: true });

  // Active shift is gone
  const activeShift = await t.query(
    internal.shifts.shiftsInternal._getActiveShift_internal,
    { outletId },
  );
  expect(activeShift).toBeNull();

  // The ended shift row has correct fields
  const endedShift = await t.run((ctx) =>
    ctx.db.get(strandedShiftId as Id<"pos_shifts">),
  );
  expect(endedShift?.ended_via).toBe("manager_override");
  expect(endedShift?.outgoing_uncounted).toBe(true);
  expect(endedShift?.ended_at).not.toBeNull();

  // Outlet is still open
  const outlet = await t.run((ctx) => ctx.db.get(outletId));
  expect((outlet as any).is_open).toBe(true);

  // Audit row exists
  const audits = await t.query(internal.audit.internal._list_internal, {
    action: "shift.manager_override",
  });
  expect(audits.length).toBeGreaterThanOrEqual(1);

  // Drain the scheduled _sendSignoffSummary action
  await drainScheduled(t);
});

// ---------------------------------------------------------------------------
// Idempotent no-op: no stranded holder → returns { ok: true } without error
// ---------------------------------------------------------------------------
test("managerOverride: no stranded holder → idempotent no-op", async () => {
  const t = convexTest(schema);

  const outletId = await seedOutletWithDevice(t, "d2");
  const managerM = await seedStaff(t, "Manager", "9999", "manager");

  // Open the outlet but don't create any shift
  await t.run(async (ctx: any) => {
    await ctx.db.patch(outletId, { is_open: true } as any);
  });

  const result = await t.action(api.shifts.actions.managerOverride, {
    idempotencyKey: "override-noop-1",
    deviceId: "d2",
    managerStaffId: managerM,
    managerPin: "9999",
  });

  expect(result).toEqual({ ok: true });
  await drainScheduled(t);
});

// ---------------------------------------------------------------------------
// Rejection: non-manager staff is rejected
// ---------------------------------------------------------------------------
test("managerOverride: non-manager staff is rejected with NOT_MANAGER", async () => {
  const t = convexTest(schema);

  const staffA = await seedStaff(t, "Budi", "1234", "staff");

  await expect(
    t.action(api.shifts.actions.managerOverride, {
      idempotencyKey: "override-reject-1",
      deviceId: "d1",
      managerStaffId: staffA,
      managerPin: "1234",
    }),
  ).rejects.toThrow(/NOT_MANAGER/);
});

// ---------------------------------------------------------------------------
// Rejection: wrong PIN is rejected
// ---------------------------------------------------------------------------
test("managerOverride: wrong PIN is rejected with INVALID_PIN", async () => {
  const t = convexTest(schema);

  const managerM = await seedStaff(t, "Manager", "9999", "manager");

  await expect(
    t.action(api.shifts.actions.managerOverride, {
      idempotencyKey: "override-wrongpin-1",
      deviceId: "d1",
      managerStaffId: managerM,
      managerPin: "0000",
    }),
  ).rejects.toThrow(/INVALID_PIN/);
});
