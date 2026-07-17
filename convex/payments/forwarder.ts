// Transactional-outbox forwarder: re-POSTs genuine QRIS paid-callbacks that land
// on this shared-Xendit-account POS webhook over to Recipe Master (Frollie Pro).
//
// V8-safe — DEFAULT runtime, NO "use node". Uses only `fetch` + `process.env`,
// both available in Convex's V8 runtime. Does NOT import from xendit.ts (its
// create funcs use Buffer/node). Secrets are NEVER stored on the outbox row
// (Convex data is dashboard-visible) — they are re-read from env at send time.

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  internalAction,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

// INVARIANT (LOW-7): forwarding is strictly POS -> RM. This target must NEVER be
// pointed back at the POS, and RM must never forward. Hardcoded (SSRF-safe) —
// never payload-derived.
const RM_QR_WEBHOOK = "https://decisive-wombat-7.convex.site/api/xendit/qr-payment";
const MAX_ATTEMPTS = 5;               // initial try + 4 retries
const BACKOFF_CAP_MS = 600_000;       // 10 min cap
// Exponential backoff, LONGER than cron's linear 60s*(n+1) — an RM redeploy can
// exceed 2 min. `tryNumber` is 1-based (the try that just failed).
function backoffMs(tryNumber: number): number {
  return Math.min(60_000 * 2 ** (tryNumber - 1), BACKOFF_CAP_MS); // 60s,120s,240s,480s,600s...
}
const LAST_ERROR_MAX = 500;           // truncate stored error

function truncate(s: string, max = LAST_ERROR_MAX): string {
  return s.length > max ? s.slice(0, max) : s;
}

// ── Enqueue ────────────────────────────────────────────────────────────────

export const _enqueueForward_internal = internalMutation({
  args: { raw_payload: v.string(), xendit_qr_id: v.string() },
  handler: async (ctx, args) => {
    // Dedup: one outbox row per xendit_qr_id (OCC-race-safe index read).
    const existing = await ctx.db
      .query("pos_qris_forward_outbox")
      .withIndex("by_xendit_qr_id", (q) => q.eq("xendit_qr_id", args.xendit_qr_id))
      .first();
    if (existing) return;

    const now = Date.now();
    const id = await ctx.db.insert("pos_qris_forward_outbox", {
      raw_payload: args.raw_payload,
      xendit_qr_id: args.xendit_qr_id,
      status: "pending",
      attempts: 0,
      created_at: now,
      next_attempt_at: now,
    });
    await ctx.scheduler.runAfter(0, internal.payments.forwarder._deliverForward, { id });
  },
});

// ── Internal read/persist helpers (the action can't touch ctx.db) ────────────

export const _getForward_internal = internalQuery({
  args: { id: v.id("pos_qris_forward_outbox") },
  handler: async (ctx, args) => ctx.db.get(args.id),
});

export const _markDelivered_internal = internalMutation({
  args: { id: v.id("pos_qris_forward_outbox") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { status: "delivered", delivered_at: Date.now() });
  },
});

export const _markFailed_internal = internalMutation({
  args: { id: v.id("pos_qris_forward_outbox"), last_error: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row) return;
    await ctx.db.patch(args.id, {
      status: "failed",
      last_error: truncate(args.last_error),
      attempts: row.attempts,
    });
  },
});

export const _markRetry_internal = internalMutation({
  args: { id: v.id("pos_qris_forward_outbox"), last_error: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.id);
    if (!row || row.status !== "pending") return;
    const nextAttempts = row.attempts + 1;
    const delay = backoffMs(nextAttempts);
    await ctx.db.patch(args.id, {
      attempts: nextAttempts,
      last_error: truncate(args.last_error),
      next_attempt_at: Date.now() + delay,
      status: "pending",
    });
    // Schedule from the mutation so patch + reschedule are atomic.
    await ctx.scheduler.runAfter(delay, internal.payments.forwarder._deliverForward, { id: args.id });
  },
});

// ── Error reporting (swallow — a report failure must not throw out) ──────────

async function reportForwardError(ctx: ActionCtx, message: string): Promise<void> {
  try {
    await ctx.runMutation(internal.ops.internal._recordError_internal, {
      kind: "backend",
      route: "convex/payments/forwarder",
      message,
    });
  } catch {
    // best-effort — never let alerting failure escape the forwarder
  }
}

// ── Retry-or-fail (shared by 5xx and connection-error paths) ─────────────────

async function handleRetryable(
  ctx: ActionCtx,
  row: { attempts: number },
  id: Id<"pos_qris_forward_outbox">,
  errMsg: string,
): Promise<void> {
  const nextAttempts = row.attempts + 1;
  if (nextAttempts >= MAX_ATTEMPTS) {
    await ctx.runMutation(internal.payments.forwarder._markFailed_internal, { id, last_error: errMsg });
    await reportForwardError(ctx, "max attempts exhausted: " + errMsg);
  } else {
    await ctx.runMutation(internal.payments.forwarder._markRetry_internal, { id, last_error: errMsg });
  }
}

// ── Delivery action ──────────────────────────────────────────────────────────

export const _deliverForward = internalAction({
  args: { id: v.id("pos_qris_forward_outbox") },
  handler: async (ctx, args) => {
    const { id } = args;
    const row = await ctx.runQuery(internal.payments.forwarder._getForward_internal, { id });
    // Idempotent — a redelivered/terminal row is a no-op.
    if (!row || row.status !== "pending") return;

    // Re-read secrets from env at send time (NEVER stored in the row).
    const callbackToken = process.env.XENDIT_CALLBACK_TOKEN ?? "";
    const forwardSecret = process.env.FROLLIE_FORWARD_SECRET ?? "";

    try {
      const res = await fetch(RM_QR_WEBHOOK, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-callback-token": callbackToken,
          "x-frollie-forward-secret": forwardSecret,
        },
        body: row.raw_payload,
      });
      if (res.ok) {
        await ctx.runMutation(internal.payments.forwarder._markDelivered_internal, { id });
        return;
      }
      const errMsg = `RM ${res.status}`;
      if (res.status === 401) {
        // TERMINAL: token/secret misconfig — retry won't help.
        await ctx.runMutation(internal.payments.forwarder._markFailed_internal, { id, last_error: errMsg });
        await reportForwardError(ctx, `401 from RM (token/secret misconfig): ${errMsg}`);
        return;
      }
      // Non-terminal (RM 5xx etc.) -> retry-or-fail.
      await handleRetryable(ctx, row, id, errMsg);
    } catch (e) {
      // Connection/timeout -> retry-or-fail.
      await handleRetryable(ctx, row, id, e instanceof Error ? e.message : String(e));
    }
  },
});
