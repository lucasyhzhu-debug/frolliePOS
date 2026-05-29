// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE COPY — from Frollie Recipe Master (product_master), Phase 84.
// Path in source repo: convex/qrisPayments/mutations.ts
// Documentation only; NOT compiled in FrolliePOS. Project-specific imports
// (reserveStockForOrderInternal, logStatusTransition, orders table) are the
// SOURCE repo's — see README "Adaptation map" for the FrolliePOS equivalents.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 84 Plan 03 — QRIS payment mutations (the transactional core).
 *
 * The highest-risk surface of the phase (real money). Encodes the staffreview
 * critical fixes:
 *   - C3 — payment-durable transition: the qrisPayments row is recorded `paid`
 *     DURABLY before the order transition/reserve is attempted; a reserve failure
 *     keeps the paid row + flags needsReview + reverts order status (SPEC R4 =
 *     payment ALWAYS honored).
 *   - C4 — unmatched COMPLETED webhook is a safe no-op (returns
 *     { transitioned: false }, throws nothing).
 *   - C7 — decideWebhookOutcome builds reviewReason COMPOSITIONALLY so both
 *     amount-mismatch AND superseded signals survive when both apply; recordPaid
 *     is ALWAYS true (honor-always).
 *   - C8 — matching is primarily on the globally-unique xenditQrId; externalId
 *     (orderNumber MMDD-NNN, NOT globally unique — resets daily) matching is
 *     scoped to the active/pending row, never a blind `.first()` over all history.
 *
 * Idempotency lives here, by the order STATUS guard, not webhook dedup (Xendit
 * may legitimately re-deliver). Mirrors the canonical guarded reserve in
 * convex/orders/mutations/statusUpdates.ts:140-210. Does NOT reuse `updatePayment`
 * (no transition/reserve) or `moveForward` (auto-expedites). Does NOT set
 * isKitchenVisible (computeIsKitchenVisible("PaymentReceived") is false, identical
 * to AwaitingPayment).
 */

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import { reserveStockForOrderInternal } from "../orders/mutations/inventoryIntegration";
import { logStatusTransition } from "../orders/helpers/statusTransitions";

/**
 * Pure decision function for the webhook outcome (staffreview C7).
 *
 * recordPaid is ALWAYS true — the customer paid, so the row is honored
 * regardless. The reason is built COMPOSITIONALLY so that when both the
 * amount-mismatch and the superseded signals apply, BOTH substrings survive.
 */
export function decideWebhookOutcome(
  order: { status: string },
  row: { amount: number; status: string },
  payload: { amount: number },
): { transition: boolean; recordPaid: true; needsReview: boolean; reason?: string } {
  const amountMismatch = payload.amount !== row.amount;
  const superseded = row.status === "expired";
  const needsReview = amountMismatch || superseded;

  const parts: string[] = [];
  if (amountMismatch) parts.push(`amount ${payload.amount} != expected ${row.amount}`);
  if (superseded) parts.push("QR was superseded/expired before payment");
  const reason = parts.length ? parts.join("; ") : undefined;

  const transition = order.status === "AwaitingPayment";
  return { transition, recordPaid: true as const, needsReview, reason };
}

/**
 * Insert exactly one `pending` qrisPayments row linked to the order.
 *
 * When called from the create-invoice action with `requireAwaitingPayment: true`,
 * this re-validates the order state server-side (R3): the order MUST be
 * AwaitingPayment and finalTotal MUST be >= 1500 (Xendit floor) — otherwise it
 * throws BEFORE inserting anything (writes nothing).
 */
export const insertPending = internalMutation({
  args: {
    orderId: v.id("orders"),
    externalId: v.string(),
    xenditQrId: v.string(),
    qrString: v.string(),
    amount: v.number(),
    expiresAt: v.number(),
    requireAwaitingPayment: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (args.requireAwaitingPayment) {
      const order = await ctx.db.get(args.orderId);
      if (!order) throw new Error("Order not found");
      if (order.status !== "AwaitingPayment") {
        throw new Error("Order is not awaiting payment");
      }
      if ((order.finalTotal ?? 0) < 1500) {
        throw new Error("Amount below QRIS minimum (1500 IDR)");
      }
    }

    const rowId = await ctx.db.insert("qrisPayments", {
      orderId: args.orderId,
      provider: "xendit",
      externalId: args.externalId,
      xenditQrId: args.xenditQrId,
      qrString: args.qrString,
      amount: args.amount,
      status: "pending",
      expiresAt: args.expiresAt,
    });
    return rowId;
  },
});

/**
 * Supersede-on-regenerate: flip every prior `pending` row for the order to
 * `expired`. Run BEFORE inserting a new pending row.
 * Index-scan-then-patch shape (customerResolution.ts:62-68).
 */
export const expirePrior = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    const pending = await ctx.db
      .query("qrisPayments")
      .withIndex("by_order", (q) => q.eq("orderId", args.orderId))
      .filter((q) => q.eq(q.field("status"), "pending"))
      .collect();
    for (const row of pending) {
      await ctx.db.patch(row._id, { status: "expired" });
    }
  },
});

/**
 * Payment-durable, idempotent paid-transition (staffreview C3/C4/C8).
 *
 * Called by the webhook (Plan 04) on a COMPLETED Xendit callback.
 * 1. MATCH primarily on xenditQrId (globally unique); fall back to the ACTIVE
 *    pending row by externalId (NEVER a blind `.first()` over all history — C8).
 * 2. NO-MATCH → return { transitioned: false }, throw nothing (C4).
 * 3. ALWAYS record the row `paid` DURABLY, BEFORE any transition/reserve (C3).
 * 4. Idempotency guard: if order already PaymentReceived → replay no-op.
 * 5. Transition AwaitingPayment → PaymentReceived + reserve stock once.
 * 6. Reserve-failure DURABILITY: keep the paid row, revert order status, flag
 *    needsReview, log — never lose the payment (C3).
 */
export const recordPaidAndTransition = internalMutation({
  args: {
    xenditQrId: v.optional(v.string()),
    externalId: v.string(),
    amount: v.number(),
    receiptId: v.optional(v.string()),
    source: v.optional(v.string()),
    rawPayload: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ transitioned: boolean }> => {
    // 1. MATCH — xenditQrId first (globally unique), else the ACTIVE row by
    //    externalId. externalId (MMDD-NNN) is NOT globally unique (resets daily),
    //    so we scope to the most-recent pending row, never a blind `.first()`.
    let row = null as Awaited<ReturnType<typeof findByQrId>>;
    if (args.xenditQrId) {
      row = await findByQrId(ctx, args.xenditQrId);
    }
    if (!row) {
      row = await findActiveByExternalId(ctx, args.externalId);
    }

    // 2. NO-MATCH — safe no-op (C4).
    if (!row) {
      console.log(
        `[qris] recordPaidAndTransition: no matching row (externalId=${args.externalId}, hasQrId=${!!args.xenditQrId})`,
      );
      return { transitioned: false };
    }

    // 3. Load order + decide outcome.
    const order = await ctx.db.get(row.orderId);
    if (!order) {
      console.log(`[qris] recordPaidAndTransition: row matched but order missing (orderId=${row.orderId})`);
      return { transitioned: false };
    }
    const outcome = decideWebhookOutcome(order, row, { amount: args.amount });

    // 4. ALWAYS record paid on the row, DURABLY, BEFORE the transition/reserve
    //    (SPEC R4 — staffreview C3). The customer paid; honor it unconditionally.
    await ctx.db.patch(row._id, {
      status: "paid",
      paidAt: Date.now(),
      ...(args.receiptId !== undefined ? { receiptId: args.receiptId } : {}),
      ...(args.source !== undefined ? { source: args.source } : {}),
      ...(args.rawPayload !== undefined ? { rawPayload: args.rawPayload } : {}),
      ...(outcome.needsReview ? { needsReview: true, reviewReason: outcome.reason } : {}),
    });

    // 5. Idempotency guard — payment already recorded above; replay is a no-op.
    if (order.status === "PaymentReceived") {
      return { transitioned: false };
    }
    if (order.status !== "AwaitingPayment") {
      // Recorded paid, but the order is in some other state — do not transition.
      return { transitioned: false };
    }

    // 6. Transition. Capture old status/paymentStatus/paymentMethod for the
    //    reserve-failure revert. Set paymentStatus: "Paid" + paymentMethod:
    //    "QRIS" — payment has arrived, matching the convention on every
    //    payment-received transition (statusUpdates.ts:733). Stamping
    //    paymentMethod lets reporting separate QRIS from bank transfer (BCA/etc.)
    //    directly on the order; "QRIS" is the canonical PaymentMethod value
    //    (src/components/orders/PaymentMethodButtons.tsx).
    const oldStatus = order.status;
    const oldPaymentStatus = order.paymentStatus;
    const oldPaymentMethod = order.paymentMethod;
    await ctx.db.patch(order._id, {
      status: "PaymentReceived",
      paymentStatus: "Paid",
      paymentMethod: "QRIS",
      confirmedAt: Date.now(),
    });

    // 7. Reserve stock with failure durability (mirror statusUpdates.ts:141-170).
    //    On throw: keep the paid row, revert order status, flag needsReview, log.
    try {
      await reserveStockForOrderInternal(ctx, { orderId: order._id });
    } catch {
      await ctx.db.patch(order._id, {
        status: oldStatus,
        paymentStatus: oldPaymentStatus,
        paymentMethod: oldPaymentMethod,
        confirmedAt: undefined,
      });
      await ctx.db.patch(row._id, {
        needsReview: true,
        reviewReason: "stock reservation failed; payment recorded",
      });
      await logStatusTransition(
        ctx,
        order._id,
        "PaymentReceived",
        "AwaitingPayment",
        "QRIS payment received but stock reservation failed",
        "system",
        undefined,
      );
      return { transitioned: false };
    }

    // 8. Audit log the successful transition (mirror statusUpdates.ts:202-210).
    await logStatusTransition(
      ctx,
      order._id,
      "AwaitingPayment",
      "PaymentReceived",
      "QRIS payment received",
      "system",
      undefined,
    );

    return { transitioned: true };
  },
});

// ---------------------------------------------------------------------------
// Match helpers (staffreview C8).
// ---------------------------------------------------------------------------

/** Find a qrisPayments row by globally-unique xenditQrId (indexed lookup). */
async function findByQrId(ctx: MutationCtx, xenditQrId: string) {
  return await ctx.db
    .query("qrisPayments")
    .withIndex("by_xenditQrId", (q) => q.eq("xenditQrId", xenditQrId))
    .first();
}

/**
 * Find the ACTIVE row for an externalId (MMDD-NNN — per-day, NOT globally
 * unique). Prefer the most-recent `pending` row; never a blind `.first()`.
 */
async function findActiveByExternalId(ctx: MutationCtx, externalId: string) {
  const rows = await ctx.db
    .query("qrisPayments")
    .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
    .collect();
  if (rows.length === 0) return null;
  const pending = rows
    .filter((r) => r.status === "pending")
    .sort((a, b) => b._creationTime - a._creationTime);
  if (pending.length > 0) return pending[0];
  // No pending row (e.g. already superseded) — fall back to the most-recent row
  // so a superseded-then-paid signal is still recorded (decideWebhookOutcome
  // flags it needsReview). Still scoped to this externalId, never global.
  return rows.sort((a, b) => b._creationTime - a._creationTime)[0];
}
