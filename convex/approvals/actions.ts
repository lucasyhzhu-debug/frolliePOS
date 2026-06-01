"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal, api } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { argon2Verify } from "hash-wasm";
import { createHash, timingSafeEqual } from "node:crypto";
import { mintUrlSafeToken } from "../lib/tokens";

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
    const rawToken = mintUrlSafeToken();
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
        role: "managers",
        kind: "staff_pin_reset",
        payload: {
          staff_name: staffInfo.name,
          staff_code: staffInfo.code ?? "(no code)",
          locked_at_iso: new Date(now).toISOString(),
          request_url: requestUrl,
        },
        idempotencyKey: `notifyLockout:${requestId}`,
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
    const existing = await ctx.runQuery(
      internal.approvals.internal._listPendingByKind_internal,
      { kind: "manual_payment_override", entityId: args.txnId as unknown as string },
    );
    if (existing.length > 0) return { requestId: existing[0]._id };

    const baseUrl = process.env.POS_BASE_URL;
    if (!baseUrl) throw new Error("POS_BASE_URL not set");

    // Step 5: mint token (only hash persisted — ADR-029)
    const rawToken = mintUrlSafeToken();
    const tokenHash = sha256Hex(rawToken);
    const now = Date.now();

    // Step 6: create request row
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
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        idempotencyKey: `${args.idempotencyKey}:failed`,
        staffId: manager._id,
        deviceId: OFF_BOOTH_DEVICE_ID,
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
    // Step 1: action-level idempotency pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { refundId: Id<"pos_refunds">; total_refund: number };

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
    if (req.kind !== "refund") throw new Error("WRONG_KIND");
    if (req.status !== "pending") throw new Error("REQUEST_RESOLVED");
    if (req.token_expires_at <= Date.now()) throw new Error("TOKEN_EXPIRED");

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
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        idempotencyKey: `${args.idempotencyKey}:failed`,
        staffId: manager._id,
        deviceId: OFF_BOOTH_DEVICE_ID,
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
      await ctx.runMutation(internal.auth.internal._recordFailedAttempt_internal, {
        idempotencyKey: `${args.idempotencyKey}:failed`,
        staffId: manager._id,
        deviceId: OFF_BOOTH_DEVICE_ID,
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
