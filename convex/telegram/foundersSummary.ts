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
// `_auditFoundersSkip_internal` (internalMutation) lives in telegram/internal.ts
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
  ): Promise<
    { ok: true } | { skipped: "disabled" } | { skipped: "role_unbound" }
  > => {
    // Step 1: check the toggle
    const settings = await ctx.runQuery(
      internal.settings.internal._getSettings_internal,
      {},
    );
    if (!settings.founders_summary_enabled) {
      await ctx.runMutation(internal.telegram.internal._auditFoundersSkip_internal, {
        reason: "disabled",
      });
      return { skipped: "disabled" };
    }

    // Step 1b: resolve the founders chat id ONCE upfront.
    //
    // Resolving here (rather than letting sendTemplate resolve internally) closes
    // the race window where:
    //   pre-check passes → admin unbinds role → sendTemplate's internal resolve
    //   throws → caught as "send_failed", conflating a config change with a real
    //   Telegram error.
    //
    // By capturing chatId here and threading it via chatIdOverride, the cron's
    // binding decision is authoritative for the entire execution. An unbind that
    // races with this single resolve is negligible (sub-millisecond window, one
    // cron tick). The KNOWN RACE comment from the pre-check pattern is now closed.
    //
    // Narrow the catch to the EXACT message getChatIdByRole throws on missing
    // binding. A bare catch would also swallow transient Convex platform errors
    // and audit them as role_unbound — suppressing the resilient retry path and
    // silently losing the day's summary on a temporary hiccup.
    let resolvedChatId: string;
    try {
      resolvedChatId = await ctx.runQuery(
        internal.telegram.chatRegistry.internal.getChatIdByRole,
        { role: "founders" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No Telegram chat assigned to role")) {
        await ctx.runMutation(internal.telegram.internal._auditFoundersSkip_internal, {
          reason: "role_unbound",
        });
        return { skipped: "role_unbound" };
      }
      throw err; // transient / unknown — let the resilient wrapper retry
    }

    // Step 2: WIB day window
    const now = Date.now();
    const { dayStartMs, dayEndMs, dateLabel } = wibDayWindow(now);

    // Step 3: daily sales aggregate
    const summary = await ctx.runQuery(
      internal.transactions.internal._dailySalesSummary_internal,
      { dayStartMs, dayEndMs },
    );

    // Step 4: send via sendTemplate — pass chatIdOverride so sendTemplate skips
    // its own role-resolve (race window closed: chatId captured once above).
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
        chatIdOverride: resolvedChatId,
      });
    } catch (err) {
      if (!isTransientError(err)) {
        // Non-transient: audit + rethrow (no infinite retry storm).
        await ctx.runMutation(internal.telegram.internal._auditFoundersSkip_internal, {
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
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true }
    | { skipped: "disabled" }
    | { skipped: "role_unbound" }
    | { ok: true; retried: true; nextAttempt: number }
  > => {
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
        // The cron dashboard sees a clean return; we tag the return value with
        // `retried: true` + `nextAttempt` so observability tooling (and the cron
        // run log line) can distinguish "first-try clean send" from "transient
        // failure, retry queued". The dashboard only shows errors on throw, so
        // this preserves no-noise behavior while making the retry visible.
        return { ok: true as const, retried: true as const, nextAttempt: attempt + 1 };
      }
      // Non-transient OR retries exhausted: surface the error.
      throw err;
    }
  },
});
