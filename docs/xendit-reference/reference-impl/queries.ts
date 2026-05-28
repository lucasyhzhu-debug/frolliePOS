// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE COPY — from Frollie Recipe Master (product_master), Phase 84.
// Path in source repo: convex/qrisPayments/queries.ts
// Documentation only; NOT compiled in FrolliePOS. `protectedQuery` / `requireRole`
// are the SOURCE repo's token-based auth; FrolliePOS uses session-based auth —
// see README "Adaptation map".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase 84 Plan 03 — QRIS payment queries.
 *
 * Role alignment (pitfall #19, staffreview C1 / role-table): EVERY query
 * reachable from the order-detail page MUST authorize the canAccessOrders
 * superset { order_staff, manager, admin }. `useSessionQuery` subscribes on
 * mount regardless of dialog-open state — a narrower role set throws
 * ConvexError → React error boundary → page crash for order_staff (3rd
 * recurrence). `businessSettings.get` is ["admin","manager"] (UNSAFE here), so
 * `getQrisConfig` folds in the NMID itself rather than calling it.
 *
 * Queries CAN read process.env in Convex (only `fetch` is action-restricted),
 * so the QRIS_ENABLED flag is read here server-side (D-01 defense-in-depth).
 */

import { v } from "convex/values";
import { protectedQuery } from "../lib/functions";
import { internalQuery } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireRole } from "../lib/auth";

/**
 * The active QRIS payment row for an order — order_staff-safe.
 *
 * Returns the MOST RECENT row among { pending, paid } (excludes only `expired`)
 * so a freshly-paid row wins over an older expired one and the dialog flips
 * reactively (staffreview I2). Returns null if none.
 */
export const getActiveQrisPayment = protectedQuery({
  roles: ["order_staff", "manager", "admin"],
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    return await resolveActiveRow(ctx, args.orderId);
  },
});

/**
 * Internal mirror of getActiveQrisPayment for tests / internal callers
 * (the integration test drives it via `t.query(internal.*)`).
 */
export const getActiveQrisPaymentInternal = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, args) => {
    return await resolveActiveRow(ctx, args.orderId);
  },
});

/**
 * QRIS feature config — order_staff-safe.
 *
 * Reads the QRIS_ENABLED flag server-side and folds in the order-staff-safe
 * NMID + merchant name (RESEARCH correction #2) so the dialog never calls
 * `useBusinessSettings()` (which is admin/manager-only and would crash
 * order_staff — pitfall #19).
 */
export const getQrisConfig = protectedQuery({
  roles: ["order_staff", "manager", "admin"],
  args: {},
  handler: async (ctx) => {
    const settings = await ctx.db.query("businessSettings").first();
    return {
      enabled: process.env.QRIS_ENABLED === "true",
      qrisNmid: settings?.qrisNmid ?? null,
      merchantName: settings?.businessName ?? null,
    };
  },
});

/**
 * Internal auth+state query for the create-invoice action (staffreview C1 / I4).
 *
 * Actions have no ctx.db and there is NO protectedAction, so the action gates
 * auth by calling this internal query, which runs requireRole FIRST (throwing
 * on unauthorized BEFORE returning state) and then returns the order fields the
 * action needs — including `orderNumber` as the externalId match key.
 * Mirror: bigsellerOrders/queries.ts:240-246 requireAdminByToken.
 */
export const getOrderForCreate = internalQuery({
  args: { orderId: v.id("orders"), token: v.string() },
  handler: async (ctx, args) => {
    await requireRole(ctx, args.token, ["order_staff", "manager", "admin"]);
    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Order not found");
    return {
      status: order.status,
      finalTotal: order.finalTotal ?? 0,
      orderNumber: order.orderNumber,
    };
  },
});

// ---------------------------------------------------------------------------
// Shared resolution: most-recent non-expired row (pending or paid).
// ---------------------------------------------------------------------------
async function resolveActiveRow(ctx: QueryCtx, orderId: Id<"orders">) {
  const rows = await ctx.db
    .query("qrisPayments")
    .withIndex("by_order", (q) => q.eq("orderId", orderId))
    .collect();
  const active = rows
    .filter((r) => r.status !== "expired")
    .sort((a, b) => b._creationTime - a._creationTime);
  return active[0] ?? null;
}
