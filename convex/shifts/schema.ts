import { defineTable } from "convex/server";
import { v } from "convex/values";

export const stepValidator = v.object({
  key: v.string(),
  label: v.string(),
  type: v.union(v.literal("instruction"), v.literal("count")),
  confirmed_at: v.number(),
});

export const shiftsTables = {
  pos_shift_events: defineTable({
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
    created_at: v.number(),
    outlet_id: v.id("outlets"),  // v2.0 Task 12: enforced (was optional during migration window)
  })
    .index("by_device_created", ["device_id", "created_at"])
    .index("by_staff_started", ["staff_id", "shift_started_at"])
    .index("by_outlet_device_created", ["outlet_id", "device_id", "created_at"]),

  pos_shifts: defineTable({
    outlet_id: v.id("outlets"),
    device_id: v.string(),
    staff_id: v.id("staff"),
    started_at: v.number(),
    started_via: v.union(
      v.literal("sop"),
      v.literal("manager_skip"),
      v.literal("handover"),
    ),
    ended_at: v.union(v.number(), v.null()),
    ended_via: v.union(
      v.literal("handover"),
      v.literal("end_of_day"),
      v.literal("manager_override"),
      v.null(),
    ),
    open_count: v.union(v.number(), v.null()),
    close_count: v.union(v.number(), v.null()),
    outgoing_uncounted: v.union(v.boolean(), v.null()),
    steps: v.array(stepValidator),
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
    prev_shift_id: v.union(v.id("pos_shifts"), v.null()),
    created_at: v.number(),
  })
    .index("by_outlet_active", ["outlet_id", "ended_at"])
    .index("by_staff_started", ["staff_id", "started_at"])
    .index("by_outlet_started", ["outlet_id", "started_at"]),
};
