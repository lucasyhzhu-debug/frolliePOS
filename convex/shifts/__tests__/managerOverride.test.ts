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
    const outletId = await ctx.db.insert("outlets", { is_open: false,
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
// Seed helpers for new Task-2 tests (inline, no _helpers.ts import)
// ---------------------------------------------------------------------------

/**
 * Seed an open booth with an active shift held by a non-manager staff member,
 * plus a manager with a known PIN. Returns { outletId, deviceId, managerId, managerPin }.
 */
async function seedOpenBoothHeldByOther(
  t: ReturnType<typeof convexTest>,
  deviceId = "d-close-1",
) {
  const outletId = await seedOutletWithDevice(t, deviceId);
  const holder = await seedStaff(t, "Stranded", "1111", "staff");
  const managerId = await seedStaff(t, "OverrideMgr", "8888", "manager");

  await t.run(async (ctx: any) => {
    await ctx.db.patch(outletId, { is_open: true } as any);
    await ctx.db.insert("pos_shifts", {
      outlet_id: outletId,
      device_id: deviceId,
      staff_id: holder,
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
    } as any);
  });

  return { outletId, deviceId, managerId, managerPin: "8888" };
}

/**
 * Seed an open outlet with a device + manager but NO active shift.
 * Returns { outletId, deviceId, managerId }.
 */
async function seedOpenBoothNoHold(
  t: ReturnType<typeof convexTest>,
  deviceId = "d-close-2",
) {
  const outletId = await seedOutletWithDevice(t, deviceId);
  const managerId = await seedStaff(t, "OverrideMgr2", "7777", "manager");

  await t.run(async (ctx: any) => {
    await ctx.db.patch(outletId, { is_open: true } as any);
  });

  return { outletId, deviceId, managerId };
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
    resultingState: "release",
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
    resultingState: "release",
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
      resultingState: "release",
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
      resultingState: "release",
    }),
  ).rejects.toThrow(/INVALID_PIN/);
});

// ---------------------------------------------------------------------------
// C1: idempotency-key replay / distinct-key behaviour
// ---------------------------------------------------------------------------
test("managerOverride: replay of key k1 does NOT end a second stranded holder; k2 does", async () => {
  const t = convexTest(schema);

  const outletId = await seedOutletWithDevice(t, "d-idem");
  const holderA = await seedStaff(t, "HolderA", "1111", "staff");
  const managerM = await seedStaff(t, "Mgr", "9999", "manager");

  // Open the outlet
  await t.run(async (ctx: any) => {
    await ctx.db.patch(outletId, { is_open: true } as any);
  });

  // Insert stranded shift for HolderA
  await t.run(async (ctx: any) =>
    ctx.db.insert("pos_shifts", {
      outlet_id: outletId, device_id: "d-idem", staff_id: holderA,
      started_at: Date.now() - 120_000, started_via: "sop",
      ended_at: null, ended_via: null, open_count: null, close_count: null,
      outgoing_uncounted: null, steps: [], summary: null, prev_shift_id: null,
      created_at: Date.now() - 120_000,
    } as any),
  );

  // k1: force-end HolderA
  await t.action(api.shifts.actions.managerOverride, {
    idempotencyKey: "k1",
    deviceId: "d-idem",
    managerStaffId: managerM,
    managerPin: "9999",
    resultingState: "release",
  });

  // Verify HolderA's shift is ended
  const afterA = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(afterA).toBeNull();

  // Seed HolderB as a new stranded shift
  const holderB = await seedStaff(t, "HolderB", "2222", "staff");
  await t.run(async (ctx: any) =>
    ctx.db.insert("pos_shifts", {
      outlet_id: outletId, device_id: "d-idem", staff_id: holderB,
      started_at: Date.now() - 60_000, started_via: "sop",
      ended_at: null, ended_via: null, open_count: null, close_count: null,
      outgoing_uncounted: null, steps: [], summary: null, prev_shift_id: null,
      created_at: Date.now() - 60_000,
    } as any),
  );

  // Replay k1 → must NOT end HolderB (cached no-op from HolderA's override)
  await t.action(api.shifts.actions.managerOverride, {
    idempotencyKey: "k1",
    deviceId: "d-idem",
    managerStaffId: managerM,
    managerPin: "9999",
    resultingState: "release",
  });
  const afterReplay = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(afterReplay).not.toBeNull(); // HolderB still active — k1 was a cache hit
  expect(afterReplay?.staff_id).toBe(holderB);

  // Fresh key k2 → force-ends HolderB
  await t.action(api.shifts.actions.managerOverride, {
    idempotencyKey: "k2",
    deviceId: "d-idem",
    managerStaffId: managerM,
    managerPin: "9999",
    resultingState: "release",
  });
  const afterK2 = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(afterK2).toBeNull(); // HolderB now force-ended

  await drainScheduled(t);
});

// ---------------------------------------------------------------------------
// Task 2: resultingState:"close" ends hold AND closes the outlet
// ---------------------------------------------------------------------------
test("managerOverride resultingState:close ends hold AND closes the outlet", async () => {
  const t = convexTest(schema);

  const { outletId, deviceId, managerId, managerPin } = await seedOpenBoothHeldByOther(t);

  await t.action(api.shifts.actions.managerOverride, {
    idempotencyKey: "c1",
    deviceId,
    managerStaffId: managerId,
    managerPin,
    resultingState: "close",
  });

  const status = await t.query(internal.outlets.status._getOutletStatus_internal, { outletId });
  expect(status.is_open).toBe(false);

  const hold = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(hold).toBeNull();

  await drainScheduled(t);
});

// ---------------------------------------------------------------------------
// Task 2: _managerOverrideCommit closeOutlet:true with NO hold still closes outlet
// ---------------------------------------------------------------------------
test("_managerOverrideCommit closeOutlet:true with NO hold still closes the outlet", async () => {
  const t = convexTest(schema);

  const { outletId, deviceId, managerId } = await seedOpenBoothNoHold(t);

  await t.mutation(internal.shifts.shiftsInternal._managerOverrideCommit_internal, {
    idempotencyKey: "c2",
    deviceId,
    managerStaffId: managerId,
    closeOutlet: true,
    source: "telegram_approval",
  });

  const status = await t.query(internal.outlets.status._getOutletStatus_internal, { outletId });
  expect(status.is_open).toBe(false);
});
