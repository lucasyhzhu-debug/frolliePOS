/**
 * convex/cockpit/dashboard.ts
 * v1.3.0 owner cockpit — cross-outlet dashboard queries.
 *
 * Both queries fan out over all active outlets (via
 * internal._listActiveOutlets_internal) and call
 * internal._fetchDayWindow_internal per outlet — no raw ctx.db on foreign
 * tables (ADR-034 / no-cross-module-db-access fence).
 *
 * IMPORTANT: explicit Promise<...> return-type annotations on both handlers
 * are required to break the Convex api-inference cycle that collapses api to
 * `any` when ctx.runQuery(internal.*) is called inside a query. Missing
 * annotations cascade implicit-any across audit/catalog/refunds/etc.
 */
import { query } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { requireCockpitSession } from "../auth/sessions";
import { computeDaySummary } from "../transactions/lib";
import { wibDayWindow } from "../lib/time";

/**
 * Consolidated sales summary across all active outlets for the given WIB day
 * (defaults to today). Owner-cockpit gated.
 *
 * Returns aggregated totals: gross revenue, transaction count, and total
 * refunds — suitable for an at-a-glance owner dashboard card.
 */
export const consolidatedSummary = query({
  args: {
    sessionId: v.id("staff_sessions"),
    dayMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { sessionId, dayMs },
  ): Promise<{ gross: number; txnCount: number; refundTotal: number }> => {
    await requireCockpitSession(ctx, sessionId);
    const { dayStartMs, dayEndMs } = wibDayWindow(dayMs ?? Date.now());
    const outlets = await ctx.runQuery(
      internal.outlets.internal._listActiveOutlets_internal,
      {},
    );
    let gross = 0,
      txnCount = 0,
      refundTotal = 0;
    for (const o of outlets) {
      const txns = await ctx.runQuery(
        internal.transactions.internal._fetchDayWindow_internal,
        { dayStartMs, dayEndMs, outletId: o._id },
      );
      const s = computeDaySummary(txns);
      gross += s.gross;
      txnCount += s.count;
      refundTotal += s.refundsTotal;
    }
    return { gross, txnCount, refundTotal };
  },
});

/**
 * Per-outlet sales summary for the given WIB day (defaults to today).
 * Owner-cockpit gated.
 *
 * Returns one row per active outlet with its outlet identity (id, code, name)
 * and aggregated sales for the day — suitable for a per-outlet breakdown table.
 */
export const perOutletSummary = query({
  args: {
    sessionId: v.id("staff_sessions"),
    dayMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { sessionId, dayMs },
  ): Promise<
    {
      outletId: Id<"outlets">;
      code: string;
      name: string;
      gross: number;
      txnCount: number;
    }[]
  > => {
    await requireCockpitSession(ctx, sessionId);
    const { dayStartMs, dayEndMs } = wibDayWindow(dayMs ?? Date.now());
    const outlets = await ctx.runQuery(
      internal.outlets.internal._listActiveOutlets_internal,
      {},
    );
    const out: {
      outletId: Id<"outlets">;
      code: string;
      name: string;
      gross: number;
      txnCount: number;
    }[] = [];
    for (const o of outlets) {
      const txns = await ctx.runQuery(
        internal.transactions.internal._fetchDayWindow_internal,
        { dayStartMs, dayEndMs, outletId: o._id },
      );
      const s = computeDaySummary(txns);
      out.push({
        outletId: o._id,
        code: o.code,
        name: o.name,
        gross: s.gross,
        txnCount: s.count,
      });
    }
    return out;
  },
});
