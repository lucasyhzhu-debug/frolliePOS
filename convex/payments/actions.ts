"use node";

import { action, ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal, api } from "../_generated/api";
import { verifyPinOrThrow } from "../auth/verifyPin";
import { createQrisCharge, createBcaVaCharge } from "./xendit";

/** Best-effort ops report for payment-path failures. Never throws. */
async function reportPaymentError(
  ctx: ActionCtx,
  err: unknown,
  route: string,
): Promise<void> {
  try {
    await ctx.runMutation(internal.ops.internal._recordError_internal, {
      kind: "payment" as const,
      message: err instanceof Error ? err.message : String(err),
      route,
    });
  } catch { /* swallow — reporting must not mask the original error */ }
}

/**
 * Create a Xendit invoice for a transaction. Action-level idempotency pattern
 * per spec §"Action-level idempotency" + staffreview Critical #1:
 *   1. Pre-check Convex cache via _lookup_internal. Hit → return cached, skip HTTP.
 *   2. POST to Xendit with X-IDEMPOTENCY-KEY = args.idempotencyKey.
 *   3. runMutation _persistInvoiceCommit_internal (which writes the cache row
 *      atomically with the invoice row).
 */
export const requestPayment = action({
  args: {
    sessionId: v.id("staff_sessions"),
    txnId: v.id("pos_transactions"),
    method: v.union(v.literal("QRIS"), v.literal("BCA_VA")),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{
    invoiceId: Id<"pos_xendit_invoices">;
    method: "QRIS" | "BCA_VA";
    qrString?: string;
    vaNumber?: string;
  }> => {
    // 1. Cache pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached);

    // Auth: a valid (non-ended) session is required to initiate a Xendit invoice.
    const session = await ctx.runQuery(api.auth.public.getSession, { sessionId: args.sessionId });
    if (!session) throw new Error("SESSION_INVALID");

    // 2. Resolve txn for amount + description
    const txn = await ctx.runQuery(internal.transactions.internal._getTxnById_internal, { txnId: args.txnId });
    if (!txn) throw new Error("TXN_NOT_FOUND");
    if (txn.status !== "awaiting_payment") throw new Error("INVALID_STATE");

    // 3. Mint the charge via the deep adapter (QR Codes for QRIS, FVA for BCA).
    const ref = `pos-${args.txnId}`;
    let charge: Awaited<ReturnType<typeof createQrisCharge>>;
    try {
      charge =
        args.method === "QRIS"
          ? await createQrisCharge(ref, txn.total, args.idempotencyKey)
          : await createBcaVaCharge(ref, txn.total, args.idempotencyKey);
    } catch (err) {
      // v1.0.1: best-effort ops report — kind: "payment"; always rethrow
      await reportPaymentError(ctx, err, "convex/payments/actions.requestPayment");
      throw err;
    }

    // 4. Commit invoice + cache row atomically (returns the full action response).
    return await ctx.runMutation(
      internal.payments.internal._persistInvoiceCommit_internal,
      {
        idempotencyKey: args.idempotencyKey,
        txnId: args.txnId,
        xendit_invoice_id: charge.providerId,
        reference_id: ref,
        xendit_idempotency_key: args.idempotencyKey,
        method: args.method,
        qr_string: charge.qrString,
        va_number: charge.vaNumber,
        status_at_create: charge.statusAtCreate,
      },
    );
  },
});

/**
 * Retry with a fresh invoice — cancels the current invoice on Xendit
 * (best-effort) and creates a new one. Per ADR-014 single-active-invoice.
 */
export const retryWithFreshInvoice = action({
  args: {
    sessionId: v.id("staff_sessions"),
    txnId: v.id("pos_transactions"),
    method: v.union(v.literal("QRIS"), v.literal("BCA_VA")),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{
    invoiceId: Id<"pos_xendit_invoices">;
    method: "QRIS" | "BCA_VA";
    qrString?: string;
    vaNumber?: string;
  }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached);

    // Auth: a valid (non-ended) session is required to mint a fresh invoice.
    const session = await ctx.runQuery(api.auth.public.getSession, { sessionId: args.sessionId });
    if (!session) throw new Error("SESSION_INVALID");

    const prev = await ctx.runQuery(internal.payments.internal._getCurrentInvoice_internal, { txnId: args.txnId });
    if (!prev) throw new Error("PREV_INVOICE_MISSING");

    const txn = await ctx.runQuery(internal.transactions.internal._getTxnById_internal, { txnId: args.txnId });
    if (!txn) throw new Error("TXN_NOT_FOUND");
    // Same guard as requestPayment: never mint a fresh invoice for a txn that has
    // already left awaiting_payment (a webhook may have won mid-retry). Without it
    // a retry burns a Xendit charge + persists an orphan invoice that no webhook
    // will ever match, with no cancel audit row.
    if (txn.status !== "awaiting_payment") throw new Error("INVALID_STATE");

    // Unique ref per retry so a regenerate can't collide with the prior QR's
    // reference. Matching is on the globally-unique provider id; this only avoids
    // any Xendit-side duplicate-reference ambiguity.
    const ref = `pos-${args.txnId}-r-${crypto.randomUUID()}`;
    let charge: Awaited<ReturnType<typeof createQrisCharge>>;
    try {
      charge =
        args.method === "QRIS"
          ? await createQrisCharge(ref, txn.total, args.idempotencyKey)
          : await createBcaVaCharge(ref, txn.total, args.idempotencyKey);
    } catch (err) {
      // v1.0.1: best-effort ops report — kind: "payment"; always rethrow
      await reportPaymentError(ctx, err, "convex/payments/actions.retryWithFreshInvoice");
      throw err;
    }

    // No Xendit "expire" exists for QR codes; the prior row is superseded locally
    // (Decision E). Pass a success outcome — the local supersede did succeed.
    return await ctx.runMutation(
      internal.payments.internal._replaceInvoiceCommit_internal,
      {
        idempotencyKey: args.idempotencyKey,
        txnId: args.txnId,
        prev_invoice_id: prev._id,
        new_xendit_id: charge.providerId,
        reference_id: ref,
        new_xendit_idempotency_key: args.idempotencyKey,
        method: args.method,
        qr_string: charge.qrString,
        va_number: charge.vaNumber,
        status_at_create: charge.statusAtCreate,
        cancel_outcome: { success: true },
      },
    );
  },
});

/**
 * Manager-PIN manual override (third confirmation path). Does NOT re-call
 * Xendit per spec §"actions.ts → manuallyConfirmPayment → Security trade-off".
 * Fraud surface mitigated via audit-log surveillance — v0.5 dashboard widget
 * surfaces manual-override count per staff per day.
 *
 * v0.5.0 (Task 12 — v050-be-mgr-picker-override): `managerStaffCode` makes the
 * approving manager an EXPLICIT argument. Any active manager's code can be used
 * at the booth — not just the session-bound staff. The session only establishes
 * "someone is logged in and at the POS"; the manager identity is independently
 * supplied and independently verified. Wrong PIN counts toward THAT manager's
 * ADR-002 lockout (not the session staff's). The UI picker lands in Wave 4 Task 18.
 *
 * Previous behaviour: session staff had to be a manager themselves (NOT_MANAGER
 * guard). New behaviour: session staff can be any role; a manager hands the
 * device to perform the override. The NOT_MANAGER guard is replaced by the
 * MANAGER_NOT_FOUND guard on the explicitly supplied code.
 */
export const manuallyConfirmPayment = action({
  args: {
    sessionId: v.id("staff_sessions"),
    txnId: v.id("pos_transactions"),
    managerStaffCode: v.string(),
    managerPin: v.string(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ confirmed: true; receiptNumber: string }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached);

    // Auth: a valid (non-ended) session is required to initiate a manual override.
    const session = await ctx.runQuery(api.auth.public.getSession, { sessionId: args.sessionId });
    if (!session) throw new Error("SESSION_INVALID");

    // Resolve manager by the explicitly supplied staff code. Reject if: no such
    // code, wrong role, or inactive. Single branch — all three cases are the same
    // error to the caller (don't leak which condition failed).
    const manager = await ctx.runQuery(internal.auth.internal._getByCode_internal, {
      code: args.managerStaffCode,
    });
    if (!manager || manager.role !== "manager" || !manager.active) {
      throw new Error("MANAGER_NOT_FOUND");
    }

    // Lockout pre-check + argon2 verify (manager's own PIN) + failed-attempt
    // recording (shared funnel — same lockout discipline as all PIN paths).
    // _recordFailedAttempt_internal targets manager._id — wrong PIN counts
    // toward THAT manager's ADR-002 lockout, not the session staff's.
    await verifyPinOrThrow(ctx, {
      staffId: manager._id,
      deviceId: session.deviceId,
      pinHash: manager.pin_hash,
      pin: args.managerPin,
      idempotencyKey: args.idempotencyKey,
    });

    // Commit funnel + cache atomically (I6) and guard against a false success on a
    // non-awaiting txn (C4) — both live inside the withIdempotency-wrapped mutation.
    // mgr_approver_id is manager._id (the actual approver), not session.staff._id.
    return await ctx.runMutation(internal.payments.internal._onPaidManual_internal, {
      idempotencyKey: args.idempotencyKey,
      txnId: args.txnId,
      reason: args.reason,
      mgr_approver_id: manager._id,
      source: "booth_inline",
    });
  },
});
