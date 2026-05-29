import { argon2Verify } from "hash-wasm";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Shared PIN-verification front-half for PIN-gated actions:
 * lockout pre-check → argon2Verify → on failure record the attempt (under a
 * `${idempotencyKey}:failed` derived key, so crash-retries don't double-count)
 * and throw. Returns void on success.
 *
 * Throws `LOCKED_OUT:<secs>` if the account is already locked (emitting a
 * staff.locked_out probe audit row first). On a wrong PIN it throws INVALID_PIN —
 * unless `lockOnFail` is set and this very attempt tripped the lock, in which
 * case it throws `LOCKED_OUT:<secs>` (loginWithPin's behaviour).
 *
 * Deliberately NOT used by approvals.approveStaffPinReset: that path intentionally
 * skips the lockout pre-check so a locked-out manager can still approve their own
 * off-booth reset (ADR-029 — token + correct PIN are sufficient authority).
 *
 * Never logs PIN values.
 */
export async function verifyPinOrThrow(
  ctx: ActionCtx,
  params: {
    staffId: Id<"staff">;
    deviceId: string;
    pinHash: string;
    pin: string;
    idempotencyKey: string;
  },
  opts: { lockOnFail?: boolean } = {},
): Promise<void> {
  const lockState = await ctx.runQuery(internal.auth.internal._getLockState_internal, {
    staffId: params.staffId,
  });
  if (lockState.locked) {
    await ctx.runMutation(internal.auth.internal._auditLockProbe_internal, {
      staffId: params.staffId,
      deviceId: params.deviceId,
      seconds_remaining: lockState.seconds_remaining,
    });
    throw new Error(`LOCKED_OUT:${lockState.seconds_remaining}`);
  }

  const ok = await argon2Verify({ password: params.pin, hash: params.pinHash });
  if (!ok) {
    const result = await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
      idempotencyKey: `${params.idempotencyKey}:failed`,
      staffId: params.staffId,
      deviceId: params.deviceId,
    });
    if (opts.lockOnFail && result.newly_locked) {
      throw new Error(`LOCKED_OUT:${result.seconds_remaining}`);
    }
    throw new Error("INVALID_PIN");
  }
}
