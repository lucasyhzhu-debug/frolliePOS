import { query } from "../_generated/server";
import { v } from "convex/values";

/**
 * Returns the most recently created (non-replaced) invoice for a txn — the
 * reactive sub the charge screen subscribes to so it can re-render the QR / VA
 * when the user taps "Retry with fresh invoice".
 */
export const getCurrentInvoice = query({
  args: { txnId: v.id("pos_transactions") },
  handler: async (ctx, args) => {
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
    return invoices.find((inv) => !inv.cancelled_at) ?? null;
  },
});
