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
    // v1.0.1 — live sales ticker opt-out. Optional + read-time default true
    // (settings/internal._getSettings_internal) so the existing prod row needs
    // no migration. Same pattern as the receipt_* fields.
    txn_ticker_enabled: v.optional(v.boolean()),
    // v1.2 #10 — static-account manual bank transfer. All optional + read-time
    // defaults (settings/internal._getSettings_internal) so the existing prod
    // row needs no migration. Same pattern as receipt_* / txn_ticker_enabled.
    manual_bca_enabled: v.optional(v.boolean()),
    manual_bca_bank_name: v.optional(v.string()),
    manual_bca_account_name: v.optional(v.string()),
    manual_bca_account_number: v.optional(v.string()),
    updated_at: v.number(),
    updated_by: v.optional(v.id("staff")),
    outlet_id: v.id("outlets"),  // v2.0 Task 12: enforced; was singleton, now one row per outlet
    // outlet_device_id (RETIRED PR#124) DROPPED in v2.0 Task 12 — prod data was
    // already cleared by migrations.stripLegacyOutletDeviceId. Nothing reads/writes it.
  })
    .index("by_outlet", ["outlet_id"]),
};
