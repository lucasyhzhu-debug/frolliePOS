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
    const invoices = await ctx.db
      .query("pos_xendit_invoices")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", args.txnId))
      .order("desc")
      .take(1);
    return invoices[0] ?? null;
  },
});
