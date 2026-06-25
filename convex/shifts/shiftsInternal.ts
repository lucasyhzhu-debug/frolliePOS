import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { stepValidator } from "./schema";

const summaryValidator = v.object({
  durationMs: v.number(),
  totalSalesIdr: v.number(),
  txnCount: v.number(),
  manualBcaCount: v.number(),
  manualBcaTotalIdr: v.number(),
});

export const _getActiveShift_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }): Promise<Doc<"pos_shifts"> | null> => {
    return await ctx.db
      .query("pos_shifts")
      .withIndex("by_outlet_active", (q) => q.eq("outlet_id", outletId).eq("ended_at", null))
      .unique();
  },
});

export const _startShift_internal = internalMutation({
  args: {
    outletId: v.id("outlets"),
    deviceId: v.string(),
    staffId: v.id("staff"),
    startedVia: v.union(v.literal("sop"), v.literal("manager_skip"), v.literal("handover")),
    openCount: v.union(v.number(), v.null()),
    steps: v.array(stepValidator),
    prevShiftId: v.union(v.id("pos_shifts"), v.null()),
  },
  handler: async (ctx, args): Promise<Id<"pos_shifts">> => {
    const now = Date.now();
    return await ctx.db.insert("pos_shifts", {
      outlet_id: args.outletId,
      device_id: args.deviceId,
      staff_id: args.staffId,
      started_at: now,
      started_via: args.startedVia,
      ended_at: null,
      ended_via: null,
      open_count: args.openCount,
      close_count: null,
      outgoing_uncounted: null,
      steps: args.steps,
      summary: null,
      prev_shift_id: args.prevShiftId,
      created_at: now,
    });
  },
});

export const _endShift_internal = internalMutation({
  args: {
    shiftId: v.id("pos_shifts"),
    endedVia: v.union(v.literal("handover"), v.literal("end_of_day"), v.literal("manager_override")),
    closeCount: v.union(v.number(), v.null()),
    steps: v.array(stepValidator),
    outgoingUncounted: v.union(v.boolean(), v.null()),
    summary: v.union(summaryValidator, v.null()),
  },
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.patch(args.shiftId, {
      ended_at: Date.now(),
      ended_via: args.endedVia,
      close_count: args.closeCount,
      steps: args.steps.length ? args.steps : (await ctx.db.get(args.shiftId))!.steps,
      outgoing_uncounted: args.outgoingUncounted,
      summary: args.summary,
    });
    return null;
  },
});
