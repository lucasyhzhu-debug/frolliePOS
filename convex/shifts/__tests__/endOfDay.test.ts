import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { setupTelegramStub, drainScheduled } from "../../__tests__/_helpers";
import type { Id } from "../../_generated/dataModel";

setupTelegramStub();

async function seedOpen(t: ReturnType<typeof convexTest>) {
  const ids = await t.run(async (ctx: any) => {
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
  await t.mutation(api.shifts.shifts.openBooth, { idempotencyKey: "open", sessionId: ids.sessionId, steps: [] });
  return ids;
}

test("endOfDay closes the outlet and ends the shift", async () => {
  const t = convexTest(schema);
  const { outletId, sessionId } = await seedOpen(t);
  const res = await t.mutation(api.shifts.shifts.endOfDay, { idempotencyKey: "e1", sessionId, steps: [] });
  expect(res.ok).toBe(true);
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(false);
  expect(await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId })).toBeNull();
  await drainScheduled(t);
});

test("endOfDay on a CLOSED outlet → idempotent no-op (session ends, durationMs 0)", async () => {
  const t = convexTest(schema);
  const { outletId, staffId } = await seedOpen(t);

  // Grab the session inserted by seedOpen (it ends openBooth flow with a live session)
  // First call: close the outlet
  const session1 = await t.run(async (ctx: any) => {
    return ctx.db
      .query("staff_sessions")
      .filter((q: any) => q.eq(q.field("staff_id"), staffId))
      .filter((q: any) => q.eq(q.field("ended_at"), null))
      .first();
  });
  await t.mutation(api.shifts.shifts.endOfDay, {
    idempotencyKey: "e1",
    sessionId: session1._id as Id<"staff_sessions">,
    steps: [],
  });

  // Outlet is now closed; shift is released. Insert a fresh session (simulate re-login).
  const session2Id: Id<"staff_sessions"> = await t.run(async (ctx: any) =>
    ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: "d1",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    }),
  );

  // Second call on the CLOSED outlet: idempotent no-op branch.
  const res2 = await t.mutation(api.shifts.shifts.endOfDay, {
    idempotencyKey: "e2",
    sessionId: session2Id,
    steps: [],
  });
  expect(res2.ok).toBe(true);
  expect(res2.durationMs).toBe(0);

  // Outlet still closed.
  expect((await t.query(internal.outlets.status._getOutletStatus_internal, { outletId })).is_open).toBe(false);

  // Fresh session is ended (end_reason set).
  const session2Row = await t.run(async (ctx: any) => ctx.db.get(session2Id));
  expect(session2Row.ended_at).not.toBeNull();
  expect(session2Row.end_reason).toBe("force_logout");

  await drainScheduled(t);
});
