import { internalMutation, MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";

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
      const invoiceId = await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: args.txnId,
        xendit_invoice_id: args.xendit_invoice_id,
        xendit_idempotency_key: args.xendit_idempotency_key,
        method: args.method,
        qr_string: args.qr_string,
        va_number: args.va_number,
        status_at_create: args.status_at_create,
        created_at: Date.now(),
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
      const newId = await ctx.db.insert("pos_xendit_invoices", {
        transaction_id: args.txnId,
        xendit_invoice_id: args.new_xendit_id,
        xendit_idempotency_key: args.new_xendit_idempotency_key,
        method: args.method,
        qr_string: args.qr_string,
        va_number: args.va_number,
        status_at_create: args.status_at_create,
        created_at: Date.now(),
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
 * Audit the best-effort Xendit invoice cancel outcome from
 * transactions.actions.cancelTransaction (staffreview T3). The action attempts a
 * best-effort Xendit expire! before committing the local cancel; a failed attempt
 * does NOT block the cancel, but the outcome is recorded here for reconciliation.
 *
 * Owned by payments because it concerns a pos_xendit_invoices lifecycle event,
 * mirroring the payment.invoice_cancelled row written in _replaceInvoiceCommit.
 * The action can't logAudit directly (no ctx.db), so it routes here via runMutation.
 */
export const _auditInvoiceCancelOutcome_internal = internalMutation({
  args: {
    txnId: v.id("pos_transactions"),
    outcome: v.object({ success: v.boolean(), error: v.optional(v.string()) }),
  },
  handler: async (ctx, args) => {
    await logAudit(ctx, {
      actor_id: "system",
      action: "payment.invoice_cancelled",
      entity_type: "pos_transactions",
      entity_id: args.txnId,
      source: "system",
      metadata: { reason: "transaction.cancelled", ...args.outcome },
    });
  },
});

/**
 * Resolve a Xendit invoice id → txn id, then delegate to the funnel. Shared by
 * the webhook and polling entry points (their only difference is the `source`
 * recorded on the confirmation). Unknown invoice → silent drop (e.g. a test
 * webhook). Idempotent because _confirmPaid status-guards.
 */
async function _resolveAndConfirm(
  ctx: MutationCtx,
  xenditInvoiceId: string,
  source: "webhook" | "polling",
): Promise<void> {
  const inv = await ctx.db
    .query("pos_xendit_invoices")
    .withIndex("by_xendit_invoice_id", (q) => q.eq("xendit_invoice_id", xenditInvoiceId))
    .first();
  if (!inv) return;
  await ctx.runMutation(internal.transactions.internal._confirmPaid_internal, {
    txnId: inv.transaction_id,
    source,
  });
}

/** Webhook path (primary). */
export const _onPaidWebhook_internal = internalMutation({
  args: { xendit_invoice_id: v.string() },
  handler: (ctx, args) => _resolveAndConfirm(ctx, args.xendit_invoice_id, "webhook"),
});

/** Polling-fallback path — the funnel's status guard makes a late poll a no-op. */
export const _onPaidPolling_internal = internalMutation({
  args: { xendit_invoice_id: v.string() },
  handler: (ctx, args) => _resolveAndConfirm(ctx, args.xendit_invoice_id, "polling"),
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
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      txnId: Id<"pos_transactions">;
      reason: string;
      mgr_approver_id: Id<"staff">;
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
