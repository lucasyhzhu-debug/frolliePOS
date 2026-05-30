// convex/telegram/foundersSummary.ts
//
// Founders shift-summary cron send + resilient wrapper (Task 24, v0.4).
//
// ── Overview ─────────────────────────────────────────────────────────────────
// Daily at 22:00 WIB (15:00 UTC) the cron registered in Task 25 fires
// `sendFoundersSummaryResilient`, which wraps `sendFoundersSummary` with the
// standard cronRetry policy (RESILIENT_MAX_ATTEMPTS = 3, linear back-off).
//
// `sendFoundersSummary` is also the on-demand entry-point (admin test-send,
// manual re-fire) — keep it clean enough to call directly.
//
// ── Runtime note ─────────────────────────────────────────────────────────────
// NO "use node" directive here. Both actions only call Convex internals via
// ctx.runQuery / ctx.runAction / ctx.runMutation — no Node-specific imports.
// `_auditSkip_internal` (internalMutation) lives in telegram/internal.ts
// because "use node" files may only export actions (same pattern as
// _auditSendFailed_internal).
//
// ── ADRs ─────────────────────────────────────────────────────────────────────
// ADR-033: founders shift-summary share
// ADR-031: server time wins (all _at fields set inside Convex functions)
// lib/cronRetry.ts: shared retry policy

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { wibDayWindow } from "../lib/time";
import {
  isTransientError,
  resilientRetryDelayMs,
  RESILIENT_MAX_ATTEMPTS,
} from "../lib/cronRetry";

// ─── sendFoundersSummary ─────────────────────────────────────────────────────

/**
 * Core founders shift-summary send action. Called directly by
 * `sendFoundersSummaryResilient` and directly from admin/test contexts.
 *
 * Flow:
 *  1. Read settings. If founders_summary_enabled === false → audit skip +
 *     return { skipped: "disabled" }. No send, no throw.
 *  2. Compute WIB day window for now (lib/time.wibDayWindow).
 *  3. Fetch daily sales aggregate from transactions._dailySalesSummary_internal.
 *  4. Call api.telegram.send.sendTemplate with kind "shift_summary".
 *     Idempotency key: "founders:{dateLabel}" — same-day retry deduped.
 *  5. On non-transient send failure: audit skip (reason "send_failed") then
 *     rethrow — the resilient wrapper surfaces the error; no retry storm.
 *  6. On transient failure: rethrow — the wrapper handles the back-off retry.
 */
export const sendFoundersSummary = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ ok: true } | { skipped: "disabled" }> => {
    // Step 1: check the toggle
    const settings = await ctx.runQuery(
      internal.settings.internal._getSettings_internal,
      {},
    );
    if (!settings.founders_summary_enabled) {
      await ctx.runMutation(internal.telegram.internal._auditSkip_internal, {
        reason: "disabled",
      });
      return { skipped: "disabled" };
    }

    // Step 2: WIB day window
    const now = Date.now();
    const { dayStartMs, dayEndMs, dateLabel } = wibDayWindow(now);

    // Step 3: daily sales aggregate
    const summary = await ctx.runQuery(
      internal.transactions.internal._dailySalesSummary_internal,
      { dayStartMs, dayEndMs },
    );

    // Step 4: send via sendTemplate
    try {
      await ctx.runAction(api.telegram.send.sendTemplate, {
        role: "founders",
        kind: "shift_summary",
        payload: {
          dateLabel,
          totalSalesIdr: summary.totalSalesIdr,
          txnCount: summary.txnCount,
          flaggedCount: summary.flaggedCount,
        },
        idempotencyKey: `founders:${dateLabel}`,
      });
    } catch (err) {
      if (!isTransientError(err)) {
        // Non-transient: audit + rethrow (no infinite retry storm).
        await ctx.runMutation(internal.telegram.internal._auditSkip_internal, {
          reason: "send_failed",
        });
        throw err;
      }
      // Transient: let the resilient wrapper handle it.
      throw err;
    }

    return { ok: true };
  },
});

// ─── sendFoundersSummaryResilient ─────────────────────────────────────────────

/**
 * Cron entry-point. Wraps `sendFoundersSummary` with the standard cronRetry
 * policy:
 *   • Transient error → self-reschedule with linear back-off via
 *     ctx.scheduler.runAfter (up to RESILIENT_MAX_ATTEMPTS).
 *   • Non-transient error or attempts exceeded → throw (surfaces in the cron
 *     dashboard; no silent drop).
 *
 * `attempt` is 0-based: the cron fires with attempt=0; retries increment it.
 */
export const sendFoundersSummaryResilient = internalAction({
  args: {
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ ok: true } | { skipped: "disabled" }> => {
    const attempt = args.attempt ?? 0;

    try {
      return await ctx.runAction(
        internal.telegram.foundersSummary.sendFoundersSummary,
        {},
      );
    } catch (err) {
      if (isTransientError(err) && attempt + 1 < RESILIENT_MAX_ATTEMPTS) {
        // Transient and retries remaining: schedule the next attempt.
        await ctx.scheduler.runAfter(
          resilientRetryDelayMs(attempt),
          internal.telegram.foundersSummary.sendFoundersSummaryResilient,
          { attempt: attempt + 1 },
        );
        // Don't rethrow — the retry is queued; the current execution is done.
        // Return a sentinel so the cron dashboard shows "scheduled retry" rather
        // than an error (the dashboard only shows errors on throw).
        return { ok: true };
      }
      // Non-transient OR retries exhausted: surface the error.
      throw err;
    }
  },
});
