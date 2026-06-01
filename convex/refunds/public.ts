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
 * Projection (B28a I1): `txn` excludes `receipt_token` — that field is the ADR-021
 * capability for the public /r/<token> receipt URL; leaking it via a staff-session
 * query would let any signed-in staffer lift the receipt URL and share it
 * externally. Each refund's `lines[]` strips `line_id` (refunds-internal id;
 * frontend renders refund history as a single total per refund, not per-line).
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
    txn: {
      _id: Id<"pos_transactions">;
      _creationTime: number;
      status: Doc<"pos_transactions">["status"];
      subtotal: number;
      voucher_discount: number;
      total: number;
      voucher_code_snapshot?: string;
      created_at: number;
      paid_at?: number;
      receipt_number?: string;
    } | null;
    lines: Array<Doc<"pos_transaction_lines"> & { refundable: number }>;
    refunds: Array<{
      _id: Id<"pos_refunds">;
      _creationTime: number;
      transaction_id: Id<"pos_transactions">;
      total_refund: number;
      reason: string;
      requested_by: Id<"staff">;
      approver_id: Id<"staff">;
      approval_source: Doc<"pos_refunds">["approval_source"];
      settlement_status: Doc<"pos_refunds">["settlement_status"];
      settled_by?: Id<"staff">;
      settled_at?: number;
      created_at: number;
      lines: Array<{ qty: number; refund_amount: number }>;
    }>;
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

    const rawRefunds = await ctx.runQuery(
      internal.refunds.internal._listForTransaction_internal,
      { transactionId: args.transactionId },
    );

    // Project to display-needed fields. line_id stripped per the existing
    // refunds-internal convention (see approvals.public.getByToken refund branch,
    // which also strips line_id from the public surface).
    const refunds = rawRefunds.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      transaction_id: r.transaction_id,
      total_refund: r.total_refund,
      reason: r.reason,
      requested_by: r.requested_by,
      approver_id: r.approver_id,
      approval_source: r.approval_source,
      settlement_status: r.settlement_status,
      ...(r.settled_by !== undefined ? { settled_by: r.settled_by } : {}),
      ...(r.settled_at !== undefined ? { settled_at: r.settled_at } : {}),
      created_at: r.created_at,
      lines: r.lines.map((l) => ({ qty: l.qty, refund_amount: l.refund_amount })),
    }));

    // Project txn to drop receipt_token (ADR-021 capability — must NOT leak
    // via a staff-session query). All other fields preserved as-is.
    const txn: {
      _id: Id<"pos_transactions">;
      _creationTime: number;
      status: Doc<"pos_transactions">["status"];
      subtotal: number;
      voucher_discount: number;
      total: number;
      voucher_code_snapshot?: string;
      created_at: number;
      paid_at?: number;
      receipt_number?: string;
    } = {
      _id: result.txn._id,
      _creationTime: result.txn._creationTime,
      status: result.txn.status,
      subtotal: result.txn.subtotal,
      voucher_discount: result.txn.voucher_discount,
      total: result.txn.total,
      ...(result.txn.voucher_code_snapshot !== undefined
        ? { voucher_code_snapshot: result.txn.voucher_code_snapshot }
        : {}),
      created_at: result.txn.created_at,
      ...(result.txn.paid_at !== undefined ? { paid_at: result.txn.paid_at } : {}),
      ...(result.txn.receipt_number !== undefined
        ? { receipt_number: result.txn.receipt_number }
        : {}),
    };

    return { txn, lines: linesWithRefundable, refunds };
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
 *
 * Projection (B28a M2): only display-needed fields (the frontend renders
 * total_refund, reason, created_at). Capped at 200 via `.take(200)` — the
 * realistic backlog is a handful, but this is a reactive subscription on
 * /mgr/refunds-pending and the page re-runs whenever pos_refunds changes; the
 * soft cap bounds the reactive payload without changing UX in any realistic
 * operational state. If the backlog ever approaches 200, that's an ops issue,
 * not a UI issue.
 */
export const listPendingSettlement = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      _id: Id<"pos_refunds">;
      _creationTime: number;
      transaction_id: Id<"pos_transactions">;
      total_refund: number;
      reason: string;
      created_at: number;
    }>
  > => {
    await requireManagerSession(ctx, args.sessionId);
    const rows = await ctx.db
      .query("pos_refunds")
      .withIndex("by_settlement_status", (q) =>
        q.eq("settlement_status", "pending"),
      )
      .order("asc")
      .take(200);
    return rows.map((r) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      transaction_id: r.transaction_id,
      total_refund: r.total_refund,
      reason: r.reason,
      created_at: r.created_at,
    }));
  },
});
