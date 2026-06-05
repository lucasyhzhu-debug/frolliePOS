import { query } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { requireManagerSession } from "../auth/sessions";
import { auditListHandler } from "./internal";

/**
 * The audit row as exposed to the manager viewer: a projection of the fields
 * the trail renders, plus the server-derived `actor_name`. We project rather
 * than spread the full Doc so the client never receives the heavy/sensitive
 * `before_state`/`after_state`/`metadata`/`device_id`/`mgr_approver_id` fields
 * the UI doesn't use (v0.5.1b Doc-leak hazard; matches the transactions
 * reporting precedent that projects to a shape).
 */
type AuditRowView = Pick<
  Doc<"audit_log">,
  "_id" | "created_at" | "action" | "entity_type" | "entity_id" | "source" | "reason"
> & { actor_name: string };

/**
 * Public audit log — manager session required. Rows are enriched with a
 * server-derived `actor_name` (ADR-034 cross-module read via
 * _listStaffNames_internal; "BE pre-derives labels" — v0.5.3a). The raw
 * `_list_internal` variant stays label-free for server/test callers.
 *
 * The handler return type is annotated explicitly: the handler references
 * `internal.*`, so inferring its return type would cycle through
 * `ApiFromModules` and widen `api` to `any` at every consumer (v0.5.3a
 * established this annotate-when-calling-internal pattern).
 */
export const list = query({
  args: {
    sessionId: v.id("staff_sessions"),
    limit: v.optional(v.number()),
    action: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AuditRowView[]> => {
    await requireManagerSession(ctx, args.sessionId);
    const rows = await auditListHandler(ctx, args);

    const staffNames = await ctx.runQuery(
      internal.auth.internal._listStaffNames_internal,
      {},
    );
    const nameById = new Map(staffNames.map((s) => [String(s._id), s.name]));

    return rows.map((r) => ({
      _id: r._id,
      created_at: r.created_at,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      source: r.source,
      reason: r.reason,
      actor_name:
        r.actor_id === "system"
          ? "System"
          : nameById.get(String(r.actor_id)) ?? String(r.actor_id),
    }));
  },
});
