// convex/telegram/internal.ts
//
// Internal mutations for the telegram module. Kept in a separate file from
// send.ts because send.ts uses "use node" (actions-only runtime) and
// internalMutation is not allowed there.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { logAudit } from "../audit/internal";

/**
 * Audit a failed Telegram send. Called by sendTemplate on !response.ok or
 * !json.ok, so the failure is traceable in the audit log even though the
 * action itself re-throws (no state is persisted on success path).
 */
export const _auditSendFailed_internal = internalMutation({
  args: {
    role: v.string(),
    kind: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    await logAudit(ctx, {
      actor_id: "system",
      action: "telegram.send_failed",
      entity_type: "telegram",
      source: "system",
      metadata: { role: args.role, kind: args.kind, status: args.status },
    });
  },
});

/**
 * Audit a founders shift-summary skip. Written when the daily cron fires but
 * the send is intentionally skipped (founders_summary_enabled: false) or the
 * send fails with a non-transient error.
 *
 * Kept here alongside the other internal mutations because this file is not
 * "use node" — internalMutation cannot live in a "use node" file.
 */
export const _auditSkip_internal = internalMutation({
  args: {
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    await logAudit(ctx, {
      actor_id: "system",
      action: "founders.summary_skipped",
      entity_type: "telegram",
      source: "system",
      metadata: { reason: args.reason },
    });
  },
});

/**
 * Append a row to telegram_log (outbound debug trail). Kept here alongside
 * _auditSendFailed_internal so both mutations share the same non-node file.
 */
export const logOutbound = internalMutation({
  args: {
    template_kind: v.string(),
    payload_json: v.string(),
    message_id: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("telegram_log", {
      direction: "out",
      template_kind: args.template_kind,
      payload_json: args.payload_json,
      message_id: args.message_id,
      created_at: Date.now(),
    });
  },
});

/**
 * Daily purge for telegramUpdates dedup rows older than 7 days. Telegram
 * update_ids increase monotonically and retries happen within seconds, so a
 * 7-day dedup window is generous. Without this purge the table grows by every
 * inbound update (including all non-command group chatter) for the lifetime
 * of the deployment.
 *
 * Page-bounded (PURGE_BATCH) so a single cron tick never overwhelms a write
 * txn. If more rows remain, the next day's run picks up the rest.
 */
const TELEGRAM_UPDATES_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TELEGRAM_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PURGE_BATCH = 500;

export const _purgeOldTelegramUpdates_internal = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const cutoff = Date.now() - TELEGRAM_UPDATES_TTL_MS;
    const old = await ctx.db
      .query("telegramUpdates")
      .withIndex("by_received_at", (q) => q.lt("receivedAt", cutoff))
      .take(PURGE_BATCH);
    for (const row of old) {
      await ctx.db.delete(row._id);
    }
    return { deleted: old.length };
  },
});

/**
 * Daily purge for telegram_log debug-trail rows older than 30 days. The audit
 * log is authoritative for compliance; telegram_log is a forensic convenience
 * for replaying sent payloads while debugging a bad template render. 30 days
 * is long enough to investigate a stale issue, short enough to bound storage.
 */
export const _purgeOldTelegramLog_internal = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const cutoff = Date.now() - TELEGRAM_LOG_TTL_MS;
    const old = await ctx.db
      .query("telegram_log")
      .withIndex("by_created_at", (q) => q.lt("created_at", cutoff))
      .take(PURGE_BATCH);
    for (const row of old) {
      await ctx.db.delete(row._id);
    }
    return { deleted: old.length };
  },
});
