import { internalMutation, internalQuery, MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";

/**
 * Normalise a pos_xendit_invoices row to the canonical instrument enum.
 * Pure helper — no DB access. Used by the day-window aggregator (and any
 * future caller) that already fetched the paid invoice via
 * `_getPaidInvoiceForTxn_internal` and just needs to surface
 * "qris" / "bca_va" / "unknown".
 *
 * v0.5.3a simplification: replaces the deleted `_instrumentForTxn_internal`
 * internalQuery — it ran identical SQL to `_getPaidInvoiceForTxn_internal`,
 * so the day-window aggregator now reuses the paid-invoice query and post-
 * processes the row with this helper.
 */
export function instrumentFromInvoice(
  inv: Pick<Doc<"pos_xendit_invoices">, "method"> | null,
): "qris" | "bca_va" | "unknown" {
  if (!inv) return "unknown";
  if (inv.method === "QRIS") return "qris";
  if (inv.method === "BCA_VA") return "bca_va";
  return "unknown";
}

/**
 * Commit a freshly-created Xendit invoice. Called from
 * payments.actions.requestPayment after the Xendit HTTP POST succeeds.
 *
 * withIdempotency wraps this so the cache row is written in the SAME
 * transaction as the invoice row + xendit_invoice_id_current patch.
 * This resolves staffreview Critical #1: an action retry that gets past
 * Xendit (because Xendit dedupes via X-IDEMPOTENCY-KEY) then runs this
 * mutation will see the cache row exists and return the cached response —
 * no double Convex-side invoice persistence.
 *
 * Boundary (ADR-034): pos_transactions is owned by the transactions module,
 * so the active-invoice pointer patch is routed through
 * transactions._setCurrentInvoice_internal via ctx.runMutation. Because
 * runMutation-within-a-mutation shares this Convex transaction, the invoice
 * insert + pointer patch + idempotency cache row commit atomically.
 */
export const _persistInvoiceCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    txnId: v.id("pos_transactions"),
    xendit_invoice_id: v.string(),
    reference_id: v.string(),
    xendit_idempotency_key: v.string(),
    method: v.union(v.literal("QRIS"), v.literal("BCA_VA")),
    qr_string: v.optional(v.string()),
    va_number: v.optional(v.string()),
    status_at_create: v.string(),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      txnId: Id<"pos_transactions">;
      xendit_invoice_id: string;
      reference_id: string;
      xendit_idempotency_key: string;
      method: "QRIS" | "BCA_VA";
      qr_string?: string;
      va_number?: string;
      status_at_create: string;
    },
    {
      invoiceId: Id<"pos_xendit_invoices">;
      method: "QRIS" | "BCA_VA";
      qrString?: string;
      vaNumber?: string;
    }
  >(
    "payments._persistInvoiceCommit",
    async (ctx, args) => {
      // v2.0 Task 5: stamp outlet_id from the associated transaction.
      const txnRow = await ctx.db.get(args.txnId);
      const txnOutletId = txnRow?.outlet_id;
      const invoiceId = await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: args.txnId,
        xendit_invoice_id: args.xendit_invoice_id,
        reference_id: args.reference_id,
        xendit_idempotency_key: args.xendit_idempotency_key,
        method: args.method,
        qr_string: args.qr_string,
        va_number: args.va_number,
        status_at_create: args.status_at_create,
        created_at: Date.now(),
        ...(txnOutletId ? { outlet_id: txnOutletId } : {}),
      });
      await ctx.runMutation(internal.transactions.internal._setCurrentInvoice_internal, {
        txnId: args.txnId,
        xenditInvoiceId: args.xendit_invoice_id,
      });
      await logAudit(ctx, {
        actor_id: "system",
        action: "payment.invoice_created",
        entity_type: "pos_xendit_invoices",
        entity_id: invoiceId,
        source: "system",
        metadata: { txnId: args.txnId, method: args.method },
      });
      // Return the FULL action response shape so the withIdempotency cache row
      // holds the complete { invoiceId, method, qrString?, vaNumber? } blob.
      // staffreview Critical #1: an action retry short-circuits on the action's
      // _lookup_internal pre-check and replays this exact blob — so qrString /
      // vaNumber survive the replay, not just invoiceId.
      return {
        invoiceId,
        method: args.method,
        qrString: args.qr_string,
        vaNumber: args.va_number,
      };
    },
  ),
});

/**
 * Replace the current invoice with a fresh one (retry-with-new-QR flow).
 * The prev invoice is marked cancelled + replaced_by_invoice_id is set
 * for audit traceability per ADR-014. The active-invoice pointer patch on
 * pos_transactions is routed through transactions._setCurrentInvoice_internal
 * (cross-module write boundary, ADR-034); the invoice rows themselves are
 * payments-owned so they're patched directly.
 */
export const _replaceInvoiceCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    txnId: v.id("pos_transactions"),
    prev_invoice_id: v.id("pos_xendit_invoices"),
    new_xendit_id: v.string(),
    reference_id: v.string(),
    new_xendit_idempotency_key: v.string(),
    method: v.union(v.literal("QRIS"), v.literal("BCA_VA")),
    qr_string: v.optional(v.string()),
    va_number: v.optional(v.string()),
    status_at_create: v.string(),
    cancel_outcome: v.object({ success: v.boolean(), error: v.optional(v.string()) }),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      txnId: Id<"pos_transactions">;
      prev_invoice_id: Id<"pos_xendit_invoices">;
      new_xendit_id: string;
      reference_id: string;
      new_xendit_idempotency_key: string;
      method: "QRIS" | "BCA_VA";
      qr_string?: string;
      va_number?: string;
      status_at_create: string;
      cancel_outcome: { success: boolean; error?: string };
    },
    {
      invoiceId: Id<"pos_xendit_invoices">;
      method: "QRIS" | "BCA_VA";
      qrString?: string;
      vaNumber?: string;
    }
  >(
    "payments._replaceInvoiceCommit",
    async (ctx, args) => {
      // v2.0 Task 5: stamp outlet_id from the associated transaction.
      const txnRow = await ctx.db.get(args.txnId);
      const txnOutletId = txnRow?.outlet_id;
      const newId = await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: args.txnId,
        xendit_invoice_id: args.new_xendit_id,
        reference_id: args.reference_id,
        xendit_idempotency_key: args.new_xendit_idempotency_key,
        method: args.method,
        qr_string: args.qr_string,
        va_number: args.va_number,
        status_at_create: args.status_at_create,
        created_at: Date.now(),
        ...(txnOutletId ? { outlet_id: txnOutletId } : {}),
      });
      await ctx.db.patch(args.prev_invoice_id, {
        cancelled_at: Date.now(),
        cancelled_reason: "replaced_by_retry",
        replaced_by_invoice_id: newId,
      });
      await ctx.runMutation(internal.transactions.internal._setCurrentInvoice_internal, {
        txnId: args.txnId,
        xenditInvoiceId: args.new_xendit_id,
      });
      await logAudit(ctx, {
        actor_id: "system",
        action: "payment.invoice_cancelled",
        entity_type: "pos_xendit_invoices",
        entity_id: args.prev_invoice_id,
        source: "system",
        metadata: {
          reason: "replaced_by_retry",
          success: args.cancel_outcome.success,
          error: args.cancel_outcome.error,
        },
      });
      await logAudit(ctx, {
        actor_id: "system",
        action: "payment.invoice_created",
        entity_type: "pos_xendit_invoices",
        entity_id: newId,
        source: "system",
        metadata: { txnId: args.txnId, method: args.method, replaced: args.prev_invoice_id },
      });
      // Full action response shape — see _persistInvoiceCommit_internal for the
      // staffreview Critical #1 rationale (cached blob must carry qrString/vaNumber).
      return {
        invoiceId: newId,
        method: args.method,
        qrString: args.qr_string,
        vaNumber: args.va_number,
      };
    },
  ),
});

/**
 * Cancel the active (no `cancelled_at` stamp) Xendit invoice for a given txn,
 * if one exists. Called by transactions.cancelAwaitingPayment when a staff
 * member abandons a payment in progress.
 *
 * "Active" is inferred from the absence of `cancelled_at` — pos_xendit_invoices
 * has no live status field (ADR-036). If no active invoice exists, this is a
 * no-op. payments owns pos_xendit_invoices so this write lives here (ADR-034).
 */
export const _cancelActiveInvoiceForTxn_internal = internalMutation({
  args: {
    txnId: v.id("pos_transactions"),
    cancel_reason: v.string(),
    // F6: Optional — when the caller has a real staff context (cancelAwaitingPayment,
    // cancelTransaction via _cancelCommit_internal), thread actor + source so forensic
    // queries filtering by staff or device_id surface the invoice-cancel half too.
    actor_id: v.optional(v.union(v.id("staff"), v.literal("system"))),
    source: v.optional(v.union(v.literal("booth_inline"), v.literal("system"))),
  },
  handler: async (ctx, args) => {
    // M6: JS post-filter — Convex q.eq(field, undefined) does not reliably match
    // absent optional fields (own MEMORY: convex-optional-field-filter-gotcha).
    const candidates = await ctx.db
      .query("pos_xendit_invoices")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.txnId))
      .collect();
    // F10: Cancel ALL active (no cancelled_at stamp) invoices, not just the first.
    // Invariant: at most one active invoice per txn at any time. If more exist,
    // cancel them all to converge state — the divergence is visible in forensic
    // queries because each invoice gets its own audit row.
    const active = candidates.filter((r) => r.cancelled_at === undefined);
    if (active.length === 0) return { cancelled: false };
    const auditActorId = args.actor_id ?? "system";
    const auditSource = args.source ?? "system";
    for (const invoice of active) {
      await ctx.db.patch(invoice._id, {
        cancelled_at: Date.now(),
        cancelled_reason: args.cancel_reason,
      });
      // I1: emit audit row for forensic queries — matches _replaceInvoiceCommit_internal's
      // audit shape on the structurally identical retry-supersede path.
      await logAudit(ctx, {
        actor_id: auditActorId,
        action: "payment.invoice_cancelled",
        entity_type: "pos_xendit_invoices",
        entity_id: invoice._id,
        source: auditSource,
        reason: args.cancel_reason,
        metadata: { txn_id: args.txnId },
      });
    }
    return { cancelled: true };
  },
});

/**
 * Resolve a Xendit provider id (QR id / FVA id) → invoice row → txn, record the
 * reconciliation fields on the payments-owned invoice row, then funnel to
 * _confirmPaid_internal threading paid_amount for the mismatch flag. Unknown id
 * → silent drop. Idempotent because the funnel status-guards.
 *
 * Atomicity invariant: the RRN/source patch and the _confirmPaid_internal call
 * run in ONE Convex transaction (nested ctx.runMutation shares it), so if the
 * funnel throws, the patch rolls back too. Do NOT split the patch into a
 * separate mutation — that would break this all-or-nothing guarantee.
 */
async function _resolveAndConfirm(
  ctx: MutationCtx,
  xenditInvoiceId: string,
  extra: { paid_amount?: number; receipt_id?: string; payment_source?: string },
): Promise<void> {
  const inv = await ctx.db
    .query("pos_xendit_invoices")
    .withIndex("by_xendit_invoice_id", (q) => q.eq("xendit_invoice_id", xenditInvoiceId))
    .first();
  if (!inv) return;
  // First-writer-wins: only stamp reconciliation fields not already set. Xendit
  // retries webhooks, and the patch runs before _confirmPaid_internal's status
  // guard, so without this a duplicate delivery would overwrite the original RRN.
  const recon: { receipt_id?: string; payment_source?: string } = {};
  if (extra.receipt_id !== undefined && inv.receipt_id === undefined) recon.receipt_id = extra.receipt_id;
  if (extra.payment_source !== undefined && inv.payment_source === undefined) recon.payment_source = extra.payment_source;
  if (recon.receipt_id !== undefined || recon.payment_source !== undefined) {
    await ctx.db.patch(inv._id, recon);
  }
  await ctx.runMutation(internal.transactions.internal._confirmPaid_internal, {
    txnId: inv.transaction_id,
    source: "webhook",
    paid_amount: extra.paid_amount,
  });
}

/** Webhook path (primary — and now the sole automatic confirmation path). */
export const _onPaidWebhook_internal = internalMutation({
  args: {
    xendit_invoice_id: v.string(),
    paid_amount: v.optional(v.number()),
    receipt_id: v.optional(v.string()),
    payment_source: v.optional(v.string()),
  },
  handler: (ctx, args) =>
    _resolveAndConfirm(ctx, args.xendit_invoice_id, {
      paid_amount: args.paid_amount,
      receipt_id: args.receipt_id,
      payment_source: args.payment_source,
    }),
});

/**
 * Manual-override path (manager PIN or WA approval). Carries the approver id
 * and reason into the funnel for audit; source=manual.
 *
 * withIdempotency-wrapped: the confirm, the receipt allocation, and the
 * idempotency cache row all commit in ONE Convex transaction (I6 — no
 * commit-then-cache window). Returns the full action response so the action's
 * _lookup_internal pre-check replays it on retry.
 */
export const _onPaidManual_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    txnId: v.id("pos_transactions"),
    reason: v.string(),
    mgr_approver_id: v.id("staff"),
    // v0.4 (Task 21): origin of the manual confirmation. Booth path
    // (payments.manuallyConfirmPayment) omits this → defaults to booth_inline
    // inside _confirmPaid_internal. Off-booth path
    // (approvals.approveManualPayment) passes "telegram_approval".
    source: v.optional(
      v.union(v.literal("booth_inline"), v.literal("telegram_approval")),
    ),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      txnId: Id<"pos_transactions">;
      reason: string;
      mgr_approver_id: Id<"staff">;
      source?: "booth_inline" | "telegram_approval";
    },
    { confirmed: true; receiptNumber: string }
  >(
    "payments.manuallyConfirmPayment",
    async (ctx, args) => {
      await ctx.runMutation(internal.transactions.internal._confirmPaid_internal, {
        txnId: args.txnId,
        source: "manual",
        mgr_approver_id: args.mgr_approver_id,
        manual_reason: args.reason,
        approvalSource: args.source,
      });
      // Read back inside the same transaction. _confirmPaid status-guards: a txn
      // that was already cancelled/expired (not awaiting_payment) no-ops and never
      // allocates a receipt — a missing receipt means "not actually confirmed", so
      // throw rather than return a false success (C4). An already-paid txn (webhook
      // arrived first) keeps its receipt and returns it normally.
      const txn = await ctx.db.get(args.txnId);
      if (!txn || txn.status !== "paid" || !txn.receipt_number) {
        throw new Error("RECEIPT_UNCONFIRMED");
      }
      return { confirmed: true as const, receiptNumber: txn.receipt_number };
    },
  ),
});

/**
 * Paying invoice for a txn — the invoice that carries the payment_method + RRN
 * receipts needs to render. Independent of whether the invoice was later
 * cancelled (e.g. PR B's refund flow may stamp `cancelled_at` on the paying
 * invoice; the receipt still needs the original method + RRN).
 *
 * Selection: among all invoices for this txn, return the one with the latest
 * `created_at`. Webhook-confirmed invoices carry the bank `receipt_id` (RRN);
 * manually confirmed invoices don't. Receipts surfaces RRN only if present.
 *
 * Returns null when no invoice row exists (e.g. pure manual-override paths
 * where no Xendit row was ever created); receipts callers fall back to a dash
 * for the payment method in that case.
 *
 * Index `by_transaction` exists on pos_xendit_invoices (payments/schema.ts).
 *
 * v0.5.3a consolidation: also used by the day-window aggregator for the
 * paymentMix bucket — paired with `instrumentFromInvoice` (pure helper above)
 * to normalise to "qris" / "bca_va" / "unknown". The former
 * `_instrumentForTxn_internal` ran identical SQL and was deleted.
 */
export const _getPaidInvoiceForTxn_internal = internalQuery({
  args: { transactionId: v.id("pos_transactions") },
  handler: async (ctx, args) => {
    const invoices = await ctx.db
      .query("pos_xendit_invoices")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.transactionId))
      .collect();
    // Reduce-pick-max instead of slice+sort — O(n) single pass, no extra
    // allocation. cancelled_at is NOT filtered out: a refund commit may stamp
    // cancelled_at on the original paying invoice, but the receipt still needs
    // its method + RRN. (manual_bca receipts bypass this query entirely upstream
    // in receipts/internal — see the v1.2 #13 note there — so a cancelled QRIS
    // invoice can no longer leak onto a manual-transfer receipt.)
    return invoices.reduce<typeof invoices[number] | null>(
      (best, cur) => (best == null || cur.created_at > best.created_at ? cur : best),
      null,
    );
  },
});

/**
 * SEC-06: current (non-cancelled) invoice read for SYSTEM callers. The public
 * `getCurrentInvoice` is now session-gated; the retry-supersede path
 * (payments/actions.ts) needs the raw row without a session, so it routes here.
 * Same selection logic as the public query (latest non-cancelled invoice).
 */
export const _getCurrentInvoice_internal = internalQuery({
  args: { txnId: v.id("pos_transactions") },
  handler: async (ctx, args): Promise<Doc<"pos_xendit_invoices"> | null> => {
    const invoices = await ctx.db
      .query("pos_xendit_invoices")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.txnId))
      .order("desc")
      .collect();
    return invoices.find((inv) => !inv.cancelled_at) ?? null;
  },
});
