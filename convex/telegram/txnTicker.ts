// V8-safe — no "use node". Uses runQuery/runAction only.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { instrumentFromInvoice } from "../payments/internal";

function instrumentLabel(
  confirmedVia: "webhook" | "polling" | "manual" | "manual_bca" | null,
  method: "qris" | "bca_va" | "unknown",
): string {
  if (confirmedVia === "manual_bca") return "Manual BCA";
  if (confirmedVia === "manual") return "Manual";
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
    // 1. Read txn first — needed for outlet_id, and lets the disabled/not_found
    //    paths short-circuit BEFORE the names + invoice reads (per-sale volume,
    //    so don't pay for them when the ticker is off).
    const txn = await ctx.runQuery(internal.transactions.internal._getTxnForTicker_internal, {
      txnId: args.txnId,
    });
    if (!txn) return { skipped: "not_found" };

    // 2. Toggle check — per-outlet settings read; silent skip, NO audit.
    const settings = await ctx.runQuery(
      internal.settings.internal._getSettings_internal,
      { outletId: txn.outlet_id },
    );
    if (!settings.txn_ticker_enabled) return { skipped: "disabled" };

    // 3. Enabled — fetch the remaining inputs in parallel.
    const [names, inv] = await Promise.all([
      ctx.runQuery(internal.auth.internal._listStaffNames_internal, {}),
      ctx.runQuery(internal.payments.internal._getPaidInvoiceForTxn_internal, {
        transactionId: args.txnId,
        outletId: txn.outlet_id,
      }),
    ]);

    // 4. Role resolve — narrow-catch (foundersSummary.ts pattern): unbound → silent
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

    const staffName = names.find((s) => s._id === txn.staff_id)?.name ?? "Staff";
    const isManualBca = txn.confirmed_via === "manual_bca";
    const instrument = instrumentLabel(txn.confirmed_via, instrumentFromInvoice(inv));

    // 5. Send — disableNotification so it's a silent running feed. paid_at is the
    //    transaction's real settlement time (server-set in _confirmPaid), not the
    //    ticker send time.
    await ctx.runAction(api.telegram.send.sendTemplate, {
      role: "managers",
      kind: "txn_ticker",
      payload: {
        receipt_number: txn.receipt_number,
        total: txn.total,
        lines: txn.lines,
        staff_name: staffName,
        instrument,
        paid_at: txn.paid_at,
        manual_bca: isManualBca,
      },
      idempotencyKey: `ticker:${args.txnId}`,
      chatIdOverride: chatId,
      disableNotification: true,
    });

    return { ok: true };
  },
});
