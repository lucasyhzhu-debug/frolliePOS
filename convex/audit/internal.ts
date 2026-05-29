import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

const sourceValidator = v.union(
  v.literal("booth_inline"),
  v.literal("wa_approval"),
  v.literal("telegram_approval"),
  v.literal("system"),
  v.literal("reaper"),
);

/**
 * Append a row to audit_log. Call from inside any state-changing mutation.
 * ADR-007: append-only — this is the ONLY function that writes to audit_log.
 * Server-time only (ADR-031) — created_at is set inside, never accepted as arg.
 *
 * Stays a plain async TypeScript function (NOT an internalMutation) per ADR-034:
 * runs in the caller's transaction, no JSON serialization overhead at a runtime
 * boundary. Direct ctx.db.insert("audit_log", ...) from outside this module is
 * the prohibited pattern.
 */
export async function logAudit(
  ctx: MutationCtx,
  args: {
    actor_id: Id<"staff"> | "system";
    action: string;
    entity_type: string;
    entity_id?: string;
    before_state?: unknown;
    after_state?: unknown;
    device_id?: string;
    mgr_approver_id?: Id<"staff">;
    source: "booth_inline" | "wa_approval" | "telegram_approval" | "system" | "reaper";
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.db.insert("audit_log", {
    actor_id: args.actor_id,
    action: args.action,
    entity_type: args.entity_type,
    entity_id: args.entity_id,
    before_state: args.before_state == null ? undefined : JSON.stringify(args.before_state),
    after_state: args.after_state == null ? undefined : JSON.stringify(args.after_state),
    device_id: args.device_id,
    mgr_approver_id: args.mgr_approver_id,
    source: args.source,
    reason: args.reason,
    metadata: args.metadata == null ? undefined : JSON.stringify(args.metadata),
    created_at: Date.now(),
  });
}

/** Shared query logic — used by both the public and internal variants. */
export async function auditListHandler(
  ctx: QueryCtx,
  args: { limit?: number; action?: string },
) {
  const limit = Math.min(args.limit ?? 100, 500);
  if (args.action) {
    return await ctx.db
      .query("audit_log")
      .withIndex("by_action_date", (q) => q.eq("action", args.action!))
      .order("desc")
      .take(limit);
  }
  return await ctx.db.query("audit_log").order("desc").take(limit);
}

/**
 * Internal-only audit list — no auth gate. Safe to use from server-side
 * contexts and tests; unreachable from public clients.
 */
export const _list_internal = internalQuery({
  args: {
    limit: v.optional(v.number()),
    action: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return auditListHandler(ctx, args);
  },
});

// Test-only helper: tests can't import + call logAudit() directly because it
// expects a MutationCtx, which only exists inside a mutation. Wrap it.
// Exported as INTERNAL — not callable from public clients.
export const __test_log = internalMutation({
  args: {
    actor_id: v.union(v.id("staff"), v.literal("system")),
    action: v.string(),
    entity_type: v.string(),
    entity_id: v.optional(v.string()),
    source: sourceValidator,
  },
  handler: async (ctx, args) => {
    await logAudit(ctx, args);
  },
});
