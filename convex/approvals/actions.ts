"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal, api } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { argon2Verify } from "hash-wasm";
import { timingSafeEqual } from "node:crypto";
import { mintUrlSafeToken } from "../lib/tokens";
import { sha256Hex } from "../lib/tokenHash";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 60 min per ADR-029

/**
 * Sentinel device id for off-booth actions taken via the /approve/:token link,
 * which have no registered-device context. Recorded on failed-attempt rows so an
 * audit query can tell a booth PIN probe from an off-booth one (m-3).
 *
 * KNOWN SECURITY (deferred to v0.5): all three approve* actions verify the
 * manager PIN per-code with NO per-token failed-attempt cap. An attacker who
 * holds a live token can iterate manager codes (low-cardinality, predictable
 * like S-0001) and burn 3 wrong PINs against each — locking out every manager
 * in sequence. Each lockout fires notifyStaffLockout, which posts a fresh
 * PIN-reset link to the same Telegram group, amplifying the loop. Mitigation:
 * track failed attempts per token (or per token+manager pair) and invalidate
 * the token after N misses across any code. Tracked in PROGRESS.md v0.5
 * stabilization + Risks under watch.
 */
const OFF_BOOTH_DEVICE_ID = "approve-route";

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
  args: {
    staffId: v.id("staff"),
    // v2.0 Spec-4: the device the lockout happened on — used to route the
    // PIN-reset card to THAT outlet's managers chat (not the default outlet).
    // Optional for backward-compat / system callers without device context.
    deviceId: v.optional(v.string()),
  },
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
    const rawToken = mintUrlSafeToken();
    const tokenHash = sha256Hex(rawToken);
    const now = Date.now();

    // v2.0 Spec-4: route to the outlet WHERE the lockout happened — resolve the
    // device's bound outlet (non-throwing), falling back to the default outlet
    // when no device context exists (system callers) or the device is unbound.
    // The lockout is session-less (the staff is locked out before login), but the
    // failing device IS outlet-bound, so its outlet is the correct managers chat.
    // pos_approval_requests.outlet_id is required (Spec-1 enforce), so we always
    // resolve a concrete outlet here.
    let outletId: Id<"outlets"> | null = null;
    if (args.deviceId) {
      outletId = await ctx.runQuery(
        internal.auth.internal._getDeviceOutletIdOrNull_internal,
        { deviceId: args.deviceId },
      );
    }
    const defaultOutlet = await ctx.runQuery(
      internal.outlets.internal._getDefaultOutlet_internal,
      {},
    );
    if (!defaultOutlet) throw new Error("NO_DEFAULT_OUTLET");
    const resolvedOutletId = outletId ?? defaultOutlet._id;

    const { requestId } = await ctx.runMutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "staff_pin_reset",
        subject_staff_id: args.staffId,
        triggered_by_event: "auth_lockout",
        triggered_at: now,
        token_hash: tokenHash,
        token_expires_at: now + TOKEN_TTL_MS,
        outletId: resolvedOutletId,
      },
    );

    const requestUrl = `${baseUrl}/approve/${rawToken}`;
    try {
      await ctx.runAction(api.telegram.send.sendTemplate, {
        role: "managers",
        kind: "staff_pin_reset",
        payload: {
          staff_name: staffInfo.name,
          staff_code: staffInfo.code ?? "(no code)",
          locked_at_iso: new Date(now).toISOString(),
          request_url: requestUrl,
        },
        idempotencyKey: `notifyLockout:${requestId}`,
        outletId: resolvedOutletId, // v2.0 Spec-4: route to the lockout outlet's managers
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
      // SEC-07: audit the off-booth miss but DON'T touch the booth lockout
      // counter (a leaked token must not DoS-lock the manager's booth login).
      // The per-token cap below bounds brute force on this path.
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        staffId: manager._id,
        deviceId: OFF_BOOTH_DEVICE_ID,
        countTowardLockout: false,
        source: "telegram_approval",
      });
      const capResult = await ctx.runMutation(
        internal.approvals.internal._recordTokenPinFailure_internal,
        { requestId: req._id },
      );
      if (capResult.capped) throw new Error("REQUEST_REVOKED");
      throw new Error("INVALID_PIN");
    }

    // subject_staff_id is always present for staff_pin_reset; guard for TS (schema
    // made it optional in v0.4 to support other kinds like manual_payment_override).
    if (!req.subject_staff_id) throw new Error("REQUEST_MISSING_SUBJECT");

    const newPinHash: string = await ctx.runAction(
      internal.auth.actions._hashPin_internal,
      { pin: args.newPin },
    );
    await ctx.runMutation(internal.auth.internal._changePinCommit_internal, {
      staffId: req.subject_staff_id,
      newPinHash,
      actor: { kind: "manager_reset", mgr_approver_id: manager._id },
      // Off-booth Telegram path: record the audit origin as telegram_approval,
      // not the booth_inline default (this reset did not happen at the booth).
      // v0.4 (Task 21): shipped delivery is always Telegram; the legacy
      // "wa_approval" literal is replaced by "telegram_approval" for consistency.
      source: "telegram_approval",
    });
    // Mark resolved + write the idempotency cache row in the SAME transaction (I6).
    return await ctx.runMutation(internal.approvals.internal._markResolved_internal, {
      idempotencyKey: args.idempotencyKey,
      requestId: req._id,
      resolved_by_manager_id: manager._id,
      source: "telegram_approval",
    });
  },
});

/**
 * Staff-initiated off-booth manual-payment approval request. Called from the
 * charge screen when no manager is present at the booth to confirm payment.
 *
 *   1. Action-level idempotency pre-check (ADR-013).
 *   2. Resolve session → staffId (auth module boundary, ADR-034).
 *   3. Fetch txn summary via transactions module (ADR-034). Reject if not awaiting_payment.
 *   4. Dedup: one live pending request per txn — return existing if found.
 *   5. Mint 32-byte URL-safe token; persist only its SHA-256 hash (ADR-029).
 *   6. Create the approval request row via _createRequest_internal.
 *   7. Send Telegram card to managers group. On failure, delete the request row
 *      (recovery pattern mirrors notifyStaffLockout) and rethrow.
 *   8. Mark notified + best-effort link telegram_message_id.
 *   9. Write action-level idempotency cache.
 */
export const requestManualPaymentApproval = action({
  args: {
    sessionId: v.id("staff_sessions"),
    txnId: v.id("pos_transactions"),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ requestId: Id<"pos_approval_requests"> }> => {
    // Step 1: idempotency pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { requestId: Id<"pos_approval_requests"> };

    // Step 2: resolve session
    const requester = await ctx.runQuery(
      internal.auth.internal._resolveSession_internal,
      { sessionId: args.sessionId },
    );
    if (!requester) throw new Error("NO_SESSION");

    const outletId = requester.outlet_id;

    const requesterInfo = await ctx.runQuery(
      internal.auth.internal._getStaffNameCode_internal,
      { staffId: requester.staffId },
    );

    // Step 3: validate txn state
    const txn = await ctx.runQuery(
      internal.transactions.internal._getTxnSummary_internal,
      { txnId: args.txnId },
    );
    if (!txn || txn.status !== "awaiting_payment") {
      throw new Error("TXN_NOT_AWAITING");
    }

    // Step 4: dedup — one live request per txn
    // v2.0 Stream 5: pass outletId for outlet-scoped dedup lookup.
    const existing = await ctx.runQuery(
      internal.approvals.internal._listPendingByKind_internal,
      { kind: "manual_payment_override", entityId: args.txnId as unknown as string, outletId },
    );
    if (existing.length > 0) return { requestId: existing[0]._id };

    const baseUrl = process.env.POS_BASE_URL;
    if (!baseUrl) throw new Error("POS_BASE_URL not set");

    // Step 5: mint token (only hash persisted — ADR-029)
    const rawToken = mintUrlSafeToken();
    const tokenHash = sha256Hex(rawToken);
    const now = Date.now();

    // Step 6: create request row
    // v2.0 Stream 5: pass outletId to stamp the approval row.
    const { requestId } = await ctx.runMutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "manual_payment_override",
        requester_staff_id: requester.staffId,
        entity_type: "pos_transactions",
        entity_id: args.txnId as unknown as string,
        context: {
          txn_id: args.txnId as unknown as string,
          amount_idr: txn.total,
          reason: args.reason,
        },
        reason: args.reason,
        triggered_by_event: "manual_payment_request",
        triggered_at: now,
        token_hash: tokenHash,
        token_expires_at: now + TOKEN_TTL_MS,
        outletId,
      },
    );

    // Step 7: send Telegram card — delete request on failure (recovery mirrors notifyStaffLockout)
    let messageId: number | undefined;
    try {
      const sendRes = await ctx.runAction(api.telegram.send.sendTemplate, {
        role: "managers",
        kind: "manual_payment_override",
        payload: {
          amount_idr: txn.total,
          reason: args.reason,
          requester_name: requesterInfo?.name ?? "Staff",
          approve_url: `${baseUrl}/approve/${rawToken}`,
        },
        idempotencyKey: `${args.idempotencyKey}:send`,
        outletId, // v2.0 Spec-4 Task 5: route to per-outlet managers (outletId = requester.outlet_id)
      });
      messageId = sendRes.message_id;
    } catch (err) {
      await ctx.runMutation(internal.approvals.internal._deleteRequest_internal, {
        requestId,
      });
      throw err;
    }

    // Step 8: mark notified + best-effort link message id
    await ctx.runMutation(internal.approvals.internal._markNotified_internal, { requestId });
    try {
      await ctx.runMutation(internal.approvals.internal._linkTelegramMessage_internal, {
        requestId,
        messageId,
        chatId: undefined,
      });
    } catch {
      // best-effort — never fail the request over a missing message link
    }

    // Step 9: cache the response (action-level idempotency)
    const out = { requestId };
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "approvals.requestManualPaymentApproval",
      response: JSON.stringify(out),
    });

    return out;
  },
});

/**
 * Off-booth manual-payment approval via the Telegram link. Spec §"approveManualPayment".
 * Mirrors approveStaffPinReset's envelope so the security story is identical:
 *
 *   1. Action-level idempotency pre-check (ADR-013) — same key replay returns
 *      the cached resolve response without re-firing the funnel.
 *   2. sha256 the raw token, lookup the request by token hash, then do a
 *      constant-time compare (defense-in-depth even though the index already matched).
 *   3. Status === pending, token not expired, kind === "manual_payment_override".
 *   4. Resolve approving manager by staff code (active manager only).
 *   5. argon2-verify managerPin against the MANAGER's hash. On fail, record a
 *      failed attempt against the manager and throw INVALID_PIN.
 *   6. Run the payment funnel via _onPaidManual_internal (idempotency-keyed with
 *      a :onpaid suffix so it doesn't collide with the action-level cache).
 *      Thread source="telegram_approval" so the payment.confirmed audit row
 *      records the real origin (not booth_inline).
 *   7. Mark the request resolved with the TOP-LEVEL idempotencyKey — same as
 *      approveStaffPinReset, this row's cache write is what the action-level
 *      _lookup_internal pre-check replays.
 *
 * Locked-out manager self-approve (mirrors approveStaffPinReset Improvement #6):
 * INTENTIONAL. argon2Verify only consults the manager's pin_hash; lockout is not
 * checked. Token + correct PIN are sufficient authority.
 *
 * Never logs PIN or token values.
 */
export const approveManualPayment = action({
  args: {
    token: v.string(),
    managerStaffCode: v.string(),
    managerPin: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ resolved: true }> => {
    // Step 1: action-level idempotency pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { resolved: true };

    // Step 2: token lookup + constant-time compare
    const tokenHash = sha256Hex(args.token);
    const req = await ctx.runQuery(
      internal.approvals.internal._getByTokenHash_internal,
      { tokenHash },
    );
    if (!req) throw new Error("TOKEN_INVALID");

    const a = Buffer.from(tokenHash, "hex");
    const b = Buffer.from(req.token_hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("TOKEN_INVALID");
    }

    // Step 3: state guards
    if (req.kind !== "manual_payment_override") throw new Error("WRONG_KIND");
    if (req.status !== "pending") throw new Error("REQUEST_RESOLVED");
    if (req.token_expires_at <= Date.now()) throw new Error("TOKEN_EXPIRED");

    // Extract txnId from the validated context (set by requestManualPaymentApproval).
    const ctxBag = (req.context ?? {}) as { txn_id?: string };
    if (!ctxBag.txn_id) throw new Error("REQUEST_MISSING_TXN");
    const txnId = ctxBag.txn_id as unknown as Id<"pos_transactions">;

    // Step 4: resolve approving manager
    const manager = await ctx.runQuery(internal.auth.internal._getByCode_internal, {
      code: args.managerStaffCode,
    });
    if (!manager || !manager.active || manager.role !== "manager") {
      throw new Error("NOT_MANAGER");
    }

    // Step 5: argon2-verify manager PIN; record failed attempt on miss
    const ok = await argon2Verify({ password: args.managerPin, hash: manager.pin_hash });
    if (!ok) {
      // SEC-07: audit the off-booth miss but DON'T touch the booth lockout
      // counter (a leaked token must not DoS-lock the manager's booth login).
      // The per-token cap below bounds brute force on this path.
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        staffId: manager._id,
        deviceId: OFF_BOOTH_DEVICE_ID,
        countTowardLockout: false,
        source: "telegram_approval",
      });
      const capResult = await ctx.runMutation(
        internal.approvals.internal._recordTokenPinFailure_internal,
        { requestId: req._id },
      );
      if (capResult.capped) throw new Error("REQUEST_REVOKED");
      throw new Error("INVALID_PIN");
    }

    // Step 6: run the payment funnel. The :onpaid suffix gives the funnel its
    // own idempotency key — same top-level retry replays both this mutation
    // (existing cache row) AND step 7 (the cached resolve response).
    await ctx.runMutation(internal.payments.internal._onPaidManual_internal, {
      idempotencyKey: `${args.idempotencyKey}:onpaid`,
      txnId,
      reason: req.reason ?? "Manual payment (off-booth approval)",
      mgr_approver_id: manager._id,
      source: "telegram_approval",
    });

    // Step 7: mark resolved + cache action response in ONE transaction (I6).
    // The TOP-LEVEL idempotencyKey is intentionally reused here so the action's
    // _lookup_internal pre-check sees the cached resolve blob on retry.
    return await ctx.runMutation(internal.approvals.internal._markResolved_internal, {
      idempotencyKey: args.idempotencyKey,
      requestId: req._id,
      resolved_by_manager_id: manager._id,
      source: "telegram_approval",
    });
  },
});

/**
 * Off-booth refund approval via the Telegram link. Spec §"approveRefund" (v0.5.1
 * PR B / Task B10). Mirrors approveManualPayment's envelope exactly — same
 * security guards, same constant-time token compare, same per-token PIN-attempt
 * cap, same lockout-self-approve carve-out. The only divergence is the commit
 * step: instead of confirming payment, it calls _commitRefund_internal (the
 * single writer used by BOTH the booth-PIN path (commitRefundInline) and this
 * off-booth path — v0.5.0 cross-path-parity lesson).
 *
 *   1. Action-level idempotency pre-check (ADR-013). Same key replay returns
 *      the cached { refundId, total_refund } blob without re-firing the funnel.
 *   2. sha256 the raw token, lookup the request by token hash, then constant-
 *      time compare (defense-in-depth even though the index already matched).
 *   3. Status === pending, token not expired, kind === "refund".
 *   4. Resolve approving manager by staff code (active manager only).
 *   5. argon2-verify managerPin against the MANAGER's hash. On fail, record a
 *      failed attempt against the manager + bump the per-token PIN-attempt cap
 *      (auto-deny at 5 misses → REQUEST_REVOKED), otherwise throw INVALID_PIN.
 *   6. Commit the refund via _commitRefund_internal — the single writer. Pass
 *      approvalSource="telegram_approval" so the pos_refunds row + refund.committed
 *      audit row record this path correctly. requested_by = requester_staff_id
 *      from the approval request; approver_id = the manager who entered PIN.
 *      `_commitRefund_internal` is NOT idempotency-wrapped, but the action-level
 *      pre-check (step 1) guarantees we only reach this branch once per key —
 *      same-key retries short-circuit at the cached blob.
 *   7. Mark the request resolved. We deliberately pass a DERIVED idempotency
 *      key (`:resolve` suffix) rather than the top-level one — _markResolved_internal's
 *      withIdempotency cache writes `{ resolved: true }`, which DOES NOT match
 *      this action's `{ refundId, total_refund }` return shape. Using a derived
 *      key keeps both cache rows independent: the resolve mutation has its own
 *      replay guard, and the action's top-level cache (step 8) stores the
 *      response shape callers actually expect.
 *   8. Write the action-level idempotency cache with the real response shape.
 *
 * Locked-out manager self-approve (mirrors approveManualPayment Improvement #6):
 * INTENTIONAL. argon2Verify only consults the manager's pin_hash; lockout is not
 * checked. Token + correct PIN are sufficient authority.
 *
 * Audit: the success audit row (refund.committed, source: telegram_approval) is
 * emitted by _commitRefund_internal — no additional audit in this action. The
 * resolve mutation also emits its own refund.committed audit per KIND_AUDIT.
 *
 * Never logs PIN or token values.
 */
export const approveRefund = action({
  args: {
    token: v.string(),
    managerStaffCode: v.string(),
    managerPin: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ refundId: Id<"pos_refunds">; total_refund: number }> => {
    // I5 (v0.5.1 PR B post-review): token auth BEFORE cache lookup. Token
    // validation is one indexed query + a constant-time compare — cheap. The
    // argon2 PIN verify stays after the cache (expensive). Pre-I5 a caller
    // without a valid token but with a leaked idempotencyKey could replay
    // the cached { refundId, total_refund }. Mirrors CLAUDE.md rule #21.
    const tokenHash = sha256Hex(args.token);
    const req = await ctx.runQuery(
      internal.approvals.internal._getByTokenHash_internal,
      { tokenHash },
    );
    if (!req) throw new Error("TOKEN_INVALID");

    const a = Buffer.from(tokenHash, "hex");
    const b = Buffer.from(req.token_hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("TOKEN_INVALID");
    }

    // State guards (still part of auth — must reject before cache replay).
    if (req.kind !== "refund") throw new Error("WRONG_KIND");
    if (req.status !== "pending") throw new Error("REQUEST_RESOLVED");
    if (req.token_expires_at <= Date.now()) throw new Error("TOKEN_EXPIRED");

    // Step 1: action-level idempotency pre-check (after token auth)
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { refundId: Id<"pos_refunds">; total_refund: number };

    // Extract the refund payload from the validated context. The context was
    // written by requestRefundApproval (B9) via _createRequest_internal, which
    // runs validateContext("refund", ...) — so shape is guaranteed here. We
    // still defensively narrow because context is stored as v.any().
    const ctxBag = (req.context ?? {}) as {
      txn_id?: string;
      lines?: Array<{ line_id: string; refund_qty: number }>;
      reason?: string;
    };
    if (!ctxBag.txn_id) throw new Error("REQUEST_MISSING_TXN");
    if (!Array.isArray(ctxBag.lines) || ctxBag.lines.length === 0) {
      throw new Error("REQUEST_MISSING_LINES");
    }
    if (!req.requester_staff_id) throw new Error("REQUEST_MISSING_REQUESTER");
    const txnId = ctxBag.txn_id as unknown as Id<"pos_transactions">;

    // Step 4: resolve approving manager
    const manager = await ctx.runQuery(internal.auth.internal._getByCode_internal, {
      code: args.managerStaffCode,
    });
    if (!manager || !manager.active || manager.role !== "manager") {
      throw new Error("NOT_MANAGER");
    }

    // Step 5: argon2-verify manager PIN; record failed attempt on miss
    const ok = await argon2Verify({ password: args.managerPin, hash: manager.pin_hash });
    if (!ok) {
      // SEC-07: audit the off-booth miss but DON'T touch the booth lockout
      // counter (a leaked token must not DoS-lock the manager's booth login).
      // The per-token cap below bounds brute force on this path.
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        staffId: manager._id,
        deviceId: OFF_BOOTH_DEVICE_ID,
        countTowardLockout: false,
        source: "telegram_approval",
      });
      const capResult = await ctx.runMutation(
        internal.approvals.internal._recordTokenPinFailure_internal,
        { requestId: req._id },
      );
      if (capResult.capped) throw new Error("REQUEST_REVOKED");
      throw new Error("INVALID_PIN");
    }

    // Step 6: commit the refund via the single writer. Map the context's
    // {line_id, refund_qty} shape to _commitRefund_internal's {line_id, qty}
    // shape. line_id was stored as a string in context (schema is v.any());
    // cast back to Id<"pos_transaction_lines"> for the mutation.
    const commitLines = ctxBag.lines.map((l) => ({
      line_id: l.line_id as unknown as Id<"pos_transaction_lines">,
      qty: l.refund_qty,
    }));
    // C1: pass derived `:commit` idempotency key so the wrapped funnel can
    // short-circuit on action-retry without double-committing the refund.
    const result = await ctx.runMutation(
      internal.refunds.internal._commitRefund_internal,
      {
        idempotencyKey: `${args.idempotencyKey}:commit`,
        transactionId: txnId,
        lines: commitLines,
        reason: ctxBag.reason ?? req.reason ?? "Refund (off-booth approval)",
        requestedBy: req.requester_staff_id,
        approverId: manager._id,
        approvalSource: "telegram_approval",
        approvalRequestId: req._id,
      },
    );

    // Step 7: mark request resolved. Use a DERIVED idempotency key so the
    // resolve mutation's withIdempotency cache (`{ resolved: true }`) does
    // not collide with the action-level cache below (`{ refundId, total_refund }`).
    await ctx.runMutation(internal.approvals.internal._markResolved_internal, {
      idempotencyKey: `${args.idempotencyKey}:resolve`,
      requestId: req._id,
      resolved_by_manager_id: manager._id,
      source: "telegram_approval",
    });

    // Step 8: cache action-level response. The top-level idempotencyKey stores
    // the `{ refundId, total_refund }` blob the UI consumes; same-key retries
    // replay this blob via step 1 without re-running the commit.
    const out = { refundId: result.refundId, total_refund: result.total_refund };
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "approvals.approveRefund",
      response: JSON.stringify(out),
    });

    return out;
  },
});

/**
 * Off-booth deny — kind-agnostic. Works for any pending approval request
 * (staff_pin_reset, manual_payment_override, and any future kind). There is
 * intentionally NO `kind` guard here: a manager can deny any pending request
 * via the /approve/:token link, regardless of what triggered it.
 *
 * Mirrors approveManualPayment's security envelope exactly except for the
 * commit step: instead of confirming payment, it commits _markDenied_internal.
 * The denied request row is terminal — the transaction (if any) stays in its
 * pre-denial state (e.g., awaiting_payment remains awaiting_payment).
 *
 *   1. Action-level idempotency pre-check (ADR-013).
 *   2. sha256 the raw token, look up the request by token hash, constant-time compare.
 *   3. Status === pending, token not expired.
 *   4. Resolve approving manager by staff code (active manager only).
 *   5. argon2-verify managerPin. On fail, record failed attempt + throw INVALID_PIN.
 *   6. Commit _markDenied_internal under the TOP-LEVEL idempotencyKey — same key
 *      the action-level pre-check replays, so concurrent retries get the cached blob.
 *
 * Never logs PIN or token values.
 */
export const denyRequest = action({
  args: {
    token: v.string(),
    managerStaffCode: v.string(),
    managerPin: v.string(),
    denyReason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ denied: true }> => {
    // Step 1: action-level idempotency pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { denied: true };

    // Step 2: token lookup + constant-time compare
    const tokenHash = sha256Hex(args.token);
    const req = await ctx.runQuery(
      internal.approvals.internal._getByTokenHash_internal,
      { tokenHash },
    );
    if (!req) throw new Error("TOKEN_INVALID");

    const a = Buffer.from(tokenHash, "hex");
    const b = Buffer.from(req.token_hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("TOKEN_INVALID");
    }

    // Step 3: state guards (kind-agnostic — no kind check)
    if (req.status !== "pending") throw new Error("REQUEST_RESOLVED");
    if (req.token_expires_at <= Date.now()) throw new Error("TOKEN_EXPIRED");

    // Step 4: resolve approving manager
    const manager = await ctx.runQuery(internal.auth.internal._getByCode_internal, {
      code: args.managerStaffCode,
    });
    if (!manager || !manager.active || manager.role !== "manager") {
      throw new Error("NOT_MANAGER");
    }

    // Step 5: argon2-verify manager PIN; record failed attempt on miss.
    // Lockout state intentionally NOT checked (mirrors approveManualPayment Improvement #6):
    // a locked-out manager can still deny via the /approve/:token link.
    const ok = await argon2Verify({ password: args.managerPin, hash: manager.pin_hash });
    if (!ok) {
      // SEC-07: audit the off-booth miss but DON'T touch the booth lockout
      // counter (a leaked token must not DoS-lock the manager's booth login).
      // The per-token cap below bounds brute force on this path.
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        staffId: manager._id,
        deviceId: OFF_BOOTH_DEVICE_ID,
        countTowardLockout: false,
        source: "telegram_approval",
      });
      const capResult = await ctx.runMutation(
        internal.approvals.internal._recordTokenPinFailure_internal,
        { requestId: req._id },
      );
      if (capResult.capped) throw new Error("REQUEST_REVOKED");
      throw new Error("INVALID_PIN");
    }

    // Step 6: commit deny + write idempotency cache row in ONE transaction (I6).
    // The TOP-LEVEL idempotencyKey is reused so the action-level pre-check (step 1)
    // replays the cached { denied: true } on any subsequent retry.
    return await ctx.runMutation(internal.approvals.internal._markDenied_internal, {
      idempotencyKey: args.idempotencyKey,
      requestId: req._id,
      denied_by_manager_id: manager._id,
      deny_reason: args.denyReason,
      source: "telegram_approval",
    });
  },
});

/**
 * Session-less off-booth shift-override request (v1.3.1 Task 4).
 *
 * Triggered when a booth device is stranded behind a locked session: the
 * blocked staffer (who has NO session) calls this from the "Request Manager
 * Override" screen. No sessionId — the device's outlet binding carries the
 * outlet context.
 *
 *   1. Action-level idempotency pre-check (ADR-013).
 *   2. Resolve outlet from deviceId via _getDeviceOutletId_internal.
 *   3. Read the active pos_shifts hold via _getActiveShift_internal.
 *      If no hold → return { noHold: true } (nothing to override; cached).
 *   4. Dedup: if a pending shift_override request already exists for this hold
 *      (keyed on entity_id = hold._id), return the existing requestId.
 *   5. Build signoff summary (sales so far) + resolve stranded staff name +
 *      outlet label.
 *   6. Mint token; create approval row via _createRequest_internal.
 *   7. Send Telegram card to managers. On failure, delete the request row and
 *      rethrow (mirrors notifyStaffLockout / requestSpoilageApproval recovery).
 *   8. Mark notified + write action-level idempotency cache.
 *
 * Never logs PIN or token values.
 */
export const requestShiftOverride = action({
  args: {
    deviceId: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ requestId: Id<"pos_approval_requests"> } | { noHold: true }> => {
    // Step 1: action-level idempotency pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) {
      return JSON.parse(cached) as { requestId: Id<"pos_approval_requests"> } | { noHold: true };
    }

    // Step 2: resolve outlet from device (throws DEVICE_HAS_NO_OUTLET if unbound)
    const outletId = await ctx.runQuery(
      internal.auth.internal._getDeviceOutletId_internal,
      { deviceId: args.deviceId },
    );

    // Step 3: check for an active shift hold
    const hold = await ctx.runQuery(
      internal.shifts.shiftsInternal._getActiveShift_internal,
      { outletId },
    );
    if (!hold) {
      const out: { noHold: true } = { noHold: true };
      await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
        key: args.idempotencyKey,
        mutationName: "approvals.requestShiftOverride",
        response: JSON.stringify(out),
      });
      return out;
    }

    // Step 4: dedup — one pending override per shift (entity_id = hold._id)
    const existing = await ctx.runQuery(
      internal.approvals.internal._listPendingByKind_internal,
      { kind: "shift_override", entityId: hold._id as unknown as string, outletId },
    );
    if (existing.length > 0) {
      // Don't write the idempotency cache here: this is a dedup hit on a
      // DIFFERENT idempotency key. A same-key replay short-circuits at step 1;
      // this path is a distinct caller who found the same pending row. Cache
      // the entry would pollute the idempotency store with a second key whose
      // response is stale (if the request resolves, a retry of THIS key would
      // still replay the old requestId). Mirrors requestManualPaymentApproval.
      return { requestId: existing[0]._id };
    }

    // Step 5: build context for the approval card
    const now = Date.now();
    const summary = await ctx.runQuery(
      internal.shifts.internal._buildSignoffSummary_internal,
      { shiftStartMs: hold.started_at, endMs: now, outletId },
    );
    const staffNames = await ctx.runQuery(
      internal.auth.internal._listStaffNames_internal,
      {},
    );
    const strandedName =
      staffNames.find((s) => s._id === hold.staff_id)?.name ?? "Staff";
    const outlet = await ctx.runQuery(
      internal.outlets.internal._getOutlet_internal,
      { outletId },
    );
    const outletLabel = outlet?.name ?? "Booth";

    const baseUrl = process.env.POS_BASE_URL;
    if (!baseUrl) throw new Error("POS_BASE_URL not set");

    // Step 5b: mint token (only hash persisted — ADR-029)
    const rawToken = mintUrlSafeToken();
    const tokenHash = sha256Hex(rawToken);

    // Step 6: create the approval request row
    const { requestId } = await ctx.runMutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "shift_override",
        entity_type: "pos_shifts",
        entity_id: hold._id as unknown as string,
        context: {
          shift_id: hold._id as unknown as string,
          device_id: args.deviceId,
          outlet_label: outletLabel,
          stranded_staff_name: strandedName,
          shift_started_at: hold.started_at,
          sales_so_far_idr: summary.totalSalesIdr,
          txn_count: summary.txnCount,
        },
        triggered_by_event: "shift_override_request",
        triggered_at: now,
        token_hash: tokenHash,
        token_expires_at: now + TOKEN_TTL_MS,
        outletId,
      },
    );

    // Step 7: send Telegram card to managers. Delete the request row on failure
    // so the next attempt mints a fresh request cleanly (mirrors notifyStaffLockout).
    try {
      await ctx.runAction(api.telegram.send.sendTemplate, {
        role: "managers",
        kind: "shift_override",
        payload: {
          outlet_label: outletLabel,
          stranded_staff_name: strandedName,
          shift_started_at: hold.started_at,
          sales_so_far_idr: summary.totalSalesIdr,
          txn_count: summary.txnCount,
          approve_url: `${baseUrl}/approve/${rawToken}`,
        },
        idempotencyKey: `${args.idempotencyKey}:send`,
        outletId,
      });
    } catch (err) {
      await ctx.runMutation(internal.approvals.internal._deleteRequest_internal, {
        requestId,
      });
      throw err;
    }

    // Step 8: mark notified + write action-level idempotency cache
    await ctx.runMutation(internal.approvals.internal._markNotified_internal, {
      requestId,
    });

    const out = { requestId };
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "approvals.requestShiftOverride",
      response: JSON.stringify(out),
    });

    return out;
  },
});

/**
 * Off-booth shift-override approval via the Telegram link (v1.3.1 Task 5). The
 * approve-side counterpart to requestShiftOverride: an off-booth manager taps
 * the /approve/:token link, enters their staff CODE + PIN, picks Close or
 * Release, and the booth's stranded hold is force-ended (+ outlet closed if
 * Close). Copies approveSpoilage's security envelope VERBATIM — token auth
 * BEFORE the cache (rule #21 / I5), argon2 PIN verify after, SEC-07 lockout
 * isolation on miss — diverging only in the commit (the shared
 * _managerOverrideCommit_internal single writer, source="telegram_approval")
 * and the resolve key (top-level idempotencyKey, mirroring approveManualPayment,
 * because the commit is no-value and the resolve's { resolved: true } matches
 * this action's return shape).
 */
export const approveShiftOverride = action({
  args: {
    token: v.string(),
    managerStaffCode: v.string(),
    managerPin: v.string(),
    resultingState: v.union(v.literal("close"), v.literal("release")),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ resolved: true }> => {
    // Step 1: token auth BEFORE cache (rule #21 / I5). Token validation is one
    // indexed query + a constant-time compare — cheap. argon2 PIN verify stays
    // after the cache (expensive). Pre-I5 a caller without a valid token but
    // with a leaked idempotencyKey could replay the cached commit.
    const tokenHash = sha256Hex(args.token);
    const req = await ctx.runQuery(
      internal.approvals.internal._getByTokenHash_internal,
      { tokenHash },
    );
    if (!req) throw new Error("TOKEN_INVALID");

    const a = Buffer.from(tokenHash, "hex");
    const b = Buffer.from(req.token_hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("TOKEN_INVALID");
    }

    // Step 3: state guards (still part of auth — must reject before cache replay).
    if (req.kind !== "shift_override") throw new Error("WRONG_KIND");
    if (req.status !== "pending") throw new Error("REQUEST_RESOLVED");
    if (req.token_expires_at <= Date.now()) throw new Error("TOKEN_EXPIRED");

    // Step 4: action-level idempotency pre-check (after token auth).
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { resolved: true };

    // Step 5: narrow context. validateContext("shift_override", ...) already ran
    // at insert time (single-writer invariant on _createRequest_internal), so the
    // shape is guaranteed here — defensive narrowing only because context is
    // stored as v.any(). device_id is load-bearing: the commit resolves the
    // outlet from the device binding.
    const ctxBag = (req.context ?? {}) as {
      shift_id?: string;
      device_id?: string;
    };
    if (!ctxBag.shift_id) throw new Error("REQUEST_MISSING_SHIFT_ID");
    if (!ctxBag.device_id) throw new Error("REQUEST_MISSING_DEVICE_ID");

    // Step 6: resolve approving manager.
    const manager = await ctx.runQuery(internal.auth.internal._getByCode_internal, {
      code: args.managerStaffCode,
    });
    if (!manager || !manager.active || manager.role !== "manager") {
      throw new Error("NOT_MANAGER");
    }

    // Step 7: argon2-verify manager PIN; record failed attempt + per-token cap on miss.
    const ok = await argon2Verify({ password: args.managerPin, hash: manager.pin_hash });
    if (!ok) {
      // SEC-07: audit the off-booth miss but DON'T touch the booth lockout
      // counter (a leaked token must not DoS-lock the manager's booth login).
      // The per-token cap below bounds brute force on this path.
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        staffId: manager._id,
        deviceId: OFF_BOOTH_DEVICE_ID,
        countTowardLockout: false,
        source: "telegram_approval",
      });
      const capResult = await ctx.runMutation(
        internal.approvals.internal._recordTokenPinFailure_internal,
        { requestId: req._id },
      );
      if (capResult.capped) throw new Error("REQUEST_REVOKED");
      throw new Error("INVALID_PIN");
    }

    // Step 8: commit via the shared single writer (Task 2). closeOutlet branches
    // on the manager's Close/Release choice; source="telegram_approval" threads
    // through to the shift.manager_override audit row so dashboards can tell the
    // off-booth approval apart from the booth-inline managerOverride. The
    // :commit-suffixed key gives the commit its own withIdempotency cache,
    // distinct from the resolve's top-level key below.
    await ctx.runMutation(
      internal.shifts.shiftsInternal._managerOverrideCommit_internal,
      {
        idempotencyKey: `${args.idempotencyKey}:commit`,
        deviceId: ctxBag.device_id,
        managerStaffId: manager._id,
        closeOutlet: args.resultingState === "close",
        source: "telegram_approval",
      },
    );

    // Step 9: mark resolved + cache action response in ONE transaction (I6). The
    // TOP-LEVEL idempotencyKey is intentionally reused here (approveManualPayment
    // pattern, NOT approveSpoilage's derived :resolve key) because the commit is
    // no-value — _markResolved_internal's { resolved: true } cache blob matches
    // this action's return shape, so the step-4 _lookup_internal pre-check
    // replays it cleanly on retry.
    return await ctx.runMutation(internal.approvals.internal._markResolved_internal, {
      idempotencyKey: args.idempotencyKey,
      requestId: req._id,
      resolved_by_manager_id: manager._id,
      source: "telegram_approval",
    });
  },
});

/**
 * Off-booth spoilage approval request (v0.6 Task S5). Manager-initiated at
 * /mgr/spoilage when "Request via Telegram" is tapped (vs the booth-inline
 * manager-PIN path in S4 — same _recordSpoilage_internal writer, different
 * authorisation envelope).
 *
 * Mirrors requestRefundApproval / requestManualPaymentApproval exactly:
 *
 *   1. Action-level idempotency pre-check (ADR-013).
 *   2. Resolve session — MANAGER ONLY (spoilage is manager-initiated; the
 *      Telegram path exists for off-booth approval, not staff escalation).
 *   3. Validate args at the action boundary (lines non-empty, qty positive
 *      integer, reason non-blank). `_recordSpoilage_internal` re-validates
 *      at commit time — this catches bad input before the row is created.
 *   4. Mint a fresh spoilage_event_id (this is the entity_id on the approval
 *      row AND the spoilage_event_id stamped on each pos_stock_movements
 *      row at commit time, grouping multi-line spoilage events).
 *   5. Mint 32-byte URL-safe token; persist only its SHA-256 hash (ADR-029).
 *   6. Create the request row via _createRequest_internal with kind="spoilage"
 *      and the SpoilageContext payload (validated by approvals/kinds.ts).
 *   7. Send the Telegram card to the managers group. On failure, delete the
 *      request row (recovery mirrors requestRefundApproval / notifyStaffLockout)
 *      so the next attempt mints a fresh request cleanly.
 *   8. Mark notified + best-effort link telegram_message_id.
 *   9. Write the action-level idempotency cache.
 *
 * No dedup-by-entity guard here: each spoilage_event_id is freshly minted, so
 * two requests will never collide on (kind, entity_id). Same-key replay still
 * short-circuits via step 1's cache lookup.
 *
 * Never logs PIN values; the raw token appears only in the Telegram URL.
 */
export const requestSpoilageApproval = action({
  args: {
    sessionId: v.id("staff_sessions"),
    lines: v.array(v.object({
      inventory_sku_id: v.id("pos_inventory_skus"),
      sku_code: v.string(),
      qty: v.number(),
    })),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args): Promise<{ requestId: Id<"pos_approval_requests"> }> => {
    // I5 (auth BEFORE cache; rule #21): resolve session + manager-role check
    // is one indexed query — cheap. Closes the cached-response-to-unauthorised
    // caller hole. Use _resolveSession_internal so we get role + outlet_id in one shot.
    const requester = await ctx.runQuery(
      internal.auth.internal._resolveSession_internal,
      { sessionId: args.sessionId },
    );
    if (!requester) throw new Error("NO_SESSION");
    // Fetch role separately for the manager check (_resolveSession_internal returns staffId+deviceId+outlet_id).
    const requesterRole = await ctx.runQuery(
      internal.auth.internal._resolveSessionRole_internal,
      { sessionId: args.sessionId },
    );
    if (!requesterRole || requesterRole.role !== "manager") throw new Error("NOT_MANAGER");
    const outletId = requester.outlet_id;

    // Step 1: action-level idempotency pre-check (after auth)
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { requestId: Id<"pos_approval_requests"> };

    // Step 3: validate args at the action boundary. The commit path
    // (_recordSpoilage_internal) revalidates these — duplication is intentional
    // so a bad payload fails BEFORE the request row + Telegram send fire.
    if (args.lines.length === 0) throw new Error("LINES_EMPTY");
    if (args.reason.trim().length === 0) throw new Error("REASON_INVALID");
    for (const line of args.lines) {
      if (!Number.isInteger(line.qty) || line.qty <= 0) throw new Error("QTY_INVALID");
    }
    const total_qty = args.lines.reduce((s, l) => s + l.qty, 0);

    const baseUrl = process.env.POS_BASE_URL;
    if (!baseUrl) throw new Error("POS_BASE_URL not set");

    // Step 4: mint event_id — entity_id on the approval row AND
    // spoilage_event_id on each movement row written at commit time (S3 groups
    // multi-line events by this id). 16 bytes = collision-resistant for v1.
    const event_id = mintUrlSafeToken(16);

    // Step 5: mint approval token (only hash persisted — ADR-029)
    const rawToken = mintUrlSafeToken();
    const tokenHash = sha256Hex(rawToken);
    const now = Date.now();

    // Step 6: create the request row. Context carries inventory_sku_id +
    // sku_code per line + total_qty so the Telegram card and /approve UI
    // render a preview BEFORE the manager enters PIN (validateContext in
    // kinds.ts cross-checks total_qty against the line sum to catch
    // tampering at the manager-display layer).
    // v2.0 Stream 5: stamp outletId from session.
    const { requestId } = await ctx.runMutation(
      internal.approvals.internal._createRequest_internal,
      {
        kind: "spoilage",
        requester_staff_id: requester.staffId,
        entity_type: "pos_stock_movements",
        entity_id: event_id,
        context: {
          spoilage_event_id: event_id,
          lines: args.lines.map((l) => ({
            inventory_sku_id: l.inventory_sku_id as unknown as string,
            sku_code: l.sku_code,
            qty: l.qty,
          })),
          total_qty,
          reason: args.reason,
        },
        reason: args.reason,
        triggered_by_event: "spoilage_request",
        triggered_at: now,
        token_hash: tokenHash,
        token_expires_at: now + TOKEN_TTL_MS,
        outletId,
      },
    );

    // Step 7: send the Telegram card. On failure, delete the request row so the
    // next attempt mints a fresh request cleanly (mirrors requestRefundApproval).
    // The spoilage.requested audit row stays as a forensic trace (append-only).
    let messageId: number | undefined;
    try {
      const sendRes = await ctx.runAction(api.telegram.send.sendTemplate, {
        role: "managers",
        kind: "spoilage",
        payload: {
          spoilage_event_id: event_id,
          lines: args.lines.map((l) => ({ sku_code: l.sku_code, qty: l.qty })),
          total_qty,
          reason: args.reason,
          request_url: `${baseUrl}/approve/${rawToken}`,
        },
        idempotencyKey: `${args.idempotencyKey}:send`,
        outletId, // v2.0 Spec-4 Task 5: route to per-outlet managers (outletId = requester.outlet_id)
      });
      messageId = sendRes.message_id;
    } catch (err) {
      await ctx.runMutation(internal.approvals.internal._deleteRequest_internal, {
        requestId,
      });
      throw err;
    }

    // Step 8: mark notified + best-effort link telegram_message_id.
    await ctx.runMutation(internal.approvals.internal._markNotified_internal, { requestId });
    try {
      await ctx.runMutation(internal.approvals.internal._linkTelegramMessage_internal, {
        requestId,
        messageId,
        chatId: undefined,
      });
    } catch {
      // best-effort — never fail the request over a missing message link
    }

    // Step 9: cache the action-level response.
    const out = { requestId };
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "approvals.requestSpoilageApproval",
      response: JSON.stringify(out),
    });

    return out;
  },
});

/**
 * Off-booth spoilage approval via the Telegram link (v0.6 Task S5). Mirrors
 * approveRefund's envelope exactly — same token-auth-before-cache, same
 * constant-time compare, same per-token PIN-attempt cap, same lockout-self-
 * approve carve-out. The divergence is at commit: instead of _commitRefund_internal,
 * this calls inventory._recordSpoilage_internal (S3) — the single writer shared
 * with the booth-PIN path (S4), source distinguished by the `source` arg.
 *
 *   1. Token auth BEFORE cache (CLAUDE.md rule #21 / I5). A leaked
 *      idempotencyKey without a valid token must not replay the cached commit.
 *   2. Constant-time token compare (defense-in-depth; the index already matched).
 *   3. State guards: kind === "spoilage", status === "pending", token not expired.
 *   4. Action-level idempotency pre-check (after token auth).
 *   5. Narrow context (already validated by validateContext at insert time).
 *   6. Resolve approving manager by staff code (active manager only).
 *   7. argon2-verify managerPin against the MANAGER's hash. On fail, record a
 *      failed attempt + bump the per-token PIN-attempt cap. Token auto-revokes
 *      at the cap (REQUEST_REVOKED).
 *   8. Commit via inventory._recordSpoilage_internal with source="telegram_approval"
 *      so the audit row records the off-booth origin (vs booth_inline for S4).
 *   9. Mark request resolved with a DERIVED idempotency key (`:resolve` suffix).
 *      _markResolved_internal's withIdempotency cache writes { resolved: true },
 *      which doesn't match this action's { event_id, line_count, total_qty }
 *      shape — using a derived key keeps both cache rows independent.
 *   10. Write action-level idempotency cache with the real response shape.
 *
 * Locked-out manager self-approve (mirrors approveRefund Improvement #6):
 * INTENTIONAL. argon2Verify only consults the manager's pin_hash; lockout is
 * not checked. Token + correct PIN are sufficient authority.
 *
 * Never logs PIN or token values.
 */
export const approveSpoilage = action({
  args: {
    token: v.string(),
    managerStaffCode: v.string(),
    managerPin: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ event_id: string; line_count: number; total_qty: number }> => {
    // Step 1: token auth BEFORE cache (rule #21 / I5). Token validation is one
    // indexed query + a constant-time compare — cheap. argon2 PIN verify stays
    // after the cache (expensive). Pre-I5 a caller without a valid token but
    // with a leaked idempotencyKey could replay the cached commit.
    const tokenHash = sha256Hex(args.token);
    const req = await ctx.runQuery(
      internal.approvals.internal._getByTokenHash_internal,
      { tokenHash },
    );
    if (!req) throw new Error("TOKEN_INVALID");

    const a = Buffer.from(tokenHash, "hex");
    const b = Buffer.from(req.token_hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("TOKEN_INVALID");
    }

    // Step 3: state guards (still part of auth — must reject before cache replay).
    if (req.kind !== "spoilage") throw new Error("WRONG_KIND");
    if (req.status !== "pending") throw new Error("REQUEST_RESOLVED");
    if (req.token_expires_at <= Date.now()) throw new Error("TOKEN_EXPIRED");

    // Step 4: action-level idempotency pre-check (after token auth)
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { event_id: string; line_count: number; total_qty: number };

    // Step 5: narrow context. validateContext("spoilage", ...) already ran at
    // insert time (single-writer invariant on _createRequest_internal), so the
    // shape is guaranteed here — defensive narrowing only because context is
    // stored as v.any().
    const ctxBag = (req.context ?? {}) as {
      spoilage_event_id?: string;
      lines?: Array<{ inventory_sku_id: string; sku_code: string; qty: number }>;
      reason?: string;
    };
    if (!ctxBag.spoilage_event_id) throw new Error("REQUEST_MISSING_EVENT_ID");
    if (!Array.isArray(ctxBag.lines) || ctxBag.lines.length === 0) {
      throw new Error("REQUEST_MISSING_LINES");
    }
    if (!ctxBag.reason) throw new Error("REQUEST_MISSING_REASON");

    // Step 6: resolve approving manager
    const manager = await ctx.runQuery(internal.auth.internal._getByCode_internal, {
      code: args.managerStaffCode,
    });
    if (!manager || !manager.active || manager.role !== "manager") {
      throw new Error("NOT_MANAGER");
    }

    // Step 7: argon2-verify manager PIN; record failed attempt + per-token cap on miss
    const ok = await argon2Verify({ password: args.managerPin, hash: manager.pin_hash });
    if (!ok) {
      // SEC-07: audit the off-booth miss but DON'T touch the booth lockout
      // counter (a leaked token must not DoS-lock the manager's booth login).
      // The per-token cap below bounds brute force on this path.
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        staffId: manager._id,
        deviceId: OFF_BOOTH_DEVICE_ID,
        countTowardLockout: false,
        source: "telegram_approval",
      });
      const capResult = await ctx.runMutation(
        internal.approvals.internal._recordTokenPinFailure_internal,
        { requestId: req._id },
      );
      if (capResult.capped) throw new Error("REQUEST_REVOKED");
      throw new Error("INVALID_PIN");
    }

    // Step 8: commit via the single writer (S3). source="telegram_approval"
    // threads through to the stock.spoilage audit row so dashboards can tell
    // off-booth approvals apart from booth-inline (S4).
    // v2.0 Task 9E: thread outlet_id from the approval request row so the
    // stock movements and on_hand cache row are outlet-stamped. The request row
    // inherited outlet_id from the requester session when requestSpoilageApproval
    // was called — pulling it here keeps the commit consistent with the request.
    const result = await ctx.runMutation(
      internal.inventory.internal._recordSpoilage_internal,
      {
        spoilage_event_id: ctxBag.spoilage_event_id,
        lines: ctxBag.lines.map((l) => ({
          inventory_sku_id: l.inventory_sku_id as unknown as Id<"pos_inventory_skus">,
          qty: l.qty,
        })),
        reason: ctxBag.reason,
        actor_id: manager._id,
        source: "telegram_approval",
        outlet_id: req.outlet_id,
      },
    );

    // Step 9: mark request resolved. DERIVED idempotency key so the resolve
    // mutation's withIdempotency cache ({ resolved: true }) does not collide
    // with the action-level cache below ({ event_id, line_count, total_qty }).
    // Mirrors approveRefund's derived-key pattern.
    await ctx.runMutation(internal.approvals.internal._markResolved_internal, {
      idempotencyKey: `${args.idempotencyKey}:resolve`,
      requestId: req._id,
      resolved_by_manager_id: manager._id,
      source: "telegram_approval",
    });

    // Step 10: cache action-level response. Top-level idempotencyKey stores the
    // { event_id, line_count, total_qty } blob the UI consumes; same-key retries
    // replay this blob via step 4 without re-running the commit.
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "approvals.approveSpoilage",
      response: JSON.stringify(result),
    });

    return result;
  },
});
