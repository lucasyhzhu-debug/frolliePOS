import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";

setupTelegramStub();

async function seedOpen(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: false,
    });
    await ctx.db.insert("registered_devices", { device_id: "d1", label: "T", activated_at: Date.now(), active: true, outlet_id: outletId });
    const staffId = await ctx.db.insert("staff", { name: "Sisca", code: "S-1", role: "staff", pin_hash: "x", active: true, must_change_pin: false, created_at: 0 });
    const sessionId = await ctx.db.insert("staff_sessions", { staff_id: staffId, device_id: "d1", started_at: Date.now(), ended_at: null, end_reason: null, outlet_id: outletId });
    return { outletId, staffId, sessionId };
  });
  await t.mutation(api.shifts.shifts.openBooth, { idempotencyKey: "open", sessionId: ids.sessionId, steps: [] });
  return ids;
}

test("startShift begins a new shift after handover; prev_shift_id links", async () => {
  const t = convexTest(schema);
  const { outletId, sessionId } = await seedOpen(t); // holder = Sisca
  await t.mutation(api.shifts.shifts.handover, { idempotencyKey: "h1", sessionId, steps: [] });

  // Budi logs in (different staff) on the now-holderless open outlet.
  const budiSession = await t.run(async (ctx: any) => {
    const dev = await ctx.db.query("registered_devices")
      .withIndex("by_device_id", (q: any) => q.eq("device_id", "d1")).first();
    const budi = await ctx.db.insert("staff", { name: "Budi", code: "S-2", role: "staff", pin_hash: "x", active: true, must_change_pin: false, created_at: 0 });
    return ctx.db.insert("staff_sessions", { staff_id: budi, device_id: "d1", started_at: Date.now(), ended_at: null, end_reason: null, outlet_id: dev.outlet_id });
  });

  const res = await t.mutation(api.shifts.shifts.startShift, {
    idempotencyKey: "s1", sessionId: budiSession, steps: [], openCount: 8,
  });
  expect(res.ok).toBe(true);
  const holder = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(holder?.started_via).toBe("handover");
  expect(holder?.open_count).toBe(8);
  expect(holder?.prev_shift_id).not.toBeNull();
  await drainScheduled(t);
});

test("startShift rejects a self-handover: the outgoing staffer cannot immediately re-claim the booth", async () => {
  const t = convexTest(schema);
  const { outletId, staffId, sessionId } = await seedOpen(t); // holder = Sisca (staffId)
  await t.mutation(api.shifts.shifts.handover, { idempotencyKey: "h1", sessionId, steps: [] });

  // Sisca (the SAME staff who just handed over) logs back in on the now-holderless
  // open outlet. This is the prod footgun: re-claiming mints a holder that strands
  // on the next lock. startShift must refuse it.
  const siscaSession2 = await t.run(async (ctx: any) => {
    const dev = await ctx.db.query("registered_devices")
      .withIndex("by_device_id", (q: any) => q.eq("device_id", "d1")).first();
    return ctx.db.insert("staff_sessions", { staff_id: staffId, device_id: "d1", started_at: Date.now(), ended_at: null, end_reason: null, outlet_id: dev.outlet_id });
  });

  await expect(
    t.mutation(api.shifts.shifts.startShift, { idempotencyKey: "s-self", sessionId: siscaSession2, steps: [], openCount: 8 }),
  ).rejects.toThrow(/SELF_HANDOVER_NOT_ALLOWED/);

  // No holder was created — the booth stays open + holderless so the ACTUAL next
  // person can log in and take over cleanly.
  const holder = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(holder).toBeNull();
  await drainScheduled(t);
});

test("startShift is NOT blocked after a manager_override release by the same staff (guard keys on ended_via=handover, not staff-id)", async () => {
  const t = convexTest(schema);
  const { outletId, staffId, sessionId } = await seedOpen(t); // holder = Sisca (staffId)

  // A manager releases the booth (closeOutlet:false): Sisca's shift ends via
  // manager_override, the outlet stays open + holderless.
  await t.mutation(internal.shifts.shiftsInternal._managerOverrideCommit_internal, {
    idempotencyKey: "ov1", deviceId: "d1", managerStaffId: staffId,
    closeOutlet: false, source: "booth_inline",
  });

  // The SAME staff (Sisca) starts again. Because the prior shift ended via
  // manager_override (NOT handover), this is a legitimate restart, not a self-handover.
  const res = await t.mutation(api.shifts.shifts.startShift, {
    idempotencyKey: "s-after-override", sessionId, steps: [], openCount: 8,
  });
  expect(res.ok).toBe(true);
  const holder = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(holder?.staff_id).toBe(staffId);
  await drainScheduled(t);
});

test("startShift on a closed outlet → BOOTH_NOT_OPEN; with a holder → SHIFT_IN_PROGRESS", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedOpen(t); // open, holder = Sisca
  await expect(
    t.mutation(api.shifts.shifts.startShift, { idempotencyKey: "s1", sessionId, steps: [] }),
  ).rejects.toThrow(/SHIFT_IN_PROGRESS/);
});

// ---------------------------------------------------------------------------
// I-D: CLOSED outlet (is_open false) + valid session → BOOTH_NOT_OPEN
// The existing test above only asserts SHIFT_IN_PROGRESS (open + holder).
// This test covers the complementary CLOSED case.
// ---------------------------------------------------------------------------
test("startShift: closed outlet rejects with BOOTH_NOT_OPEN (I-D)", async () => {
  const t = convexTest(schema);

  // Seed a CLOSED outlet + a valid session (no openBooth call)
  const sessionId = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "CLS", name: "closed", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: false,
    });
    await ctx.db.insert("registered_devices", {
      device_id: "d-cls", label: "T", activated_at: Date.now(), active: true, outlet_id: outletId,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Budi", code: "S-ID", role: "staff", pin_hash: "x", active: true, must_change_pin: false, created_at: 0,
    });
    return ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d-cls",
      started_at: Date.now(), ended_at: null, end_reason: null, outlet_id: outletId,
    });
  });

  await expect(
    t.mutation(api.shifts.shifts.startShift, { idempotencyKey: "id-closed", sessionId, steps: [] }),
  ).rejects.toThrow(/BOOTH_NOT_OPEN/);
});

