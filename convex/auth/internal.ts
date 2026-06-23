import { internalQuery, internalMutation, QueryCtx, MutationCtx } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { withIdempotency } from "../idempotency/internal";
import { logAudit } from "../audit/internal";
import { requireManagerSession, resolveDeviceOutletId } from "./sessions";

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
    role: "staff" | "manager" | "owner";
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
    role: "staff" | "manager" | "owner";
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
 * SEC-01: this counter is NO LONGER withIdempotency-wrapped. The old "Fix 10"
 * derived-key wrap (${idempotencyKey}:failed) let an attacker reuse one client
 * key to freeze fail_count at 1, defeating lockout entirely. The counter is now
 * keyed solely on staff_id; over-counting on a genuine crash-retry is fail-SAFE
 * (a legit user briefly waits out a 60s lockout — far better than an unbounded
 * brute-force window).
 *
 * SEC-07: `countTowardLockout` gates whether a miss touches the booth lockout
 * counter. Off-booth Telegram approve misses pass `false` — they are AUDITED
 * (rule #10 trail) but must NOT lock the booth login, else a leaked approval
 * token lets an attacker DoS-lock a manager. Brute force on that path is bounded
 * by the per-token cap (_recordTokenPinFailure_internal, 5).
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
    staffId: v.id("staff"),
    deviceId: v.string(),
    // SEC-01: replaces the old idempotencyKey-derived withIdempotency wrap.
    countTowardLockout: v.boolean(),
    source: v.optional(failedAttemptSourceValidator),
  },
  handler: async (ctx, args): Promise<{ newly_locked: boolean; seconds_remaining: number }> => {
    const now = Date.now();
    const source = args.source ?? "booth_inline";

    // SEC-07: off-booth approve misses are AUDITED but never touch the booth
    // lockout counter (a leaked token would otherwise DoS-lock a manager).
    if (!args.countTowardLockout) {
      await logAudit(ctx, {
        actor_id: args.staffId, action: "staff.failed_pin",
        entity_type: "staff", entity_id: args.staffId, source, device_id: args.deviceId,
      });
      return { newly_locked: false, seconds_remaining: 0 };
    }

    // Fix 3: use mutation-path helper that dedupes concurrent duplicate rows
    const attempt = await cleanupAndGetAttempt(ctx, args.staffId);

    // Fix 7: if the lockout period has already expired, start a fresh cycle
    const lockExpired = attempt?.locked_until != null && attempt.locked_until <= now;
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
    { sessionId: Id<"staff_sessions">; role: "staff" | "manager" | "owner" }
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

      // v2.0 Task 12 (ENFORCE): resolve outlet from the device binding —
      // resolveDeviceOutletId now throws DEVICE_HAS_NO_OUTLET on an unbound
      // device (the migration-window default fallback is gone).
      const outletId = await resolveDeviceOutletId(ctx, args.deviceId);

      // v2.0 Task 12 (ENFORCE): a staff member must have a staff_outlet_access
      // row for this outlet before a session is minted. Mirrors
      // _assertStaffHasOutletAccess_internal (inlined: this is a mutation, which
      // cannot runQuery). Manager takeover BYPASSES this (escape hatch).
      const access = await ctx.db
        .query("staff_outlet_access")
        .withIndex("by_staff_outlet", (q) =>
          q.eq("staff_id", args.staffId).eq("outlet_id", outletId),
        )
        .first();
      if (!access) throw new Error("NO_OUTLET_ACCESS");

      const sessionId = await ctx.db.insert("staff_sessions", {
        staff_id: args.staffId,
        device_id: args.deviceId,
        started_at: now,
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      });
      await ctx.db.patch(args.staffId, { last_login_at: now });
      await logAudit(ctx, {
        actor_id: args.staffId, action: "staff.login",
        entity_type: "staff_session", entity_id: sessionId,
        source: "booth_inline", device_id: args.deviceId,
        metadata: { outlet_id: outletId },
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
  ): Promise<{ staffId: Id<"staff">; deviceId: string; outlet_id: Id<"outlets"> } | null> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.ended_at != null) return null;
    const staff = await ctx.db.get(session.staff_id);
    if (!staff || !staff.active) return null;
    // v2.0 owner-auth (C5): a cockpit session must never resolve a booth identity.
    // Reject BEFORE the outlet check so the error is the clear NOT_BOOTH_SESSION,
    // not the misleading SESSION_NO_OUTLET (cockpit sessions are outlet-less by design).
    if ((session.kind ?? "booth") !== "booth") throw new Error("NOT_BOOTH_SESSION");
    // v2.0 Task 12 (ENFORCE): mirror requireSession — every live booth session is
    // backfill-stamped, so an absent outlet is a hard throw.
    if (!session.outlet_id) throw new Error("SESSION_NO_OUTLET");
    return { staffId: session.staff_id, deviceId: session.device_id, outlet_id: session.outlet_id as Id<"outlets"> };
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
  ): Promise<{
    staffId: Id<"staff">;
    deviceId: string;
    role: "staff" | "manager" | "owner";
    outlet_id: Id<"outlets">;
  } | null> => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.ended_at != null) return null;
    const staff = await ctx.db.get(session.staff_id);
    if (!staff || !staff.active) return null;
    // v2.0 owner-auth (C5): a cockpit session must never resolve a booth identity.
    // Reject BEFORE the outlet check so the error is the clear NOT_BOOTH_SESSION,
    // not the misleading SESSION_NO_OUTLET (cockpit sessions are outlet-less by design).
    if ((session.kind ?? "booth") !== "booth") throw new Error("NOT_BOOTH_SESSION");
    // v2.0 Task 12 (ENFORCE): every live booth session is backfill-stamped. Absent ⇒ throw.
    if (!session.outlet_id) throw new Error("SESSION_NO_OUTLET");
    return { staffId: session.staff_id, deviceId: session.device_id, role: staff.role, outlet_id: session.outlet_id as Id<"outlets"> };
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
    // SEC-03: any successful PIN change clears the forced-rotation flag (the
    // single commit funnel for self / manager_reset / approval paths — rule #18).
    await ctx.db.patch(args.staffId, { pin_hash: args.newPinHash, must_change_pin: false });

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
    // Allocate next S-NNNN using the same OCC-safe collect-and-reduce pattern
    // as _createStaffCommit_internal (seed path must also assign a stable code).
    const all = await ctx.db.query("staff").collect();
    const maxN = all.reduce((m, s) => {
      const n = s.code?.match(/^S-(\d{4})$/)?.[1];
      return n ? Math.max(m, parseInt(n, 10)) : m;
    }, 0);
    const code = `S-${String(maxN + 1).padStart(4, "0")}`;
    return await ctx.db.insert("staff", {
      name: args.name,
      pin_hash: args.pin_hash,
      role: args.role,
      active: true,
      created_at: Date.now(),
      code,
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
  ): Promise<{ staffId: Id<"staff">; deviceId: string; outlet_id: Id<"outlets"> }> => {
    return await requireManagerSession(ctx, args.sessionId);
  },
});

/**
 * Return all staff (active + inactive) projected to { _id, name } for callers
 * that need to label entities by staff. Used by v0.5.3a transactions._fetchDayWindow_internal
 * to map staff_id → display name without per-row N+1 lookups. Includes inactive
 * staff so historical txns by a now-deactivated staff member still get a name.
 */
export const _listStaffNames_internal = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ _id: Id<"staff">; name: string }>> => {
    const rows = await ctx.db.query("staff").collect();
    return rows.map((s) => ({ _id: s._id, name: s.name }));
  },
});

/**
 * Return all staff (active + inactive) projected to { _id, code } for the
 * Public API transactions feed. `_listStaffNames_internal` returns { _id, name }
 * with NO `code` — a separate internal is needed per ADR-034 (transactions reads
 * staff via an auth internal, never direct ctx.db).
 *
 * `code` is required post-Task 3 (staff.code: v.string()), so no ?? fallback
 * is needed. Includes inactive staff so historical txns still resolve.
 */
export const _listStaffCodes_internal = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ _id: Id<"staff">; code: string }>> => {
    const rows = await ctx.db.query("staff").collect();
    return rows.map((s) => ({ _id: s._id, code: s.code }));
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

/**
 * End a single staff_sessions row (shift lifecycle session-end). Called by
 * shifts.public lifecycle mutations (signoff / handover-out / lock) to cross the
 * ADR-034 module boundary — `staff_sessions` is owned by auth; shifts must not
 * patch it directly. Mirrors the patch shape used by _managerTakeoverSession_internal
 * (`ended_at` + `end_reason`).
 *
 * `endReason` is constrained to the two literals the shift flow uses:
 *   - "force_logout" — end-of-day sign-off + handover-out (the staff is done /
 *     handed over; PLAN-mandated value).
 *   - "manual_lock"  — lockShift (staff steps away; PLAN-mandated value).
 *
 * No withIdempotency wrapper — the calling public mutation owns the idempotency
 * key; this is a single deterministic patch.
 */
export const _endShiftSession_internal = internalMutation({
  args: {
    sessionId: v.id("staff_sessions"),
    endReason: v.union(v.literal("manual_lock"), v.literal("force_logout")),
  },
  handler: async (ctx, args): Promise<void> => {
    await ctx.db.patch(args.sessionId, {
      ended_at: Date.now(),
      end_reason: args.endReason,
    });
  },
});

/**
 * Force-end all active sessions on a device and create a new manager session.
 * Called by shifts._commitManagerTakeover_internal to cross the ADR-034 module
 * boundary — `staff_sessions` is owned by auth; shifts must not access it directly.
 *
 * Steps:
 *   1. Query by_device_active for ended_at = null; patch each with force_logout.
 *   2. Capture the first displaced staff_id (for Task 9 Founders summary).
 *   3. Insert the new manager session (mirrors _loginCommit_internal shape).
 *   4. Patch last_login_at on the manager + emit staff.login audit row for parity.
 *
 * No withIdempotency wrapper — this is called from within the already-idempotent
 * _commitManagerTakeover_internal; nesting would require a separate key derivation.
 *
 * Returns { sessionId, displacedStaffId }.
 */
export const _managerTakeoverSession_internal = internalMutation({
  args: {
    deviceId: v.string(),
    managerStaffId: v.id("staff"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ sessionId: Id<"staff_sessions">; displacedStaffId: Id<"staff"> | null }> => {
    const now = Date.now();

    // Step 1: Resolve outlet from device binding (window-tolerant, mirrors _loginCommit_internal).
    // Must come BEFORE the session query so we can use by_outlet_device_active.
    // No throw/access-assert — deferred to Task 12 (lives in resolveDeviceOutletId).
    const outletId = await resolveDeviceOutletId(ctx, args.deviceId);

    // Step 2: Force-end all active sessions for the device.
    // Convex optional-field filter gotcha: ended_at is v.union(number, null) —
    // collect via index then check in JS (by_outlet_device_active narrows on outlet+device).
    // v2.0 Task 9: always use outlet-scoped index (window-tolerant: outletId may be undefined).
    const activeSessions = await ctx.db
      .query("staff_sessions")
      .withIndex("by_outlet_device_active", (q) =>
        q.eq("outlet_id", outletId).eq("device_id", args.deviceId).eq("ended_at", null),
      )
      .collect();
    const displacedStaffId: Id<"staff"> | null = activeSessions[0]?.staff_id ?? null;
    for (const sess of activeSessions) {
      await ctx.db.patch(sess._id, { ended_at: now, end_reason: "force_logout" });
    }

    // Step 3: Create new manager session (mirrors _loginCommit_internal shape).
    const sessionId: Id<"staff_sessions"> = await ctx.db.insert("staff_sessions", {
      staff_id: args.managerStaffId,
      device_id: args.deviceId,
      started_at: now,
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    });

    // Step 4: Record last_login_at + staff.login audit (parity with _loginCommit_internal).
    await ctx.db.patch(args.managerStaffId, { last_login_at: now });
    await logAudit(ctx, {
      actor_id: args.managerStaffId,
      action: "staff.login",
      entity_type: "staff_session",
      entity_id: sessionId,
      source: "booth_inline",
      device_id: args.deviceId,
      metadata: { outlet_id: outletId }, // parity with _loginCommit_internal (audit outlet context where a session exists)
    });

    return { sessionId, displacedStaffId };
  },
});

/**
 * Resolve the outlet bound to a device (window-tolerant).
 *
 * v2.0 Stream 5 helper for cross-module callers (e.g. shifts) that need the
 * device's outlet_id without crossing ADR-034 module boundaries. v2.0 Task 12
 * (ENFORCE): throws DEVICE_HAS_NO_OUTLET on an unbound device (via
 * resolveDeviceOutletId) — the default fallback is gone.
 *
 * auth owns `registered_devices` and `outlets` (Decision 3), so this lives here.
 */
export const _getDeviceOutletId_internal = internalQuery({
  args: { deviceId: v.string() },
  handler: async (
    ctx,
    { deviceId },
  ): Promise<import("../_generated/dataModel").Id<"outlets">> =>
    resolveDeviceOutletId(ctx, deviceId),
});

// ---------------------------------------------------------------------------
// v2.0 Task 6: staff_outlet_access read helpers
// auth owns the staff_outlet_access table (Decision 3) so these live here.
// ---------------------------------------------------------------------------

/**
 * List all active staff with an access row for a given outlet.
 * Uses the by_outlet index to bound the scan, then fetches each staff doc
 * and filters to active only. Inactive staff with a row are skipped — their
 * access row is not deleted on deactivation (cheap, auditable, reversible).
 */
export const _listStaffForOutlet_internal = internalQuery({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }) => {
    const access = await ctx.db
      .query("staff_outlet_access")
      .withIndex("by_outlet", (q) => q.eq("outlet_id", outletId))
      .collect();
    const staff = await Promise.all(access.map((a) => ctx.db.get(a.staff_id)));
    return staff.filter((s): s is NonNullable<typeof s> => !!s && s.active);
  },
});

/**
 * Assert that a staff member has a `staff_outlet_access` row for the given outlet.
 * Throws `NO_OUTLET_ACCESS` if no row is found — callers gate multi-outlet
 * operations on this check so an unassigned staff member cannot act on an outlet.
 */
export const _assertStaffHasOutletAccess_internal = internalQuery({
  args: { staffId: v.id("staff"), outletId: v.id("outlets") },
  handler: async (ctx, { staffId, outletId }) => {
    const row = await ctx.db
      .query("staff_outlet_access")
      .withIndex("by_staff_outlet", (q) => q.eq("staff_id", staffId).eq("outlet_id", outletId))
      .first();
    if (!row) throw new Error("NO_OUTLET_ACCESS");
    return true;
  },
});

/**
 * Grant a staff member access to an outlet. Idempotent — if a row for the
 * (staff_id, outlet_id) pair already exists, it is returned unchanged (no
 * duplicate insert). Logs `staff.grantOutletAccess` for audit.
 *
 * Called by staff.actions.grantOutletAccess (manager-PIN action).
 */
export const _grantOutletAccess_internal = internalMutation({
  args: {
    staffId: v.id("staff"),
    outletId: v.id("outlets"),
    grantedBy: v.id("staff"),
    deviceId: v.string(),
  },
  handler: async (ctx, args): Promise<{ accessId: Id<"staff_outlet_access">; created: boolean }> => {
    // Idempotent: check if a row already exists before inserting.
    const existing = await ctx.db
      .query("staff_outlet_access")
      .withIndex("by_staff_outlet", (q) =>
        q.eq("staff_id", args.staffId).eq("outlet_id", args.outletId),
      )
      .first();
    if (existing) {
      return { accessId: existing._id, created: false };
    }
    const accessId = await ctx.db.insert("staff_outlet_access", {
      staff_id: args.staffId,
      outlet_id: args.outletId,
      granted_at: Date.now(),
      granted_by: args.grantedBy,
    });
    await logAudit(ctx, {
      actor_id: args.grantedBy,
      action: "staff.grantOutletAccess",
      entity_type: "staff",
      entity_id: args.staffId,
      source: "booth_inline",
      device_id: args.deviceId,
      metadata: { outlet_id: args.outletId },
    });
    return { accessId, created: true };
  },
});

/**
 * Revoke a staff member's access to an outlet. Idempotent — if no row exists,
 * no-ops silently. Logs `staff.revokeOutletAccess` only when a row is deleted.
 *
 * Called by staff.actions.revokeOutletAccess (manager-PIN action).
 */
export const _revokeOutletAccess_internal = internalMutation({
  args: {
    staffId: v.id("staff"),
    outletId: v.id("outlets"),
    revokedBy: v.id("staff"),
    deviceId: v.string(),
  },
  handler: async (ctx, args): Promise<{ deleted: boolean }> => {
    const existing = await ctx.db
      .query("staff_outlet_access")
      .withIndex("by_staff_outlet", (q) =>
        q.eq("staff_id", args.staffId).eq("outlet_id", args.outletId),
      )
      .first();
    if (!existing) {
      return { deleted: false };
    }
    await ctx.db.delete(existing._id);
    await logAudit(ctx, {
      actor_id: args.revokedBy,
      action: "staff.revokeOutletAccess",
      entity_type: "staff",
      entity_id: args.staffId,
      source: "booth_inline",
      device_id: args.deviceId,
      metadata: { outlet_id: args.outletId },
    });
    return { deleted: true };
  },
});

/**
 * Nightly housekeeping for owner-auth tables. Deletes:
 *   - `owner_auth_otp` rows where `expires_at < now` OR `consumed_at != null`
 *   - `owner_auth_bindings` rows where `expires_at < now` OR `redeemed_at != null`
 *
 * Uses the `by_expires` index for the expired-row scan to bound the number of
 * reads. Consumed/redeemed rows without an expired TTL are caught by a full
 * collect + JS filter (low-cardinality in practice — they are normally expired
 * before the next cron fires; the JS pass is a safety net). Mirrors the pattern
 * of `api/v1/internal._purgeApiHousekeeping_internal`.
 *
 * Registered in crons.ts as "owner-auth-housekeeping" at 20:10 UTC / 03:10 WIB.
 */
export const _purgeOwnerAuthHousekeeping_internal = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const now = Date.now();

    // ── owner_auth_otp ────────────────────────────────────────────────────────
    // Pass 1: expired rows via index (cheap — bounded by by_expires).
    const expiredOtps = await ctx.db
      .query("owner_auth_otp")
      .withIndex("by_expires", (q) => q.lt("expires_at", now))
      .collect();
    for (const row of expiredOtps) {
      await ctx.db.delete(row._id);
    }
    // Pass 2: consumed rows not yet expired (safety net; collect full table
    // post-pass-1 so we only touch what remains).
    const remainingOtps = await ctx.db.query("owner_auth_otp").collect();
    for (const row of remainingOtps) {
      if (row.consumed_at !== null) {
        await ctx.db.delete(row._id);
      }
    }

    // ── owner_auth_bindings ───────────────────────────────────────────────────
    // Pass 1: expired rows via index.
    const expiredBindings = await ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_expires", (q) => q.lt("expires_at", now))
      .collect();
    for (const row of expiredBindings) {
      await ctx.db.delete(row._id);
    }
    // Pass 2: redeemed rows not yet expired.
    const remainingBindings = await ctx.db.query("owner_auth_bindings").collect();
    for (const row of remainingBindings) {
      if (row.redeemed_at !== null) {
        await ctx.db.delete(row._id);
      }
    }
  },
});
