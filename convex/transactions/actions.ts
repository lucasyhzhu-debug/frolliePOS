"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal, api } from "../_generated/api";

/**
 * Cancel an awaiting_payment transaction. Spec §"transactions/ → actions.ts"
 * (staffreview T2):
 *   - Guard: txn.status must be "awaiting_payment".
 *   - runMutation _cancelCommit_internal atomically:
 *       (a) flips status → cancelled + logs transaction.cancelled
 *       (b) cancels the active Xendit invoice (C1 atomicity — F1 fix)
 *       (c) cascade-denies live pending manual_payment_override approvals
 *           via _cancelPendingManualPaymentForTxn_internal (Task 11)
 *       (d) writes the idempotency cache row (I6)
 *     All four side effects share ONE Convex transaction — a transient
 *     failure on step b or c cannot strand an uncancelled invoice or live
 *     approval against a cancelled txn (the pre-F1 bug).
 *
 * The prior best-effort Xendit expire! call has been removed (Decision E):
 * dedicated QR Codes / FVA APIs have no invoice "expire" endpoint, and a pay-
 * after-cancel (customer pays a superseded QR) is handled by the funnel's
 * terminal-state alert in _confirmPaid_internal rather than a remote cancel call.
 *
 * Action-level idempotency pattern (ADR-013):
 *   1. Pre-check the cache via _lookup_internal — hit replays the stored response
 *      without re-running HTTP or re-committing Convex state.
 *   2. _cancelCommit_internal commits ALL side effects + the idempotency cache
 *      row atomically (I6 + C1).
 *
 * Actions have no ctx.db, so all audit happens inside the mutations:
 *   - _cancelCommit_internal logs "transaction.cancelled".
 *   - _cancelActiveInvoiceForTxn_internal logs "payment.invoice_cancelled".
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

    // 4. Commit the cancel (status flip + audit + invoice cancel + cascade-deny)
    //    AND the idempotency cache row in the same Convex transaction (I6 +
    //    C1 atomicity). All four side effects are inside _cancelCommit_internal
    //    so a transient failure on any step can't strand state. Dedicated APIs
    //    have no invoice "expire" call; pay-after-cancel is handled by the
    //    funnel's terminal-state alert in _confirmPaid_internal (Decision E).
    const result = await ctx.runMutation(internal.transactions.internal._cancelCommit_internal, {
      idempotencyKey: args.idempotencyKey,
      txnId: args.txnId,
      reason: args.reason,
      actor_staff_id: session.staff._id,
      device_id: session.deviceId,
    });

    return result;
  },
});
