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
 * v2.0 Task 12 (ENFORCE): returns outlet_id as a required Id<"outlets">. Every
 * live session is backfill-stamped (assertZeroNullOutletIds = true on prod), so
 * an absent outlet_id is now a hard SESSION_NO_OUTLET throw — the migration
 * window has closed.
 */
export async function requireSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string; role: "staff" | "manager" | "owner"; outlet_id: Id<"outlets"> }> {
  const s = await ctx.db.get(sessionId);
  if (!s || s.ended_at != null) throw new Error("NO_SESSION");
  const staff = await ctx.db.get(s.staff_id);
  if (!staff || !staff.active) throw new Error("NO_SESSION");
  // Booth sessions must be outlet-stamped (ADR-051). Cockpit sessions (kind="cockpit")
  // are outlet-less — callers that want cockpit sessions should NOT call requireSession.
  if (!s.outlet_id) throw new Error("SESSION_NO_OUTLET");
  return { staffId: s.staff_id, deviceId: s.device_id, role: staff.role, outlet_id: s.outlet_id as Id<"outlets"> };
}

export async function requireManagerSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string; outlet_id: Id<"outlets"> }> {
  const { staffId, deviceId, role, outlet_id } = await requireSession(ctx, sessionId);
  if (role !== "manager") throw new Error("MANAGER_ONLY");
  return { staffId, deviceId, outlet_id };
}

/**
 * Resolve the outlet a device is bound to. v2.0 Task 12 (ENFORCE): an unbound
 * device now throws DEVICE_HAS_NO_OUTLET (user-facing: ask a manager to assign
 * this device to an outlet) instead of falling back to the default outlet — the
 * migration window has closed. auth owns `registered_devices`, so this
 * device→outlet mapping lives here. Shared by _loginCommit_internal,
 * managerTakeover, and _getDeviceOutletId_internal — flipping the throw here
 * flips all three.
 */
export async function resolveDeviceOutletId(
  ctx: QueryCtx | MutationCtx,
  deviceId: string,
): Promise<Id<"outlets">> {
  const dev = await ctx.db
    .query("registered_devices")
    .withIndex("by_device_id", (q) => q.eq("device_id", deviceId))
    .first();
  if (!dev?.outlet_id) throw new Error("DEVICE_HAS_NO_OUTLET");
  return dev.outlet_id as Id<"outlets">;
}
