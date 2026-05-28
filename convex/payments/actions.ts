"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal, api } from "../_generated/api";
import { argon2Verify } from "hash-wasm";

const XENDIT_BASE = "https://api.xendit.co";

interface XenditInvoiceResponse {
  id: string;
  status: string;
  qr_string?: string;
  account_number?: string;
}

/**
 * Read a fetch Response body as JSON without throwing on a non-JSON body.
 * Xendit 5xx/timeout responses can be an HTML page; calling r.json() directly
 * would throw a SyntaxError mid-action instead of letting the `!ok` guard surface
 * a clean XENDIT_* error. Non-JSON bodies come back under `_raw` for the error path.
 */
async function readJson<T>(r: Response): Promise<T> {
  const text = await r.text();
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { _raw: text } as T;
  }
}

async function xenditPost<T = any>(
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<{ ok: boolean; data: T }> {
  const key = process.env.XENDIT_SECRET_KEY;
  if (!key) throw new Error("XENDIT_SECRET_KEY not set");
  const auth = `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
  const r = await fetch(`${XENDIT_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth,
      "X-IDEMPOTENCY-KEY": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, data: await readJson<T>(r) };
}

async function xenditGet<T = any>(path: string): Promise<{ ok: boolean; data: T }> {
  const key = process.env.XENDIT_SECRET_KEY;
  if (!key) throw new Error("XENDIT_SECRET_KEY not set");
  const auth = `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
  const r = await fetch(`${XENDIT_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: auth },
  });
  return { ok: r.ok, data: await readJson<T>(r) };
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
    const txn = await ctx.runQuery(api.transactions.public.getById, { txnId: args.txnId });
    if (!txn) throw new Error("TXN_NOT_FOUND");
    if (txn.status !== "awaiting_payment") throw new Error("INVALID_STATE");

    // 3. POST Xendit
    const payload: Record<string, unknown> = {
      external_id: `pos-${args.txnId}`,
      amount: txn.total,
      payment_methods: args.method === "QRIS" ? ["QRIS"] : ["BCA"],
      description: `Frollie POS sale ${args.txnId}`,
    };
    const { ok, data } = await xenditPost<XenditInvoiceResponse>("/v2/invoices", payload, args.idempotencyKey);
    if (!ok) throw new Error(`XENDIT_INVOICE_FAILED: ${JSON.stringify(data)}`);

    // 4. Commit invoice + cache row atomically. The commit mutation returns the
    // FULL action response shape and caches it under args.idempotencyKey, so a
    // retry's _lookup_internal pre-check above replays the complete blob
    // (qrString/vaNumber included) — staffreview Critical #1.
    return await ctx.runMutation(
      internal.payments.internal._persistInvoiceCommit_internal,
      {
        idempotencyKey: args.idempotencyKey,
        txnId: args.txnId,
        xendit_invoice_id: data.id,
        xendit_idempotency_key: args.idempotencyKey,
        method: args.method,
        qr_string: data.qr_string,
        va_number: data.account_number,
        status_at_create: data.status,
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
    let cancel_outcome: { success: boolean; error?: string } = { success: true };
    try {
      const { ok, data } = await xenditPost(`/invoices/${prev.xendit_invoice_id}/expire!`, {}, `${args.idempotencyKey}:cancel`);
      if (!ok) cancel_outcome = { success: false, error: JSON.stringify(data) };
    } catch (e: any) {
      cancel_outcome = { success: false, error: String(e?.message ?? e) };
    }

    const txn = await ctx.runQuery(api.transactions.public.getById, { txnId: args.txnId });
    if (!txn) throw new Error("TXN_NOT_FOUND");
    const { ok, data } = await xenditPost<XenditInvoiceResponse>("/v2/invoices", {
      // Unique per retry — randomUUID avoids the Date.now() collision two
      // concurrent retries in the same millisecond would hit (I3).
      external_id: `pos-${args.txnId}-retry-${crypto.randomUUID()}`,
      amount: txn.total,
      payment_methods: args.method === "QRIS" ? ["QRIS"] : ["BCA"],
      description: `Frollie POS sale ${args.txnId} (retry)`,
    }, args.idempotencyKey);
    if (!ok) throw new Error(`XENDIT_INVOICE_FAILED: ${JSON.stringify(data)}`);

    // Commit mutation returns + caches the full action response shape under
    // args.idempotencyKey (staffreview Critical #1 — retry replays the complete
    // blob via the _lookup_internal pre-check above).
    return await ctx.runMutation(
      internal.payments.internal._replaceInvoiceCommit_internal,
      {
        idempotencyKey: args.idempotencyKey,
        txnId: args.txnId,
        prev_invoice_id: prev._id,
        new_xendit_id: data.id,
        new_xendit_idempotency_key: args.idempotencyKey,
        method: args.method,
        qr_string: data.qr_string,
        va_number: data.account_number,
        status_at_create: data.status,
        cancel_outcome,
      },
    );
  },
});

/**
 * Polling fallback — GET invoice status; if PAID, runMutation _onPaidPolling.
 * No idempotencyKey arg: this is a side-effect-free read for the PENDING case,
 * and the funnel is idempotent for the PAID case.
 */
export const checkInvoiceStatus = action({
  args: { invoiceId: v.string() },
  handler: async (ctx, args): Promise<{
    status: "PENDING" | "PAID" | "EXPIRED" | "UNKNOWN";
  }> => {
    if (!args.invoiceId) return { status: "UNKNOWN" };
    const { ok, data } = await xenditGet<XenditInvoiceResponse>(`/v2/invoices/${args.invoiceId}`);
    if (!ok) return { status: "UNKNOWN" };
    if (data.status === "PAID") {
      await ctx.runMutation(internal.payments.internal._onPaidPolling_internal, {
        xendit_invoice_id: args.invoiceId,
      });
      return { status: "PAID" };
    }
    if (data.status === "EXPIRED") return { status: "EXPIRED" };
    return { status: "PENDING" };
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

    // Pre-verify lockout check — reject a locked manager cheaply before spending
    // argon2 cycles, mirroring the other PIN-verify paths' lockout discipline (I1).
    const lockState = await ctx.runQuery(internal.auth.internal._getLockState_internal, {
      staffId: session.staff._id,
    });
    if (lockState.locked) {
      await ctx.runMutation(internal.auth.internal._auditLockProbe_internal, {
        staffId: session.staff._id,
        deviceId: session.deviceId,
        seconds_remaining: lockState.seconds_remaining,
      });
      throw new Error(`LOCKED_OUT:${lockState.seconds_remaining}`);
    }

    const ok = await argon2Verify({ password: args.managerPin, hash: actor.pin_hash });
    if (!ok) {
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        idempotencyKey: `${args.idempotencyKey}:failed`,
        staffId: session.staff._id,
        deviceId: session.deviceId,
      });
      throw new Error("INVALID_PIN");
    }

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
