import { query, internalQuery, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { withIdempotency } from "./idempotency";
import { logAudit } from "./audit";

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

export const getSession = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, args) => {
    const s = await ctx.db.get(args.sessionId);
    if (!s || s.ended_at != null) return null;
    const staff = await ctx.db.get(s.staff_id);
    if (!staff || !staff.active) return null;
    return {
      sessionId: s._id,
      staff: { _id: staff._id, name: staff.name, role: staff.role },
      deviceId: s.device_id,
      startedAt: s.started_at,
    };
  },
});

/**
 * Read the pin_hash for verify. Internal-only — only the Node action that
 * runs argon2Verify is allowed to call this.
 */
export const _getStaffPinHash_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, args) => {
    const s = await ctx.db.get(args.staffId);
    if (!s) return null;
    return { _id: s._id, pin_hash: s.pin_hash, active: s.active, role: s.role };
  },
});

const LOCKOUT_MS = 60_000;
const MAX_FAILS = 3;

/**
 * Read the current lock state for a staff member. Called by the loginWithPin
 * action BEFORE argon2Verify so locked users get rejected cheaply.
 */
export const _getLockState_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, args): Promise<{ locked: boolean; seconds_remaining: number; fail_count: number }> => {
    const attempt = await ctx.db
      .query("pos_auth_attempts")
      .withIndex("by_staff", (q) => q.eq("staff_id", args.staffId))
      .unique();
    const now = Date.now();
    if (attempt?.locked_until && attempt.locked_until > now) {
      return {
        locked: true,
        seconds_remaining: Math.ceil((attempt.locked_until - now) / 1000),
        fail_count: attempt.fail_count,
      };
    }
    return { locked: false, seconds_remaining: 0, fail_count: attempt?.fail_count ?? 0 };
  },
});

/**
 * Record a failed PIN attempt. MUST commit before the action throws so lockout
 * state survives. NOT wrapped in withIdempotency — failed attempts must always
 * execute (user may retry with a correct PIN on the next attempt).
 */
export const _recordFailedAttempt_internal = internalMutation({
  args: { staffId: v.id("staff"), deviceId: v.string() },
  handler: async (ctx, args): Promise<{ newly_locked: boolean; seconds_remaining: number }> => {
    const now = Date.now();
    const attempt = await ctx.db
      .query("pos_auth_attempts")
      .withIndex("by_staff", (q) => q.eq("staff_id", args.staffId))
      .unique();
    const next = (attempt?.fail_count ?? 0) + 1;
    const lock = next >= MAX_FAILS ? now + LOCKOUT_MS : null;
    if (attempt) {
      await ctx.db.patch(attempt._id, { fail_count: next, locked_until: lock, last_attempt_at: now });
    } else {
      await ctx.db.insert("pos_auth_attempts", {
        staff_id: args.staffId, fail_count: next, locked_until: lock, last_attempt_at: now,
      });
    }
    await logAudit(ctx, {
      actor_id: args.staffId, action: "staff.failed_pin",
      entity_type: "staff", entity_id: args.staffId,
      source: "booth_inline", device_id: args.deviceId,
    });
    if (lock) {
      await logAudit(ctx, {
        actor_id: args.staffId, action: "staff.locked_out",
        entity_type: "staff", entity_id: args.staffId,
        source: "booth_inline", device_id: args.deviceId,
        reason: `${MAX_FAILS} consecutive failures`,
      });
    }
    return {
      newly_locked: lock != null,
      seconds_remaining: lock ? Math.ceil((lock - now) / 1000) : 0,
    };
  },
});

/**
 * Commit a successful login: clears the fail counter, writes the session row,
 * emits the audit log. INTERNAL — only called by loginWithPin AFTER argon2Verify
 * has confirmed the PIN is correct. Wrapped in withIdempotency so retries replay
 * the cached { sessionId, role } without re-running any DB writes.
 */
export const _loginCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    staffId: v.id("staff"),
    deviceId: v.string(),
  },
  handler: withIdempotency<
    { idempotencyKey: string; staffId: Id<"staff">; deviceId: string },
    { sessionId: Id<"staff_sessions">; role: "staff" | "manager" }
  >(
    "auth.loginWithPin",
    async (ctx, args) => {
      const now = Date.now();
      const staff = await ctx.db.get(args.staffId);
      if (!staff || !staff.active) {
        // Shouldn't happen — action checked already. Defensive only.
        throw new Error("INVALID_PIN");
      }

      // Clear failed-attempt counter on success
      const attempt = await ctx.db
        .query("pos_auth_attempts")
        .withIndex("by_staff", (q) => q.eq("staff_id", args.staffId))
        .unique();
      if (attempt) {
        await ctx.db.patch(attempt._id, { fail_count: 0, locked_until: null, last_attempt_at: now });
      }

      const sessionId = await ctx.db.insert("staff_sessions", {
        staff_id: args.staffId,
        device_id: args.deviceId,
        started_at: now,
        ended_at: null,
        end_reason: null,
      });
      await ctx.db.patch(args.staffId, { last_login_at: now });
      await logAudit(ctx, {
        actor_id: args.staffId, action: "staff.login",
        entity_type: "staff_session", entity_id: sessionId,
        source: "booth_inline", device_id: args.deviceId,
      });

      return { sessionId, role: staff.role };
    },
    { staffIdFromArgs: (a) => a.staffId },
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
  ),
});

/** Test-only commit used by _seedHashedStaff_internal. */
export const _seedStaffCommit_internal = internalMutation({
  args: {
    name: v.string(),
    pin_hash: v.string(),
    role: v.union(v.literal("staff"), v.literal("manager")),
  },
  handler: async (ctx, args): Promise<Id<"staff">> => {
    return await ctx.db.insert("staff", {
      name: args.name,
      pin_hash: args.pin_hash,
      role: args.role,
      active: true,
      created_at: Date.now(),
    });
  },
});
