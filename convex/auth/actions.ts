"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal, api } from "../_generated/api";
import { argon2id } from "hash-wasm";
import { verifyPinOrThrow, verifyManagerPinOrThrow, assertManagerSessionInAction } from "./verifyPin";
import { withActionCache } from "../idempotency/action";

const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19_456, // ~19 MiB → ~200ms on Convex action runtime
  hashLength: 32,
  outputType: "encoded" as const,
};

/**
 * Hash a PIN with argon2id. Used by createStaff, seedActions.reset, and tests.
 * Returns the PHC-encoded string ($argon2id$v=19$m=...$salt$hash). ADR-004.
 */
export const _hashPin_internal = internalAction({
  args: { pin: v.string() },
  handler: async (_ctx, args): Promise<string> => {
    if (!/^\d{4}$/.test(args.pin)) {
      throw new Error("PIN must be exactly 4 digits");
    }
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    return argon2id({ password: args.pin, salt, ...ARGON2_PARAMS });
  },
});

/**
 * Public surface for PIN login. Runs argon2Verify in the Node action runtime
 * (so the ~200ms verify cost doesn't block the V8 mutation event loop), then
 * commits the session via the internal mutation. ADR-001 + ADR-002 + ADR-003 + ADR-004.
 *
 * Idempotency: the inner mutation's withIdempotency wrap caches the response.
 * The action checks the cache FIRST via _lookup_internal so a retry skips
 * argon2 verify entirely.
 *
 * Fix 5: after a cache hit, verify the session is still live. If the session
 * was force-ended between the original login and this retry, treat as a cache
 * miss and run a fresh login.
 *
 * SEC-01: the failed-attempt counter is no longer deduped on a client key
 * (the old "Fix 10" derived-key wrap let a reused key defeat lockout). Booth
 * misses always count (countTowardLockout: true); a crash-retry over-counting
 * by one is a deliberate fail-safe.
 *
 * Fix 14: emit a staff.locked_out audit row before throwing LOCKED_OUT so
 * repeated probes are visible in the audit log.
 */
export const loginWithPin = action({
  args: {
    idempotencyKey: v.string(),
    staffId: v.id("staff"),
    pin: v.string(),
    deviceId: v.string(),
  },
  handler: async (ctx, args): Promise<{ sessionId: Id<"staff_sessions">; role: "staff" | "manager" }> => {
    // Short-circuit on cache hit BEFORE running argon2
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });

    // Fix 5: after a cache hit, verify the cached session is still live.
    // If the session was force-ended (manager logout, deactivated staff),
    // fall through to run a fresh login with a derived commit key so the
    // _loginCommit_internal idempotency cache is also bypassed.
    let commitKey = args.idempotencyKey;
    if (cached) {
      const parsed = JSON.parse(cached) as { sessionId: Id<"staff_sessions">; role: "staff" | "manager" };
      const live = await ctx.runQuery(api.auth.public.getSession, { sessionId: parsed.sessionId });
      if (live) return parsed; // session still valid — replay cache
      // Session is dead. Use a derived commit key so the stale commit-level
      // cache is bypassed when we issue a fresh session below.
      commitKey = `${args.idempotencyKey}:refresh`;
    }

    const staff = await ctx.runQuery(internal.auth.internal._getStaffPinHash_internal, {
      staffId: args.staffId,
    });
    // Treat missing/deactivated staff as INVALID_PIN to avoid leaking which
    // staff records exist via timing or message variance.
    if (!staff || !staff.active) {
      throw new Error("INVALID_PIN");
    }

    // Lockout pre-check + argon2 verify + failed-attempt recording (shared funnel).
    // lockOnFail: a wrong PIN that trips the 3rd-strike lock surfaces as LOCKED_OUT.
    await verifyPinOrThrow(
      ctx,
      {
        staffId: args.staffId,
        deviceId: args.deviceId,
        pinHash: staff.pin_hash,
        pin: args.pin,
        idempotencyKey: args.idempotencyKey,
      },
      { lockOnFail: true },
    );

    // PIN verified — commit session (use commitKey which may differ from
    // args.idempotencyKey if a stale-session refresh forced a cache bypass)
    return await ctx.runMutation(internal.auth.internal._loginCommit_internal, {
      idempotencyKey: commitKey,
      staffId: args.staffId,
      deviceId: args.deviceId,
    });
  },
});

/**
 * Create a new staff member. Manager session + manager PIN required (v0.5.3b).
 * Hash is computed in the Node action runtime (argon2id), then committed via
 * the internal V8 mutation.
 *
 * PIN gate (Task 4): the caller proves they are an active manager via
 * `verifyManagerPinOrThrow` BEFORE the new staffer's PIN is hashed. The helper
 * runs the shared lockout pre-check + argon2 + failed-attempt recording funnel
 * against the MANAGER's own hash (records lockout/fail against the manager).
 * The inner `_createStaffCommit_internal` still defensively re-checks the
 * manager session (ADR-013 hazard note) and provides idempotency caching.
 */
export const createStaff = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    name: v.string(),
    role: v.union(v.literal("staff"), v.literal("manager")),
    pin: v.string(),
    managerPin: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ _id: Id<"staff">; name: string; role: "staff" | "manager" }> => {
    if (!/^\d{4}$/.test(args.pin)) {
      throw new Error("PIN must be exactly 4 digits");
    }
    // PIN gate: prove the caller is an active manager (records lockout on fail).
    await verifyManagerPinOrThrow(ctx, {
      sessionId: args.sessionId,
      managerPin: args.managerPin,
      idempotencyKey: args.idempotencyKey,
    });
    const pin_hash: string = await ctx.runAction(internal.auth.actions._hashPin_internal, {
      pin: args.pin,
    });
    return await ctx.runMutation(internal.staff.internal._createStaffCommit_internal, {
      idempotencyKey: args.idempotencyKey,
      sessionId: args.sessionId,
      name: args.name,
      role: args.role,
      pin_hash,
    });
  },
});

/**
 * Self-change PIN. Spec §"PIN management → Self-change". The caller proves
 * identity by verifying their CURRENT PIN against their own pin_hash, then the
 * new PIN is hashed and committed through the shared funnel with actor=self.
 *
 *   1. Cache pre-check (action-level idempotency, ADR-013).
 *   2. Validate newPin (4 digits) and reject newPin === currentPin.
 *   3. Resolve session → staff (deactivated/missing → INVALID_PIN).
 *   4. argon2-verify currentPin against the caller's pin_hash. On fail, record a
 *      failed attempt (lockout policy) under a derived key and throw INVALID_PIN.
 *   5. argon2-hash newPin (reuse _hashPin_internal).
 *   6. runMutation _changePinCommit_internal with actor={kind:"self"}.
 *   7. Write the response into the idempotency cache.
 *
 * Never logs PIN values.
 */
export const changePin = action({
  args: {
    sessionId: v.id("staff_sessions"),
    currentPin: v.string(),
    newPin: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ changed: true }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { changed: true };

    if (!/^\d{4}$/.test(args.newPin)) throw new Error("NEW_PIN_INVALID");
    if (args.currentPin === args.newPin) throw new Error("SAME_PIN");

    const session = await ctx.runQuery(api.auth.public.getSession, {
      sessionId: args.sessionId,
    });
    if (!session) throw new Error("SESSION_INVALID");

    const staff = await ctx.runQuery(internal.auth.internal._getStaffPinHash_internal, {
      staffId: session.staff._id,
    });
    if (!staff || !staff.active) throw new Error("INVALID_PIN");

    // Lockout pre-check + argon2 verify (of the CURRENT pin) + failed-attempt
    // recording (shared funnel, mirrors loginWithPin's lockout discipline).
    await verifyPinOrThrow(ctx, {
      staffId: session.staff._id,
      deviceId: session.deviceId,
      pinHash: staff.pin_hash,
      pin: args.currentPin,
      idempotencyKey: args.idempotencyKey,
    });

    const newPinHash: string = await ctx.runAction(internal.auth.actions._hashPin_internal, {
      pin: args.newPin,
    });
    await ctx.runMutation(internal.auth.internal._changePinCommit_internal, {
      staffId: session.staff._id,
      newPinHash,
      actor: { kind: "self" },
    });

    const response = { changed: true } as const;
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "auth.changePin",
      response: JSON.stringify(response),
    });
    return response;
  },
});

/**
 * Manager-reset booth-inline. Spec §"PIN management → Manager-reset booth-inline".
 * A manager physically at the booth resets a staff member's PIN by proving their
 * own manager PIN. SECURITY: the managerPin is verified against the MANAGER's
 * pin_hash (the caller), never the target's — a wrong manager PIN cannot reset.
 *
 *   1. Cache pre-check.
 *   2. Validate newPin (4 digits).
 *   3. Resolve session → caller must be an active manager (else MANAGER_SESSION_REQUIRED,
 *      thrown by the pre-cache authCheck before step 1).
 *   4. Reject self-reset (use changePin instead).
 *   5. Resolve target staff (missing/deactivated → TARGET_NOT_FOUND).
 *   6. argon2-verify managerPin against the MANAGER's pin_hash. On fail, record a
 *      failed attempt against the manager and throw INVALID_PIN.
 *   7. argon2-hash newPin, commit via funnel with actor=manager_reset (this also
 *      clears the target's lockout and logs staff.pin_reset).
 *   8. Write the response into the idempotency cache.
 *
 * Never logs PIN values.
 */
export const resetStaffPin = action({
  args: {
    sessionId: v.id("staff_sessions"),
    targetStaffId: v.id("staff"),
    newPin: v.string(),
    managerPin: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ reset: true }> =>
    // v0.5.3b post-review extraction: uniform action-level idempotency
    // (lookup → fn → write) hoisted into withActionCache. Body unchanged
    // otherwise; PIN-regex/session/target checks stay BEFORE the manager-PIN
    // verify so a malformed retry surfaces NEW_PIN_INVALID rather than
    // incrementing the manager's failed-PIN counter on noise.
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "auth.resetStaffPin" },
      () => assertManagerSessionInAction(ctx, args.sessionId),
      async () => {
        if (!/^\d{4}$/.test(args.newPin)) throw new Error("NEW_PIN_INVALID");

        const session = await ctx.runQuery(api.auth.public.getSession, {
          sessionId: args.sessionId,
        });
        // Unreachable in normal flow after assertManagerSessionInAction (ADR-046); covers the narrow TOCTOU window where the session ends between the pre-cache authCheck and fn execution.
        if (!session) throw new Error("SESSION_INVALID");
        if (session.staff._id === args.targetStaffId) {
          throw new Error("USE_CHANGE_PIN_FOR_SELF");
        }

        const target = await ctx.runQuery(internal.auth.internal._getStaffPinHash_internal, {
          staffId: args.targetStaffId,
        });
        if (!target || !target.active) throw new Error("TARGET_NOT_FOUND");

        // Manager identity + PIN proof via the shared funnel (replaces the inline
        // manager lookup + verifyPinOrThrow). SECURITY unchanged: verifies the
        // MANAGER's hash, records lockout/fail against the manager.
        const { managerId } = await verifyManagerPinOrThrow(ctx, {
          sessionId: args.sessionId,
          managerPin: args.managerPin,
          idempotencyKey: args.idempotencyKey,
        });

        const newPinHash: string = await ctx.runAction(internal.auth.actions._hashPin_internal, {
          pin: args.newPin,
        });
        await ctx.runMutation(internal.auth.internal._changePinCommit_internal, {
          staffId: args.targetStaffId,
          newPinHash,
          actor: { kind: "manager_reset", mgr_approver_id: managerId },
        });

        return { reset: true } as const;
      },
    ),
});

/**
 * Internal helper used ONLY by convex/auth/__tests__/auth.test.ts to seed staff rows with
 * real hashes. Not exposed publicly.
 */
export const _seedHashedStaff_internal = internalAction({
  args: {
    name: v.string(),
    pin: v.string(),
    role: v.union(v.literal("staff"), v.literal("manager")),
  },
  handler: async (ctx, args): Promise<Id<"staff">> => {
    const pinHash: string = await ctx.runAction(internal.auth.actions._hashPin_internal, {
      pin: args.pin,
    });
    const id: Id<"staff"> = await ctx.runMutation(internal.auth.internal._seedStaffCommit_internal, {
      name: args.name,
      pin_hash: pinHash,
      role: args.role,
    });
    return id;
  },
});
