import { internalQuery } from "../_generated/server";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { v } from "convex/values";

export const _requireOutletCode_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }) => {
    const o = await ctx.db.get(outletId);
    if (!o) throw new Error("OUTLET_NOT_FOUND");
    return o.code;
  },
});

/**
 * Migration-tolerant fallback: the single active outlet during the optional
 * window. Plain V8 helpers so plain session helpers (auth/sessions.ts) can
 * resolve the default outlet via ctx.db WITHOUT an illegal runQuery-in-query
 * hop. The `by_active` query lives HERE only — every "outlet_id may be absent →
 * use the default" site routes through these, so the Task-12 enforce step
 * (absent ⇒ throw SESSION_NO_OUTLET) flips the policy in exactly one place.
 *
 * `getDefaultOutletDoc` returns the row (callers needing the name/code);
 * `resolveDefaultOutletId` returns just the id for the `?? default` fallback
 * sites; `_getDefaultOutlet_internal` wraps the doc form for cross-module
 * (runQuery) callers. V8-safe.
 */
export async function getDefaultOutletDoc(ctx: QueryCtx | MutationCtx) {
  return ctx.db
    .query("outlets")
    .withIndex("by_active", (q) => q.eq("active", true))
    .first();
}

export async function resolveDefaultOutletId(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"outlets"> | undefined> {
  const def = await getDefaultOutletDoc(ctx);
  return def?._id;
}

export const _getDefaultOutlet_internal = internalQuery({
  args: {},
  handler: (ctx) => getDefaultOutletDoc(ctx),
});
