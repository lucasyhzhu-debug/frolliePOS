import { query, mutation } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { Id } from "../_generated/dataModel";
import { requireManagerSession } from "../auth/sessions";
import { withIdempotency } from "../idempotency/internal";
import { effectiveStatus, type EffectiveStatus } from "./lib";
import { sha256Hex } from "../lib/sha256";

// ---------------------------------------------------------------------------
// Discriminated return type for getByToken
// ---------------------------------------------------------------------------

// Shared "decision details" populated when status === "denied". Set per-kind so
// the already-resolved/denied surfaces can render informative copy ("Declined by
// Lucas — 'suspicious lockout'") instead of a generic ✓-ish acknowledgement.
type DenyDetails = {
  denied_at?: number;
  deny_reason?: string;
  denied_by_manager_name?: string;
  denied_by_manager_code?: string;
};

type StaffPinResetResult = {
  kind: "staff_pin_reset";
  subject_staff_name: string;
  subject_staff_code?: string;
  status: EffectiveStatus;
  triggered_at: number;
  token_expires_at: number;
  resolved_at?: number;
} & DenyDetails;

type ManualPaymentOverrideResult = {
  kind: "manual_payment_override";
  display: {
    amount_idr: number;
    reason: string;
    receipt_preview?: string;
    requester_name?: string;
  };
  status: EffectiveStatus;
  triggered_at: number;
  token_expires_at: number;
  resolved_at?: number;
} & DenyDetails;

type RefundResult = {
  kind: "refund";
  display: {
    receipt_number: string;
    total_refund: number;
    reason: string;
    lines: Array<{
      product_name: string;
      refund_qty: number;
      refund_amount: number;
    }>;
    requester_name?: string;
  };
  status: EffectiveStatus;
  triggered_at: number;
  token_expires_at: number;
  resolved_at?: number;
} & DenyDetails;

// v0.6 S7: spoilage variant. Strips inventory_sku_id from the public surface
// (storage-internal — same convention as RefundResult stripping line_id).
type SpoilageResult = {
  kind: "spoilage";
  display: {
    spoilage_event_id: string;
    total_qty: number;
    reason: string;
    lines: Array<{ sku_code: string; qty: number }>;
    requester_name?: string;
  };
  status: EffectiveStatus;
  triggered_at: number;
  token_expires_at: number;
  resolved_at?: number;
} & DenyDetails;

type GetByTokenResult =
  | StaffPinResetResult
  | ManualPaymentOverrideResult
  | RefundResult
  | SpoilageResult;

/**
 * Resolve an approval request by its raw token (for the off-booth approval page).
 * ADR-029: token authorises VIEW — returns display fields only. token_hash is NEVER
 * included in the return value.
 *
 * Returns a discriminated union on `kind`:
 *   - "staff_pin_reset": subject_staff_name/code from auth module boundary
 *   - "manual_payment_override": display.{amount_idr, reason, receipt_preview?, requester_name?}
 *   - "refund": display.{receipt_number, total_refund, reason, lines, requester_name?}
 *   - "spoilage": display.{spoilage_event_id, total_qty, reason, lines, requester_name?}
 *
 * Effective status rules (DB row is not mutated here; cleanup is a future job):
 *   - If row.status === "pending" && row.token_expires_at <= Date.now() → "expired"
 *   - Otherwise: row.status as-is.
 */
export const getByToken = query({
  args: { rawToken: v.string() },
  // Explicit return type breaks the cross-module circular inference (this handler
  // calls ctx.runQuery on the auth internal surface). Without it tsc -b collapses
  // the inferred type to `any`.
  handler: async (ctx, args): Promise<GetByTokenResult | null> => {
    const hash = await sha256Hex(args.rawToken);

    const req = await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", hash))
      .first();

    if (!req) return null;

    // Compute effective status without mutating the DB row
    const eff: EffectiveStatus = effectiveStatus(req);

    const base = {
      status: eff,
      triggered_at: req.triggered_at,
      token_expires_at: req.token_expires_at,
      ...(req.resolved_at !== undefined ? { resolved_at: req.resolved_at } : {}),
    };

    // Populate denier details (reason + manager name/code) when the row is denied,
    // so the "already denied" surfaces can render informative copy instead of a
    // generic message. Cross-module read goes via auth/internal per ADR-034.
    const denyDetails: DenyDetails = {};
    if (eff === "denied") {
      if (req.denied_at !== undefined) denyDetails.denied_at = req.denied_at;
      if (req.deny_reason !== undefined) denyDetails.deny_reason = req.deny_reason;
      if (req.denied_by_manager_id && req.denied_by_manager_id !== "system") {
        const m = await ctx.runQuery(
          internal.auth.internal._getStaffNameCode_internal,
          { staffId: req.denied_by_manager_id },
        );
        if (m) {
          denyDetails.denied_by_manager_name = m.name;
          if (m.code) denyDetails.denied_by_manager_code = m.code;
        }
      }
    }

    if (req.kind === "staff_pin_reset") {
      if (!req.subject_staff_id) return null;

      // Resolve staff via auth module boundary (ADR-034: approvals does not own `staff`)
      const staffInfo = await ctx.runQuery(
        internal.auth.internal._getStaffNameCode_internal,
        { staffId: req.subject_staff_id },
      );

      if (!staffInfo) return null;

      return {
        kind: "staff_pin_reset",
        subject_staff_name: staffInfo.name,
        subject_staff_code: staffInfo.code,
        ...base,
        ...denyDetails,
      };
    }

    if (req.kind === "manual_payment_override") {
      const ctx2 = req.context as
        | { txn_id?: string; amount_idr?: number; reason?: string; receipt_preview?: string }
        | undefined;

      const amount_idr: number = ctx2?.amount_idr ?? 0;
      const reason: string = ctx2?.reason ?? req.reason ?? "";

      // Resolve requester name via auth module boundary when requester_staff_id is set
      let requester_name: string | undefined;
      if (req.requester_staff_id) {
        const info = await ctx.runQuery(
          internal.auth.internal._getStaffNameCode_internal,
          { staffId: req.requester_staff_id },
        );
        requester_name = info?.name;
      }

      return {
        kind: "manual_payment_override",
        display: {
          amount_idr,
          reason,
          ...(ctx2?.receipt_preview !== undefined
            ? { receipt_preview: ctx2.receipt_preview }
            : {}),
          ...(requester_name !== undefined ? { requester_name } : {}),
        },
        ...base,
        ...denyDetails,
      };
    }

    if (req.kind === "refund") {
      const ctx2 = req.context as
        | {
            receipt_number?: string;
            total_refund?: number;
            reason?: string;
            lines?: Array<{
              product_name?: string;
              refund_qty?: number;
              refund_amount?: number;
            }>;
          }
        | undefined;

      // B28a I2: validateContext("refund", ...) GUARANTEES these fields are
      // present and well-formed BEFORE the row is written. If any are missing
      // at READ time, the row was corrupted post-insert (manual DB edit, future
      // migration regression, etc.) — throw CONTEXT_CORRUPTED rather than
      // silently degrading to "Refund of Rp 0 approved" in the manager UI.
      // Distinct prefix from CONTEXT_INVALID (write-time) so the breadcrumb
      // names the failure mode (read-time on an already-persisted row).
      // Per v0.5.1a MEMORY lesson: hardcoded deferred values become
      // customer-facing lies; fail loud instead.
      if (typeof ctx2?.receipt_number !== "string" || ctx2.receipt_number === "") {
        throw new Error("CONTEXT_CORRUPTED: receipt_number");
      }
      if (typeof ctx2.total_refund !== "number" || !Number.isInteger(ctx2.total_refund) || ctx2.total_refund <= 0) {
        throw new Error("CONTEXT_CORRUPTED: total_refund");
      }
      if (typeof ctx2.reason !== "string" || ctx2.reason.trim() === "") {
        throw new Error("CONTEXT_CORRUPTED: reason");
      }
      if (!Array.isArray(ctx2.lines) || ctx2.lines.length === 0) {
        throw new Error("CONTEXT_CORRUPTED: lines");
      }
      const receipt_number = ctx2.receipt_number;
      const total_refund: number = ctx2.total_refund;
      const reason: string = ctx2.reason;
      // Strip line_id from the public surface — storage-internal per the
      // existing pattern (see ManualPayment which never exposes context).
      const lines = ctx2.lines.map((l) => {
        if (typeof l.product_name !== "string") {
          throw new Error("CONTEXT_CORRUPTED: line.product_name");
        }
        if (!Number.isInteger(l.refund_qty) || (l.refund_qty as number) <= 0) {
          throw new Error("CONTEXT_CORRUPTED: line.refund_qty");
        }
        if (!Number.isInteger(l.refund_amount) || (l.refund_amount as number) < 0) {
          throw new Error("CONTEXT_CORRUPTED: line.refund_amount");
        }
        return {
          product_name: l.product_name,
          refund_qty: l.refund_qty as number,
          refund_amount: l.refund_amount as number,
        };
      });

      let requester_name: string | undefined;
      if (req.requester_staff_id) {
        const info = await ctx.runQuery(
          internal.auth.internal._getStaffNameCode_internal,
          { staffId: req.requester_staff_id },
        );
        requester_name = info?.name;
      }

      return {
        kind: "refund",
        display: {
          receipt_number,
          total_refund,
          reason,
          lines,
          ...(requester_name !== undefined ? { requester_name } : {}),
        },
        ...base,
        ...denyDetails,
      };
    }

    if (req.kind === "spoilage") {
      const ctx2 = req.context as
        | {
            spoilage_event_id?: string;
            lines?: Array<{
              inventory_sku_id?: string;
              sku_code?: string;
              qty?: number;
            }>;
            total_qty?: number;
            reason?: string;
          }
        | undefined;

      // validateContext("spoilage", ...) guarantees these fields at write time
      // (single-writer invariant on _createRequest_internal). If anything is
      // missing at read time the row was corrupted post-insert — throw
      // CONTEXT_CORRUPTED rather than rendering a "0 units" spoilage card.
      // Mirrors refund's read-time guards (v0.5.1a "fail loud" lesson).
      if (typeof ctx2?.spoilage_event_id !== "string" || ctx2.spoilage_event_id === "") {
        throw new Error("CONTEXT_CORRUPTED: spoilage_event_id");
      }
      if (
        typeof ctx2.total_qty !== "number" ||
        !Number.isInteger(ctx2.total_qty) ||
        ctx2.total_qty <= 0
      ) {
        throw new Error("CONTEXT_CORRUPTED: total_qty");
      }
      if (typeof ctx2.reason !== "string" || ctx2.reason.trim() === "") {
        throw new Error("CONTEXT_CORRUPTED: reason");
      }
      if (!Array.isArray(ctx2.lines) || ctx2.lines.length === 0) {
        throw new Error("CONTEXT_CORRUPTED: lines");
      }

      // Strip inventory_sku_id from the public surface — storage-internal,
      // same convention as refund stripping line_id.
      const lines = ctx2.lines.map((l) => {
        if (typeof l.sku_code !== "string" || l.sku_code === "") {
          throw new Error("CONTEXT_CORRUPTED: line.sku_code");
        }
        if (!Number.isInteger(l.qty) || (l.qty as number) <= 0) {
          throw new Error("CONTEXT_CORRUPTED: line.qty");
        }
        return { sku_code: l.sku_code, qty: l.qty as number };
      });

      let requester_name: string | undefined;
      if (req.requester_staff_id) {
        const info = await ctx.runQuery(
          internal.auth.internal._getStaffNameCode_internal,
          { staffId: req.requester_staff_id },
        );
        requester_name = info?.name;
      }

      return {
        kind: "spoilage",
        display: {
          spoilage_event_id: ctx2.spoilage_event_id,
          total_qty: ctx2.total_qty,
          reason: ctx2.reason,
          lines,
          ...(requester_name !== undefined ? { requester_name } : {}),
        },
        ...base,
        ...denyDetails,
      };
    }

    // Exhaustive: any future kind not yet handled → null (safe fallback)
    return null;
  },
});

/**
 * Reactive status query for the frontend useApproval hook.
 * Returns just the effective status of a request by its ID.
 * Useful for polling-free live updates on the approve landing page.
 */
export const getRequestStatus = query({
  args: { requestId: v.id("pos_approval_requests") },
  handler: async (
    ctx,
    args,
  ): Promise<{ status: EffectiveStatus } | null> => {
    const req = await ctx.db.get(args.requestId);
    if (!req) return null;
    return { status: effectiveStatus(req) };
  },
});

/**
 * Most recent staff_pin_reset request for a given staff, within a recency
 * window so stale terminal-state rows don't keep firing the login-screen
 * "your reset was declined" toast on every session. v0.4 surface: the
 * locked-out staff sits on the PIN screen waiting for the manager — if the
 * manager declines via Telegram, the login screen needs to surface that.
 *
 * Returns null when there's no recent pin_reset for this staff. Otherwise
 * returns the row's effective status + denier details when denied. NOT
 * token-gated — staff identity is already public on the login picker, so
 * this isn't a fresh info leak.
 */
export const getRecentPinResetForStaff = query({
  args: { staffId: v.id("staff") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    requestId: string;
    status: EffectiveStatus;
    triggered_at: number;
    deny_reason?: string;
    denied_by_manager_name?: string;
    denied_by_manager_code?: string;
    denied_at?: number;
  } | null> => {
    const RECENCY_MS = 10 * 60 * 1000;
    const cutoff = Date.now() - RECENCY_MS;

    // Scope by_subject_staff already narrows to one staff's pin_reset history.
    // For v0.4 single-stall, lockout count per staff stays small (a manager
    // resets after each), so the post-collect filter is a few rows at most.
    // If lockout history grows large (multi-stall / long-running deployments),
    // promote to a composite `["subject_staff_id", "triggered_at"]` index and
    // switch to `.gt("triggered_at", cutoff).order("desc").first()`.
    //
    const rows = await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", args.staffId))
      .collect();

    const pinResets = rows
      .filter((r) => r.kind === "staff_pin_reset" && r.status !== "resolved" && r.triggered_at > cutoff)
      .sort((a, b) => b.triggered_at - a.triggered_at);

    if (pinResets.length === 0) return null;
    const req = pinResets[0];

    const status: EffectiveStatus = effectiveStatus(req);

    let denied_by_manager_name: string | undefined;
    let denied_by_manager_code: string | undefined;
    if (status === "denied" && req.denied_by_manager_id && req.denied_by_manager_id !== "system") {
      const m = await ctx.runQuery(
        internal.auth.internal._getStaffNameCode_internal,
        { staffId: req.denied_by_manager_id },
      );
      if (m) {
        denied_by_manager_name = m.name;
        denied_by_manager_code = m.code;
      }
    }

    return {
      requestId: req._id as unknown as string,
      status,
      triggered_at: req.triggered_at,
      ...(req.deny_reason !== undefined ? { deny_reason: req.deny_reason } : {}),
      ...(denied_by_manager_name !== undefined ? { denied_by_manager_name } : {}),
      ...(denied_by_manager_code !== undefined ? { denied_by_manager_code } : {}),
      ...(req.denied_at !== undefined ? { denied_at: req.denied_at } : {}),
    };
  },
});

/**
 * List active managers for the /approve page's manager picker.
 * Token-gated per ADR-029 ("token authorizes VIEW"): a valid approval token
 * is required, so this isn't a public staff-roster leak. Returns null when
 * the token is invalid/expired so the UI can surface "Link expired".
 *
 * Cross-module read goes via auth/internal per ADR-034 — approvals does not
 * read the `staff` table directly. The internal query uses the `by_role`
 * index so we don't full-scan staff on every reactive page load.
 */
export const listActiveManagers = query({
  // Arg name intentionally differs from getByToken (`rawToken`) so test mocks
  // can dispatch the two queries by args-shape — Convex FunctionReferences
  // don't safely coerce to strings, so we can't dispatch by query identity.
  args: { token: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ name: string; code: string }> | null> => {
    const hash = await sha256Hex(args.token);
    const req = await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", hash))
      .unique();
    if (!req || req.token_expires_at <= Date.now()) return null;

    return await ctx.runQuery(
      internal.auth.internal._listActiveManagers_internal,
      {},
    );
  },
});

/**
 * Cancel a pending approval request from the on-booth manager panel.
 * ADR-005: manager-PIN gate is handled by requireManagerSession (session-based,
 * not one-off PIN). The manager's staffId is recorded as cancelled_by_manager_id
 * so the audit trail names who invalidated the request.
 *
 * Source is "booth_inline" — the manager invokes this from the in-booth UI
 * (not from the off-booth Telegram approval link, which uses "telegram_approval").
 *
 * withIdempotency-wrapped per the strict ESLint idempotency-required rule (error
 * severity since Task 6). Same-key replay returns { denied: boolean } from cache
 * without re-patching the DB or re-emitting audit rows.
 */
export const cancelPendingRequest = mutation({
  args: {
    sessionId: v.id("staff_sessions"),
    requestId: v.id("pos_approval_requests"),
    reason: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: withIdempotency<
    {
      sessionId: Id<"staff_sessions">;
      requestId: Id<"pos_approval_requests">;
      reason?: string;
      idempotencyKey: string;
    },
    { denied: boolean }
  >(
    "approvals.cancelPendingRequest",
    async (ctx, args): Promise<{ denied: boolean }> => {
      const session = await requireManagerSession(ctx, args.sessionId);
      return await ctx.runMutation(
        internal.approvals.internal._markDeniedBySystem_internal,
        {
          requestId: args.requestId,
          deny_reason: args.reason ?? "manager_cancelled",
          cancelled_by_manager_id: session.staffId,
          source: "booth_inline",
        },
      );
    },
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});
