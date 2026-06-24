// convex/telegram/resolveOutletChat.ts
//
// V8-SAFE — NO "use node". This module lives in the action layer only because
// it needs to cross module boundaries via ctx.runQuery; it is imported by
// send.ts ("use node") and the test wrapper internalAction below.

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

/**
 * Resolve the per-outlet chat ID for an OUTLET-SCOPED role.
 *
 * Algorithm (ADR-035 / Spec-4 decision 4):
 *   1. Try concrete (role, outlet_id) lookup first.
 *   2. On miss, if EXACTLY ONE active outlet exists AND a bare by_role row
 *      (outlet_id absent) exists, return it — transitional single-outlet
 *      bind-free path.
 *   3. Otherwise throw — a multi-outlet misroute is impossible under this gate.
 *
 * Lives in the action layer (not a resolver query) because the single-outlet
 * fallback reads the `outlets` table via ctx.runQuery — a cross-module read
 * that only ActionCtx may do, and queries have no ctx.runQuery.
 */
export async function resolveOutletChatId(
  ctx: ActionCtx,
  role: string,
  outletId: Id<"outlets">,
): Promise<string> {
  // 1. Try concrete outlet-scoped lookup first.
  const scoped = await ctx.runQuery(
    internal.telegram.chatRegistry.internal.getChatIdByRoleAndOutlet,
    { role, outletId },
  );
  if (scoped) return scoped;

  // 2. Bare-row fallback — ONLY safe when exactly one active outlet exists.
  // TRANSITIONAL: this path matters only in the window after Step-1 deploys but
  // before the backfill binds chats to outlets (a single bare `managers` row, one
  // active outlet). The three sequential cross-module reads here have a benign
  // race (a chat could be archived between the scoped miss and the bare lookup) —
  // bounded to that window + a single-outlet deployment; once backfill runs, the
  // scoped lookup (step 1) hits and this path is never taken.
  const active = await ctx.runQuery(
    internal.outlets.internal._listActiveOutlets_internal,
    {},
  );
  if (active.length === 1) {
    const bare = await ctx.runQuery(
      internal.telegram.chatRegistry.internal.getChatIdByRoleBareOrNull,
      { role },
    );
    if (bare) return bare;
  }

  throw new Error(
    `No Telegram chat assigned to role '${role}' for outlet '${outletId}'`,
  );
}

/**
 * Thin internalAction wrapper for testing resolveOutletChatId end-to-end via
 * convex-test's t.action(). Only referenced from __tests__; tree-shaken in prod.
 */
export const _resolveOutletChatId_test_internal = internalAction({
  args: { role: v.string(), outletId: v.id("outlets") },
  handler: (ctx, args) => resolveOutletChatId(ctx, args.role, args.outletId),
});
