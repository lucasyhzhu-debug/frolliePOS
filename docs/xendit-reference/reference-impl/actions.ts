// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE COPY — from Frollie Recipe Master (product_master), Phase 84.
// Path in source repo: convex/qrisPayments/actions.ts
// Documentation only; NOT compiled in FrolliePOS.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 84 Plan 03 — QRIS create-invoice action.
 *
 * `createQrisInvoice` mints a Xendit dynamic QR for an order. There is NO
 * `protectedAction` in this project (staffreview C1), so this is a RAW
 * `action({ args: { orderId, token }, handler })` that gates auth by calling
 * the internal `getOrderForCreate` query (which runs requireRole). The token is
 * NEVER forwarded to the external Xendit call. Mirror: bigsellerOrders/actions.ts.
 *
 * Defense-in-depth: re-checks QRIS_ENABLED server-side (D-01), guards
 * AwaitingPayment + finalTotal >= 1500 BEFORE any write (R3 — throws, writes
 * nothing). Supersede-on-regenerate: expires any prior pending row, then inserts
 * exactly one new pending row.
 */

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { xenditProvider } from "../integrations/qris/xendit";

export const createQrisInvoice = action({
  args: { orderId: v.id("orders"), token: v.string() },
  handler: async (ctx, args) => {
    // 1. Flag re-check server-side (D-01 defense-in-depth).
    if (process.env.QRIS_ENABLED !== "true") {
      throw new Error("QRIS is not enabled");
    }

    // 2. Auth + state read via the internal query (requireRole inside it throws
    //    on unauthorized BEFORE returning state — staffreview C1).
    const order = await ctx.runQuery(internal.qrisPayments.queries.getOrderForCreate, {
      orderId: args.orderId,
      token: args.token,
    });

    // 3. State guards — throw BEFORE any write (R3).
    if (order.status !== "AwaitingPayment") {
      throw new Error("Order is not awaiting payment");
    }
    if (order.finalTotal < 1500) {
      throw new Error("Amount below QRIS minimum (1500 IDR)");
    }

    // 4. Mint the QR. The token is never forwarded to Xendit.
    const { xenditQrId, qrString, expiresAt } = await xenditProvider.createInvoice({
      orderNumber: order.orderNumber,
      finalTotal: order.finalTotal,
    });

    // 5. Supersede any prior pending row, then insert the fresh one.
    await ctx.runMutation(internal.qrisPayments.mutations.expirePrior, {
      orderId: args.orderId,
    });
    await ctx.runMutation(internal.qrisPayments.mutations.insertPending, {
      orderId: args.orderId,
      externalId: order.orderNumber,
      xenditQrId,
      qrString,
      amount: order.finalTotal,
      expiresAt,
    });

    return { xenditQrId, qrString, expiresAt };
  },
});
