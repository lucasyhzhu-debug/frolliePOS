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
 */
export async function requireSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string; role: "staff" | "manager" }> {
  const s = await ctx.db.get(sessionId);
  if (!s || s.ended_at != null) throw new Error("NO_SESSION");
  const staff = await ctx.db.get(s.staff_id);
  if (!staff || !staff.active) throw new Error("NO_SESSION");
  return { staffId: s.staff_id, deviceId: s.device_id, role: staff.role };
}

export async function requireManagerSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string }> {
  const { staffId, deviceId, role } = await requireSession(ctx, sessionId);
  if (role !== "manager") throw new Error("MANAGER_ONLY");
  return { staffId, deviceId };
}
