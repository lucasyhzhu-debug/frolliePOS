import { argon2Verify } from "hash-wasm";
import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Shared PIN-verification front-half for PIN-gated actions:
 * lockout pre-check → argon2Verify → on failure record the attempt
 * (`countTowardLockout: true`, keyed on staff_id — SEC-01 removed the old
 * `${idempotencyKey}:failed` derived-key dedupe; a crash-retry over-counting by
 * one is a deliberate fail-safe) and throw. Returns void on success.
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
    // SEC-01: booth misses always count toward lockout (keyed on staff_id, not
    // a client idempotencyKey). params.idempotencyKey is no longer consumed by
    // the failed-attempt path; it is retained on the signature to avoid a wide
    // caller sweep this phase — follow-up: remove it.
    const result = await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
      staffId: params.staffId,
      deviceId: params.deviceId,
      countTowardLockout: true,
    });
    if (opts.lockOnFail && result.newly_locked) {
      throw new Error(`LOCKED_OUT:${result.seconds_remaining}`);
    }
    throw new Error("INVALID_PIN");
  }
}

/**
 * Action-context fail-cheap manager-session assert. Throws if the session is
 * ended/absent or the staff is not an active manager. Does NOT verify PIN.
 *
 * Used as the pre-cache authCheck for withActionCache (ADR-046): it must accept
 * exactly the session set verifyManagerPinOrThrow accepts (active manager, not
 * ended) — keep the two in lockstep (resolution-parity invariant, spec §3.2).
 */
export async function assertManagerSessionInAction(
  ctx: ActionCtx,
  sessionId: Id<"staff_sessions">,
): Promise<void> {
  const resolved = await ctx.runQuery(
    internal.auth.internal._resolveSessionRole_internal,
    { sessionId },
  );
  if (!resolved || resolved.role !== "manager") {
    throw new Error("MANAGER_SESSION_REQUIRED");
  }
}

/**
 * Manager-PIN gate for inline (at-portal) admin actions. Resolves the session,
 * asserts the caller is an ACTIVE MANAGER, then runs the shared verifyPinOrThrow
 * funnel against the MANAGER's own hash (lockout pre-check + argon2 + failed-attempt
 * recording — booth misses count unconditionally post-SEC-01, no idempotency key).
 * Returns the manager identity for audit attribution. Never logs PIN values.
 * Inline-only — NOT the Telegram path.
 *
 * NOTE: the `idempotencyKey` param below is no longer consumed by the
 * failed-attempt path (SEC-01); retained to avoid a wide caller sweep this phase.
 * Follow-up: remove it (tracked in the v1.1 hardening follow-ups).
 */
export async function verifyManagerPinOrThrow(
  ctx: ActionCtx,
  params: {
    sessionId: Id<"staff_sessions">;
    managerPin: string;
    idempotencyKey: string;
  },
): Promise<{ managerId: Id<"staff">; deviceId: string }> {
  const session = await ctx.runQuery(api.auth.public.getSession, {
    sessionId: params.sessionId,
  });
  if (!session) throw new Error("SESSION_INVALID");
  const manager = await ctx.runQuery(internal.auth.internal._getStaffPinHash_internal, {
    staffId: session.staff._id,
  });
  if (!manager || !manager.active || manager.role !== "manager") {
    throw new Error("NOT_MANAGER");
  }
  await verifyPinOrThrow(ctx, {
    staffId: session.staff._id,
    deviceId: session.deviceId,
    pinHash: manager.pin_hash,
    pin: params.managerPin,
    idempotencyKey: params.idempotencyKey,
  });
  return { managerId: session.staff._id, deviceId: session.deviceId };
}
