"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal, api } from "../_generated/api";
import { argon2id, argon2Verify } from "hash-wasm";

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
 * Fix 10: pass a derived idempotencyKey (${key}:failed) to
 * _recordFailedAttempt_internal so crash-retries don't double-increment.
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

    // Pre-verify lockout check — reject cheaply before spending argon2 cycles
    const lockState = await ctx.runQuery(internal.auth.internal._getLockState_internal, {
      staffId: args.staffId,
    });
    if (lockState.locked) {
      // Fix 14: emit audit row for each probe during an active lockout
      await ctx.runMutation(internal.auth.internal._auditLockProbe_internal, {
        staffId: args.staffId,
        deviceId: args.deviceId,
        seconds_remaining: lockState.seconds_remaining,
      });
      throw new Error(`LOCKED_OUT:${lockState.seconds_remaining}`);
    }

    const verifyOk = await argon2Verify({ password: args.pin, hash: staff.pin_hash });

    if (!verifyOk) {
      // Commit the failed attempt in its own mutation BEFORE throwing so the
      // write survives. Fix 10: pass derived key so retries are idempotent.
      const result = await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        idempotencyKey: `${args.idempotencyKey}:failed`,
        staffId: args.staffId,
        deviceId: args.deviceId,
      });
      if (result.newly_locked) {
        throw new Error(`LOCKED_OUT:${result.seconds_remaining}`);
      }
      throw new Error("INVALID_PIN");
    }

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
 * Create a new staff member. Manager session required. Hash is computed in the
 * Node action runtime (argon2id), then committed via the internal V8 mutation.
 * Manager check enforced inside the wrapped mutation per ADR-013 hazard note.
 */
export const createStaff = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    name: v.string(),
    role: v.union(v.literal("staff"), v.literal("manager")),
    pin: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ _id: Id<"staff">; name: string; role: "staff" | "manager" }> => {
    if (!/^\d{4}$/.test(args.pin)) {
      throw new Error("PIN must be exactly 4 digits");
    }
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

    // Pre-verify lockout check — reject the caller cheaply before spending
    // argon2 cycles, mirroring loginWithPin's lockout discipline.
    const lockState = await ctx.runQuery(internal.auth.internal._getLockState_internal, {
      staffId: session.staff._id,
    });
    if (lockState.locked) {
      await ctx.runMutation(internal.auth.internal._auditLockProbe_internal, {
        staffId: session.staff._id,
        deviceId: session.deviceId,
        seconds_remaining: lockState.seconds_remaining,
      });
      throw new Error(`LOCKED_OUT:${lockState.seconds_remaining}`);
    }

    const ok = await argon2Verify({ password: args.currentPin, hash: staff.pin_hash });
    if (!ok) {
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        idempotencyKey: `${args.idempotencyKey}:failed`,
        staffId: session.staff._id,
        deviceId: session.deviceId,
      });
      throw new Error("INVALID_PIN");
    }

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
 *   3. Resolve session → caller must be an active manager (else NOT_MANAGER).
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
  handler: async (ctx, args): Promise<{ reset: true }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { reset: true };

    if (!/^\d{4}$/.test(args.newPin)) throw new Error("NEW_PIN_INVALID");

    const session = await ctx.runQuery(api.auth.public.getSession, {
      sessionId: args.sessionId,
    });
    if (!session) throw new Error("SESSION_INVALID");

    const manager = await ctx.runQuery(internal.auth.internal._getStaffPinHash_internal, {
      staffId: session.staff._id,
    });
    if (!manager || !manager.active || manager.role !== "manager") {
      throw new Error("NOT_MANAGER");
    }
    if (session.staff._id === args.targetStaffId) {
      throw new Error("USE_CHANGE_PIN_FOR_SELF");
    }

    const target = await ctx.runQuery(internal.auth.internal._getStaffPinHash_internal, {
      staffId: args.targetStaffId,
    });
    if (!target || !target.active) throw new Error("TARGET_NOT_FOUND");

    // Pre-verify lockout check — the managerPin (the caller's PIN) is what gets
    // verified, so reject a locked manager cheaply before spending argon2 cycles.
    // Mirrors loginWithPin's lockout discipline.
    const lockState = await ctx.runQuery(internal.auth.internal._getLockState_internal, {
      staffId: session.staff._id,
    });
    if (lockState.locked) {
      await ctx.runMutation(internal.auth.internal._auditLockProbe_internal, {
        staffId: session.staff._id,
        deviceId: session.deviceId,
        seconds_remaining: lockState.seconds_remaining,
      });
      throw new Error(`LOCKED_OUT:${lockState.seconds_remaining}`);
    }

    // SECURITY: verify against the MANAGER's hash (the caller), never the target's.
    const ok = await argon2Verify({ password: args.managerPin, hash: manager.pin_hash });
    if (!ok) {
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        idempotencyKey: `${args.idempotencyKey}:failed`,
        staffId: session.staff._id,
        deviceId: session.deviceId,
      });
      throw new Error("INVALID_PIN");
    }

    const newPinHash: string = await ctx.runAction(internal.auth.actions._hashPin_internal, {
      pin: args.newPin,
    });
    await ctx.runMutation(internal.auth.internal._changePinCommit_internal, {
      staffId: args.targetStaffId,
      newPinHash,
      actor: { kind: "manager_reset", mgr_approver_id: session.staff._id },
    });

    const response = { reset: true } as const;
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "auth.resetStaffPin",
      response: JSON.stringify(response),
    });
    return response;
  },
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
