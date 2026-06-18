import { query } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { wibDayWindow } from "../lib/time";

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
  handler: async (ctx, args) => {
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
    const invoices = await ctx.db
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
