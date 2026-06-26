import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Plain V8-safe helper that idempotently inserts a `staff_outlet_access` row.
 * Does NOT emit audit — callers are responsible for audit emission.
 *
 * Returns `{ accessId, created: true }` on first insert,
 * `{ accessId, created: false }` if the row already existed.
 */
export async function grantOutletAccessRow(
  ctx: MutationCtx,
  {
    staffId,
    outletId,
    grantedBy,
    now,
  }: {
    staffId: Id<"staff">;
    outletId: Id<"outlets">;
    grantedBy: Id<"staff">;
    now: number;
  },
): Promise<{ accessId: Id<"staff_outlet_access">; created: boolean }> {
  const existing = await ctx.db
    .query("staff_outlet_access")
    .withIndex("by_staff_outlet", (q) =>
      q.eq("staff_id", staffId).eq("outlet_id", outletId),
    )
    .first();
  if (existing) return { accessId: existing._id, created: false };
  const accessId = await ctx.db.insert("staff_outlet_access", {
    staff_id: staffId,
    outlet_id: outletId,
    granted_at: now,
    granted_by: grantedBy,
  });
  return { accessId, created: true };
}
