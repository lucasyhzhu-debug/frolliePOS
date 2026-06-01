"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal, api } from "../_generated/api";
import { verifyPinOrThrow } from "../auth/verifyPin";
import { createHash } from "node:crypto";
import { mintUrlSafeToken } from "../lib/tokens";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 60 min per ADR-029

/**
 * SHA-256 hex of a string. Tokens are high-entropy (32 random bytes), so a
 * salt-less SHA-256 is appropriate (ADR-029) — argon2id is reserved for
 * low-entropy PINs. Runs in the Node runtime ("use node"), so node:crypto is
 * available here. Mirrors the helper in approvals/actions.ts.
 */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

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
    // C1: pass derived `:commit` idempotency key so the wrapped funnel can
    // short-circuit on action-retry without double-committing the refund.
    const result = await ctx.runMutation(
      internal.refunds.internal._commitRefund_internal,
      {
        idempotencyKey: `${args.idempotencyKey}:commit`,
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

/**
 * Staff-initiated off-booth refund approval request (Telegram path). Called
 * from the refund screen when no manager is at the booth to authorise the
 * refund. The manager opens the /approve/:token URL from the managers'
 * Telegram group and enters PIN — that finishes the loop in `approveRefund`
 * (B10), which funnels through `_commitRefund_internal` just like the booth
 * path.
 *
 * Structural sibling of `approvals.requestManualPaymentApproval`. The shape is
 * intentionally identical so the security envelope, dedup behaviour, and
 * recovery semantics are predictable across approval kinds.
 *
 *   1. Action-level idempotency pre-check (ADR-013) — staff double-tap retry
 *      replays the same `{requestId}` blob, never re-mints a token / re-sends.
 *   2. Resolve session → staffId (auth module boundary, ADR-034). No PIN at
 *      this stage — staff just *initiates*; the manager's PIN happens later
 *      via `approveRefund`.
 *   3. Compute the refund preview via `_computeRefundPreview_internal`. This
 *      both validates that the txn is refundable AND captures the rendered
 *      preview (per-line product_name + refund_amount, total) for the
 *      Telegram card and the /approve UI.
 *   4. Dedup: one live pending refund per txn — return existing if found
 *      (`_findPendingRefundForTxn_internal`). Prevents Telegram spam.
 *   5. Mint 32-byte URL-safe token; persist only its SHA-256 hash (ADR-029).
 *   6. Create the request row via `_createRequest_internal` with kind="refund"
 *      and the RefundContext payload (validated by approvals/kinds.ts).
 *   7. Send the Telegram card. On failure, delete the request row (mirrors
 *      requestManualPaymentApproval recovery) so the next attempt isn't
 *      blocked by the dedup guard for the full TTL.
 *   8. Mark notified + best-effort link telegram_message_id.
 *   9. Write the action-level idempotency cache.
 *
 * Never logs PIN values; the raw token appears only in the Telegram URL.
 */
export const requestRefundApproval = action({
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
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ requestId: Id<"pos_approval_requests"> }> => {
    // Step 1: action-level idempotency pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { requestId: Id<"pos_approval_requests"> };

    // Step 2: resolve session — staff just initiates; no PIN at this stage.
    const requester = await ctx.runQuery(
      internal.auth.internal._resolveSession_internal,
      { sessionId: args.sessionId },
    );
    if (!requester) throw new Error("NO_SESSION");

    // Step 3: validate + compute preview in one shot. Throws TXN_NOT_REFUNDABLE
    // / TXN_NOT_PAID / LINE_NOT_FOUND on bad input — matches _commitRefund_internal's
    // error surface so both paths look the same to callers.
    const preview = await ctx.runQuery(
      internal.refunds.internal._computeRefundPreview_internal,
      { transactionId: args.transactionId, lines: args.lines },
    );

    // Step 4: dedup — one live request per txn. Returns the existing requestId
    // if a pending+unexpired refund request already exists.
    const existing = await ctx.runQuery(
      internal.refunds.internal._findPendingRefundForTxn_internal,
      { transactionId: args.transactionId },
    );
    if (existing) {
      const out = { requestId: existing };
      // Cache the dedup hit so a later retry under the same idempotency key
      // replays the same response without re-running the preview query.
      await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
        key: args.idempotencyKey,
        mutationName: "refunds.requestRefundApproval",
        response: JSON.stringify(out),
      });
      return out;
    }

    const baseUrl = process.env.POS_BASE_URL;
    if (!baseUrl) throw new Error("POS_BASE_URL not set");

    // Step 5: mint token (only hash persisted — ADR-029)
    const rawToken = mintUrlSafeToken();
    const tokenHash = sha256Hex(rawToken);
    const now = Date.now();

    // Step 6: create the request row. Context carries line_id (RefundContext)
    // so approveRefund (B10) can pass them into _commitRefund_internal without
    // needing to re-resolve from txn state. Schema stores Ids as strings.
    const { requestId } = await ctx.runMutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "refund",
        requester_staff_id: requester.staffId,
        entity_type: "pos_transactions",
        entity_id: args.transactionId as unknown as string,
        context: {
          txn_id: args.transactionId as unknown as string,
          receipt_number: preview.receipt_number,
          lines: preview.lines.map((l) => ({
            line_id: l.line_id as unknown as string,
            product_name: l.product_name,
            refund_qty: l.refund_qty,
            refund_amount: l.refund_amount,
          })),
          total_refund: preview.total_refund,
          reason: args.reason,
        },
        reason: args.reason,
        triggered_by_event: "refund_request",
        triggered_at: now,
        token_hash: tokenHash,
        token_expires_at: now + TOKEN_TTL_MS,
      },
    );

    // Step 7: send the Telegram card. The render payload (RefundPayload) does
    // NOT include line_id — that lives in the approval context only. Strip
    // before passing to sendTemplate.
    const telegramLines = preview.lines.map(({ product_name, refund_qty, refund_amount }) => ({
      product_name,
      refund_qty,
      refund_amount,
    }));
    let messageId: number | undefined;
    try {
      const sendRes = await ctx.runAction(api.telegram.send.sendTemplate, {
        role: "managers",
        kind: "refund",
        payload: {
          receipt_number: preview.receipt_number,
          total_refund: preview.total_refund,
          lines: telegramLines,
          reason: args.reason,
          request_url: `${baseUrl}/approve/${rawToken}`,
        },
        idempotencyKey: `${args.idempotencyKey}:send`,
      });
      messageId = sendRes.message_id;
    } catch (err) {
      // Stuck pending row would block dedup for the full TTL — delete so the
      // next attempt mints a fresh request cleanly (mirrors
      // requestManualPaymentApproval recovery). The refund.requested audit
      // row stays as a forensic trace (append-only).
      await ctx.runMutation(internal.approvals.internal._deleteRequest_internal, {
        requestId,
      });
      throw err;
    }

    // Step 8: mark notified + best-effort link message id
    await ctx.runMutation(internal.approvals.internal._markNotified_internal, { requestId });
    try {
      await ctx.runMutation(internal.approvals.internal._linkTelegramMessage_internal, {
        requestId,
        messageId,
        chatId: undefined,
      });
    } catch {
      // best-effort — never fail the request over a missing message link
    }

    // Step 9: cache the action-level response
    const out = { requestId };
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "refunds.requestRefundApproval",
      response: JSON.stringify(out),
    });

    return out;
  },
});
