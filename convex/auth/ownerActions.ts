"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal, api } from "../_generated/api";
import { argon2Verify } from "hash-wasm";
import { verifyManagerPinOrThrow } from "./verifyPin";
import { mintUrlSafeToken } from "../lib/tokens";
import { sha256Hex } from "../lib/sha256";
import { withActionCache } from "../idempotency/action";

// OTP validity in minutes, surfaced in the DM copy (mirrors OTP_TTL_MS in
// ownerInternal.ts — keep in sync if that constant changes).
const OTP_EXPIRES_MINUTES = 5;

/** Mint a 6-digit OTP, zero-padded, from a CSPRNG (crypto.getRandomValues). */
function mintOtpCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

/**
 * Issue a one-time Telegram `/start <token>` bind link for an owner (WS2,
 * ADR-052). The link, opened in the owner's PRIVATE Telegram DM, binds that chat
 * to the target staff row (writes staff.telegram_user_id) so future cockpit OTPs
 * can be delivered there.
 *
 * Authorisation is a two-way gate (I1):
 *   - managerPin provided ⇒ manager-PIN funnel (verifyManagerPinOrThrow) — a
 *     booth manager bootstraps the FIRST owner before any cockpit session exists.
 *   - else ⇒ a live owner cockpit session (_assertCockpitSession_internal) — an
 *     owner re-binds / binds a peer once the plane is up.
 *
 * Idempotency (ADR-013/046): withActionCache runs the authCheck BEFORE the cache
 * lookup, then caches the { deepLink } so a replay returns the SAME link without
 * re-minting a token. The bind token is server-minted (mintUrlSafeToken, 32B),
 * hashed with the V8-safe async sha256Hex; only the hash is persisted.
 *
 * 60-minute TTL (mirrors the view-token convention, ADR-029). Audit
 * `owner.bind_link_issued` (source "system") is written by the commit internal.
 *
 * Errors: BIND_AUTH_REQUIRED (neither gate satisfied), INVALID_PIN /
 * MANAGER_SESSION_REQUIRED / NOT_MANAGER / SESSION_INVALID / LOCKED_OUT:<secs>
 * (PIN branch), NO_SESSION / NOT_COCKPIT_SESSION / SESSION_IDLE_TIMEOUT (cockpit
 * branch), TELEGRAM_BOT_USERNAME_MISSING.
 */
const BIND_TOKEN_TTL_MS = 60 * 60 * 1000; // 60 min (ADR-029 view-token convention)

export const issueOwnerTelegramBindLink = action({
  args: {
    idempotencyKey: v.string(),
    targetStaffId: v.id("staff"),
    sessionId: v.optional(v.id("staff_sessions")),
    managerPin: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ deepLink: string }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "auth.issueOwnerTelegramBindLink" },
      // ── authCheck (runs BEFORE the cache lookup, ADR-046) ──
      async () => {
        if (args.managerPin != null) {
          if (!args.sessionId) throw new Error("SESSION_INVALID");
          await verifyManagerPinOrThrow(ctx, {
            sessionId: args.sessionId,
            managerPin: args.managerPin,
            idempotencyKey: args.idempotencyKey,
          });
        } else if (args.sessionId) {
          await ctx.runQuery(internal.auth.ownerInternal._assertCockpitSession_internal, {
            sessionId: args.sessionId,
          });
        } else {
          throw new Error("BIND_AUTH_REQUIRED");
        }
      },
      // ── fn (cache miss only) ──
      async () => {
        const botUsername = process.env.TELEGRAM_BOT_USERNAME;
        if (!botUsername) throw new Error("TELEGRAM_BOT_USERNAME_MISSING");

        const raw = mintUrlSafeToken(32);
        const tokenHash = await sha256Hex(raw);
        await ctx.runMutation(internal.auth.ownerInternal._createBindLink_internal, {
          staffId: args.targetStaffId,
          tokenHash,
          expiresAt: Date.now() + BIND_TOKEN_TTL_MS,
          actorId: "system",
        });
        return { deepLink: `https://t.me/${botUsername}?start=${raw}` };
      },
    ),
});

/**
 * Request a cockpit login OTP (WS3, ADR-052). Unauthenticated by design — this
 * IS the login. Mirrors loginWithPin's action-level idempotency (cache pre-check
 * BEFORE side effects).
 *
 * Flow:
 *   1. Action-level cache pre-check (replay returns the cached generic { ok }).
 *   2. Resolve the identifier to an OTP-eligible owner. Leak-free: a null owner
 *      (unknown / non-owner / unbound) returns a generic { ok: true } — no
 *      enumeration, no challenge minted.
 *   3. Rate-limit (SEC-07, owner_auth_attempts only — never pos_auth_attempts).
 *   4. Mint a 6-digit code (CSPRNG), argon2id-hash it (Node), create the
 *      challenge (5-min TTL, supersedes any prior active one).
 *   5. DM the code to the owner's PRIVATE bound chat via chatIdOverride
 *      (NOT a role broadcast — `role:"owner"` is an audit label only; the bot
 *      never resolves an "owner" group chat). DISTINCT send key `${key}:send`.
 *   6. Cache + return the generic { ok: true }.
 *
 * Errors: OTP_COOLDOWN:<secs> (rate limit). All other failure modes (unknown
 * identifier, send failure) are deliberately opaque to the client.
 */
export const requestOwnerOtp = action({
  args: {
    idempotencyKey: v.string(),
    identifier: v.string(),
    deviceId: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { ok: true };

    const owner = await ctx.runQuery(
      internal.auth.ownerInternal._getOwnerByIdentifier_internal,
      { identifier: args.identifier },
    );

    // Leak-free: a non-owner / unbound identifier looks identical to success.
    if (!owner) return { ok: true };

    // SEC-07: rate limit is isolated to owner_auth_attempts. OTP_COOLDOWN is the
    // ONE non-generic error — a throttled caller needs the cooldown seconds.
    await ctx.runMutation(internal.auth.ownerInternal._checkOtpRateLimit_internal, {
      staffId: owner.staffId,
    });

    const code = mintOtpCode();
    const codeHash: string = await ctx.runAction(internal.auth.actions._hashOtpCode_internal, {
      code,
    });
    await ctx.runMutation(internal.auth.ownerInternal._createOtpChallenge_internal, {
      staffId: owner.staffId,
      codeHash,
      deviceId: args.deviceId,
    });

    // Private DM via chatIdOverride — `role` is an audit label only (the override
    // skips getChatIdByRole). DISTINCT send key (idempotency shared-key hazard).
    await ctx.runAction(api.telegram.send.sendTemplate, {
      role: "owner",
      kind: "owner_otp",
      payload: { code, expires_minutes: OTP_EXPIRES_MINUTES },
      chatIdOverride: String(owner.telegram_user_id),
      idempotencyKey: `${args.idempotencyKey}:send`,
      disableNotification: false,
    });

    const result = { ok: true as const };
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "auth.requestOwnerOtp",
      response: JSON.stringify(result),
    });
    return result;
  },
});

/**
 * Verify a cockpit OTP and mint a cockpit session (WS3, ADR-052). Mirrors
 * loginWithPin: cache pre-check → resolve owner → load active challenge →
 * argon2Verify in the Node runtime → on miss record the failure (SEC-07,
 * owner_auth_otp only) and throw a generic OTP_INVALID → on hit consume the
 * challenge and commit the cockpit session via _cockpitLoginCommit_internal
 * (DISTINCT commit key `${key}:commit`).
 *
 * Every non-success path throws the SAME generic OTP_INVALID (unknown identifier,
 * no live challenge, wrong code) — no enumeration or oracle.
 */
export const verifyOwnerOtp = action({
  args: {
    idempotencyKey: v.string(),
    identifier: v.string(),
    code: v.string(),
    deviceId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ sessionId: Id<"staff_sessions">; role: "owner" }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) {
      return JSON.parse(cached) as { sessionId: Id<"staff_sessions">; role: "owner" };
    }

    const owner = await ctx.runQuery(
      internal.auth.ownerInternal._getOwnerByIdentifier_internal,
      { identifier: args.identifier },
    );
    if (!owner) throw new Error("OTP_INVALID");

    const challenge = await ctx.runQuery(
      internal.auth.ownerInternal._loadActiveOtpChallenge_internal,
      { staffId: owner.staffId },
    );
    if (!challenge) throw new Error("OTP_INVALID");

    const match = await argon2Verify({ password: args.code, hash: challenge.codeHash });
    if (!match) {
      // SEC-07: failure counter lives in owner_auth_otp, never pos_auth_attempts.
      await ctx.runMutation(internal.auth.ownerInternal._recordOtpFailure_internal, {
        challengeId: challenge.challengeId,
      });
      throw new Error("OTP_INVALID");
    }

    // Correct code — single-use: consume the challenge, then mint the session.
    await ctx.runMutation(internal.auth.ownerInternal._consumeOtpChallenge_internal, {
      challengeId: challenge.challengeId,
    });
    const result = await ctx.runMutation(
      internal.auth.ownerInternal._cockpitLoginCommit_internal,
      {
        idempotencyKey: `${args.idempotencyKey}:commit`,
        staffId: owner.staffId,
        deviceId: args.deviceId,
      },
    );

    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "auth.verifyOwnerOtp",
      response: JSON.stringify(result),
    });
    return result;
  },
});

/**
 * Enroll a remembered-device quick-PIN (WS5, ADR-052). After a full OTP login an
 * owner can register the FAST return path on the current device: subsequent
 * logins on this device use the quick-PIN instead of waiting for a Telegram OTP.
 *
 * authCheck (BEFORE the cache lookup, ADR-046): a live owner COCKPIT session via
 * _assertCockpitSession_internal (bridged the same way issueOwnerTelegramBindLink
 * bridges requireCockpitSession from "use node"). A booth session is rejected
 * (NOT_COCKPIT_SESSION).
 *
 * On a cache miss: mint a high-entropy rememberToken (mintUrlSafeToken 32B,
 * hashed with the async sha256Hex — only the hash is persisted), argon2-hash the
 * LOW-entropy quick-PIN (Node), and insert a `remember_device` binding (30-day
 * TTL). The raw rememberToken is returned ONCE for the FE to persist under a
 * namespaced storage-keys entry; the quick-PIN is never returned or logged.
 * Audit owner.device_remembered (source "system") by the commit internal.
 *
 * Errors: NO_SESSION / NOT_COCKPIT_SESSION / SESSION_IDLE_TIMEOUT (cockpit gate),
 * QUICK_PIN_INVALID (not 4–6 digits).
 */
export const registerRememberedDevice = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    deviceId: v.string(),
    quickPin: v.string(),
  },
  handler: async (ctx, args): Promise<{ rememberToken: string }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "auth.registerRememberedDevice" },
      // ── authCheck (runs BEFORE the cache lookup, ADR-046) ──
      async () => {
        await ctx.runQuery(internal.auth.ownerInternal._assertCockpitSession_internal, {
          sessionId: args.sessionId,
        });
      },
      // ── fn (cache miss only) ──
      async () => {
        // Resolve the cockpit session's owner inside fn (the authCheck proved it
        // is live; re-resolve to get the staff id for the binding).
        const { staffId } = await ctx.runQuery(
          internal.auth.ownerInternal._assertCockpitSession_internal,
          { sessionId: args.sessionId },
        );

        // argon2-hash the quick-PIN (validates /^\d{4,6}$/ inside).
        const quickPinHash: string = await ctx.runAction(
          internal.auth.actions._hashQuickPin_internal,
          { quickPin: args.quickPin },
        );

        const raw = mintUrlSafeToken(32);
        const tokenHash = await sha256Hex(raw);
        await ctx.runMutation(
          internal.auth.ownerInternal._createRememberBinding_internal,
          { staffId, deviceId: args.deviceId, tokenHash, quickPinHash },
        );
        return { rememberToken: raw };
      },
    ),
});

/**
 * Quick-PIN login on a remembered device (WS5, ADR-052). The FAST return path —
 * no Telegram OTP. Mirrors verifyOwnerOtp's shape: cache pre-check → resolve the
 * binding by sha256Hex(rememberToken) + per-binding lockout pre-check →
 * argon2Verify the quick-PIN in Node → on miss record the failure (SEC-07,
 * owner_auth_bindings ONLY) and throw a generic REMEMBER_INVALID → on hit clear
 * the failure counter and mint the cockpit session via _cockpitLoginCommit_internal
 * (DISTINCT commit key `${key}:commit`, subReason "quick_pin").
 *
 * A wrong-device / expired / unknown token throws REMEMBER_INVALID (no oracle).
 * A wrong quick-PIN throws REMEMBER_INVALID too — the SAME generic error — so a
 * caller can't distinguish "wrong device" from "wrong PIN". A locked binding
 * throws LOCKED_OUT:<secs>.
 */
export const quickPinLogin = action({
  args: {
    idempotencyKey: v.string(),
    identifier: v.string(),
    deviceId: v.string(),
    rememberToken: v.string(),
    quickPin: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ sessionId: Id<"staff_sessions">; role: "owner" }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) {
      return JSON.parse(cached) as { sessionId: Id<"staff_sessions">; role: "owner" };
    }

    // Resolve the binding by token hash + run the per-binding lockout pre-check
    // (REMEMBER_INVALID on a bad token/device/expiry; LOCKED_OUT:<secs> if locked).
    const tokenHash = await sha256Hex(args.rememberToken);
    const binding = await ctx.runMutation(
      internal.auth.ownerInternal._loadRememberBindingForLogin_internal,
      { tokenHash, deviceId: args.deviceId },
    );

    const match = await argon2Verify({
      password: args.quickPin,
      hash: binding.quickPinHash,
    });
    if (!match) {
      // SEC-07: failure counter lives on the binding, never pos_auth_attempts /
      // owner_auth_attempts. Generic REMEMBER_INVALID — no PIN-vs-device oracle.
      await ctx.runMutation(
        internal.auth.ownerInternal._recordQuickPinFailure_internal,
        { bindingId: binding.bindingId },
      );
      throw new Error("REMEMBER_INVALID");
    }

    // Correct quick-PIN — clear the counter and mint the cockpit session.
    await ctx.runMutation(
      internal.auth.ownerInternal._clearQuickPinFailures_internal,
      { bindingId: binding.bindingId },
    );
    const result = await ctx.runMutation(
      internal.auth.ownerInternal._cockpitLoginCommit_internal,
      {
        idempotencyKey: `${args.idempotencyKey}:commit`,
        staffId: binding.staffId,
        deviceId: args.deviceId,
        subReason: "quick_pin",
      },
    );

    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "auth.quickPinLogin",
      response: JSON.stringify(result),
    });
    return result;
  },
});
