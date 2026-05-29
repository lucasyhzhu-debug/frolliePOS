// convex/settings/schema.ts
import { defineTable } from "convex/server";
import { v } from "convex/values";

// Single-row settings table. v0.4 ships ONE field; v0.5 extends. Read-time
// default (settings/public.getSettings) returns founders_summary_enabled: true
// when the row is absent — no seeded row required (avoids a first-cron throw).
export const settingsTables = {
  pos_settings: defineTable({
    founders_summary_enabled: v.boolean(),
    updated_at: v.number(),
    updated_by: v.optional(v.id("staff")),
  }),
};
