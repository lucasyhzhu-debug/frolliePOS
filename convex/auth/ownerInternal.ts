// convex/auth/ownerInternal.ts
//
// Owner-auth (cockpit) internal queries/mutations — the V8-safe (non-"use node")
// half of the owner auth plane (ADR-052, "OTP authorises MANAGE"). Actions that
// need argon2 / external calls live in ownerActions.ts ("use node") and call
// through these. This module owns the `owner_auth_bindings` read/redeem path for
// the one-time Telegram `/start <token>` binding (WS2).
//
// High-entropy bind tokens are hashed with the V8-safe async sha256Hex
// (convex/lib/sha256.ts) at the call site; this module only ever sees the hash
// and looks up by exact `token_hash` (by_token_hash). Audit source is "system"
// (bot-mediated) — NOT "telegram_approval" (reserved for PIN approval flows).

import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { logAudit } from "../audit/internal";
import { requireCockpitSession } from "./sessions";
import { withIdempotency } from "../idempotency/internal";

// ── OTP throttle / TTL constants (SEC-07) ────────────────────────────────────
// OTP rate-limit and failure counters live ENTIRELY in owner_auth_attempts /
// owner_auth_otp. They MUST NEVER read or write pos_auth_attempts — a leaked or
// abused OTP path must not be able to DoS-lock booth PIN logins (SEC-07).
const OTP_TTL_MS = 5 * 60_000; // 5-minute OTP validity
const OTP_FAIL_CAP = 5; // 5 wrong codes consume the challenge
const OTP_RATE_WINDOW_MS = 15 * 60_000; // rolling 15-minute request window
const OTP_RATE_MAX = 3; // 3 requests per window; 4th → OTP_COOLDOWN

// ── Remembered-device quick-PIN constants (WS5, SEC-07) ───────────────────────
// The quick-PIN failure counter lives ENTIRELY on the owner_auth_bindings row
// (quick_pin_fail_count / quick_pin_locked_until). It MUST NEVER touch
// pos_auth_attempts (booth) or owner_auth_attempts (OTP request throttle) — the
// three lockout planes are fully isolated so no path can DoS-lock another.
const REMEMBER_TTL_MS = 30 * 864e5; // 30-day remembered-device validity
const QUICK_PIN_FAIL_CAP = 3; // 3 wrong quick-PINs → lockout
const QUICK_PIN_LOCKOUT_MS = 60_000; // 60-second lockout

/**
 * Resolve a bind/remember binding row by its exact token_hash. Non-throwing —
 * returns null when no binding matches. Read-only; callers enforce validity.
 */
export const _lookupBinding_internal = internalQuery({
  args: { tokenHash: v.string() },
  handler: (ctx, { tokenHash }) =>
    ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .first(),
});

/**
 * Redeem a one-time Telegram bind token: bind the owner's private Telegram chat
 * to their staff row by writing `staff.telegram_user_id`. Single-use.
 *
 * Guards (in order):
 *  - BIND_PRIVATE_ONLY: redeem MUST be from a private DM — an OTP must never be
 *    deliverable to a group chat (the bound chat is the future OTP target).
 *  - BIND_INVALID: token unknown / wrong kind / already redeemed / expired.
 *  - TELEGRAM_ALREADY_BOUND: this Telegram user is already bound to a DIFFERENT
 *    staff row (one Telegram account → one staff identity).
 *
 * On success: mark the binding redeemed, stamp `staff.telegram_user_id`, audit
 * `owner.telegram_bound` (source "system"). Server time wins (ADR-031).
 */
export const _redeemBinding_internal = internalMutation({
  args: { tokenHash: v.string(), fromId: v.number(), chatType: v.string() },
  handler: async (ctx, { tokenHash, fromId, chatType }) => {
    // Private-DM only — the bound chat becomes the OTP delivery target (SEC).
    if (chatType !== "private") throw new Error("BIND_PRIVATE_ONLY");

    const now = Date.now();
    const b = await ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .first();
    if (
      !b ||
      b.kind !== "telegram_bind" ||
      b.redeemed_at != null ||
      b.expires_at < now
    ) {
      throw new Error("BIND_INVALID");
    }

    // One Telegram account ⇒ one staff identity. Re-binding the SAME staff is a
    // no-op-safe idempotent redeem; a DIFFERENT staff is a hard conflict.
    const dup = await ctx.db
      .query("staff")
      .withIndex("by_telegram_user_id", (q) => q.eq("telegram_user_id", fromId))
      .first();
    if (dup && dup._id !== b.staff_id) throw new Error("TELEGRAM_ALREADY_BOUND");

    await ctx.db.patch(b._id, { redeemed_at: now });
    await ctx.db.patch(b.staff_id, { telegram_user_id: fromId });
    await logAudit(ctx, {
      actor_id: b.staff_id,
      action: "owner.telegram_bound",
      entity_type: "staff",
      entity_id: b.staff_id,
      source: "system",
    });
    return { staff_id: b.staff_id };
  },
});

/**
 * Insert a fresh telegram_bind binding (called by the issuance action, which has
 * already minted the raw token and hashed it). Server-minted token only — the
 * action passes the pre-computed sha256 hash; this mutation never sees the raw.
 */
export const _createBindLink_internal = internalMutation({
  args: {
    staffId: v.id("staff"),
    tokenHash: v.string(),
    expiresAt: v.number(),
    actorId: v.union(v.id("staff"), v.literal("system")),
  },
  handler: async (ctx, { staffId, tokenHash, expiresAt, actorId }) => {
    const bindingId = await ctx.db.insert("owner_auth_bindings", {
      kind: "telegram_bind",
      staff_id: staffId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      redeemed_at: null,
      created_at: Date.now(),
    });
    await logAudit(ctx, {
      actor_id: actorId,
      action: "owner.bind_link_issued",
      entity_type: "staff",
      entity_id: staffId,
      source: "system",
    });
    return { bindingId };
  },
});

/**
 * Action-context cockpit-session assert. Owner-cockpit-gated issuance uses this
 * as its authCheck (cannot import requireCockpitSession into a "use node" action
 * directly — that's a pure helper bound to QueryCtx; run it through a query).
 * Throws on a non-cockpit / non-owner / idle-timed-out session.
 */
export const _assertCockpitSession_internal = internalQuery({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, { sessionId }) => {
    const { staffId } = await requireCockpitSession(ctx, sessionId);
    return { staffId };
  },
});

// ── OTP login plane (WS3) ────────────────────────────────────────────────────

/**
 * Resolve a login identifier (staff `code`) to an OTP-eligible owner. Leak-free:
 * returns null unless the row is role==="owner" && active && telegram_user_id
 * is bound. requestOwnerOtp returns a generic { ok: true } on null (no
 * enumeration); verifyOwnerOtp throws a generic OTP_INVALID on null.
 */
export const _getOwnerByIdentifier_internal = internalQuery({
  args: { identifier: v.string() },
  handler: async (
    ctx,
    { identifier },
  ): Promise<{ staffId: Id<"staff">; telegram_user_id: number } | null> => {
    const s = await ctx.db
      .query("staff")
      .withIndex("by_code", (q) => q.eq("code", identifier))
      .first();
    if (!s || s.role !== "owner" || !s.active || s.telegram_user_id == null) {
      return null;
    }
    return { staffId: s._id, telegram_user_id: s.telegram_user_id };
  },
});

/**
 * Return the bound Telegram user id for an owner so telegram/send.ts never reads
 * the auth-owned `staff` table directly (no-cross-module-db-access, ADR-034).
 * Null when unbound.
 */
export const _getOwnerTelegramTarget_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, { staffId }): Promise<number | null> => {
    const s = await ctx.db.get(staffId);
    return s?.telegram_user_id ?? null;
  },
});

/**
 * Rolling 15-minute OTP-request rate limit (SEC-07). Reads/writes ONLY
 * owner_auth_attempts — never pos_auth_attempts. The 4th request inside a window
 * throws OTP_COOLDOWN:<secs>. The window resets once OTP_RATE_WINDOW_MS elapses
 * since window_start_at.
 */
export const _checkOtpRateLimit_internal = internalMutation({
  args: { staffId: v.id("staff") },
  handler: async (ctx, { staffId }) => {
    const now = Date.now();
    const row = await ctx.db
      .query("owner_auth_attempts")
      .withIndex("by_staff", (q) => q.eq("staff_id", staffId))
      .first();

    if (!row) {
      await ctx.db.insert("owner_auth_attempts", {
        staff_id: staffId,
        request_count: 1,
        window_start_at: now,
        locked_until: null,
      });
      return;
    }

    // Window expired → reset to a fresh single-request window.
    if (now - row.window_start_at >= OTP_RATE_WINDOW_MS) {
      await ctx.db.patch(row._id, {
        request_count: 1,
        window_start_at: now,
        locked_until: null,
      });
      return;
    }

    // Inside the window: 4th+ request is throttled.
    if (row.request_count >= OTP_RATE_MAX) {
      const secs = Math.ceil((row.window_start_at + OTP_RATE_WINDOW_MS - now) / 1000);
      throw new Error(`OTP_COOLDOWN:${secs}`);
    }

    await ctx.db.patch(row._id, { request_count: row.request_count + 1 });
  },
});

/**
 * Create a fresh OTP challenge. Consumes any prior active challenge for this
 * staff (one live OTP at a time), inserts a new owner_auth_otp row with a 5-min
 * TTL, and audits owner.otp_requested (source "system"). The code is hashed by
 * the calling action (argon2id, Node) — this mutation only sees the hash.
 */
export const _createOtpChallenge_internal = internalMutation({
  args: { staffId: v.id("staff"), codeHash: v.string(), deviceId: v.string() },
  handler: async (ctx, { staffId, codeHash, deviceId }) => {
    const now = Date.now();

    // Supersede any active (unconsumed) challenge — only one live OTP per owner.
    const active = await ctx.db
      .query("owner_auth_otp")
      .withIndex("by_staff_active", (q) => q.eq("staff_id", staffId).eq("consumed_at", null))
      .collect();
    for (const c of active) {
      await ctx.db.patch(c._id, { consumed_at: now });
    }

    const challengeId = await ctx.db.insert("owner_auth_otp", {
      staff_id: staffId,
      code_hash: codeHash,
      expires_at: now + OTP_TTL_MS,
      fail_count: 0,
      consumed_at: null,
      created_at: now,
      device_id: deviceId,
    });
    await logAudit(ctx, {
      actor_id: staffId,
      action: "owner.otp_requested",
      entity_type: "owner_auth_otp",
      entity_id: challengeId,
      source: "system",
    });
    return { challengeId };
  },
});

/**
 * Load the single active (unconsumed, unexpired) OTP challenge for an owner so
 * the verify action can argon2-verify its code_hash in the Node runtime. Returns
 * null when none is live (verifyOwnerOtp maps that to a generic OTP_INVALID).
 */
export const _loadActiveOtpChallenge_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (
    ctx,
    { staffId },
  ): Promise<{ challengeId: Id<"owner_auth_otp">; codeHash: string } | null> => {
    const now = Date.now();
    const c = await ctx.db
      .query("owner_auth_otp")
      .withIndex("by_staff_active", (q) => q.eq("staff_id", staffId).eq("consumed_at", null))
      .order("desc")
      .first();
    if (!c || c.expires_at < now || c.fail_count >= OTP_FAIL_CAP) return null;
    return { challengeId: c._id, codeHash: c.code_hash };
  },
});

/**
 * Record a wrong-code attempt against an OTP challenge (SEC-07). Increments
 * fail_count; at OTP_FAIL_CAP the challenge is consumed (consumed_at set). Audits
 * owner.otp_failed. Touches ONLY owner_auth_otp — never pos_auth_attempts, so a
 * brute-forced OTP cannot DoS-lock booth PIN logins.
 */
export const _recordOtpFailure_internal = internalMutation({
  args: { challengeId: v.id("owner_auth_otp") },
  handler: async (ctx, { challengeId }) => {
    const c = await ctx.db.get(challengeId);
    if (!c) return;
    const now = Date.now();
    const nextCount = c.fail_count + 1;
    const consume = nextCount >= OTP_FAIL_CAP;
    await ctx.db.patch(challengeId, {
      fail_count: nextCount,
      ...(consume ? { consumed_at: now } : {}),
    });
    await logAudit(ctx, {
      actor_id: c.staff_id,
      action: "owner.otp_failed",
      entity_type: "owner_auth_otp",
      entity_id: challengeId,
      source: "system",
    });
  },
});

/**
 * Consume an OTP challenge on a successful verify (mark consumed_at). Single-use:
 * a replayed correct code finds no active challenge.
 */
export const _consumeOtpChallenge_internal = internalMutation({
  args: { challengeId: v.id("owner_auth_otp") },
  handler: async (ctx, { challengeId }) => {
    const c = await ctx.db.get(challengeId);
    if (!c || c.consumed_at != null) return;
    await ctx.db.patch(challengeId, { consumed_at: Date.now() });
  },
});

/**
 * Commit a cockpit (owner) login session after the OTP is verified. Mirrors the
 * booth _loginCommit_internal pattern but: kind="cockpit", NO outlet_id (cockpit
 * is the cross-outlet plane, ADR-052), last_active_at anchored for the sliding
 * idle timeout, and audit owner.login (source "system", entity_type
 * "staff_session"). withIdempotency-wrapped — a retry replays the same session.
 */
export const _cockpitLoginCommit_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    staffId: v.id("staff"),
    deviceId: v.string(),
    // WS5: a quick-PIN login passes "quick_pin" so the single owner.login audit
    // writer carries metadata { sub_reason: "quick_pin" }. Absent for OTP logins.
    subReason: v.optional(v.string()),
  },
  handler: withIdempotency<
    { idempotencyKey: string; staffId: Id<"staff">; deviceId: string; subReason?: string },
    { sessionId: Id<"staff_sessions">; role: "owner" }
  >(
    "auth.cockpitLogin",
    async (ctx, args) => {
      const now = Date.now();
      const staff = await ctx.db.get(args.staffId);
      if (!staff || !staff.active || staff.role !== "owner") {
        // Defensive — the action resolved an owner already.
        throw new Error("OTP_INVALID");
      }
      const sessionId = await ctx.db.insert("staff_sessions", {
        staff_id: args.staffId,
        device_id: args.deviceId,
        kind: "cockpit",
        started_at: now,
        last_active_at: now,
        ended_at: null,
        end_reason: null,
        // NO outlet_id — cockpit sessions are outlet-less (ADR-052).
      });
      await ctx.db.patch(args.staffId, { last_login_at: now });
      await logAudit(ctx, {
        actor_id: args.staffId,
        action: "owner.login",
        entity_type: "staff_session",
        entity_id: sessionId,
        source: "system",
        device_id: args.deviceId,
        ...(args.subReason ? { metadata: { sub_reason: args.subReason } } : {}),
      });
      return { sessionId, role: "owner" as const };
    },
    { staffIdFromArgs: (a) => a.staffId },
  ),
});

// ── Remembered-device quick-PIN plane (WS5) ───────────────────────────────────

/**
 * Insert a fresh `remember_device` binding (called by registerRememberedDevice,
 * which has already minted the rememberToken + argon2-hashed the quick-PIN). The
 * action passes the pre-computed sha256 token hash + argon2 PIN hash; this
 * mutation never sees either raw value. 30-day TTL (REMEMBER_TTL_MS), server time
 * (ADR-031). Audits owner.device_remembered (source "system").
 */
export const _createRememberBinding_internal = internalMutation({
  args: {
    staffId: v.id("staff"),
    deviceId: v.string(),
    tokenHash: v.string(),
    quickPinHash: v.string(),
  },
  handler: async (ctx, { staffId, deviceId, tokenHash, quickPinHash }) => {
    const now = Date.now();
    const bindingId = await ctx.db.insert("owner_auth_bindings", {
      kind: "remember_device",
      staff_id: staffId,
      token_hash: tokenHash,
      expires_at: now + REMEMBER_TTL_MS,
      redeemed_at: null,
      created_at: now,
      device_id: deviceId,
      quick_pin_hash: quickPinHash,
      quick_pin_fail_count: 0,
      quick_pin_locked_until: null,
    });
    await logAudit(ctx, {
      actor_id: staffId,
      action: "owner.device_remembered",
      entity_type: "owner_auth_bindings",
      entity_id: bindingId,
      source: "system",
      device_id: deviceId,
    });
    return { bindingId };
  },
});

/**
 * Resolve a `remember_device` binding for a quick-PIN login attempt and run the
 * per-binding lockout PRE-CHECK in one mutation (so the lockout state is read +
 * gated atomically). Looks up by exact token_hash (by_token_hash).
 *
 * Throws (all generic, no oracle):
 *  - REMEMBER_INVALID: unknown token / wrong kind / device_id mismatch / expired.
 *    A wrong device or expired token is indistinguishable from an unknown one.
 *  - LOCKED_OUT:<secs>: this binding is in its 60s quick-PIN lockout window.
 *
 * On success returns the binding id + staff id + the quick_pin_hash so the
 * calling action can argon2Verify it in the Node runtime. Never touches
 * pos_auth_attempts / owner_auth_attempts (SEC-07).
 */
export const _loadRememberBindingForLogin_internal = internalMutation({
  args: { tokenHash: v.string(), deviceId: v.string() },
  handler: async (
    ctx,
    { tokenHash, deviceId },
  ): Promise<{
    bindingId: Id<"owner_auth_bindings">;
    staffId: Id<"staff">;
    quickPinHash: string;
  }> => {
    const now = Date.now();
    const b = await ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .first();
    // Generic REMEMBER_INVALID for every validity failure — no enumeration of
    // which dimension (token / device / expiry) was wrong.
    if (
      !b ||
      b.kind !== "remember_device" ||
      b.device_id !== deviceId ||
      b.expires_at < now ||
      b.quick_pin_hash == null
    ) {
      throw new Error("REMEMBER_INVALID");
    }
    // Per-binding lockout pre-check (SEC-07).
    if (b.quick_pin_locked_until != null && b.quick_pin_locked_until > now) {
      const secs = Math.ceil((b.quick_pin_locked_until - now) / 1000);
      throw new Error(`LOCKED_OUT:${secs}`);
    }
    return { bindingId: b._id, staffId: b.staff_id, quickPinHash: b.quick_pin_hash };
  },
});

/**
 * Record a wrong quick-PIN attempt against a binding (SEC-07). Increments
 * quick_pin_fail_count; at QUICK_PIN_FAIL_CAP sets a 60s quick_pin_locked_until.
 * Touches ONLY owner_auth_bindings — never pos_auth_attempts / owner_auth_attempts,
 * so a brute-forced quick-PIN cannot DoS-lock booth PIN logins or OTP requests.
 * Audits owner.quick_pin_failed.
 */
export const _recordQuickPinFailure_internal = internalMutation({
  args: { bindingId: v.id("owner_auth_bindings") },
  handler: async (ctx, { bindingId }) => {
    const b = await ctx.db.get(bindingId);
    if (!b) return;
    const now = Date.now();
    const nextCount = (b.quick_pin_fail_count ?? 0) + 1;
    const lock = nextCount >= QUICK_PIN_FAIL_CAP;
    await ctx.db.patch(bindingId, {
      quick_pin_fail_count: nextCount,
      ...(lock ? { quick_pin_locked_until: now + QUICK_PIN_LOCKOUT_MS } : {}),
    });
    await logAudit(ctx, {
      actor_id: b.staff_id,
      action: "owner.quick_pin_failed",
      entity_type: "owner_auth_bindings",
      entity_id: bindingId,
      source: "system",
    });
  },
});

/**
 * Clear a binding's quick-PIN failure counter + lockout on a successful login.
 * Touches ONLY owner_auth_bindings (SEC-07).
 */
export const _clearQuickPinFailures_internal = internalMutation({
  args: { bindingId: v.id("owner_auth_bindings") },
  handler: async (ctx, { bindingId }) => {
    const b = await ctx.db.get(bindingId);
    if (!b) return;
    if ((b.quick_pin_fail_count ?? 0) === 0 && b.quick_pin_locked_until == null) return;
    await ctx.db.patch(bindingId, {
      quick_pin_fail_count: 0,
      quick_pin_locked_until: null,
    });
  },
});
