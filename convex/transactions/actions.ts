"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal, api } from "../_generated/api";

/**
 * Cancel an awaiting_payment transaction. Spec §"transactions/ → actions.ts"
 * (staffreview T2):
 *   - Guard: txn.status must be "awaiting_payment".
 *   - runMutation _cancelCommit_internal flips status + logs transaction.cancelled.
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
    return await ctx.runMutation(internal.transactions.internal._cancelCommit_internal, {
      idempotencyKey: args.idempotencyKey,
      txnId: args.txnId,
      reason: args.reason,
      actor_staff_id: session.staff._id,
      device_id: session.deviceId,
    });
  },
});
