"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal, api } from "../_generated/api";

/**
 * Cancel an awaiting_payment transaction. Spec §"transactions/ → actions.ts"
 * (staffreview T2):
 *   - Guard: txn.status must be "awaiting_payment".
 *   - runMutation _cancelCommit_internal flips status + logs transaction.cancelled.
 *   - After the commit, cascade-denies any live pending manual_payment_override
 *     approvals for this txn via _cancelPendingManualPaymentForTxn_internal (Task 11 /
 *     v050-be-cancel-cancels-approval). The cascade fires AFTER the terminal commit
 *     so if it fails the txn cancel is already landed (txn is source of truth).
 *
 * The prior best-effort Xendit expire! call has been removed (Decision E):
 * dedicated QR Codes / FVA APIs have no invoice "expire" endpoint, and a pay-
 * after-cancel (customer pays a superseded QR) is handled by the funnel's
 * terminal-state alert in _confirmPaid_internal rather than a remote cancel call.
 *
 * Action-level idempotency pattern (ADR-013):
 *   1. Pre-check the cache via _lookup_internal — hit replays the stored response
 *      without re-running HTTP or re-committing Convex state.
 *   2. _cancelCommit_internal commits the cancel + the idempotency cache row
 *      atomically (I6).
 *
 * Actions have no ctx.db, so all audit happens inside the mutations:
 *   - _cancelCommit_internal logs "transaction.cancelled".
 *   - _cancelPendingManualPaymentForTxn_internal logs manual_payment_override.denied for each cascaded row.
 */
export const cancelTransaction = action({
  args: {
    sessionId: v.id("staff_sessions"),
    txnId: v.id("pos_transactions"),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ cancelled: true }> => {
    // 1. Cache pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached);

    // 2. Resolve session → actor staff + device
    const session = await ctx.runQuery(api.auth.public.getSession, {
      sessionId: args.sessionId,
    });
    if (!session) throw new Error("SESSION_INVALID");

    // 3. Load txn + state guard
    const txn = await ctx.runQuery(api.transactions.public.getById, { txnId: args.txnId });
    if (!txn) throw new Error("TXN_NOT_FOUND");
    if (txn.status !== "awaiting_payment") throw new Error("INVALID_STATE_FOR_CANCEL");

    // 4. Commit the cancel (status flip + audit transaction.cancelled) AND the
    //    idempotency cache row in the same Convex transaction (I6 atomicity).
    // Dedicated APIs have no invoice "expire" call; the prior QR/VA is superseded
    // locally and the funnel's terminal-state alert handles a pay-after-cancel
    // (Decision E). Just commit the local cancel.
    const result = await ctx.runMutation(internal.transactions.internal._cancelCommit_internal, {
      idempotencyKey: args.idempotencyKey,
      txnId: args.txnId,
      reason: args.reason,
      actor_staff_id: session.staff._id,
      device_id: session.deviceId,
    });

    // 5. C1: Cancel the active Xendit invoice for this txn (parity with cancelAwaitingPayment).
    //    Fires AFTER the terminal commit so if this step fails the txn cancel is already
    //    landed. No-op when no active invoice exists.
    await ctx.runMutation(
      internal.payments.internal._cancelActiveInvoiceForTxn_internal,
      { txnId: args.txnId, cancel_reason: "txn_cancelled" },
    );

    // 6. Cascade-deny any live pending manual_payment_override approvals for this
    //    txn. Fires AFTER the terminal commit so if the cascade fails the txn
    //    cancel is already landed (txn is source of truth). Best-effort: the helper
    //    is a no-op when no pending rows exist (Task 11 / v050-be-cancel-cancels-approval).
    await ctx.runMutation(
      internal.approvals.internal._cancelPendingManualPaymentForTxn_internal,
      { txnId: args.txnId, reason: "txn_cancelled" },
    );

    return result;
  },
});
