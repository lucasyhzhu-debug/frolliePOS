"use node";

import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
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
    const cached = await ctx.runQuery(internal.idempotency._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached);

    const staff = await ctx.runQuery(internal.auth._getStaffPinHash_internal, {
      staffId: args.staffId,
    });
    // Treat missing/deactivated staff as INVALID_PIN to avoid leaking which
    // staff records exist via timing or message variance.
    if (!staff || !staff.active) {
      const err = new Error("INVALID_PIN") as Error & { code?: string };
      err.code = "INVALID_PIN";
      throw err;
    }

    const verifyOk = await argon2Verify({ password: args.pin, hash: staff.pin_hash });

    try {
      return await ctx.runMutation(internal.auth._loginCommit_internal, {
        idempotencyKey: args.idempotencyKey,
        staffId: args.staffId,
        deviceId: args.deviceId,
        verifyOk,
      });
    } catch (e) {
      throw e;
    }
  },
});

/**
 * Internal helper used ONLY by convex/auth.test.ts to seed staff rows with
 * real hashes. Not exposed publicly.
 */
export const _seedHashedStaff_internal = internalAction({
  args: {
    name: v.string(),
    pin: v.string(),
    role: v.union(v.literal("staff"), v.literal("manager")),
  },
  handler: async (ctx, args): Promise<Id<"staff">> => {
    const pinHash: string = await ctx.runAction(internal.authActions._hashPin_internal, {
      pin: args.pin,
    });
    const id: Id<"staff"> = await ctx.runMutation(internal.auth._seedStaffCommit_internal, {
      name: args.name,
      pin_hash: pinHash,
      role: args.role,
    });
    return id;
  },
});
