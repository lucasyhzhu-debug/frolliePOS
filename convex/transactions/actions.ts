"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal, api } from "../_generated/api";

const XENDIT_BASE = "https://api.xendit.co";

/**
 * Cancel an awaiting_payment transaction. Spec §"transactions/ → actions.ts"
 * (staffreview T2 + T3):
 *   - Guard: txn.status must be "awaiting_payment".
 *   - Best-effort Xendit invoice cancel (expire!) if a current invoice exists;
 *     failure does NOT block the cancel (T3) — we still flip the status and
 *     record the failed outcome to the audit log for reconciliation.
 *   - runMutation _cancelCommit_internal flips status + logs transaction.cancelled.
 *
 * Action-level idempotency pattern (ADR-013):
 *   1. Pre-check the cache via _lookup_internal — hit replays the stored response
 *      without re-running HTTP or re-committing Convex state.
 *   2. Upstream idempotency: X-IDEMPOTENCY-KEY = `${idempotencyKey}:cancel` on the
 *      Xendit expire! call so a retry safely re-fires.
 *   3. Write the cache row via the idempotency module's own internal mutation
 *      (ADR-034: transactions must not write pos_idempotency directly). The
 *      _cancelCommit_internal mutation already committed all Convex state, so this
 *      is a stand-alone cache write.
 *
 * Actions have no ctx.db, so all audit happens inside the mutations:
 *   - _cancelCommit_internal logs "transaction.cancelled".
 *   - _auditInvoiceCancelOutcome_internal logs "payment.invoice_cancelled" with
 *     the best-effort Xendit outcome (success + optional error).
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

    // 4. Best-effort Xendit invoice cancel (expire!). Failure does NOT throw —
    //    the local cancel still proceeds (T3); the outcome is audited below.
    let cancel_outcome: { success: boolean; error?: string } | undefined;
    if (txn.xendit_invoice_id_current) {
      cancel_outcome = { success: true };
      try {
        const key = process.env.XENDIT_SECRET_KEY;
        if (!key) throw new Error("XENDIT_SECRET_KEY not set");
        const auth = `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
        const r = await fetch(
          `${XENDIT_BASE}/invoices/${txn.xendit_invoice_id_current}/expire!`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: auth,
              "X-IDEMPOTENCY-KEY": `${args.idempotencyKey}:cancel`,
            },
            body: JSON.stringify({}),
          },
        );
        if (!r.ok) {
          cancel_outcome = { success: false, error: await r.text() };
        }
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        cancel_outcome = { success: false, error };
      }
    }

    // 5. Audit the best-effort Xendit cancel outcome FIRST (only when attempted).
    //    _cancelCommit folds the idempotency cache write into its own transaction,
    //    so on a same-key retry the cache short-circuits before we re-reach this
    //    point — emitting the outcome here (not after the commit) is what keeps it
    //    from being lost if the action dies between commit and a trailing audit (I6).
    if (cancel_outcome !== undefined) {
      await ctx.runMutation(internal.payments.internal._auditInvoiceCancelOutcome_internal, {
        txnId: args.txnId,
        outcome: cancel_outcome,
      });
    }

    // 6. Commit the cancel (status flip + audit transaction.cancelled) AND the
    //    idempotency cache row in the same Convex transaction (I6 atomicity).
    return await ctx.runMutation(internal.transactions.internal._cancelCommit_internal, {
      idempotencyKey: args.idempotencyKey,
      txnId: args.txnId,
      reason: args.reason,
      actor_staff_id: session.staff._id,
      device_id: session.deviceId,
    });
  },
});
