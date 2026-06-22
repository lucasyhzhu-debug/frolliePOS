import { query, mutation } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { wibDayWindow } from "../lib/time";
import { requireSession } from "../auth/sessions";
import { withIdempotency } from "../idempotency/internal";

/**
 * Returns the most recently created (non-replaced) invoice for a txn — the
 * reactive sub the charge screen subscribes to so it can re-render the QR / VA
 * when the user taps "Retry with fresh invoice".
 *
 * SEC-06: session-gated + day-scoped (was ungated — leaked qr_string/va_number
 * for any txn to any caller). Scope mirrors transactions.getById:
 *   - manager: any txn's invoice
 *   - staff:   only server-today (WIB) txns; null otherwise
 *   - null on invalid session OR missing txn/invoice
 * System callers use payments.internal._getCurrentInvoice_internal instead.
 */
export const getCurrentInvoice = query({
  args: { sessionId: v.id("staff_sessions"), txnId: v.id("pos_transactions") },
  handler: async (ctx, args): Promise<{
    xendit_invoice_id: string;
    method: "QRIS" | "BCA_VA";
    qr_string?: string;
    va_number?: string;
    reference_id?: string;
    created_at: number;
    cancelled_at?: number;
  } | null> => {
    // Day-scope gate mirrors transactions.resolveScopedTxn (single-writer there;
    // can't import a local fn cross-module). The two independent reads run in
    // parallel. Gates on the TRANSACTION's day, not the invoice's.
    const [who, txn] = await Promise.all([
      ctx.runQuery(internal.auth.internal._resolveSessionRole_internal, { sessionId: args.sessionId }),
      ctx.db.get(args.txnId),
    ]);
    if (!who || !txn) return null;
    if (who.role !== "manager") {
      const today = wibDayWindow(Date.now());
      if (txn.created_at < today.dayStartMs || txn.created_at >= today.dayEndMs) return null;
    }
    // Exclude superseded rows so the charge screen never re-renders a stale QR/VA
    // after a retry (a retry sets cancelled_at on the prior row; a plain txn-cancel
    // leaves the row intact). Filtering happens in JS, not via a .filter() on the
    // optional column: Convex's null-vs-undefined matching of an absent optional
    // field is ambiguous and differs between convex-test and prod. A txn has only
    // a handful of invoices, so collecting them is cheap and unambiguously correct.
    // v2.0 Stream 5: use by_outlet_transaction when outlet available on the txn.
    const outletId = txn.outlet_id;
    const invoices = outletId
      ? await ctx.db
          .query("pos_xendit_invoices")
          .withIndex("by_outlet_transaction", (q) =>
            q.eq("outlet_id", outletId).eq("transaction_id", args.txnId),
          )
          .order("desc")
          .collect()
      : await ctx.db
          .query("pos_xendit_invoices")
          .withIndex("by_transaction", (q) => q.eq("transaction_id", args.txnId))
          .order("desc")
          .collect();
    const inv = invoices.find((i) => !i.cancelled_at);
    if (!inv) return null;
    // SEC-06: project only the fields the charge screen renders — never spread the
    // raw invoice Doc (keeps the public seam narrow).
    return {
      xendit_invoice_id: inv.xendit_invoice_id,
      method: inv.method,
      qr_string: inv.qr_string,
      va_number: inv.va_number,
      reference_id: inv.reference_id,
      created_at: inv.created_at,
      cancelled_at: inv.cancelled_at,
    };
  },
});

/**
 * Staff-self-confirm for manual BCA transfer — the charge screen calls this
 * when the cashier has visually verified the BCA m-banking screenshot and taps
 * "Confirm". No manager PIN required (staff-session-only per ADR-036 §manual-BCA
 * design — staff is the attesting party; Telegram audit trail covers the approval
 * gap instead of a live PIN).
 *
 * Flow:
 *   1. Auth: valid staff session (throws NO_SESSION if invalid).
 *   2. Funnel: _confirmPaid_internal with source="manual_bca" + confirm_staff_id.
 *      Status-guard inside _confirmPaid means this is idempotent: if webhook
 *      already confirmed, _confirmPaid no-ops and the txn stays paid via webhook.
 *   3. Guard: read back txn — if not paid / no receipt, throw RECEIPT_UNCONFIRMED
 *      (C4: don't report false success; catches cancelled/expired races).
 *   4. Invoice cancel (WE-won-the-race guard): cancel the live QRIS/VA invoice
 *      ONLY when confirmed_via==="manual_bca". If the webhook arrived first and
 *      already set confirmed_via="webhook", skip — the paying invoice stays intact
 *      for the audit/receipt trail and cancelling it would corrupt forensics.
 *
 * Wrapped in withIdempotency + authCheck (ADR-013, rule #20). authCheck runs
 * BEFORE the cache lookup so an expired-session retry can't replay a cached
 * success (docs/PATTERNS/idempotency-dual-call-authcheck.md).
 */
export const confirmManualBcaPayment = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    txnId: v.id("pos_transactions"),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      sessionId: Id<"staff_sessions">;
      txnId: Id<"pos_transactions">;
    },
    { confirmed: true; receiptNumber: string }
  >(
    "payments.confirmManualBcaPayment",
    async (ctx, args) => {
      // Step 1: Require valid session — dual call intentional per ADR-013 §authCheck.
      const { staffId } = await requireSession(ctx, args.sessionId);

      // Step 2: Funnel through _confirmPaid_internal. Status-guard makes this
      // idempotent: if txn is already paid (webhook arrived first), this no-ops.
      await ctx.runMutation(internal.transactions.internal._confirmPaid_internal, {
        txnId: args.txnId,
        source: "manual_bca",
        confirm_staff_id: staffId,
      });

      // Step 3: Read back — throw if not paid or no receipt (C4: false-success guard).
      const txn = await ctx.db.get(args.txnId);
      if (!txn || txn.status !== "paid" || !txn.receipt_number) {
        throw new Error("RECEIPT_UNCONFIRMED");
      }

      // Step 4: Cancel the live invoice only if WE won the confirmation race.
      // If webhook got there first (confirmed_via="webhook"), the paying invoice
      // carries the bank RRN and must NOT be cancelled — receipts + audit need it.
      if (txn.confirmed_via === "manual_bca") {
        await ctx.runMutation(
          internal.payments.internal._cancelActiveInvoiceForTxn_internal,
          {
            txnId: args.txnId,
            cancel_reason: "manual_bca_confirmed",
            actor_id: staffId,
            source: "booth_inline",
          },
        );
      }

      return { confirmed: true as const, receiptNumber: txn.receipt_number };
    },
    {
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});
