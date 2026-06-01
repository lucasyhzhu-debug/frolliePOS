import { internalQuery, internalMutation, QueryCtx, MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { requireManagerSession } from "./sessions";

/**
 * Resolve a staff member's display fields (name, code) by id.
 * Called by approvals/public via ctx.runQuery to cross the module boundary
 * (ADR-034: approvals does not own the `staff` table).
 * Returns null if the staff row does not exist.
 */
export const _getStaffNameCode_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, args): Promise<{ name: string; code?: string } | null> => {
    const s = await ctx.db.get(args.staffId);
    if (!s) return null;
    return { name: s.name, code: s.code };
  },
});

/**
 * Resolve a staff row by its `code`. Used by approvals/actions.approveStaffPinReset
 * to identify which manager is approving (the form supplies managerStaffCode).
 * Returns the fields the action needs to argon2-verify and authorise the reset.
 * The `staff` table is owned by the auth module (ADR-034), so this lookup lives
 * here — other modules reach it via ctx.runQuery. Returns null if no match.
 */
export const _getByCode_internal = internalQuery({
  args: { code: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    _id: Id<"staff">;
    pin_hash: string;
    active: boolean;
    role: "staff" | "manager";
  } | null> => {
    const s = await ctx.db
      .query("staff")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .first();
    if (!s) return null;
    return { _id: s._id, pin_hash: s.pin_hash, active: s.active, role: s.role };
  },
});

/**
 * Read the pin_hash for verify. Internal-only — only the Node action that
 * runs argon2Verify is allowed to call this.
 */
export const _getStaffPinHash_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    _id: Id<"staff">;
    pin_hash: string;
    active: boolean;
    role: "staff" | "manager";
  } | null> => {
    const s = await ctx.db.get(args.staffId);
    if (!s) return null;
    return { _id: s._id, pin_hash: s.pin_hash, active: s.active, role: s.role };
  },
});

const LOCKOUT_MS = 60_000;
const MAX_FAILS = 3;

// ---------------------------------------------------------------------------
// Fix 3: duplicate-tolerant pos_auth_attempts helpers
// ---------------------------------------------------------------------------

/**
 * Query-path: collect all attempt rows for staff, return the one with the
 * maximum locked_until (worst-case fail-safe — if any row says locked, treat
 * as locked). Cannot delete duplicates from a query.
 */
async function getAttemptForQuery(
  ctx: QueryCtx,
  staffId: Id<"staff">,
) {
  const rows = await ctx.db
    .query("pos_auth_attempts")
    .withIndex("by_staff", (q) => q.eq("staff_id", staffId))
    .collect();
  if (rows.length === 0) return null;
  // Pick row with highest locked_until (most restrictive), fallback to most
  // recent last_attempt_at for non-locked rows.
  return rows.reduce((best, row) => {
    const bestLock = best.locked_until ?? 0;
    const rowLock = row.locked_until ?? 0;
    if (rowLock > bestLock) return row;
    if (rowLock === bestLock && row.last_attempt_at > best.last_attempt_at) return row;
    return best;
  });
}

/**
 * Mutation-path: collect all attempt rows for staff, keep the most recent one
 * (highest last_attempt_at), delete any older duplicates in the same tx.
 * Returns the surviving row, or null if none existed.
 */
async function cleanupAndGetAttempt(
  ctx: MutationCtx,
  staffId: Id<"staff">,
) {
  const rows = await ctx.db
    .query("pos_auth_attempts")
    .withIndex("by_staff", (q) => q.eq("staff_id", staffId))
    .collect();
  if (rows.length === 0) return null;
  // Sort descending by last_attempt_at; keep index 0, delete the rest.
  const sorted = rows.slice().sort((a, b) => b.last_attempt_at - a.last_attempt_at);
  for (let i = 1; i < sorted.length; i++) {
    await ctx.db.delete(sorted[i]._id);
  }
  return sorted[0];
}

/**
 * Read the current lock state for a staff member. Called by the loginWithPin
 * action BEFORE argon2Verify so locked users get rejected cheaply.
 */
export const _getLockState_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, args): Promise<{ locked: boolean; seconds_remaining: number; fail_count: number }> => {
    // Fix 3: use collect-based helper, pick worst-case row (max locked_until)
    const attempt = await getAttemptForQuery(ctx, args.staffId);
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
 * state survives.
 *
 * Fix 7: if lockout has expired (locked_until != null && <= now), reset the
 * fail_count to 1 (fresh cycle) instead of incrementing from the stale value.
 *
 * Fix 10: wrapped in withIdempotency using a derived key (${key}:failed) so
 * action retries after a crash don't double-increment.
 *
 * `source` (optional, default "booth_inline") sets the audit row's source — off-booth
 * PIN attempts (a wrong manager PIN on the /approve/:token landing) thread
 * "telegram_approval" so the audit trail factually shows where the attempt happened
 * (ADR-035 amendment + business rule #10). Without this, a "show me all off-booth
 * manager PIN failures this week" query (filter `source = telegram_approval`) would
 * miss every wrong PIN entered from /approve.
 */
const failedAttemptSourceValidator = v.union(
  v.literal("booth_inline"),
  v.literal("telegram_approval"),
);

export const _recordFailedAttempt_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    staffId: v.id("staff"),
    deviceId: v.string(),
    source: v.optional(failedAttemptSourceValidator),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      staffId: Id<"staff">;
      deviceId: string;
      source?: "booth_inline" | "telegram_approval";
    },
    { newly_locked: boolean; seconds_remaining: number }
  >(
    "auth._recordFailedAttempt",
    async (ctx, args) => {
      const now = Date.now();
      const source = args.source ?? "booth_inline";
      // Fix 3: use mutation-path helper that dedupes concurrent duplicate rows
      const attempt = await cleanupAndGetAttempt(ctx, args.staffId);

      // Fix 7: if the lockout period has already expired, start a fresh cycle
      const lockExpired =
        attempt?.locked_until != null && attempt.locked_until <= now;
      const next = lockExpired ? 1 : (attempt?.fail_count ?? 0) + 1;

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
        source, device_id: args.deviceId,
      });
      if (lock) {
        await logAudit(ctx, {
          actor_id: args.staffId, action: "staff.locked_out",
          entity_type: "staff", entity_id: args.staffId,
          source, device_id: args.deviceId,
          reason: `${MAX_FAILS} consecutive failures`,
        });
        // Task 18: on the newly-locked transition only (lock != null this call),
        // fire the off-booth PIN-reset notification. `next` is computed fresh each
        // call (Fix 7 resets on expired lockout), so this branch is reached exactly
        // when the account first locks in the current cycle — not on every probe.
        await ctx.scheduler.runAfter(0, internal.approvals.actions.notifyStaffLockout, {
          staffId: args.staffId,
        });
      }
      return {
        newly_locked: lock != null,
        seconds_remaining: lock ? Math.ceil((lock - now) / 1000) : 0,
      };
    },
  ),
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

      // Fix 3: use mutation-path helper to clear and dedupe attempt rows
      const attempt = await cleanupAndGetAttempt(ctx, args.staffId);
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

/**
 * Fix 14: Emit a staff.locked_out audit row when a locked user probes the
 * login endpoint. Called from loginWithPin (action) after lock-state check.
 * Separate from the lockout audit emitted when the lock was first set, so
 * repeated probes are always visible in the audit log.
 */
export const _auditLockProbe_internal = internalMutation({
  args: { staffId: v.id("staff"), deviceId: v.string(), seconds_remaining: v.number() },
  handler: async (ctx, args) => {
    await logAudit(ctx, {
      actor_id: args.staffId, action: "staff.locked_out",
      entity_type: "staff", entity_id: args.staffId,
      source: "booth_inline", device_id: args.deviceId,
      reason: `probe during lockout (${args.seconds_remaining}s remaining)`,
    });
  },
});

/**
 * Resolve an active session to its staff + device. Exposed so other modules
 * (e.g. transactions) can authorise a sessionId without reading the auth-owned
 * staff_sessions table directly (ADR-034 module boundary).
 *
 * Returns null when:
 *   - the session does not exist
 *   - the session has ended (Locked)
 *   - the underlying staff record is missing or inactive (matches
 *     requireSession() semantics in auth/sessions.ts so cross-module callers
 *     get the same authorisation surface as in-module callers — closes the
 *     v0.5.0 parity gap fixed in v0.5.1)
 */
export const _resolveSession_internal = internalQuery({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (
    ctx,
    args,
  ): Promise<{ staffId: Id<"staff">; deviceId: string } | null> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.ended_at != null) return null;
    const staff = await ctx.db.get(session.staff_id);
    if (!staff || !staff.active) return null;
    return { staffId: session.staff_id, deviceId: session.device_id };
  },
});

/**
 * Like _resolveSession_internal but also includes the staff role. Non-throwing —
 * returns null on missing / ended session, missing / inactive staff. Used by
 * v0.5.3a reporting queries to fork manager-vs-staff behaviour without raising
 * (queries return [] / null instead of throwing).
 *
 * Prefer this over _resolveSession_internal when the caller needs to fork on
 * role (e.g. manager sees any day, staff sees server-today only). Use
 * _resolveSession_internal for everything else to avoid unnecessary coupling
 * to the role field.
 */
export const _resolveSessionRole_internal = internalQuery({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (
    ctx,
    args,
  ): Promise<{ staffId: Id<"staff">; deviceId: string; role: "staff" | "manager" } | null> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.ended_at != null) return null;
    const staff = await ctx.db.get(session.staff_id);
    if (!staff || !staff.active) return null;
    return { staffId: session.staff_id, deviceId: session.device_id, role: staff.role };
  },
});

const changePinActorValidator = v.union(
  v.object({ kind: v.literal("self") }),
  v.object({ kind: v.literal("manager_reset"), mgr_approver_id: v.id("staff") }),
);

// Audit `source` union (mirrors audit/internal.ts sourceValidator). Off-booth
// callers (e.g. approvals.approveStaffPinReset via Telegram) override this so the
// staff.pin_reset row records where the action actually originated.
// v0.4 (Task 21): "telegram_approval" added — the shipped off-booth path always
// delivers via Telegram, so the action layer threads that literal end-to-end.
// "wa_approval" retained for backward compatibility on existing rows.
const changePinSourceValidator = v.union(
  v.literal("booth_inline"),
  v.literal("wa_approval"),
  v.literal("telegram_approval"),
  v.literal("system"),
  v.literal("reaper"),
);

/**
 * Single funnel for PIN updates from all three v0.3 paths:
 *   1. auth.actions.changePin (self)
 *   2. auth.actions.resetStaffPin (manager at booth)
 *   3. approvals.actions.approveStaffPinReset (manager off-booth via Telegram)
 *
 * Branches on actor.kind:
 *   - "self": logs staff.pin_changed, actor_id = staffId
 *   - "manager_reset": logs staff.pin_reset, actor_id = mgr_approver_id, AND
 *     clears pos_auth_attempts (lockout unwind).
 *
 * `source` (optional) sets the audit origin on the manager_reset row. Defaults to
 * "booth_inline" (manager at the booth). The off-booth path passes
 * "telegram_approval" (v0.4+; the legacy "wa_approval" literal remains in the
 * validator for backward-compatible rows but no production caller emits it).
 * The self branch is always at-booth in v0.3, so it stays "booth_inline".
 *
 * Never logs PIN values — payload has no PIN fields. Not withIdempotency-wrapped:
 * callers wrap their own public mutation/action with their idempotency key.
 */
export const _changePinCommit_internal = internalMutation({
  args: {
    staffId: v.id("staff"),
    newPinHash: v.string(),
    actor: changePinActorValidator,
    source: v.optional(changePinSourceValidator),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.staffId, { pin_hash: args.newPinHash });

    if (args.actor.kind === "manager_reset") {
      const attempts = await ctx.db
        .query("pos_auth_attempts")
        .withIndex("by_staff", (q) => q.eq("staff_id", args.staffId))
        .collect();
      for (const a of attempts) {
        await ctx.db.patch(a._id, { fail_count: 0, locked_until: null, last_attempt_at: Date.now() });
      }
      await logAudit(ctx, {
        actor_id: args.actor.mgr_approver_id,
        mgr_approver_id: args.actor.mgr_approver_id,
        action: "staff.pin_reset",
        entity_type: "staff", entity_id: args.staffId,
        source: args.source ?? "booth_inline",
      });
    } else {
      await logAudit(ctx, {
        actor_id: args.staffId,
        action: "staff.pin_changed",
        entity_type: "staff", entity_id: args.staffId,
        source: "booth_inline",
      });
    }
  },
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

/**
 * Action-callable wrapper for `requireManagerSession`. Actions cannot read
 * `ctx.db` directly, so callers (e.g. telegram.chatRegistry.mgrSendTest) reach
 * the session gate via `ctx.runQuery(internal.auth.internal._requireManagerSession_internal, ...)`.
 * Throws `MANAGER_ONLY` / `NO_SESSION` per requireManagerSession.
 */
export const _requireManagerSession_internal = internalQuery({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (
    ctx,
    args,
  ): Promise<{ staffId: Id<"staff">; deviceId: string }> => {
    return await requireManagerSession(ctx, args.sessionId);
  },
});

/**
 * List active managers (with codes) for the /approve manager-identity picker.
 * Lives here per ADR-034 — approvals does not read the `staff` table directly.
 *
 * Uses the `by_role` index to bound the scan to manager rows only. `active`
 * + `code` filtering happens in JS (low-cardinality post-index narrowing —
 * the role index brings the candidate set down to the manager-only subset).
 */
export const _listActiveManagers_internal = internalQuery({
  args: {},
  // I2: return code+name only — per ADR-034 §Stable string identifiers, the
  // external surface uses staff_code not Convex _id. manuallyConfirmPayment
  // consumes the code; _id was never used by any consumer.
  handler: async (
    ctx,
  ): Promise<Array<{ name: string; code: string }>> => {
    const managers = await ctx.db
      .query("staff")
      .withIndex("by_role", (q) => q.eq("role", "manager"))
      .collect();
    return managers
      .filter((s) => s.active && s.code)
      .map((s) => ({ name: s.name, code: s.code ?? "" }))
      .filter((m) => m.code !== "")
      .sort((a, b) => a.code.localeCompare(b.code));
  },
});
