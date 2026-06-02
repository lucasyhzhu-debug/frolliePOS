// convex/settings/schema.ts
import { defineTable } from "convex/server";
import { v } from "convex/values";

// Single-row settings table. v0.4 ships ONE field; v0.5 extends. Read-time
// default (settings/public.getSettings) returns founders_summary_enabled: true
// when the row is absent — no seeded row required (avoids a first-cron throw).
export const settingsTables = {
  pos_settings: defineTable({
    founders_summary_enabled: v.boolean(),
    // v0.5.3b receipt config — all optional; read-time defaults (see
    // settings/internal._getSettings_internal) preserve the prior hardcoded
    // values so an absent row still renders receipts unchanged.
    receipt_business_name: v.optional(v.string()),
    receipt_address: v.optional(v.string()),
    receipt_contact: v.optional(v.string()),
    receipt_instagram_handle: v.optional(v.string()),
    receipt_footer_text: v.optional(v.string()),
    receipt_logo_storage_id: v.optional(v.id("_storage")),
    updated_at: v.number(),
    updated_by: v.optional(v.id("staff")),
  }),
};
