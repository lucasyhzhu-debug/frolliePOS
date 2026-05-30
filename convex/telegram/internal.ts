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
