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
import { truncate, MESSAGE_MAX } from "../ops/lib"; // V8-safe pure helpers; shared max keeps stored-error ceiling in lockstep with the ops pipe

// INVARIANT (LOW-7): forwarding is strictly POS -> RM. This target must NEVER be
// pointed back at the POS, and RM must never forward. Hardcoded (SSRF-safe) —
// never payload-derived.
const RM_QR_WEBHOOK = "https://decisive-wombat-7.convex.site/api/xendit/qr-payment";
const MAX_ATTEMPTS = 5;               // initial try + 4 retries
const BACKOFF_CAP_MS = 600_000;       // 10 min cap
// Exponential backoff, LONGER than cron's linear 60s*(n+1) — an RM redeploy can
// exceed 2 min. `tryNumber` is 1-based (the try that just failed). Only
// backoffMs(1..MAX_ATTEMPTS-1) is ever scheduled (the MAX_ATTEMPTS-th failure is
// terminal, not rescheduled), so with MAX_ATTEMPTS=5 the reachable delays are
// 60s,120s,240s,480s; BACKOFF_CAP_MS is a defensive ceiling that never binds at
// current MAX_ATTEMPTS but bounds the schedule if MAX_ATTEMPTS is raised.
function backoffMs(tryNumber: number): number {
  return Math.min(60_000 * 2 ** (tryNumber - 1), BACKOFF_CAP_MS);
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
  // `attempts` is the actual number of delivery tries made (the terminal try
  // included) — so a stuck `failed` row reads true forensics. See handleRetryable
  // / the 401 branch: both pass row.attempts + 1 (the try that just failed).
  args: { id: v.id("pos_qris_forward_outbox"), last_error: v.string(), attempts: v.number() },
  handler: async (ctx, args) => {
    // Patch directly (like _markDelivered) — the action already read + status-
    // guarded this row, and the single-in-flight chain guarantees it still exists.
    await ctx.db.patch(args.id, {
      status: "failed",
      last_error: truncate(args.last_error, MESSAGE_MAX),
      attempts: args.attempts,
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
      last_error: truncate(args.last_error, MESSAGE_MAX),
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

// Terminal fail: mark the row failed (counting the try that just failed) and
// record an ops error that names the exact payment to reconcile. `qr_ids` are
// alphanumeric, so distinct failures get distinct error signatures (not one
// collapsed alert). Shared by the 401 branch and the max-attempts branch.
async function failTerminal(
  ctx: ActionCtx,
  row: { attempts: number; xendit_qr_id: string },
  id: Id<"pos_qris_forward_outbox">,
  errMsg: string,
  reason: string,
): Promise<void> {
  await ctx.runMutation(internal.payments.forwarder._markFailed_internal, {
    id, last_error: errMsg, attempts: row.attempts + 1,
  });
  await reportForwardError(ctx, `${reason} qr=${row.xendit_qr_id}: ${errMsg}`);
}

// ── Retry-or-fail (shared by 5xx and connection-error paths) ─────────────────

// NOTE: the fail-vs-retry decision reads `row.attempts` from the action's
// entry snapshot, NOT a fresh read. This is correct ONLY because a single
// self-rescheduling chain guarantees exactly one in-flight _deliverForward per
// row. If a recovery sweeper is ever added (deferred follow-up — see the
// by_status_next index), it MUST NOT re-drive a row with a live in-flight
// delivery, or two _deliverForward run concurrently → double POST + double
// increment. Add a lease/claim before relaxing this invariant.
async function handleRetryable(
  ctx: ActionCtx,
  row: { attempts: number; xendit_qr_id: string },
  id: Id<"pos_qris_forward_outbox">,
  errMsg: string,
): Promise<void> {
  if (row.attempts + 1 >= MAX_ATTEMPTS) {
    await failTerminal(ctx, row, id, errMsg, "max attempts exhausted");
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
        // TERMINAL: token/secret misconfig — retry won't help. (Recovery of a
        // failed row after the operator corrects the secret is a deferred
        // follow-up — see the outbox durability/recovery note in ROADMAP.)
        await failTerminal(ctx, row, id, errMsg, "401 from RM (token/secret misconfig)");
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
