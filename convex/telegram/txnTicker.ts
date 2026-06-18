// V8-safe — no "use node". Uses runQuery/runAction only.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { instrumentFromInvoice } from "../payments/internal";

function instrumentLabel(
  method: "qris" | "bca_va" | "unknown",
  isManual: boolean,
): string {
  if (isManual) return "Manual";
  if (method === "qris") return "QRIS";
  if (method === "bca_va") return "BCA VA";
  return "—";
}

/**
 * v1.0.1 sales ticker. Scheduled (not inline) from _confirmPaid_internal so a
 * Telegram failure runs in its own transaction and can NEVER roll back a paid
 * sale. Toggle + role checks live here — toggle off / role unbound → SILENT skip,
 * NO audit_log rows (per-sale volume = audit spam). Only genuine send failures
 * get audited (inside sendTemplate).
 *
 * idempotencyKey = "ticker:<txnId>" (no Date.now bucketing — one ticker per sale).
 * disableNotification: true — silent running feed, not 100 buzzes.
 */
export const sendTxnTicker = internalAction({
  args: { txnId: v.id("pos_transactions") },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: true } | { skipped: "disabled" | "role_unbound" | "not_found" }> => {
    // 1. Toggle check — silent skip, NO audit.
    const settings = await ctx.runQuery(
      internal.settings.internal._getSettings_internal,
      {},
    );
    if (!settings.txn_ticker_enabled) return { skipped: "disabled" };

    // 2. Role resolve — narrow-catch (foundersSummary.ts pattern): unbound → silent
    //    skip; transient/unknown → rethrow so platform surfaces it.
    let chatId: string;
    try {
      chatId = await ctx.runQuery(
        internal.telegram.chatRegistry.internal.getChatIdByRole,
        { role: "managers" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No Telegram chat assigned to role")) {
        return { skipped: "role_unbound" };
      }
      throw err;
    }

    // 3. Read txn + lines + staff name + instrument.
    const txn = await ctx.runQuery(
      internal.transactions.internal._getTxnForTicker_internal,
      { txnId: args.txnId },
    );
    if (!txn) return { skipped: "not_found" };

    // _listStaffNames_internal args: {} → Array<{ _id; name }>. Resolve by .find.
    const names = await ctx.runQuery(
      internal.auth.internal._listStaffNames_internal,
      {},
    );
    const staffName = names.find((s) => s._id === txn.staff_id)?.name ?? "Staff";

    // _getPaidInvoiceForTxn_internal arg is `transactionId` (NOT txnId).
    const inv = await ctx.runQuery(
      internal.payments.internal._getPaidInvoiceForTxn_internal,
      { transactionId: args.txnId },
    );
    const instrument = instrumentLabel(
      instrumentFromInvoice(inv),
      txn.confirmed_via === "manual",
    );

    // 4. Send — disableNotification so it's a silent running feed.
    await ctx.runAction(api.telegram.send.sendTemplate, {
      role: "managers",
      kind: "txn_ticker",
      payload: {
        receipt_number: txn.receipt_number,
        total: txn.total,
        lines: txn.lines,
        staff_name: staffName,
        instrument,
        paid_at: Date.now(),
      },
      idempotencyKey: `ticker:${args.txnId}`,
      chatIdOverride: chatId,
      disableNotification: true,
    });

    return { ok: true };
  },
});
