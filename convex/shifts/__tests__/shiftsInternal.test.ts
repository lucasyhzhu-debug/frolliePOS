import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null, is_open: true,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Sisca", code: "S-1", role: "staff", pin_hash: "x",
      active: true, must_change_pin: false, created_at: 0,
    });
    return { outletId, staffId };
  });
}

test("start then end a shift; active holder reflects state", async () => {
  const t = convexTest(schema);
  const { outletId, staffId } = await seed(t);

  const shiftId = await t.mutation(internal.shifts.shiftsInternal._startShift_internal, {
    outletId, deviceId: "d1", staffId, startedVia: "sop",
    openCount: 12, steps: [], prevShiftId: null,
  });
  let active = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(active?._id).toBe(shiftId);

  await t.mutation(internal.shifts.shiftsInternal._endShift_internal, {
    shiftId, endedVia: "handover", closeCount: 10, steps: [],
    outgoingUncounted: null,
    summary: { durationMs: 1, totalSalesIdr: 0, txnCount: 0, manualBcaCount: 0, manualBcaTotalIdr: 0 },
  });
  active = await t.query(internal.shifts.shiftsInternal._getActiveShift_internal, { outletId });
  expect(active).toBeNull();
});
