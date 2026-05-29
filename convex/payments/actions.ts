"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal, api } from "../_generated/api";
import { verifyPinOrThrow } from "../auth/verifyPin";
import { createQrisCharge, createBcaVaCharge } from "./xendit";

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
    const txn = await ctx.runQuery(api.transactions.public.getById, { txnId: args.txnId });
    if (!txn) throw new Error("TXN_NOT_FOUND");
    if (txn.status !== "awaiting_payment") throw new Error("INVALID_STATE");

    // 3. Mint the charge via the deep adapter (QR Codes for QRIS, FVA for BCA).
    const ref = `pos-${args.txnId}`;
    const charge =
      args.method === "QRIS"
        ? await createQrisCharge(ref, txn.total, args.idempotencyKey)
        : await createBcaVaCharge(ref, txn.total, args.idempotencyKey);

    // 4. Commit invoice + cache row atomically (returns the full action response).
    return await ctx.runMutation(
      internal.payments.internal._persistInvoiceCommit_internal,
      {
        idempotencyKey: args.idempotencyKey,
        txnId: args.txnId,
        xendit_invoice_id: charge.providerId,
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

    const prev = await ctx.runQuery(api.payments.public.getCurrentInvoice, { txnId: args.txnId });
    if (!prev) throw new Error("PREV_INVOICE_MISSING");

    const txn = await ctx.runQuery(api.transactions.public.getById, { txnId: args.txnId });
    if (!txn) throw new Error("TXN_NOT_FOUND");

    // Unique ref per retry so a regenerate can't collide with the prior QR's
    // reference. Matching is on the globally-unique provider id; this only avoids
    // any Xendit-side duplicate-reference ambiguity.
    const ref = `pos-${args.txnId}-r-${crypto.randomUUID()}`;
    const charge =
      args.method === "QRIS"
        ? await createQrisCharge(ref, txn.total, args.idempotencyKey)
        : await createBcaVaCharge(ref, txn.total, args.idempotencyKey);

    // No Xendit "expire" exists for QR codes; the prior row is superseded locally
    // (Decision E). Pass a success outcome — the local supersede did succeed.
    return await ctx.runMutation(
      internal.payments.internal._replaceInvoiceCommit_internal,
      {
        idempotencyKey: args.idempotencyKey,
        txnId: args.txnId,
        prev_invoice_id: prev._id,
        new_xendit_id: charge.providerId,
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
 */
export const manuallyConfirmPayment = action({
  args: {
    sessionId: v.id("staff_sessions"),
    txnId: v.id("pos_transactions"),
    managerPin: v.string(),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ confirmed: true; receiptNumber: string }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached);

    const session = await ctx.runQuery(api.auth.public.getSession, { sessionId: args.sessionId });
    if (!session) throw new Error("SESSION_INVALID");

    // Resolve manager (the actor must be a manager OR provide a manager PIN
    // for any staff. v0.3: require sessionStaff.role==="manager" — booth has
    // a manager present. v0.4 will route through approvals/ for off-booth.)
    const actor = await ctx.runQuery(internal.auth.internal._getStaffPinHash_internal, {
      staffId: session.staff._id,
    });
    if (!actor || actor.role !== "manager") throw new Error("NOT_MANAGER");

    // Lockout pre-check + argon2 verify (manager's own PIN) + failed-attempt
    // recording (shared funnel — same lockout discipline as the auth PIN paths).
    await verifyPinOrThrow(ctx, {
      staffId: session.staff._id,
      deviceId: session.deviceId,
      pinHash: actor.pin_hash,
      pin: args.managerPin,
      idempotencyKey: args.idempotencyKey,
    });

    // Commit funnel + cache atomically (I6) and guard against a false success on a
    // non-awaiting txn (C4) — both live inside the withIdempotency-wrapped mutation.
    return await ctx.runMutation(internal.payments.internal._onPaidManual_internal, {
      idempotencyKey: args.idempotencyKey,
      txnId: args.txnId,
      reason: args.reason,
      mgr_approver_id: session.staff._id,
    });
  },
});
