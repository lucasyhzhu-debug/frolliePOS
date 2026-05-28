import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { logAudit } from "../audit/internal";

/**
 * Insert a new pos_approval_requests row in "pending" status.
 * Token fields (token_hash, token_expires_at) are supplied by the caller —
 * raw token generation happens in the action layer (ADR-029: token authorises VIEW).
 */
export const _createRequest_internal = internalMutation({
  args: {
    kind: v.union(v.literal("staff_pin_reset")),
    subject_staff_id: v.id("staff"),
    triggered_by_event: v.string(),
    triggered_at: v.number(),
    token_hash: v.string(),
    token_expires_at: v.number(),
  },
  handler: async (ctx, args) => {
    const requestId = await ctx.db.insert("pos_approval_requests", {
      kind: args.kind,
      subject_staff_id: args.subject_staff_id,
      triggered_by_event: args.triggered_by_event,
      triggered_at: args.triggered_at,
      token_hash: args.token_hash,
      token_expires_at: args.token_expires_at,
      status: "pending",
    });

    await logAudit(ctx, {
      actor_id: "system",
      action: "approval.created",
      entity_type: "pos_approval_requests",
      entity_id: requestId,
      source: "system",
      metadata: {
        kind: args.kind,
        subject_staff_id: args.subject_staff_id,
      },
    });

    return { requestId };
  },
});

/**
 * Record that the WA notification was sent for an approval request.
 * ADR-027: staff sends the WA message from their own device; this stamps when it happened.
 */
export const _markNotified_internal = internalMutation({
  args: {
    requestId: v.id("pos_approval_requests"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      notified_at: Date.now(),
    });

    await logAudit(ctx, {
      actor_id: "system",
      action: "approval.notified",
      entity_type: "pos_approval_requests",
      entity_id: args.requestId,
      source: "system",
    });
  },
});

/**
 * Mark an approval request as resolved by a manager.
 * ADR-029: PIN authorises ACT — the caller must have already verified the manager PIN
 * before calling this mutation.
 */
export const _markResolved_internal = internalMutation({
  args: {
    requestId: v.id("pos_approval_requests"),
    resolved_by_manager_id: v.id("staff"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      status: "resolved",
      resolved_at: Date.now(),
      resolved_by_manager_id: args.resolved_by_manager_id,
    });

    await logAudit(ctx, {
      actor_id: args.resolved_by_manager_id,
      action: "approval.resolved",
      entity_type: "pos_approval_requests",
      entity_id: args.requestId,
      source: "wa_approval",
      mgr_approver_id: args.resolved_by_manager_id,
    });
  },
});
