import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { Id, Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { withIdempotency } from "../idempotency/internal";
import { requireSession, requireManagerSession } from "../auth/sessions";
import { lineRefundable } from "./lib";
import { logAudit } from "../audit/internal";
import { wibDayWindow } from "../lib/time";

/**
 * Today's paid transactions, available to refund. Q1=B contract: paid since
 * 00:00 WIB today; older txns are unreachable in v0.5.1 (lock keeps the refund
 * surface small + predictable). Uses the WIB day-window helper so the cutoff
 * matches the founders shift-summary boundary.
 *
 * Cross-module read routed through transactions/internal per ADR-034 —
 * pos_transactions is transactions-owned, so refunds/public never queries it
 * directly. Returns newest-first.
 */
export const listTodaysRefundable = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args): Promise<Doc<"pos_transactions">[]> => {
    await requireSession(ctx, args.sessionId);
    const { dayStartMs } = wibDayWindow(Date.now());
    return await ctx.runQuery(
      internal.transactions.internal._listPaidTxnsSince_internal,
      { sinceMs: dayStartMs },
    );
  },
});

/**
 * Aggregate read for the refund form on /refund/[txnId]: returns the txn, its
 * lines (each annotated with `refundable` = remaining refundable qty), and any
 * existing refunds. Powers the per-line stepper + the "already refunded" history
 * block in one round-trip.
 *
 * Cross-module reads routed via owning-module internals per ADR-034:
 *   - pos_transactions / pos_transaction_lines via transactions'
 *     _getPaidTxnWithLinesForReceipt_internal (the same aggregate the receipts
 *     module uses — single canonical helper for "paid txn + its lines").
 *   - pos_refunds is refunds-owned; we read it directly here but funnel intra-
 *     module via _listForTransaction_internal so the ordering convention
 *     (oldest-first) stays consistent with receipts' refund-history rendering.
 *
 * Returns null txn + empty lists when the session is invalid OR the txn is not
 * found / not paid — the caller renders an empty-state rather than throwing.
 */
export const listForTransaction = query({
  args: {
    sessionId: v.id("staff_sessions"),
    transactionId: v.id("pos_transactions"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    txn: Doc<"pos_transactions"> | null;
    lines: Array<Doc<"pos_transaction_lines"> & { refundable: number }>;
    refunds: Doc<"pos_refunds">[];
  }> => {
    await requireSession(ctx, args.sessionId);

    const result = await ctx.runQuery(
      internal.transactions.internal._getPaidTxnWithLinesForReceipt_internal,
      { transactionId: args.transactionId },
    );
    if (!result) return { txn: null, lines: [], refunds: [] };

    const linesWithRefundable = result.lines.map((l) => ({
      ...l,
      refundable: lineRefundable(l),
    }));

    const refunds = await ctx.runQuery(
      internal.refunds.internal._listForTransaction_internal,
      { transactionId: args.transactionId },
    );

    return { txn: result.txn, lines: linesWithRefundable, refunds };
  },
});

/**
 * Manager flips a refund's settlement_status pending → settled per ADR-038.
 *
 * MANAGER SESSION gate — NOT a PIN gate. ADR-038: the money-authorising
 * decision happened at refund APPROVAL time (booth or Telegram PIN). Settling
 * is bookkeeping ack that the cash actually moved in the off-system channel
 * (cash-in-hand return, QRIS reverse transfer, etc.) — it doesn't need a fresh
 * PIN. CLAUDE.md business rule #22 (added in B27).
 *
 * Idempotent: a second call on an already-settled refund returns the existing
 * { settled_by, settled_at } without re-patching or re-auditing. Combined with
 * the withIdempotency wrapper, both same-key replays AND distinct-key races on
 * a settled refund are safe.
 */
export const markRefundSettled = mutation({
  args: {
    sessionId: v.id("staff_sessions"),
    idempotencyKey: v.string(),
    refundId: v.id("pos_refunds"),
  },
  handler: withIdempotency<
    {
      sessionId: Id<"staff_sessions">;
      idempotencyKey: string;
      refundId: Id<"pos_refunds">;
    },
    { settled_by: Id<"staff">; settled_at: number }
  >(
    "refunds.markRefundSettled",
    async (ctx, args) => {
      // Re-resolve the session inside the handler so the staffId for audit
      // attribution comes from the validated session. authCheck (below) has
      // already proven manager-ness; this read is the typed source for staffId.
      const { staffId } = await requireManagerSession(ctx, args.sessionId);

      const refund = await ctx.db.get(args.refundId);
      if (!refund) throw new Error("REFUND_NOT_FOUND");

      if (refund.settlement_status === "settled") {
        // Idempotent re-call: surface the original settler/timestamp. The
        // settled_by/at fields are set together in the patch below, so when
        // status is "settled" both are guaranteed present (non-null assertion
        // is safe and reflects the schema invariant).
        return {
          settled_by: refund.settled_by!,
          settled_at: refund.settled_at!,
        };
      }

      const now = Date.now();
      await ctx.db.patch(args.refundId, {
        settlement_status: "settled",
        settled_by: staffId,
        settled_at: now,
      });

      await logAudit(ctx, {
        actor_id: staffId,
        action: "refund.settled",
        entity_type: "pos_refunds",
        entity_id: args.refundId,
        source: "booth_inline",
        metadata: {
          total_refund: refund.total_refund,
          transaction_id: refund.transaction_id,
        },
      });

      return { settled_by: staffId, settled_at: now };
    },
    {
      // Gate the cache lookup itself so a same-key replay from a non-manager
      // session can't read back the cached settled response without authn.
      // Precedent: settings/public.ts setFoundersSummaryEnabled.
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});

/**
 * Refunds awaiting settlement, oldest-first. Powers /mgr/refunds-pending so a
 * manager can sweep through outstanding refund money-movements in FIFO order.
 *
 * Manager-only — the settlement queue is bookkeeping for managers; staff don't
 * see it. Uses the by_settlement_status index (composite on
 * [settlement_status, created_at]) so the asc order is index-native.
 *
 * pos_refunds is refunds-owned, so this query reads its own table directly
 * (intra-module, no ADR-034 boundary crossed).
 */
export const listPendingSettlement = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args): Promise<Doc<"pos_refunds">[]> => {
    await requireManagerSession(ctx, args.sessionId);
    return await ctx.db
      .query("pos_refunds")
      .withIndex("by_settlement_status", (q) =>
        q.eq("settlement_status", "pending"),
      )
      .order("asc")
      .collect();
  },
});
