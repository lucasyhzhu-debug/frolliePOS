import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { logAudit } from "../audit/internal";
import { withIdempotency } from "../idempotency/internal";
import { validateContext, KIND_AUDIT } from "./kinds";
import { TOKEN_PIN_ATTEMPT_CAP } from "./lib";

/**
 * Insert a new pos_approval_requests row in "pending" status.
 * Token fields (token_hash, token_expires_at) are supplied by the caller —
 * raw token generation happens in the action layer (ADR-029: token authorises VIEW).
 *
 * INVARIANT: every insert goes through validateContext — context is validated
 * per-kind before the row is written. Adding a kind requires extending kinds.ts.
 * v0.3 behavior preserved: staff_pin_reset passes no context; validateContext
 * returns {} so the context field is stored as an empty object.
 */
export const _createRequest_internal = internalMutation({
  args: {
    kind: v.union(
      v.literal("staff_pin_reset"),
      v.literal("manual_payment_override"),
    ),
    requester_staff_id: v.optional(v.id("staff")),
    entity_type: v.optional(v.string()),
    entity_id: v.optional(v.string()),
    subject_staff_id: v.optional(v.id("staff")),
    context: v.optional(v.any()),
    reason: v.optional(v.string()),
    triggered_by_event: v.string(),
    triggered_at: v.number(),
    token_hash: v.string(),
    token_expires_at: v.number(),
  },
  handler: async (ctx, args) => {
    // INVARIANT: every writer validates context here — no bypass path.
    const validatedContext = validateContext(args.kind, args.context);

    const requestId = await ctx.db.insert("pos_approval_requests", {
      kind: args.kind,
      requester_staff_id: args.requester_staff_id,
      entity_type: args.entity_type,
      entity_id: args.entity_id,
      subject_staff_id: args.subject_staff_id,
      context: validatedContext,
      reason: args.reason,
      triggered_by_event: args.triggered_by_event,
      triggered_at: args.triggered_at,
      token_hash: args.token_hash,
      token_expires_at: args.token_expires_at,
      status: "pending",
      notification_channel: "telegram",
    });

    await logAudit(ctx, {
      actor_id: args.requester_staff_id ?? "system",
      action: KIND_AUDIT[args.kind].requested,
      entity_type: "pos_approval_requests",
      entity_id: requestId,
      source: "system",
      // approval_request_id surfaced explicitly in metadata per ADR-030 amendment —
      // the `by_entity` index already covers entity_id lookups, but keeping the
      // id in metadata matches the convention used by <kind>.resolved/<kind>.denied rows.
      metadata: {
        approval_request_id: requestId,
        kind: args.kind,
        entity_id: args.entity_id,
        subject_staff_id: args.subject_staff_id,
      },
    });

    return { requestId };
  },
});

/**
 * Delete an approval request row. Used by notifyStaffLockout's recovery path: if
 * the Telegram send fails after the row was created (but before notified_at is
 * stamped), the stuck pending row would block the dedup guard for the full token
 * TTL — leaving managers blind. Deleting it lets the next lockout cycle create a
 * fresh request cleanly. approvals owns pos_approval_requests (ADR-034), so the
 * delete lives here. The "approval.created" audit row stays as a forensic trace
 * (append-only log).
 */
export const _deleteRequest_internal = internalMutation({
  args: {
    requestId: v.id("pos_approval_requests"),
  },
  handler: async (ctx, args) => {
    // Emit a compensating audit row BEFORE deleting so the trail self-documents:
    // <kind>.requested → approval.notification_failed (no notified, no resolved),
    // rather than an orphaned <kind>.requested with no follow-up (m-6).
    await logAudit(ctx, {
      actor_id: "system",
      action: "approval.notification_failed",
      entity_type: "pos_approval_requests",
      entity_id: args.requestId,
      source: "system",
      reason: "telegram_send_failed",
    });
    await ctx.db.delete(args.requestId);
  },
});

/**
 * Record that the notification was sent for an approval request.
 * ADR-035 (supersedes ADR-027): the off-booth PIN-reset link is delivered via the
 * managers' Telegram group; this stamps when that notification went out.
 */
export const _markNotified_internal = internalMutation({
  args: {
    requestId: v.id("pos_approval_requests"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      notified_at: Date.now(),
    });

    await logAudit(ctx, {
      actor_id: "system",
      action: "approval.notified",
      entity_type: "pos_approval_requests",
      entity_id: args.requestId,
      source: "system",
    });
  },
});

/**
 * Mark an approval request as resolved by a manager.
 * ADR-029: PIN authorises ACT — the caller must have already verified the manager PIN
 * before calling this mutation.
 *
 * withIdempotency-wrapped: the resolve patch + audit + cache row commit in ONE
 * Convex transaction (I6). As the final commit step of approveStaffPinReset, this
 * closes the commit-then-cache window — a same-key retry replays the cached
 * { resolved: true } instead of throwing REQUEST_RESOLVED on the already-resolved row.
 */
export const _markResolved_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    requestId: v.id("pos_approval_requests"),
    resolved_by_manager_id: v.id("staff"),
    // v0.4 (Task 21): origin of the resolve. The action layer threads
    // "telegram_approval" for both shipped kinds (staff_pin_reset, manual_payment_override).
    // Kept as a parameter (not hardcoded) so future kinds can record a different
    // origin (e.g. booth_inline if a manager ever resolves at the booth).
    source: v.union(v.literal("wa_approval"), v.literal("telegram_approval")),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      requestId: Id<"pos_approval_requests">;
      resolved_by_manager_id: Id<"staff">;
      source: "wa_approval" | "telegram_approval";
    },
    { resolved: true }
  >(
    "approvals.approveStaffPinReset",
    async (ctx, args) => {
      // Single-use enforcement: if a concurrent approval (a different manager
      // opening the same /approve link with its own idempotencyKey) already
      // resolved this request, reject rather than double-resolve + double-audit.
      // Same-key retries never reach here — withIdempotency short-circuits first.
      const req = await ctx.db.get(args.requestId);
      if (!req) throw new Error("REQUEST_NOT_FOUND");
      // Same error code as the action-layer pre-check (actions.ts), so the
      // frontend mapError needs only one branch. Fires only on a concurrent
      // second manager racing to commit; same-key retries short-circuit
      // at the withIdempotency cache lookup above.
      if (req.status !== "pending") throw new Error("REQUEST_RESOLVED");
      await ctx.db.patch(args.requestId, {
        status: "resolved",
        resolved_at: Date.now(),
        resolved_by_manager_id: args.resolved_by_manager_id,
      });

      // Audit action string comes from KIND_AUDIT (ADR-030 + business rule #20):
      // route via the registry so per-kind divergence stays in one place. Metadata
      // carries approval_request_id + kind so dashboards can filter "all resolved
      // manual_payment approvals" without joining back to pos_approval_requests.
      await logAudit(ctx, {
        actor_id: args.resolved_by_manager_id,
        action: KIND_AUDIT[req.kind].resolved,
        entity_type: "pos_approval_requests",
        entity_id: args.requestId,
        source: args.source,
        mgr_approver_id: args.resolved_by_manager_id,
        metadata: { approval_request_id: args.requestId, kind: req.kind },
      });

      return { resolved: true as const };
    },
  ),
});

/**
 * List pending, unexpired staff_pin_reset requests for a staff member.
 * Used by notifyStaffLockout's dedup guard (staffreview Improvement #5): if any
 * row is already pending and live, the second lockout notification is skipped.
 */
export const _listPendingForStaff_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", args.staffId))
      .collect();
    const now = Date.now();
    return rows.filter(
      (r) =>
        r.kind === "staff_pin_reset" &&
        r.status === "pending" &&
        r.token_expires_at > now,
    );
  },
});

/**
 * Resolve an approval request by its token hash (sha256 hex). Returns the full
 * row (including token_hash) so the action layer can do a constant-time compare
 * and check status / expiry. INTERNAL — never exposed to a public client.
 */
export const _getByTokenHash_internal = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", args.tokenHash))
      .first();
  },
});

/**
 * Deny a pending approval request. Terminal — mirrors _markResolved_internal
 * but sets status="denied". withIdempotency-wrapped so concurrent manager
 * retries or double-taps don't double-write the deny lifecycle.
 */
export const _markDenied_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    requestId: v.id("pos_approval_requests"),
    denied_by_manager_id: v.id("staff"),
    deny_reason: v.string(),
    // Origin of the deny — symmetric to _markResolved_internal so a future
    // booth-inline deny path (any kind) can record source factually.
    source: v.union(v.literal("wa_approval"), v.literal("telegram_approval")),
  },
  handler: withIdempotency<
    {
      idempotencyKey: string;
      requestId: Id<"pos_approval_requests">;
      denied_by_manager_id: Id<"staff">;
      deny_reason: string;
      source: "wa_approval" | "telegram_approval";
    },
    { denied: true }
  >(
    "approvals.denyRequest",
    async (ctx, args) => {
      const req = await ctx.db.get(args.requestId);
      if (!req) throw new Error("REQUEST_NOT_FOUND");
      // Same error code as the action-layer pre-check (actions.ts), so the
      // frontend mapError needs only one branch. Fires only on a concurrent
      // second manager racing to commit; same-key retries short-circuit
      // at the withIdempotency cache lookup above.
      if (req.status !== "pending") throw new Error("REQUEST_RESOLVED");
      await ctx.db.patch(args.requestId, {
        status: "denied",
        denied_at: Date.now(),
        denied_by_manager_id: args.denied_by_manager_id,
        deny_reason: args.deny_reason,
      });
      await logAudit(ctx, {
        actor_id: args.denied_by_manager_id,
        action: KIND_AUDIT[req.kind].denied,
        entity_type: "pos_approval_requests",
        entity_id: args.requestId,
        source: args.source,
        mgr_approver_id: args.denied_by_manager_id,
        reason: args.deny_reason,
        metadata: { approval_request_id: args.requestId, kind: req.kind },
      });
      return { denied: true as const };
    },
  ),
});

/**
 * Dedup guard for non-staff kinds: list live pending rows for (kind, entity_id).
 * Used by the v0.4 notify actions to skip a second notification while a live
 * pending request already exists for the same entity.
 *
 * `kind` is a literal union (not v.string()) so Convex runtime-validates the
 * arg — without this, a typo'd kind would silently return [] via the
 * `by_kind_status` index (no matching rows for "manual_paymet_override").
 * The single-writer invariant on _createRequest_internal still enforces
 * `validateContext`; this validator catches caller-side typos at the read path.
 */
export const _listPendingByKind_internal = internalQuery({
  args: {
    kind: v.union(
      v.literal("staff_pin_reset"),
      v.literal("manual_payment_override"),
    ),
    entityId: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_kind_status", (q) =>
        q.eq("kind", args.kind).eq("status", "pending"),
      )
      .collect();
    const now = Date.now();
    return rows.filter(
      (r) => r.entity_id === args.entityId && r.token_expires_at > now,
    );
  },
});

/**
 * Best-effort patch of the sent Telegram message id + chat id onto the request
 * row (called after a successful Telegram send so we can later edit/delete the
 * message). Never throws on missing row — best-effort by design.
 */
export const _linkTelegramMessage_internal = internalMutation({
  args: {
    requestId: v.id("pos_approval_requests"),
    messageId: v.optional(v.number()),
    chatId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.requestId, {
      telegram_message_id: args.messageId,
      telegram_chat_id: args.chatId,
    });
  },
});

/**
 * Shared system-deny patch. Three v0.5.0 callers — all now DELEGATE here
 * (none inline their own deny-write block):
 *   (1) Token PIN-cap auto-deny (_recordTokenPinFailure_internal) — source: "system",
 *       extra_metadata: { failed_pin_attempts }.
 *   (2) Manager-initiated cancelPendingRequest (Task 10) — source: "telegram_approval"
 *       when actioned from the off-booth Telegram UI, or "booth_inline" when from
 *       the in-booth manager panel. Carries cancelled_by_manager_id for mgr_approver_id.
 *   (3) cancelAwaitingPayment / cancelTransaction cascade (Task 11) via
 *       _cancelPendingManualPaymentForTxn_internal — source: "system",
 *       extra_metadata: { cascaded_from_txn }.
 * Caller supplies `source` explicitly so audit data is semantically correct for
 * each context — mirrors the _markResolved_internal / _markDenied_internal pattern.
 * Returns { denied: true } on success, { denied: false } no-op if already terminal.
 */
export const _markDeniedBySystem_internal = internalMutation({
  args: {
    requestId: v.id("pos_approval_requests"),
    deny_reason: v.string(),
    cancelled_by_manager_id: v.optional(v.id("staff")),
    source: v.union(
      v.literal("booth_inline"),
      v.literal("telegram_approval"),
      v.literal("system"),
    ),
    // F3: constrained to the only current consumer shapes — rejects unknown
    // scalars or keys that could silently overwrite canonical audit fields.
    extra_metadata: v.optional(v.object({
      failed_pin_attempts: v.optional(v.number()),
      // F5: cascade-deny path threads cascaded_from_txn for dashboard filtering.
      cascaded_from_txn: v.optional(v.id("pos_transactions")),
    })),
  },
  handler: async (ctx, args) => {
    const req = await ctx.db.get(args.requestId);
    if (!req) throw new Error("REQUEST_NOT_FOUND");
    if (req.status !== "pending") return { denied: false };
    await ctx.db.patch(args.requestId, {
      status: "denied",
      denied_at: Date.now(),
      denied_by_manager_id: args.cancelled_by_manager_id ?? "system",
      deny_reason: args.deny_reason,
    });
    // source column is the discriminator for system vs booth_inline vs
    // telegram_approval. Do not duplicate as metadata.cancelled_via (F9).
    // F3: spread extra_metadata FIRST so canonical keys win over any caller-
    // supplied overrides (safe because the validator now constrains the shape).
    await logAudit(ctx, {
      actor_id: args.cancelled_by_manager_id ?? "system",
      action: KIND_AUDIT[req.kind].denied,
      entity_type: "pos_approval_requests",
      entity_id: args.requestId,
      source: args.source,
      // F8: thread mgr_approver_id when present (booth_inline cancel path) so
      // dashboards filtering by mgr_approver_id surface booth cancels too.
      mgr_approver_id: args.cancelled_by_manager_id,
      reason: args.deny_reason,
      metadata: {
        ...(args.extra_metadata ?? {}),
        approval_request_id: args.requestId,
        kind: req.kind,
      },
    });
    return { denied: true };
  },
});

/**
 * Cascade-deny all live pending manual_payment_override approvals for a given txn.
 * Used when a sale is cancelled mid-payment so managers can't approve a request
 * whose underlying txn already moved on.
 *
 * M5 rename: was _cancelPendingApprovalsForTxn_internal — that name implied
 * kind-agnostic behaviour but the implementation hardcodes kind==="manual_payment_override".
 * Renamed to match actual scope. Future kinds requiring cascade should parameterize kind
 * at that point.
 */
export const _cancelPendingManualPaymentForTxn_internal = internalMutation({
  args: { txnId: v.id("pos_transactions"), reason: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_kind_status", (q) => q.eq("kind", "manual_payment_override").eq("status", "pending"))
      .collect();
    const now = Date.now();
    for (const req of rows) {
      if (req.entity_id !== args.txnId) continue;
      // Skip already-expired rows — they're user-visible as "expired" via effectiveStatus;
      // re-patching to "denied" would change audit shape without changing UX.
      if (req.token_expires_at <= now) continue;
      // F5: delegate to _markDeniedBySystem_internal instead of inlining the deny-write.
      // The cascade-specific metadata (cascaded_from_txn) is passed via extra_metadata
      // so the shared helper emits a consistent audit row (including cancelled_by_manager_id
      // and source discriminator) without duplicate code. Cascade-specific pre-filter
      // (entity_id + expiry skip) stays here before the delegate call.
      await ctx.runMutation(
        internal.approvals.internal._markDeniedBySystem_internal,
        {
          requestId: req._id,
          deny_reason: args.reason,
          source: "system",
          extra_metadata: { cascaded_from_txn: args.txnId },
        },
      );
    }
  },
});

/**
 * Increment failed_pin_attempts and auto-deny on cap-trip. Called from action
 * sites after argon2id PIN verify fails. Returns { capped: true } if the 5th
 * miss tripped the cap so the caller can throw REQUEST_REVOKED instead of
 * INVALID_PIN.
 */
// NOTE: _recordTokenPinFailure_internal imports internal to delegate to
// _markDeniedBySystem_internal via ctx.runMutation. The import is already at
// the top of this file (convex/_generated/api).
export const _recordTokenPinFailure_internal = internalMutation({
  args: { requestId: v.id("pos_approval_requests") },
  handler: async (ctx, args) => {
    const req = await ctx.db.get(args.requestId);
    if (!req) throw new Error("REQUEST_NOT_FOUND");
    if (req.status !== "pending") return { capped: false };
    const next = (req.failed_pin_attempts ?? 0) + 1;
    await ctx.db.patch(args.requestId, { failed_pin_attempts: next });
    if (next >= TOKEN_PIN_ATTEMPT_CAP) {
      // C3: delegate to _markDeniedBySystem_internal instead of inlining the
      // deny-write block. Keeps the two-writer invariant at one callsite.
      // extra_metadata carries failed_pin_attempts for dashboard disambiguation (M4).
      const result = await ctx.runMutation(
        internal.approvals.internal._markDeniedBySystem_internal,
        {
          requestId: args.requestId,
          deny_reason: "too_many_pin_attempts",
          source: "system",
          extra_metadata: { failed_pin_attempts: next },
        },
      );
      // F4: if the delegate found the row already terminal (concurrent resolve
      // raced ahead), do NOT report capped — the caller's action site will
      // throw INVALID_PIN instead, which is correct: the PIN was wrong, but
      // the request's terminal state is what matters.
      return { capped: result.denied };
    }
    return { capped: false };
  },
});
