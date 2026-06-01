"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal, api } from "../_generated/api";
import { verifyPinOrThrow } from "../auth/verifyPin";

/**
 * Booth-inline refund commit (manager at the booth). The manager hands the
 * device to the staffer; the manager's own PIN authorises the refund. argon2
 * verify is long-running so this lives in an action, not a mutation (CLAUDE.md
 * rule). On verify-success, delegate to the shared single-writer
 * `_commitRefund_internal` (B7) so the booth-PIN and Telegram-PIN paths share
 * one writer — v0.5.0 cross-path-parity lesson.
 *
 * Action-level idempotency pattern (mirrors payments.manuallyConfirmPayment):
 *   1. Cache pre-check via _lookup_internal. Hit → return cached response.
 *   2. Validate session (auth module boundary, ADR-034).
 *   3. Resolve approving manager by `managerStaffCode` (ADR-034 §Stable string
 *      identifiers — the external surface uses staff_code, never Convex _id).
 *      Single MANAGER_NOT_FOUND for the three "manager-not-usable" cases so we
 *      don't leak which condition failed.
 *   4. verifyPinOrThrow — lockout pre-check + argon2Verify + failed-attempt
 *      bookkeeping under a `${idempotencyKey}:failed` derived key so retries
 *      don't double-count. Wrong PIN counts toward THIS manager's lockout.
 *   5. Commit via `_commitRefund_internal` (the single writer). approvalSource =
 *      "booth_inline" so the refund row + audit row record this path correctly.
 *   6. Write the action-level idempotency cache row so a retry replays the same
 *      `{refundId, total_refund}` response without re-running the commit.
 *
 * Auth model (v0.5.0 manager-picker parity): the session establishes "someone
 * is logged in at the POS"; the manager identity is supplied independently as
 * `managerStaffCode`. The session staffer is recorded as `requested_by`; the
 * manager is recorded as `approver_id`. They may be the same person if the
 * manager is the one logged in.
 *
 * Never logs PIN values.
 */
export const commitRefundInline = action({
  args: {
    sessionId: v.id("staff_sessions"),
    idempotencyKey: v.string(),
    transactionId: v.id("pos_transactions"),
    lines: v.array(
      v.object({
        line_id: v.id("pos_transaction_lines"),
        qty: v.number(),
      }),
    ),
    reason: v.string(),
    managerStaffCode: v.string(),
    managerPin: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ refundId: Id<"pos_refunds">; total_refund: number }> => {
    // 1. Cache pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached);

    // 2. Auth: a valid (non-ended) session is required to initiate a refund.
    const session = await ctx.runQuery(api.auth.public.getSession, {
      sessionId: args.sessionId,
    });
    if (!session) throw new Error("SESSION_INVALID");

    // 3. Resolve approving manager by the explicitly supplied staff code.
    //    Single MANAGER_NOT_FOUND covers "no such code", "wrong role", and
    //    "inactive" — same convention as manuallyConfirmPayment.
    const manager = await ctx.runQuery(internal.auth.internal._getByCode_internal, {
      code: args.managerStaffCode,
    });
    if (!manager || manager.role !== "manager" || !manager.active) {
      throw new Error("MANAGER_NOT_FOUND");
    }

    // 4. Lockout pre-check + argon2 verify + failed-attempt recording. Wrong
    //    PIN counts toward THIS manager's ADR-002 lockout (not the session
    //    staff's). Shared funnel used by every PIN-gated action.
    await verifyPinOrThrow(ctx, {
      staffId: manager._id,
      deviceId: session.deviceId,
      pinHash: manager.pin_hash,
      pin: args.managerPin,
      idempotencyKey: args.idempotencyKey,
    });

    // 5. Commit through the single writer. requested_by = session staff (who
    //    initiated), approver_id = manager (who authorised). approvalSource
    //    records that this happened at the booth, not via Telegram.
    const result = await ctx.runMutation(
      internal.refunds.internal._commitRefund_internal,
      {
        transactionId: args.transactionId,
        lines: args.lines,
        reason: args.reason,
        requestedBy: session.staff._id,
        approverId: manager._id,
        approvalSource: "booth_inline",
      },
    );

    // 6. Cache the action-level response. _commitRefund_internal does not wrap
    //    with withIdempotency, so the action owns the cache write (same shape as
    //    a stand-alone _writeCache_internal call from approvals/actions when the
    //    commit funnel doesn't carry the top-level idempotency key).
    const out = { refundId: result.refundId, total_refund: result.total_refund };
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "refunds.commitRefundInline",
      response: JSON.stringify(out),
    });

    return out;
  },
});
