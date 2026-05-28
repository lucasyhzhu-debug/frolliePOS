"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal, api } from "../_generated/api";
import { argon2Verify } from "hash-wasm";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 60 min per ADR-029

/**
 * Sentinel device id for off-booth actions taken via the /approve/:token link,
 * which have no registered-device context. Recorded on failed-attempt rows so an
 * audit query can tell a booth PIN probe from an off-booth one (m-3).
 */
const OFF_BOOTH_DEVICE_ID = "approve-route";

/**
 * SHA-256 hex of a string. Tokens are high-entropy (32 random bytes), so salt-less
 * SHA-256 is appropriate (ADR-029) — argon2id is reserved for low-entropy PINs.
 * Runs in the Node runtime ("use node"), so node:crypto is available here.
 */
function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Fired (via ctx.scheduler.runAfter) when a staff member trips the 3rd failed
 * PIN attempt and the account locks (auth/internal._recordFailedAttempt). Sends
 * the off-booth PIN-reset link to the managers' Telegram group.
 *
 * Dedup (staffreview Improvement #5): if a pending+unexpired request already
 * exists for this staff, skip silently — a manager is already holding a live link.
 *
 * Never logs the raw token: it appears only in the request URL we hand to Telegram.
 */
export const notifyStaffLockout = internalAction({
  args: { staffId: v.id("staff") },
  handler: async (ctx, args): Promise<{ skipped?: boolean; reason?: string }> => {
    // Dedup: skip if a live request already exists for this staff.
    const existing = await ctx.runQuery(
      internal.approvals.internal._listPendingForStaff_internal,
      { staffId: args.staffId },
    );
    if (existing.length > 0) {
      return { skipped: true, reason: "pending_request_exists" };
    }

    // Resolve display fields via the auth module boundary (ADR-034).
    const staffInfo = await ctx.runQuery(
      internal.auth.internal._getStaffNameCode_internal,
      { staffId: args.staffId },
    );
    if (!staffInfo) throw new Error("STAFF_NOT_FOUND");

    const baseUrl = process.env.POS_BASE_URL;
    if (!baseUrl) throw new Error("POS_BASE_URL not set");

    // Generate a high-entropy URL-safe token; only the hash is persisted.
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = sha256Hex(rawToken);
    const now = Date.now();

    const { requestId } = await ctx.runMutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "staff_pin_reset",
        subject_staff_id: args.staffId,
        triggered_by_event: "auth_lockout",
        triggered_at: now,
        token_hash: tokenHash,
        token_expires_at: now + TOKEN_TTL_MS,
      },
    );

    const requestUrl = `${baseUrl}/approve/${rawToken}`;
    try {
      await ctx.runAction(api.telegram.send.sendTemplate, {
        kind: "staff_pin_reset",
        payload: {
          staff_name: staffInfo.name,
          staff_code: staffInfo.code ?? "(no code)",
          locked_at_iso: new Date(now).toISOString(),
          request_url: requestUrl,
        },
      });
    } catch (err) {
      // Telegram send failed (network / 5xx). The request row is already pending
      // but never got notified — leaving it would make the dedup guard block the
      // NEXT lockout cycle for the full token TTL, so the manager stays blind.
      // Delete the row so a retry can create a fresh request cleanly, then re-throw
      // so the scheduled-function failure surfaces in Convex logs. The
      // "approval.created" audit row remains as a forensic trace (append-only).
      await ctx.runMutation(internal.approvals.internal._deleteRequest_internal, {
        requestId,
      });
      throw err;
    }

    await ctx.runMutation(internal.approvals.internal._markNotified_internal, {
      requestId,
    });
    return {};
  },
});

/**
 * Off-booth PIN reset via the Telegram link. Spec §"approveStaffPinReset".
 *
 *   1. Action-level idempotency pre-check (ADR-013).
 *   2. Validate newPin (4 digits).
 *   3. sha256 the raw token, look up the request via by_token_hash, then do a
 *      constant-time compare (staffreview Improvement #7) — defense-in-depth even
 *      though the index lookup already matched the hash.
 *   4. Check status === pending AND token_expires_at > now.
 *   5. Resolve the approving manager by staff code (must be an active manager).
 *   6. argon2-verify managerPin against the MANAGER's hash. On fail, record a
 *      failed attempt against the manager (lockout policy) and throw INVALID_PIN.
 *   7. argon2-hash newPin and commit via the shared funnel with actor=manager_reset
 *      (this also clears the subject's lockout and logs staff.pin_reset).
 *   8. Mark the request resolved, then cache the response (action-level idempotency).
 *
 * Locked-out manager self-reset (staffreview Improvement #6): INTENTIONAL.
 * argon2Verify only consults the manager's pin_hash; lockout state is deliberately
 * NOT checked here. A manager who locked themselves out can still approve their own
 * off-booth reset link — the token + correct PIN are sufficient authority.
 *
 * Never logs PIN or token values.
 */
export const approveStaffPinReset = action({
  args: {
    token: v.string(),
    managerPin: v.string(),
    newPin: v.string(),
    managerStaffCode: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ resolved: true }> => {
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { resolved: true };

    if (!/^\d{4}$/.test(args.newPin)) throw new Error("NEW_PIN_INVALID");

    const tokenHash = sha256Hex(args.token);
    const req = await ctx.runQuery(
      internal.approvals.internal._getByTokenHash_internal,
      { tokenHash },
    );
    if (!req) throw new Error("TOKEN_INVALID");

    // Constant-time compare (staffreview Improvement #7) — defense-in-depth.
    const a = Buffer.from(tokenHash, "hex");
    const b = Buffer.from(req.token_hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("TOKEN_INVALID");
    }

    if (req.status !== "pending") throw new Error("REQUEST_RESOLVED");
    if (req.token_expires_at <= Date.now()) throw new Error("TOKEN_EXPIRED");

    const manager = await ctx.runQuery(internal.auth.internal._getByCode_internal, {
      code: args.managerStaffCode,
    });
    if (!manager || !manager.active || manager.role !== "manager") {
      throw new Error("NOT_MANAGER");
    }

    // SECURITY: verify against the MANAGER's hash (the approver), never the
    // subject's. Lockout state intentionally NOT consulted (see header comment).
    const ok = await argon2Verify({ password: args.managerPin, hash: manager.pin_hash });
    if (!ok) {
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        idempotencyKey: `${args.idempotencyKey}:failed`,
        staffId: manager._id,
        deviceId: OFF_BOOTH_DEVICE_ID,
      });
      throw new Error("INVALID_PIN");
    }

    const newPinHash: string = await ctx.runAction(
      internal.auth.actions._hashPin_internal,
      { pin: args.newPin },
    );
    await ctx.runMutation(internal.auth.internal._changePinCommit_internal, {
      staffId: req.subject_staff_id,
      newPinHash,
      actor: { kind: "manager_reset", mgr_approver_id: manager._id },
      // Off-booth Telegram path: record the audit origin as wa_approval, not the
      // booth_inline default (this reset did not happen at the booth).
      source: "wa_approval",
    });
    // Mark resolved + write the idempotency cache row in the SAME transaction (I6).
    return await ctx.runMutation(internal.approvals.internal._markResolved_internal, {
      idempotencyKey: args.idempotencyKey,
      requestId: req._id,
      resolved_by_manager_id: manager._id,
    });
  },
});
