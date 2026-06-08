import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { logAudit } from "../audit/internal";

/**
 * Single writer for pos_settlements. Upserts ONE row per settlement day
 * (key = `settle-${settlement_date}`). Conflict rule: poll wins over manual —
 * a later xendit_poll overwrites a manual row's amounts, flips source, preserves
 * created_at, and audits settlement.poll_superseded_manual. Manual-over-manual
 * and poll-over-poll simply patch in place. Never lossy-silent.
 * ADR-031: created_at / last_synced_at set inside the handler (server time).
 *
 * Note: a separate _auditSyncSkip_internal will be added in Task 6.
 */
export const _upsertSettlementDay_internal = internalMutation({
  args: {
    settlement_date: v.string(),
    gross_amount: v.number(),
    mdr_amount: v.number(),
    net_amount: v.number(),
    transaction_count: v.number(),
    source: v.union(v.literal("xendit_poll"), v.literal("manual")),
    entered_by: v.optional(v.id("staff")),
    bca_account_destination: v.optional(v.string()),
    payload: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"pos_settlements">> => {
    const key = `settle-${args.settlement_date}`;
    const now = Date.now();

    const existing = await ctx.db
      .query("pos_settlements")
      .withIndex("by_settlement_key", (q) => q.eq("settlement_key", key))
      .first();

    const fields = {
      gross_amount: args.gross_amount,
      mdr_amount: args.mdr_amount,
      net_amount: args.net_amount,
      transaction_count: args.transaction_count,
      source: args.source,
      ...(args.entered_by !== undefined ? { entered_by: args.entered_by } : {}),
      ...(args.bca_account_destination !== undefined
        ? { bca_account_destination: args.bca_account_destination }
        : {}),
      ...(args.payload !== undefined ? { payload: args.payload } : {}),
      ...(args.source === "xendit_poll" ? { last_synced_at: now } : {}),
    };

    if (existing) {
      const supersededManual =
        existing.source === "manual" && args.source === "xendit_poll";

      await ctx.db.patch(existing._id, fields);

      await logAudit(ctx, {
        actor_id: args.entered_by ?? "system",
        action: supersededManual
          ? "settlement.poll_superseded_manual"
          : "settlement.upserted",
        entity_type: "pos_settlements",
        entity_id: existing._id,
        source: args.source === "manual" ? "booth_inline" : "system",
        metadata: {
          settlement_date: args.settlement_date,
          source: args.source,
          net_amount: args.net_amount,
        },
      });

      return existing._id;
    }

    const id = await ctx.db.insert("pos_settlements", {
      settlement_key: key,
      settlement_date: args.settlement_date,
      created_at: now,
      ...fields,
    });

    await logAudit(ctx, {
      actor_id: args.entered_by ?? "system",
      action: "settlement.upserted",
      entity_type: "pos_settlements",
      entity_id: id,
      source: args.source === "manual" ? "booth_inline" : "system",
      metadata: {
        settlement_date: args.settlement_date,
        source: args.source,
        net_amount: args.net_amount,
      },
    });

    return id;
  },
});

/**
 * Audit an audited-skip for the settlement sync cron. Called when
 * listTransactions returns zero settled rows — expected pre-KYB result; not
 * an error, but worth logging so the cron dashboard and audit trail can
 * distinguish "ran and found nothing" from "never ran".
 *
 * entity_id is omitted intentionally: a sync-skip has no entity (matches the
 * inventory stock-recon skip audit pattern in inventory/internal.ts).
 * ADR-007: audit_log is append-only; ADR-031: created_at set inside logAudit.
 */
export const _auditSyncSkip_internal = internalMutation({
  args: {
    reason: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<void> => {
    await logAudit(ctx, {
      actor_id: "system",
      action: "settlement.sync_skipped",
      entity_type: "pos_settlements",
      source: "system",
      metadata: { reason: args.reason, ...(args.metadata ?? {}) },
    });
  },
});
