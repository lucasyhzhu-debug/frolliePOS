import { query } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { wibDayWindow } from "../lib/time";
import {
  computeReceiptStatus,
  STATUS_LABELS,
  type ReceiptViewModel,
  type ReceiptStatus,
} from "./template";

/**
 * v0.5.4 — receipt data for in-app Bluetooth printing. Returns the structured
 * ReceiptViewModel (snapshot-safe, ADR-001) + a pre-derived status label.
 *
 * Scope mirrors transactions.public.getTransactionDetail:
 *   - manager: any paid txn
 *   - staff:   only txns whose created_at is within server-today (WIB)
 *   - null on invalid session / non-paid / out-of-scope (graceful UI degrade)
 *
 * Does NOT return receipt_token / URL — the QR token is minted via the
 * transactions.shareReceipt mutation (ADR-021 single-seam capability).
 */
export const getReceiptForPrint = query({
  args: { sessionId: v.id("staff_sessions"), txnId: v.id("pos_transactions") },
  handler: async (
    ctx,
    args,
  ): Promise<{ viewModel: ReceiptViewModel; status: ReceiptStatus; statusLabel: string } | null> => {
    const who = await ctx.runQuery(internal.auth.internal._resolveSessionRole_internal, {
      sessionId: args.sessionId,
    });
    if (!who) return null;

    // Staff-today scope (manager bypasses). Read created_at via transactions internal
    // surface (ADR-034) — receipts must not query pos_transactions directly.
    if (who.role !== "manager") {
      const txnMeta = await ctx.runQuery(
        internal.transactions.internal._getPaidTxnWithLinesForReceipt_internal,
        { transactionId: args.txnId },
      );
      if (!txnMeta) return null;
      const today = wibDayWindow(Date.now());
      if (txnMeta.txn.created_at < today.dayStartMs || txnMeta.txn.created_at >= today.dayEndMs) {
        return null;
      }
    }

    const vm = await ctx.runQuery(internal.receipts.internal._buildViewModel_internal, {
      transactionId: args.txnId,
    });
    if (!vm) return null;

    const status = computeReceiptStatus(vm);
    return { viewModel: vm, status, statusLabel: STATUS_LABELS[status].label };
  },
});
