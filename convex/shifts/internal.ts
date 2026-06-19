import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { stepValidator } from "./schema";

const shiftEventFields = {
  device_id: v.string(),
  type: v.union(
    v.literal("start_of_day"),
    v.literal("lock"),
    v.literal("resume"),
    v.literal("signoff_close"),
    v.literal("handover_out"),
    v.literal("handover_in"),
    v.literal("manager_takeover"),
  ),
  staff_id: v.id("staff"),
  shift_started_at: v.number(),
  shift_ended_at: v.union(v.number(), v.null()),
  steps: v.array(stepValidator),
  count_changed: v.union(v.number(), v.null()),
  takeover: v.union(v.boolean(), v.null()),
  outgoing_uncounted: v.union(v.boolean(), v.null()),
  stale_autoclose: v.union(v.boolean(), v.null()),
  linked_event_id: v.union(v.id("pos_shift_events"), v.null()),
  summary: v.union(
    v.object({
      durationMs: v.number(),
      totalSalesIdr: v.number(),
      txnCount: v.number(),
      manualBcaCount: v.number(),
      manualBcaTotalIdr: v.number(),
    }),
    v.null(),
  ),
};

export const _latestShiftEvent_internal = internalQuery({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) =>
    ctx.db
      .query("pos_shift_events")
      .withIndex("by_device_created", (q) => q.eq("device_id", deviceId))
      .order("desc")
      .first(),
});

export const _recordShiftEvent_internal = internalMutation({
  args: shiftEventFields,
  handler: async (ctx, args) =>
    ctx.db.insert("pos_shift_events", { ...args, created_at: Date.now() }),
});

export const _shiftStartAnchor_internal = internalQuery({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    // Walk back to the most recent shift-START event (open of the current shift).
    const recent = await ctx.db
      .query("pos_shift_events")
      .withIndex("by_device_created", (q) => q.eq("device_id", deviceId))
      .order("desc")
      .take(50);
    const anchor = recent.find(
      (e) =>
        e.type === "start_of_day" ||
        e.type === "handover_in" ||
        e.type === "manager_takeover",
    );
    return anchor
      ? { shift_started_at: anchor.shift_started_at, staff_id: anchor.staff_id }
      : null;
  },
});
