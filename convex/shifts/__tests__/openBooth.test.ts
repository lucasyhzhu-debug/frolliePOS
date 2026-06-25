/**
 * Task 4: openBooth (SOP start-of-day) + managerSkipOpen tests.
 *
 * TDD: tests written first (RED), implementation follows (GREEN).
 *
 * PIN hashing for managerSkipOpen mirrors takeover.test.ts — routes through
 * the Node internalAction _seedHashedStaff_internal so jsdom doesn't evaluate
 * argon2; the production hashing routine is used.
 */

import { convexTest } from "convex-test";
import { expect, test, beforeEach, afterEach } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

// ---------------------------------------------------------------------------
// Telegram fetch stub (needed by managerSkipOpen path that may trigger Telegram)
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * Seed a CLOSED outlet + device + staff + session. Returns all IDs.
 */
async function seedClosed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: false,
    });
    await ctx.db.insert("registered_devices", {
      device_id: "d1", label: "T", activated_at: Date.now(), active: true, outlet_id: outletId,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Sisca", code: "S-1", role: "staff", pin_hash: "x",
      active: true, must_change_pin: false, created_at: 0,
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d1", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: outletId,
    });
    return { outletId, staffId, sessionId };
  });
}

/**
 * Seed a staff member with a REAL argon2id hash via the Node internalAction.
 * Mirrors takeover.test.ts seedStaff helper.
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
// openBooth tests
// ---------------------------------------------------------------------------

test("openBooth opens outlet and starts the first shift", async () => {
  const t = convexTest(schema);
  const { outletId, sessionId } = await seedClosed(t);

  const res = await t.mutation(api.shifts.shifts.openBooth, {
    idempotencyKey: "k1", sessionId, steps: [], openCount: 12,
  });
  expect(res.ok).toBe(true);

  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(true);
  const holder = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(holder?.started_via).toBe("sop");
  expect(holder?.open_count).toBe(12);
});

test("openBooth on an already-open outlet → BOOTH_ALREADY_OPEN", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedClosed(t);
  await t.mutation(api.shifts.shifts.openBooth, { idempotencyKey: "k1", sessionId, steps: [] });
  await expect(
    t.mutation(api.shifts.shifts.openBooth, { idempotencyKey: "k2", sessionId, steps: [] }),
  ).rejects.toThrow(/BOOTH_ALREADY_OPEN/);
});

// ---------------------------------------------------------------------------
// managerSkipOpen test
// ---------------------------------------------------------------------------

test("managerSkipOpen: manager PIN opens a closed outlet with manager_skip", async () => {
  const t = convexTest(schema);

  // Seed outlet + bind device
  const outletId: Id<"outlets"> = await t.run(async (ctx: any) => {
    const oid = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: false,
    });
    await ctx.db.insert("registered_devices", {
      device_id: "d2", label: "T", activated_at: Date.now(), active: true, outlet_id: oid,
    });
    return oid;
  });

  // Seed manager with argon2 hash via Node action
  const managerId = await seedStaff(t, "Manajer", "9999", "manager");

  // Create an active manager session
  const sessionId: Id<"staff_sessions"> = await t.run(async (ctx: any) =>
    ctx.db.insert("staff_sessions", {
      staff_id: managerId,
      device_id: "d2",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    }),
  );

  // Act: manager skips SOP
  const res = await t.action(api.shifts.actions.managerSkipOpen, {
    idempotencyKey: "skip-1",
    sessionId,
    managerPin: "9999",
  });

  expect(res.ok).toBe(true);
  expect(res.shiftId).toBeDefined();

  // Outlet must be open
  const status = await t.query(internal.outlets.status._getOutletStatus_internal, { outletId });
  expect(status.is_open).toBe(true);

  // Active shift must be started_via: "manager_skip"
  const shift = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(shift?.started_via).toBe("manager_skip");
  expect(shift?.open_count).toBeNull();
});

test("managerSkipOpen: wrong PIN throws INVALID_PIN", async () => {
  const t = convexTest(schema);

  const outletId: Id<"outlets"> = await t.run(async (ctx: any) => {
    const oid = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: false,
    });
    await ctx.db.insert("registered_devices", {
      device_id: "d3", label: "T", activated_at: Date.now(), active: true, outlet_id: oid,
    });
    return oid;
  });

  const managerId = await seedStaff(t, "Manajer2", "9999", "manager");

  const sessionId: Id<"staff_sessions"> = await t.run(async (ctx: any) =>
    ctx.db.insert("staff_sessions", {
      staff_id: managerId,
      device_id: "d3",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    }),
  );

  await expect(
    t.action(api.shifts.actions.managerSkipOpen, {
      idempotencyKey: "skip-wrongpin",
      sessionId,
      managerPin: "0000",
    }),
  ).rejects.toThrow(/INVALID_PIN/);
});
