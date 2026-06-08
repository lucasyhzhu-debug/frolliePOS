// convex/settlements/cronActions.ts
//
// Cron-driven internal actions for the settlements module (v0.7, Task 6).
//
// ── Why this file ────────────────────────────────────────────────────────────
// Mirrors inventory/cronActions.ts: keeps V8-safe cron actions separate from
// any "use node" code. No node directive here — we only call ctx.run* and the
// plain listTransactions fetch helper (V8-safe via btoa+fetch, no Buffer).
//
// ── Pattern ──────────────────────────────────────────────────────────────────
// Inner action `syncSettlements` does the work: calls listTransactions, parses
// and aggregates, upserts one row per settled day (or audited-skip on empty).
// Outer action `syncSettlementsResilient` wraps it with the shared cronRetry
// policy (linear back-off, RESILIENT_MAX_ATTEMPTS). Crons point at the
// resilient wrapper; on-demand callers can hit the inner action directly.
//
// ── ADRs ─────────────────────────────────────────────────────────────────────
// ADR-031: server time wins — Date.now() captured inside the function.
// ADR-007: audit_log is append-only; skip events are audited via _auditSyncSkip_internal.
// lib/cronRetry.ts: shared transient-classification + back-off helpers.
// docs/xendit-reference/settlement-reconciliation.md: no settlement webhook —
//   poll-only. LOOKBACK_DAYS = 7 covers late settlement windows; the query
//   windows on `updated[gte]` (settlement posting updates the txn) so a txn
//   created >7d ago but settled recently is still caught (self-heal, spec G5).
//
// ── KYB-gated caveat (#66) ───────────────────────────────────────────────────
// The day bucket key derives from `estimated_settlement_time` (an ESTIMATE). If
// that estimate shifts to an adjacent day after a row is written, the re-poll
// keys a second day-row and the original under-reports. Unverifiable pre-KYB
// (TEST keys produce no real settlements); the raw `payload` is retained so a
// post-KYB reconciliation can detect + repair drift. Manual entry is the
// verified launch path; the auto-poll is shape-tested only. See issue #66.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { listTransactions } from "../payments/xendit";
import { parseListTransactions, aggregateSettledByDate } from "./lib";
import type { XenditTxnRow } from "./lib";
import {
  isTransientError,
  resilientRetryDelayMs,
  RESILIENT_MAX_ATTEMPTS,
} from "../lib/cronRetry";
import { wibDateLabel } from "../lib/time";

const LOOKBACK_DAYS = 7;

/** Returns a WIB YYYY-MM-DD string for `n` days before `now` (shared helper). */
function wibDateNDaysAgo(now: number, n: number): string {
  return wibDateLabel(now - n * 86_400_000);
}

// ─── syncSettlements ─────────────────────────────────────────────────────────

/**
 * Inner action: fetch Xendit settled transactions for the last LOOKBACK_DAYS,
 * aggregate by WIB settlement date, and upsert one pos_settlements row per day.
 *
 * Flow:
 *  1. Call listTransactions (paginated; V8-safe btoa fetch).
 *  2. parseListTransactions — throws on unrecognised shape (masks no errors).
 *  3. aggregateSettledByDate — filters MONEY_IN + SETTLED/EARLY_SETTLED rows.
 *  4. Zero days → audit settlement.sync_skipped + return { skipped }.
 *  5. N days → upsert each via _upsertSettlementDay_internal. Payload is the
 *     raw JSON (same rows feed reconciliation UI if needed).
 *
 * Idempotent: _upsertSettlementDay_internal is a keyed upsert; re-running the
 * cron for the same day window patches existing rows without duplicating.
 */
export const syncSettlements = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ ok: true; days: number } | { skipped: "no_settlements" }> => {
    const settledAfterIso = wibDateNDaysAgo(Date.now(), LOOKBACK_DAYS);
    const body = await listTransactions({ settledAfterIso });
    const rows = parseListTransactions(body);
    const days = aggregateSettledByDate(rows);

    if (days.length === 0) {
      await ctx.runMutation(
        internal.settlements.internal._auditSyncSkip_internal,
        {
          reason: "no_settlements",
          metadata: { settledAfterIso },
        },
      );
      return { skipped: "no_settlements" };
    }

    // Scope payload to each day's own rows (not the whole 7-day blob) so a
    // row's payload is a usable per-day debug + future match-back artifact (N1).
    const rowsByDate = new Map<string, XenditTxnRow[]>();
    for (const r of rows) {
      if (!r.settlement_date) continue;
      const bucket = rowsByDate.get(r.settlement_date);
      if (bucket) bucket.push(r);
      else rowsByDate.set(r.settlement_date, [r]);
    }
    for (const d of days) {
      await ctx.runMutation(
        internal.settlements.internal._upsertSettlementDay_internal,
        {
          settlement_date: d.settlement_date,
          gross_amount: d.gross_amount,
          mdr_amount: d.mdr_amount,
          net_amount: d.net_amount,
          transaction_count: d.transaction_count,
          source: "xendit_poll",
          payload: JSON.stringify(rowsByDate.get(d.settlement_date) ?? []),
        },
      );
    }
    return { ok: true, days: days.length };
  },
});

// ─── syncSettlementsResilient ─────────────────────────────────────────────────

/**
 * Cron entry-point. Wraps `syncSettlements` with the standard cronRetry policy:
 *   • Transient error → self-reschedule with linear back-off (up to
 *     RESILIENT_MAX_ATTEMPTS).
 *   • Non-transient error or attempts exceeded → throw (surfaces in the cron
 *     dashboard; no silent drop).
 *
 * `attempt` is 0-based: cron fires with attempt=0; retries increment it.
 *
 * Mirrors `sendStockReconResilient` byte-for-byte where the policy is
 * concerned — only the inner action reference differs.
 */
export const syncSettlementsResilient = internalAction({
  args: {
    attempt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; days: number }
    | { skipped: "no_settlements" }
    | { ok: true; retried: true; nextAttempt: number }
  > => {
    const attempt = args.attempt ?? 0;
    try {
      return await ctx.runAction(
        internal.settlements.cronActions.syncSettlements,
        {},
      );
    } catch (err) {
      if (isTransientError(err) && attempt + 1 < RESILIENT_MAX_ATTEMPTS) {
        await ctx.scheduler.runAfter(
          resilientRetryDelayMs(attempt),
          internal.settlements.cronActions.syncSettlementsResilient,
          { attempt: attempt + 1 },
        );
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
