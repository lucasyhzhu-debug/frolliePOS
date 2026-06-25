import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

// _latestShiftEvent_internal, _recordShiftEvent_internal, _shiftStartAnchor_internal,
// and shiftEventFields deleted (ADR-053): the legacy pos_shift_events writer/reader path
// has zero runtime callers now that booth state is two stored levels. pos_shift_events is
// kept read-only for legacy audit history.

/**
 * Aggregate sales + manual-BCA stats for the end-of-day sign-off summary.
 *
 * Consumes:
 *   - transactions._dailySalesSummary_internal → { totalSalesIdr, txnCount, flaggedCount }
 *   - transactions._manualBcaReconciliation_internal → { items, count, totalIdr }
 *
 * Returns a flat object stored on the pos_shift_events.summary field. The
 * `flaggedCount` from _dailySalesSummary_internal is intentionally NOT stored
 * in the summary field (the schema doesn't include it); it's available from
 * the audit log if needed. `manualBca.items` is also dropped — the per-item
 * detail is already available via the transactions query; only count + totalIdr
 * are summary-level aggregates.
 */
export const _buildSignoffSummary_internal = internalQuery({
  args: {
    shiftStartMs: v.number(),
    endMs: v.number(),
    outletId: v.id("outlets"),
  },
  handler: async (
    ctx,
    { shiftStartMs, endMs, outletId },
  ): Promise<{
    durationMs: number;
    totalSalesIdr: number;
    txnCount: number;
    manualBcaCount: number;
    manualBcaTotalIdr: number;
  }> => {
    // v2.0 Stream 5: pass outletId so the aggregates are outlet-scoped.
    const [sales, manualBca] = await Promise.all([
      ctx.runQuery(
        internal.transactions.internal._dailySalesSummary_internal,
        { dayStartMs: shiftStartMs, dayEndMs: endMs, outletId },
      ),
      ctx.runQuery(
        internal.transactions.internal._manualBcaReconciliation_internal,
        { dayStartMs: shiftStartMs, dayEndMs: endMs, outletId },
      ),
    ]);
    return {
      durationMs: Math.max(0, endMs - shiftStartMs),
      totalSalesIdr: sales.totalSalesIdr,
      txnCount: sales.txnCount,
      manualBcaCount: manualBca.count,
      manualBcaTotalIdr: manualBca.totalIdr,
    };
  },
});

// _commitManagerTakeover_internal deleted (ADR-053): superseded by managerOverride
// in shiftsInternal.ts, which force-ends a stranded pos_shifts row without creating
// a new session (the original staffer re-authenticates via standard login).
