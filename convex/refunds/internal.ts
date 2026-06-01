import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id, Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { computeRefundAmount, lineRefundable } from "./lib";
import { logAudit } from "../audit/internal";
import { withIdempotency } from "../idempotency/internal";

/**
 * Cross-module read surface: receipts module calls this to list refunds for a
 * txn when rendering the receipt (ADR-039). Returns the rows ordered oldest-
 * first so the receipt's refund block reads chronologically.
 */
export const _listForTransaction_internal = internalQuery({
  args: { transactionId: v.id("pos_transactions") },
  handler: async (ctx, args): Promise<Doc<"pos_refunds">[]> => {
    return await ctx.db
      .query("pos_refunds")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.transactionId))
      .collect();
  },
});

/**
 * Dedup guard for the Telegram approval path. Returns the live pending refund
 * request for this txn if one exists; otherwise null. Used by
 * requestRefundApproval action (B9) to skip re-minting tokens / re-sending
 * cards when staff double-taps. Mirrors v0.4 manual_payment_override pattern.
 *
 * Cross-module read (pos_approval_requests is approvals-owned per ADR-034)
 * routed through approvals._listPendingByKind_internal — the helper already
 * filters by (kind, status="pending", token_expires_at > now) and matches on
 * entity_id, so refunds never touches pos_approval_requests directly.
 */
export const _findPendingRefundForTxn_internal = internalQuery({
  args: { transactionId: v.id("pos_transactions") },
  handler: async (ctx, args): Promise<Id<"pos_approval_requests"> | null> => {
    const rows = await ctx.runQuery(
      internal.approvals.internal._listPendingByKind_internal,
      { kind: "refund", entityId: args.transactionId },
    );
    const first = rows[0];
    return first?._id ?? null;
  },
});

/**
 * Compute the refund preview (per-line product_name + refund_qty +
 * refund_amount, plus total) for an off-booth approval request. Used by
 * requestRefundApproval (B9) to populate the approval-request `context` so the
 * Telegram card + /approve UI show exactly what's being approved before the
 * manager enters PIN.
 *
 * Routes through transactions' canonical aggregate
 * (_getPaidTxnWithLinesForReceipt_internal) per ADR-034 — refunds never reads
 * pos_transactions / pos_transaction_lines directly. Same null-handling shape
 * as _commitRefund_internal so the two paths surface identical error codes
 * (TXN_NOT_REFUNDABLE for "missing or not paid", LINE_NOT_FOUND for bad
 * line_id).
 *
 * Stateless: no DB writes; the caller (action) uses the returned preview as
 * input to `_createRequest_internal`'s context payload.
 */
export const _computeRefundPreview_internal = internalQuery({
  args: {
    transactionId: v.id("pos_transactions"),
    lines: v.array(
      v.object({
        line_id: v.id("pos_transaction_lines"),
        qty: v.number(),
      }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    receipt_number: string;
    lines: Array<{
      line_id: Id<"pos_transaction_lines">;
      product_name: string;
      refund_qty: number;
      refund_amount: number;
    }>;
    total_refund: number;
  }> => {
    const result = await ctx.runQuery(
      internal.transactions.internal._getPaidTxnWithLinesForReceipt_internal,
      { transactionId: args.transactionId },
    );
    if (!result) throw new Error("TXN_NOT_REFUNDABLE");
    // receipt_number is stamped at paid-commit; a paid txn without one is a
    // schema-invariant violation rather than a user-facing error.
    if (!result.txn.receipt_number) throw new Error("TXN_NOT_PAID");

    const linesById = new Map<string, Doc<"pos_transaction_lines">>();
    for (const l of result.lines) {
      linesById.set(l._id as unknown as string, l);
    }

    const previewLines: Array<{
      line_id: Id<"pos_transaction_lines">;
      product_name: string;
      refund_qty: number;
      refund_amount: number;
    }> = [];
    let total = 0;
    // N1: dedupe-check args.lines BEFORE per-line validation. Two entries
    // with the same line_id could each individually pass `qty <= refundable`
    // but the AGGREGATE would exceed refundable, yielding a double commit.
    // Reject at the args boundary so both preview + commit surfaces share one
    // contract.
    const seen = new Set<string>();
    for (const r of args.lines) {
      const key = r.line_id as unknown as string;
      if (seen.has(key)) throw new Error("REFUND_LINES_DUPLICATE");
      seen.add(key);
      const line = linesById.get(r.line_id as unknown as string);
      if (!line) throw new Error("LINE_NOT_FOUND");
      const amount = computeRefundAmount(line, result.txn, r.qty);
      previewLines.push({
        line_id: line._id,
        product_name: line.product_name_snapshot,
        refund_qty: r.qty,
        refund_amount: amount,
      });
      total += amount;
    }

    return {
      receipt_number: result.txn.receipt_number,
      lines: previewLines,
      total_refund: total,
    };
  },
});

/**
 * The single writer for refund commits — both inline (booth-PIN) and off-booth
 * (Telegram-PIN) paths funnel through here per v0.5.0 cross-path-parity lesson.
 *
 * Pipeline:
 *   1. Validate: txn paid; every line.qty in args matches a line on the txn
 *      and is ≤ refundable.
 *   2. Compute total_refund via ADR-040 helper.
 *   3. INSERT pos_refunds row.
 *   4. PATCH each line.refunded_qty += qty (via transactions/internal).
 *   5. Re-credit stock via inventory/internal helper (positive movements,
 *      source: refund).
 *   6. PURGE cached receipt HTML (B6 supplies the real implementation; B5
 *      callers don't exist yet so the PR A throwing stub is harmless here).
 *   7. AUDIT refund.committed.
 *
 * Cross-module reads/writes (ADR-034):
 *   - pos_transactions / pos_transaction_lines READ via
 *     transactions._getPaidTxnWithLinesForReceipt_internal (returns {txn,lines}).
 *   - pos_transaction_lines PATCH (refunded_qty) via
 *     transactions._patchLineRefundedQty_internal (B7).
 *   - inventory re-credit via inventory._refundReCredit_internal.
 *   - receipt cache purge via receipts._purgeReceiptCache_internal.
 */
export const _commitRefund_internal = internalMutation({
  args: {
    // v0.5.1 PR B C1: derived idempotency key (callers pass `${topKey}:commit`).
    // Wrapping the funnel with withIdempotency closes the "action-retry double-
    // commit" hole — if the outer action retried AFTER this mutation committed
    // but BEFORE the action-level cache row was written, a same-`:commit`-key
    // retry now short-circuits at the wrapper's cache lookup and returns the
    // original { refundId, total_refund } instead of re-inserting a second
    // pos_refunds row + second stock movements + second audit row.
    idempotencyKey: v.string(),
    transactionId: v.id("pos_transactions"),
    lines: v.array(v.object({
      line_id: v.id("pos_transaction_lines"),
      qty: v.number(),
    })),
    reason: v.string(),
    requestedBy: v.id("staff"),
    approverId: v.id("staff"),
    approvalSource: v.union(v.literal("booth_inline"), v.literal("telegram_approval")),
    approvalRequestId: v.optional(v.id("pos_approval_requests")),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      transactionId: Id<"pos_transactions">;
      lines: Array<{ line_id: Id<"pos_transaction_lines">; qty: number }>;
      reason: string;
      requestedBy: Id<"staff">;
      approverId: Id<"staff">;
      approvalSource: "booth_inline" | "telegram_approval";
      approvalRequestId?: Id<"pos_approval_requests">;
    },
    { refundId: Id<"pos_refunds">; total_refund: number }
  >(
    "refunds._commitRefund_internal",
    async (ctx, args): Promise<{ refundId: Id<"pos_refunds">; total_refund: number }> => {
      // 1. Validate txn + lines via transactions owning-module helper (ADR-034).
    //    Helper returns null if txn missing OR not paid, so a single null check
    //    covers TXN_NOT_FOUND + TXN_NOT_PAID. We surface them as one error code
    //    rather than two — callers (B8 booth-PIN, B10 telegram-PIN, B9 approval-
    //    request) treat "can't refund this txn" identically.
    const txnWithLines = await ctx.runQuery(
      internal.transactions.internal._getPaidTxnWithLinesForReceipt_internal,
      { transactionId: args.transactionId },
    );
    if (!txnWithLines) throw new Error("TXN_NOT_REFUNDABLE");
    const { txn, lines: txnLines } = txnWithLines;

    // Build a lookup so per-arg validation is O(1) and we don't re-read
    // each line individually from outside the transactions module.
    const lineById = new Map<string, Doc<"pos_transaction_lines">>();
    for (const l of txnLines) lineById.set(l._id as unknown as string, l);

    const lineDocs: Array<{ line: Doc<"pos_transaction_lines">; qty: number }> = [];
    // N1: dedupe-check args.lines so two same-line_id entries can't slip past
    // the per-line refundable cap and double-commit. Mirrors the same check
    // in _computeRefundPreview_internal — both writers share one contract.
    const seenLineIds = new Set<string>();
    for (const r of args.lines) {
      const key = r.line_id as unknown as string;
      if (seenLineIds.has(key)) throw new Error("REFUND_LINES_DUPLICATE");
      seenLineIds.add(key);
      const line = lineById.get(r.line_id as unknown as string);
      // LINE_NOT_FOUND covers both "no such line" AND "line belongs to a
      // different txn" — the lookup is scoped to txnLines, so a foreign
      // line_id falls into the same bucket without a separate LINE_MISMATCH.
      if (!line) throw new Error("LINE_NOT_FOUND");
      const refundable = lineRefundable(line);
      if (r.qty <= 0) throw new Error("REFUND_QTY_INVALID");
      if (r.qty > refundable) throw new Error("REFUND_QTY_EXCEEDS_REFUNDABLE");
      lineDocs.push({ line, qty: r.qty });
    }

    // 2. Compute per-line + total (ADR-040)
    const refundLineRows = lineDocs.map(({ line, qty }) => ({
      line_id: line._id,
      qty,
      refund_amount: computeRefundAmount(line, txn, qty),
    }));
    const total_refund = refundLineRows.reduce((s, r) => s + r.refund_amount, 0);
    // N4: reject zero-rupiah refunds at the booth-PIN path (the Telegram path
    // is already gated by validateContext("refund") which rejects
    // total_refund <= 0). A 100%-voucher-covered line or a zero-paid txn
    // would otherwise insert a pos_refunds row + audit + stock credit for
    // Rp 0 — meaningless write that pollutes the settlement queue.
    if (total_refund <= 0) throw new Error("REFUND_TOTAL_ZERO");

    const now = Date.now();

    // 3. INSERT refund row (pos_refunds is refunds-owned per ADR-034).
    const refundId = await ctx.db.insert("pos_refunds", {
      transaction_id: args.transactionId,
      lines: refundLineRows,
      total_refund,
      reason: args.reason,
      requested_by: args.requestedBy,
      approver_id: args.approverId,
      approval_source: args.approvalSource,
      approval_request_id: args.approvalRequestId,
      settlement_status: "pending",
      created_at: now,
    });

    // 4. PATCH refunded_qty per line — routed through transactions module
    //    (pos_transaction_lines is transactions-owned per ADR-034). B7 ships
    //    the _patchLineRefundedQty_internal helper.
    for (const { line, qty } of lineDocs) {
      await ctx.runMutation(
        internal.transactions.internal._patchLineRefundedQty_internal,
        { lineId: line._id, addQty: qty },
      );
    }

    // 5. Re-credit stock — delegated to inventory module per ADR-034. Pass
    //    line_qty (snapshotted at sale time, immutable) so inventory can
    //    derive per-unit components from the historic sale movements rather
    //    than re-reading the current recipe (I3 — recipe-drift safety).
    await ctx.runMutation(internal.inventory.internal._refundReCredit_internal, {
      refundId,
      transactionId: args.transactionId,
      lines: lineDocs.map(({ line, qty }) => ({
        line_id: line._id,
        line_qty: line.qty,
        qty,
      })),
    });

    // 6. Purge cached receipt. Throws if no receipt_token (v0.5.1 invariant
    //    violation — pre-v0.5.1 paid rows should be filtered out by the
    //    recent-list cutoff Q1=B so they're not in the refundable set).
    //    NOTE: The PR A stub of _purgeReceiptCache_internal currently throws
    //    "PR A stub" — B6 (next task) replaces it with the real implementation.
    //    Code is correct; runtime behaviour is gated by B6.
    await ctx.runMutation(internal.receipts.internal._purgeReceiptCache_internal, {
      transactionId: args.transactionId,
    });

    // 7. Audit
    await logAudit(ctx, {
      actor_id: args.approverId,
      action: "refund.committed",
      entity_type: "pos_refunds",
      entity_id: refundId,
      source: args.approvalSource,
      metadata: {
        transaction_id: args.transactionId,
        total_refund,
        lines_count: refundLineRows.length,
        reason: args.reason,
      },
    });

      return { refundId, total_refund };
    },
  ),
});
