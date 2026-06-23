// convex/inventory/cronActions.ts
//
// Cron-driven internal actions for the inventory module (v0.6, Task R5).
//
// ── Why this file ───────────────────────────────────────────────────────────
// inventory/actions.ts is "use node" — it owns the manager-PIN argon2id verify
// path (recordSpoilage). These resilient cron internals do NOT need Node: they
// only call ctx.runQuery / ctx.runMutation / ctx.runAction. We follow the
// foundersSummary precedent (convex/telegram/foundersSummary.ts — no
// "use node") and keep these in a sibling V8 file so the directive on
// actions.ts can never interfere with internalAction registration.
//
// ── Pattern ─────────────────────────────────────────────────────────────────
// Inner action `sendStockRecon` does the work (run recon → maybe send). Outer
// action `sendStockReconResilient` wraps it with the shared cronRetry policy
// (linear back-off, RESILIENT_MAX_ATTEMPTS). Crons point at the resilient
// wrapper; on-demand callers can hit either entry-point.
//
// ── ADRs ────────────────────────────────────────────────────────────────────
// ADR-044: stock-recon is REPORT-ONLY — we never auto-correct the cache.
// ADR-031: server time wins (Date.now() captured inside the function).
// ADR-035: Telegram routes to a role; we resolve chat-id once upfront and
//          thread chatIdOverride to close the unbind race (same fix that
//          landed for founders-summary).
// lib/cronRetry.ts: shared transient-classification + back-off helpers.
//
// v2.0 Spec-4 Task 6: iterate ALL active outlets. Each outlet runs its own
// recon + routes to its own inventory chat. An unbound outlet chat → audited
// skip for THAT outlet only (never abort the loop).

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import {
  isTransientError,
  resilientRetryDelayMs,
  RESILIENT_MAX_ATTEMPTS,
} from "../lib/cronRetry";
import { resolveOutletChatId } from "../telegram/resolveOutletChat";

// ─── sendStockRecon ──────────────────────────────────────────────────────────

/**
 * Inner action: for each active outlet, run the recon writer + (on drift)
 * dispatch the per-outlet inventory Telegram alert.
 *
 * Flow per outlet:
 *  1. Run `_runStockRecon_internal({ outletId })` — writes drift_log rows +
 *     audit rows + returns { scanned, drifted }.
 *  2. No drift → audit-skip (reason="no_drift") for that outlet, continue.
 *  3. Resolve per-outlet `inventory` chat id via `resolveOutletChatId`.
 *     Narrow catch ONLY to the missing-binding error — unbound → audited
 *     skip (reason="role_unbound") for THAT outlet, continue loop (never
 *     abort other outlets). Transient / unknown → rethrow to resilient wrapper.
 *  4. Send via sendTemplate with kind="stock_drift_alert" and
 *     chatIdOverride=<resolved> (race-window closed; same fix as
 *     founders-summary).
 *  5. On send failure: transient → rethrow (wrapper retries);
 *     non-transient → audit-skip (reason="send_failed") + rethrow.
 *
 * Idempotency key: "stock-recon:<outlet.code>:<YYYY-MM-DD>" — per-outlet, per-day.
 * The old global "stock-recon:<date>" key caused a silent action-cache hit for
 * all outlets after the first (idempotency shared-key collision lesson).
 */
export const sendStockRecon = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    | { ok: true; outlets: number }
    | { skipped: "no_outlets" }
  > => {
    // Enumerate all active outlets.
    const outlets = await ctx.runQuery(
      internal.outlets.internal._listActiveOutlets_internal,
      {},
    );

    if (outlets.length === 0) {
      return { skipped: "no_outlets" };
    }

    const dateKey = new Date(Date.now()).toISOString().slice(0, 10); // YYYY-MM-DD

    for (const outlet of outlets) {
      // Step 1: run per-outlet recon. Writes pos_stock_drift_log + audit on drift.
      const result = await ctx.runMutation(
        internal.inventory.internal._runStockRecon_internal,
        { outletId: outlet._id },
      );

      if (result.drifted.length === 0) {
        await ctx.runMutation(
          internal.inventory.internal._auditStockReconSkip_internal,
          {
            reason: "no_drift",
            metadata: { scanned: result.scanned, outlet_code: outlet.code },
          },
        );
        continue;
      }

      // Step 2: resolve per-outlet `inventory` chat id — closes the unbind
      // race window. Narrow catch ONLY to the missing-binding error so transient
      // Convex platform errors still bubble up to the resilient wrapper.
      // An unbound outlet → audited skip for THAT outlet only; never abort.
      let resolvedChatId: string;
      try {
        resolvedChatId = await resolveOutletChatId(ctx, "inventory", outlet._id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("No Telegram chat assigned to role")) {
          await ctx.runMutation(
            internal.inventory.internal._auditStockReconSkip_internal,
            {
              reason: "role_unbound",
              metadata: { drifted: result.drifted.length, outlet_code: outlet.code },
            },
          );
          continue; // next outlet
        }
        throw err; // transient / unknown — let the resilient wrapper retry
      }

      // Step 3: send the drift alert. Informational (no URL button — ADR-044:
      // resolution happens at the booth, not via Telegram callback).
      // Per-outlet idempotency key: outlet code + date.
      // CRITICAL: global key = silent drop for all outlets after first (shared-key
      // collision lesson — use outlet.code to scope).
      try {
        await ctx.runAction(api.telegram.send.sendTemplate, {
          role: "inventory",
          kind: "stock_drift_alert",
          payload: {
            drifted: result.drifted,
            detected_at: Date.now(),
          },
          idempotencyKey: `stock-recon:${outlet.code}:${dateKey}`,
          chatIdOverride: resolvedChatId,
          outletId: outlet._id,
        });
      } catch (err) {
        if (!isTransientError(err)) {
          // Non-transient: audit-skip + rethrow (no infinite retry storm).
          await ctx.runMutation(
            internal.inventory.internal._auditStockReconSkip_internal,
            { reason: "send_failed", metadata: { outlet_code: outlet.code } },
          );
          throw err;
        }
        throw err; // transient — let the resilient wrapper handle it
      }
    }

    return { ok: true, outlets: outlets.length };
  },
});

// ─── sendStockReconResilient ─────────────────────────────────────────────────

/**
 * Cron entry-point. Wraps `sendStockRecon` with the standard cronRetry policy:
 *   • Transient error → self-reschedule with linear back-off (up to
 *     RESILIENT_MAX_ATTEMPTS).
 *   • Non-transient error or attempts exceeded → throw (surfaces in the cron
 *     dashboard; no silent drop).
 *
 * `attempt` is 0-based: cron fires with attempt=0; retries increment it.
 *
 * Mirrors `sendFoundersSummaryResilient` byte-for-byte where the policy is
 * concerned — only the inner action reference differs.
 */
export const sendStockReconResilient = internalAction({
  args: {
    attempt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; outlets: number }
    | { skipped: "no_outlets" }
    | { ok: true; retried: true; nextAttempt: number }
  > => {
    const attempt = args.attempt ?? 0;
    try {
      return await ctx.runAction(
        internal.inventory.cronActions.sendStockRecon,
        {},
      );
    } catch (err) {
      if (isTransientError(err) && attempt + 1 < RESILIENT_MAX_ATTEMPTS) {
        await ctx.scheduler.runAfter(
          resilientRetryDelayMs(attempt),
          internal.inventory.cronActions.sendStockReconResilient,
          { attempt: attempt + 1 },
        );
        // Clean return so the cron dashboard doesn't show an error; the
        // `retried: true` tag lets observability distinguish "first-try
        // clean send" from "transient failure, retry queued".
        return {
          ok: true as const,
          retried: true as const,
          nextAttempt: attempt + 1,
        };
      }
      throw err; // non-transient OR retries exhausted
    }
  },
});
