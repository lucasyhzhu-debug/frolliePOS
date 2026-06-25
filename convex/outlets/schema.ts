import { defineTable } from "convex/server";
import { v } from "convex/values";

export const outletsTables = {
  outlets: defineTable({
    code: v.string(),
    name: v.string(),
    address: v.optional(v.string()),
    geo: v.optional(v.object({ lat: v.number(), lng: v.number() })),
    timezone: v.string(),
    active: v.boolean(),
    created_at: v.number(),
    created_by: v.union(v.id("staff"), v.null()), // null for the backfilled default outlet (house null-convention, cf. staff_sessions.ended_at)
    // v2.1 two-level booth state (ADR-053): Level-1 outlet status. Optional during
    // the additive migration window; flipped required after backfill (Task 10).
    is_open: v.optional(v.boolean()),
    opened_at: v.optional(v.union(v.number(), v.null())),
    opened_by: v.optional(v.union(v.id("staff"), v.null())),
    opened_via: v.optional(v.union(v.literal("sop"), v.literal("manager_skip"), v.null())),
    closed_at: v.optional(v.union(v.number(), v.null())),
    closed_by: v.optional(v.union(v.id("staff"), v.null())),
  })
    .index("by_code", ["code"])
    .index("by_active", ["active"]),

  staff_outlet_access: defineTable({
    staff_id: v.id("staff"),
    outlet_id: v.id("outlets"),
    granted_at: v.number(),
    granted_by: v.union(v.id("staff"), v.null()), // null for backfilled access (house null-convention)
  })
    .index("by_staff", ["staff_id"])
    .index("by_outlet", ["outlet_id"])
    .index("by_staff_outlet", ["staff_id", "outlet_id"]),
};
