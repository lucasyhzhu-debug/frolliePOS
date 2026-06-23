import { query, mutation } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { internal } from "../_generated/api";
import { requireCockpitSession } from "./sessions";

/**
 * List active staff for the login screen.
 * Public: pre-auth (login screen calls this before any session exists).
 * Returns name + role + _id only; pin_hash never leaves the server.
 */
export const getActiveStaff = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("staff")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    return rows.map((s) => ({ _id: s._id, name: s.name, role: s.role }));
  },
});

/**
 * v2.0 Task 10: Whether this device should run the start-of-day / handover SOP gate.
 * Public (pre-auth) — called by RootLayout before any session-scoped query.
 *
 * Migration-window rule (backward-compatible, Task 12 will tighten):
 *   - Registered + active + outlet_id SET → outlet device, SOP gate fires.
 *   - Registered + active + outlet_id NULL → unbound during migration, treat as
 *     outlet (backward-compatible for single-device booth).
 *   - Not registered or inactive → false (should have been caught by device gate).
 *
 * Task 12 will change the NULL case to return false (unbound = viewer) once all
 * devices have been formally assigned via mgr/device (assignDeviceOutlet).
 */
export const isDeviceOutlet = query({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }): Promise<boolean> => {
    const dev = await ctx.db
      .query("registered_devices")
      .withIndex("by_device_id", (q) => q.eq("device_id", deviceId))
      .first();
    if (!dev || !dev.active) return false;
    // Window-tolerant: unbound device = outlet (backward-compat until Task 12).
    return true;
  },
});

/**
 * v2.0 Task 10: List active staff scoped to the device's bound outlet.
 * Public (pre-auth) — called by the login screen so only staff who work at THIS
 * outlet appear in the roster. Falls back to an empty array when the device has
 * no outlet binding yet (unbound device → show the "ask a manager" state).
 *
 * Resolution: registered_devices by_device_id → outlet_id → _listStaffForOutlet_internal.
 * Window-tolerant: returns all active staff when no outlet_id is bound so the
 * login screen degrades gracefully during the migration window (no hard-block
 * until Task 12 enforces the binding gate).
 */
export const listStaffForDevice = query({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }): Promise<Array<{ _id: Id<"staff">; name: string; role: "staff" | "manager" }>> => {
    const dev = await ctx.db
      .query("registered_devices")
      .withIndex("by_device_id", (q) => q.eq("device_id", deviceId))
      .first();
    if (!dev) return [];
    const outletId = dev.outlet_id as Id<"outlets"> | undefined;
    if (!outletId) {
      // Unbound device during migration window: fall back to all active staff so
      // the booth keeps working. Task 12 will enforce the binding gate.
      const rows = await ctx.db
        .query("staff")
        .withIndex("by_active", (q) => q.eq("active", true))
        .collect();
      return rows.map((s) => ({ _id: s._id, name: s.name, role: s.role as "staff" | "manager" }));
    }
    const staffRows = await ctx.runQuery(
      internal.auth.internal._listStaffForOutlet_internal,
      { outletId },
    ) as Array<{ _id: Id<"staff">; name: string; role: string }>;
    return staffRows.map((s) => ({ _id: s._id, name: s.name, role: s.role as "staff" | "manager" }));
  },
});

export const getSession = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args) => {
    const s = await ctx.db.get(args.sessionId);
    if (!s || s.ended_at != null) return null;
    const staff = await ctx.db.get(s.staff_id);
    if (!staff || !staff.active) return null;
    const kind = (s.kind ?? "booth") as "booth" | "cockpit"; // WS6 + I4 (ADR-052)
    // v2.0 owner-auth: cockpit (owner) sessions are outlet-less by design — skip
    // the booth outlet resolution entirely. For booth sessions, Task 12 (ENFORCE)
    // guarantees every live session is backfill-stamped, so an absent outlet is a
    // hard SESSION_NO_OUTLET throw. (auth/ is allowlisted for cross-module db
    // reads, ADR-034 §"Layer 1".)
    const outlet =
      kind === "cockpit"
        ? null
        : await (async () => {
            if (!s.outlet_id) throw new Error("SESSION_NO_OUTLET");
            return ctx.db.get(s.outlet_id);
          })();
    return {
      sessionId: s._id,
      kind, // WS6 + I4: "booth" | "cockpit" — FE routes the session gate on this.
      // SEC-03: surface must_change_pin so the FE can force a rotation prompt.
      staff: {
        _id: staff._id,
        name: staff.name,
        role: staff.role,
        must_change_pin: staff.must_change_pin ?? false,
        locale: staff.locale ?? "en", // v1.2 #1: absent ⇒ English
        outlet_id: outlet?._id,
        outlet_label: outlet?.name,
      },
      deviceId: s.device_id,
      startedAt: s.started_at,
    };
  },
});

/**
 * Refresh a cockpit session's idle anchor (sliding 30-min timeout, ADR-052).
 * Owner-only via the requireCockpitSession authCheck (runs BEFORE the idempotency
 * cache lookup, rule #20).
 *
 * The authCheck THROWS (not a no-op) when the session is missing/ended
 * (NO_SESSION), a booth session (NOT_COCKPIT_SESSION), or already past the idle
 * window (SESSION_IDLE_TIMEOUT) — a keepalive must NOT silently revive a session
 * that has legitimately timed out. The FE keepalive treats any throw as
 * "session ended → redirect to /cockpit/login". The handler body's null-return is
 * the success path only.
 */
export const touchCockpitSession = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<{ idempotencyKey: string; sessionId: Id<"staff_sessions"> }, null>(
    "auth.touchCockpitSession",
    async (ctx, args) => {
      const s = await ctx.db.get(args.sessionId);
      if (!s || s.ended_at != null || (s.kind ?? "booth") !== "cockpit") return null;
      await ctx.db.patch(args.sessionId, { last_active_at: Date.now() });
      return null;
    },
    { authCheck: async (ctx, args) => { await requireCockpitSession(ctx, args.sessionId); } },
  ),
});

/**
 * End a cockpit (owner) session. Idempotent — a stale/already-ended session is a
 * graceful no-op (authCheck no-op like auth.logout) so "Sign out" is safe to retry.
 * Audited as owner.logout with source "system" (bot-mediated owner plane, ADR-052).
 */
export const logoutCockpit = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<{ idempotencyKey: string; sessionId: Id<"staff_sessions"> }, null>(
    "auth.logoutCockpit",
    async (ctx, args) => {
      const s = await ctx.db.get(args.sessionId);
      if (!s || s.ended_at != null) return null;
      await ctx.db.patch(args.sessionId, { ended_at: Date.now(), end_reason: "owner_logout" });
      await logAudit(ctx, {
        actor_id: s.staff_id, action: "owner.logout",
        entity_type: "staff_session", entity_id: args.sessionId,
        source: "system", device_id: s.device_id,
      });
      return null;
    },
    // intentional: logout is idempotent — graceful no-op like auth.logout (rule #20).
    { authCheck: async () => {} },
  ),
});

export const logout = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<{ idempotencyKey: string; sessionId: Id<"staff_sessions"> }, null>(
    "auth.logout",
    async (ctx, args) => {
      const session = await ctx.db.get(args.sessionId);
      if (!session || session.ended_at != null) return null;
      await ctx.db.patch(args.sessionId, {
        ended_at: Date.now(),
        end_reason: "manual_lock",
      });
      await logAudit(ctx, {
        actor_id: session.staff_id, action: "staff.logout",
        entity_type: "staff_session", entity_id: args.sessionId,
        source: "booth_inline", device_id: session.device_id,
      });
      return null;
    },
    {
      // intentional: logout is idempotent — a stale or already-ended session must
      // remain a graceful no-op (handler body returns null without throwing). The
      // idempotency key dedupes genuine double-taps of the Lock button. Strict
      // authCheck would surface a NO_SESSION error to the PWA, breaking the UX
      // contract that "Lock" is safe to retry.
      authCheck: async () => {},
    },
  ),
});
