import { QueryCtx, MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";

/**
 * Resolve a session id to its staff context. Throws NO_SESSION if the session
 * is ended, missing, or its staff record is inactive.
 *
 * Extracted from convex/staff.ts in v0.2.1 to break the audit→staff backwards
 * dependency (ADR-034 §"Layer 1 — module boundaries"). Now lives in auth/
 * (foundational module) so audit/, staff/, and any future module can import it
 * without reaching across the staff/ boundary.
 *
 * v2.0 Stream 5: returns outlet_id (window-typed: Id<"outlets"> | undefined).
 * Unstamped sessions (pre-migration-backfill) fall back to the single active
 * outlet. The hard SESSION_NO_OUTLET throw is Task 12 (enforce window), not now.
 */
export async function requireSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string; role: "staff" | "manager"; outlet_id: Id<"outlets"> | undefined }> {
  const s = await ctx.db.get(sessionId);
  if (!s || s.ended_at != null) throw new Error("NO_SESSION");
  const staff = await ctx.db.get(s.staff_id);
  if (!staff || !staff.active) throw new Error("NO_SESSION");
  // Migration-tolerant window (I4): unstamped old sessions fall back to the single default outlet.
  let outlet_id = s.outlet_id as Id<"outlets"> | undefined;
  if (!outlet_id) {
    const def = await ctx.db.query("outlets").withIndex("by_active", (q) => q.eq("active", true)).first();
    outlet_id = def?._id;
  }
  return { staffId: s.staff_id, deviceId: s.device_id, role: staff.role, outlet_id };
}

export async function requireManagerSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string; outlet_id: Id<"outlets"> | undefined }> {
  const { staffId, deviceId, role, outlet_id } = await requireSession(ctx, sessionId);
  if (role !== "manager") throw new Error("MANAGER_ONLY");
  return { staffId, deviceId, outlet_id };
}
