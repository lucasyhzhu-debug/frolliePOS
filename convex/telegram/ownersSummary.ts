// convex/telegram/ownersSummary.ts
//
// Owners shift-summary cron send + resilient wrapper (v2.0 Spec-4 Task 7).
//
// ── Overview ─────────────────────────────────────────────────────────────────
// Daily at 22:00 WIB (15:00 UTC) the cron registered in crons.ts fires
// `sendOwnersSummaryResilient`, which wraps `sendOwnersSummary` with the
// standard cronRetry policy (RESILIENT_MAX_ATTEMPTS = 3, linear back-off).
//
// Two outputs per execution:
//   A) Owners rollup → `owners` chat with `kind:"shift_summary"` + perOutlet
//      breakdown when more than one active outlet exists.
//   B) Per-outlet managers_daily_summary → each outlet's `(managers, outlet_id)`
//      chat with `kind:"managers_daily_summary"`, scoped per outlet.
//
// `sendOwnersSummary` is also the on-demand entry-point (admin test-send,
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
// ADR-033: founders shift-summary share (owners rollup)
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
import type { ManualBcaTally } from "../lib/telegramHtml";
import { resolveOutletChatId } from "./resolveOutletChat";

// ─── sendOwnersSummary ────────────────────────────────────────────────────────

/**
 * Core owners shift-summary send action. Called directly by
 * `sendOwnersSummaryResilient` and directly from admin/test contexts.
 *
 * Flow:
 *  1. Toggle: read the DEFAULT outlet's settings. If founders_summary_enabled
 *     === false → audit skip + return { skipped: "disabled" }.
 *  2. Resolve the `owners` chat id ONCE upfront (race-window closed).
 *     Unbound → audit skip "role_unbound" + return; no throw.
 *  3. Compute WIB day window.
 *  4. List all active outlets; for each, fetch _dailySalesSummary_internal +
 *     _manualBcaReconciliation_internal. Build perOutlet[] + business totals.
 *     Merge manualBca tallies into a business-wide sum.
 *  5. Send owners rollup → kind:"shift_summary" with perOutlet when > 1 outlet.
 *  6. For each outlet: if that outlet's founders_summary_enabled is on,
 *     resolveOutletChatId("managers", outlet._id) → send kind:"managers_daily_summary".
 *     Unbound for one outlet → audited skip for that outlet only; loop continues.
 *  7. On non-transient send failure: audit skip + rethrow.
 *  8. On transient failure: rethrow (resilient wrapper handles back-off).
 */
export const sendOwnersSummary = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    { ok: true } | { skipped: "disabled" } | { skipped: "role_unbound" }
  > => {
    // Step 1: toggle — read the DEFAULT outlet's setting.
    const defaultOutlet = await ctx.runQuery(
      internal.outlets.internal._getDefaultOutlet_internal,
      {},
    );
    if (!defaultOutlet) throw new Error("NO_DEFAULT_OUTLET");

    const ownerSettings = await ctx.runQuery(
      internal.settings.internal._getSettings_internal,
      { outletId: defaultOutlet._id },
    );
    if (!ownerSettings.founders_summary_enabled) {
      await ctx.runMutation(internal.telegram.internal._auditFoundersSkip_internal, {
        reason: "disabled",
      });
      return { skipped: "disabled" };
    }

    // Step 2: resolve the owners chat id ONCE upfront (race-window closed).
    // Same narrow-catch pattern as the old founders resolution — only swallows
    // the "No Telegram chat assigned" message; transient Convex errors propagate
    // to the resilient wrapper so they don't silence the retry path.
    let ownersChatId: string;
    try {
      ownersChatId = await ctx.runQuery(
        internal.telegram.chatRegistry.internal.getChatIdByRole,
        { role: "owners" },
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

    // Step 3: WIB day window
    const now = Date.now();
    const { dayStartMs, dayEndMs, dateLabel } = wibDayWindow(now);

    // Step 4: list all active outlets + aggregate per outlet.
    const outlets = await ctx.runQuery(
      internal.outlets.internal._listActiveOutlets_internal,
      {},
    );

    type PerOutletEntry = {
      outletLabel: string;
      totalSalesIdr: number;
      txnCount: number;
      flaggedCount: number;
    };
    const perOutlet: PerOutletEntry[] = [];
    let bizTotalSalesIdr = 0;
    let bizTxnCount = 0;
    let bizFlaggedCount = 0;

    // Business-wide manualBca tally (summed across all outlets).
    const bizManualBca: ManualBcaTally = { count: 0, totalIdr: 0, items: [] };

    // Per-outlet manualBca for the managers_daily_summary loop below.
    // Indexed in parallel with perOutlet[].
    const perOutletManualBca: ManualBcaTally[] = [];

    for (const o of outlets) {
      const [summary, manualBca] = await Promise.all([
        ctx.runQuery(internal.transactions.internal._dailySalesSummary_internal, {
          dayStartMs,
          dayEndMs,
          outletId: o._id,
        }),
        ctx.runQuery(
          internal.transactions.internal._manualBcaReconciliation_internal,
          { dayStartMs, dayEndMs, outletId: o._id },
        ),
      ]);

      perOutlet.push({
        outletLabel: o.name,
        totalSalesIdr: summary.totalSalesIdr,
        txnCount: summary.txnCount,
        flaggedCount: summary.flaggedCount,
      });
      perOutletManualBca.push(manualBca);

      bizTotalSalesIdr += summary.totalSalesIdr;
      bizTxnCount += summary.txnCount;
      bizFlaggedCount += summary.flaggedCount;

      // Merge per-outlet manualBca into business tally.
      bizManualBca.count += manualBca.count;
      bizManualBca.totalIdr += manualBca.totalIdr;
      bizManualBca.items.push(...manualBca.items);
    }

    // Step 5: send owners rollup.
    // perOutlet is included when > 1 outlet so renderOwnersSummary appends a
    // per-outlet breakdown beneath the business total.
    // Single-outlet: perOutlet omitted (renderer skips breakdown for length ≤ 1).
    try {
      await ctx.runAction(api.telegram.send.sendTemplate, {
        role: "owners",
        kind: "shift_summary",
        payload: {
          dateLabel,
          totalSalesIdr: bizTotalSalesIdr,
          txnCount: bizTxnCount,
          flaggedCount: bizFlaggedCount,
          manualBca: bizManualBca.count > 0 ? bizManualBca : undefined,
          perOutlet: perOutlet.length > 1 ? perOutlet : undefined,
        },
        idempotencyKey: `owners:${dateLabel}`,
        chatIdOverride: ownersChatId,
      });
    } catch (err) {
      if (!isTransientError(err)) {
        await ctx.runMutation(internal.telegram.internal._auditFoundersSkip_internal, {
          reason: "send_failed",
        });
        throw err;
      }
      throw err;
    }

    // Step 6: per-outlet managers_daily_summary.
    // Each outlet is independent — an unbound/disabled outlet never aborts the loop.
    for (let i = 0; i < outlets.length; i++) {
      const o = outlets[i];

      // Per-outlet toggle check.
      const outletSettings = await ctx.runQuery(
        internal.settings.internal._getSettings_internal,
        { outletId: o._id },
      );
      if (!outletSettings.founders_summary_enabled) {
        await ctx.runMutation(internal.telegram.internal._auditFoundersSkip_internal, {
          reason: `disabled:outlet:${o.code}`,
        });
        continue;
      }

      // Resolve per-outlet managers chat — skip on unbound, don't abort the loop.
      let mgrChatId: string;
      try {
        mgrChatId = await resolveOutletChatId(ctx, "managers", o._id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          msg.includes("No Telegram chat assigned to role") ||
          msg.startsWith("OUTLET_REQUIRED_FOR_ROLE")
        ) {
          await ctx.runMutation(internal.telegram.internal._auditFoundersSkip_internal, {
            reason: `managers_unbound:outlet:${o.code}`,
          });
          continue;
        }
        throw err; // transient — propagate (resilient wrapper retries)
      }

      const entry = perOutlet[i];
      const outletManualBca = perOutletManualBca[i];

      try {
        await ctx.runAction(api.telegram.send.sendTemplate, {
          role: "managers",
          kind: "managers_daily_summary",
          outletId: o._id,
          payload: {
            dateLabel,
            outletLabel: o.name,
            totalSalesIdr: entry.totalSalesIdr,
            txnCount: entry.txnCount,
            flaggedCount: entry.flaggedCount,
            manualBca: outletManualBca.count > 0 ? outletManualBca : undefined,
          },
          idempotencyKey: `mgrsum:${o.code}:${dateLabel}`,
          chatIdOverride: mgrChatId,
        });
      } catch (err) {
        if (!isTransientError(err)) {
          // Non-transient failure for THIS outlet (won't succeed on retry) →
          // audited skip for this outlet only; never abort the loop (the plan's
          // "an unbound/disabled outlet → skip that outlet only" rule extends to
          // a hard send failure — other outlets + the owners rollup still stand).
          await ctx.runMutation(internal.telegram.internal._auditFoundersSkip_internal, {
            reason: `send_failed:outlet:${o.code}`,
          });
          continue;
        }
        // Transient → propagate so the resilient wrapper retries the whole run
        // (per-outlet idempotency keys make already-sent outlets no-ops on retry).
        throw err;
      }
    }

    return { ok: true };
  },
});

// ─── sendOwnersSummaryResilient ───────────────────────────────────────────────

/**
 * Cron entry-point. Wraps `sendOwnersSummary` with the standard cronRetry
 * policy:
 *   • Transient error → self-reschedule with linear back-off via
 *     ctx.scheduler.runAfter (up to RESILIENT_MAX_ATTEMPTS).
 *   • Non-transient error or attempts exceeded → throw (surfaces in the cron
 *     dashboard; no silent drop).
 *
 * `attempt` is 0-based: the cron fires with attempt=0; retries increment it.
 */
export const sendOwnersSummaryResilient = internalAction({
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
        internal.telegram.ownersSummary.sendOwnersSummary,
        {},
      );
    } catch (err) {
      if (isTransientError(err) && attempt + 1 < RESILIENT_MAX_ATTEMPTS) {
        await ctx.scheduler.runAfter(
          resilientRetryDelayMs(attempt),
          internal.telegram.ownersSummary.sendOwnersSummaryResilient,
          { attempt: attempt + 1 },
        );
        return { ok: true as const, retried: true as const, nextAttempt: attempt + 1 };
      }
      throw err;
    }
  },
});
