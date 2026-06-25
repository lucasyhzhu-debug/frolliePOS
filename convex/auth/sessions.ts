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
  // v2.0 owner-auth (C5): a cockpit session must NEVER authenticate a booth
  // operation. Guard BEFORE the outlet check — a cockpit session carries no
  // outlet, so if SESSION_NO_OUTLET ran first it would mask the real reason
  // (wrong plane). NOT_BOOTH_SESSION must precede SESSION_NO_OUTLET. (ADR-052)
  if ((s.kind ?? "booth") !== "booth") throw new Error("NOT_BOOTH_SESSION");
  // Booth sessions must be outlet-stamped (ADR-051). Cockpit sessions (kind="cockpit")
  // are outlet-less — callers that want cockpit sessions should NOT call requireSession.
  if (!s.outlet_id) throw new Error("SESSION_NO_OUTLET");
  return { staffId: s.staff_id, deviceId: s.device_id, role: staff.role, outlet_id: s.outlet_id as Id<"outlets"> };
}

/**
 * Sliding idle-timeout for cockpit (owner) sessions. A cockpit session whose
 * last_active_at is older than this is treated as expired (re-auth required).
 * Booth sessions have no idle timeout (ADR-003) — this applies to cockpit only.
 */
export const COCKPIT_IDLE_MS = 30 * 60 * 1000; // 30 min

/**
 * Resolve a cockpit (owner) session — the third auth plane (ADR-052,
 * "OTP authorises MANAGE"). Distinct from requireSession (booth): cockpit
 * sessions carry NO outlet_id, are owner-role only, and are idle-timeout gated.
 *
 * Throws:
 *  - NO_SESSION: missing / ended session, or inactive / non-owner staff.
 *  - NOT_COCKPIT_SESSION: a booth session passed to a cockpit gate (cross-plane).
 *  - SESSION_IDLE_TIMEOUT: last_active_at older than COCKPIT_IDLE_MS.
 */
export async function requireCockpitSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"staff_sessions">,
): Promise<{ staffId: Id<"staff">; deviceId: string }> {
  const s = await ctx.db.get(sessionId);
  if (!s || s.ended_at != null) throw new Error("NO_SESSION");
  // Cross-plane guard: a booth session must never authenticate a cockpit op.
  if ((s.kind ?? "booth") !== "cockpit") throw new Error("NOT_COCKPIT_SESSION");
  const staff = await ctx.db.get(s.staff_id);
  if (!staff || !staff.active || staff.role !== "owner") throw new Error("NO_SESSION");
  // Fail-closed: a cockpit session always carries last_active_at (set at commit),
  // so an absent anchor is a malformed row — treat it as timed-out rather than
  // always-live, so it can never bypass the idle gate.
  if (s.last_active_at == null || Date.now() - s.last_active_at > COCKPIT_IDLE_MS) {
    throw new Error("SESSION_IDLE_TIMEOUT");
  }
  return { staffId: s.staff_id, deviceId: s.device_id };
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
 * managerOverride, and _getDeviceOutletId_internal — flipping the throw here
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
