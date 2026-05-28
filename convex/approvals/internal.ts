import { internalMutation, internalQuery } from "../_generated/server";
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
 * Delete an approval request row. Used by notifyStaffLockout's recovery path: if
 * the Telegram send fails after the row was created (but before notified_at is
 * stamped), the stuck pending row would block the dedup guard for the full token
 * TTL — leaving managers blind. Deleting it lets the next lockout cycle create a
 * fresh request cleanly. approvals owns pos_approval_requests (ADR-034), so the
 * delete lives here. The "approval.created" audit row stays as a forensic trace
 * (append-only log).
 */
export const _deleteRequest_internal = internalMutation({
  args: {
    requestId: v.id("pos_approval_requests"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.requestId);
  },
});

/**
 * Record that the notification was sent for an approval request.
 * ADR-035 (supersedes ADR-027): the off-booth PIN-reset link is delivered via the
 * managers' Telegram group; this stamps when that notification went out.
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

/**
 * List pending, unexpired staff_pin_reset requests for a staff member.
 * Used by notifyStaffLockout's dedup guard (staffreview Improvement #5): if any
 * row is already pending and live, the second lockout notification is skipped.
 */
export const _listPendingForStaff_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", args.staffId))
      .collect();
    const now = Date.now();
    return rows.filter(
      (r) =>
        r.kind === "staff_pin_reset" &&
        r.status === "pending" &&
        r.token_expires_at > now,
    );
  },
});

/**
 * Resolve an approval request by its token hash (sha256 hex). Returns the full
 * row (including token_hash) so the action layer can do a constant-time compare
 * and check status / expiry. INTERNAL — never exposed to a public client.
 */
export const _getByTokenHash_internal = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", args.tokenHash))
      .first();
  },
});
