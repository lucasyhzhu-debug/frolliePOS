import { defineTable } from "convex/server";
import { v } from "convex/values";

// One row per settlement DAY (not a Xendit object — Xendit has no settlement
// object; settlement is per-transaction, we aggregate by settlement_date).
// A row originates from the nightly poll (source="xendit_poll") or a manager's
// manual entry (source="manual"); poll wins on conflict (see _upsertSettlementDay_internal).
// All money is integer rupiah (ADR-015). settlement_key = `settle-${settlement_date}`.
export const settlementsTables = {
  pos_settlements: defineTable({
    settlement_key: v.string(), // `settle-YYYY-MM-DD` — unique upsert key
    settlement_date: v.string(), // ISO date YYYY-MM-DD (WIB calendar)
    gross_amount: v.number(),
    mdr_amount: v.number(),
    net_amount: v.number(), // gross - mdr
    transaction_count: v.number(),
    source: v.union(v.literal("xendit_poll"), v.literal("manual")),
    entered_by: v.optional(v.id("staff")), // set for source="manual"
    last_synced_at: v.optional(v.number()), // set on each poll upsert
    bca_account_destination: v.optional(v.string()), // last 4 digits (ADR-012)
    payload: v.optional(v.string()), // raw aggregated rows JSON (poll); debug + future match-back
    synced_to_frollie_pro_at: v.optional(v.number()), // dormant v1.1 hook
    created_at: v.number(),
  })
    .index("by_settlement_date", ["settlement_date"])
    .index("by_settlement_key", ["settlement_key"]),
};
