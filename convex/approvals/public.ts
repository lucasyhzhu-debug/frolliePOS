import { query } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

/**
 * Derive a SHA-256 hex digest from a string using Web Crypto (V8-compatible).
 * Used to look up pos_approval_requests by_token_hash index.
 * Raw tokens are high-entropy (32 bytes), so salt-less SHA-256 is fine here —
 * argon2id is for low-entropy passwords (ADR-004); tokens use SHA-256 (ADR-029).
 */
async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Discriminated return type for getByToken
// ---------------------------------------------------------------------------

type EffectiveStatus = "pending" | "resolved" | "denied" | "expired";

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

type GetByTokenResult = StaffPinResetResult | ManualPaymentOverrideResult;

/**
 * Resolve an approval request by its raw token (for the off-booth approval page).
 * ADR-029: token authorises VIEW — returns display fields only. token_hash is NEVER
 * included in the return value.
 *
 * Returns a discriminated union on `kind`:
 *   - "staff_pin_reset": subject_staff_name/code from auth module boundary
 *   - "manual_payment_override": display.{amount_idr, reason, receipt_preview?, requester_name?}
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
    const effectiveStatus: EffectiveStatus =
      req.status === "pending" && req.token_expires_at <= Date.now()
        ? "expired"
        : req.status;

    const base = {
      status: effectiveStatus,
      triggered_at: req.triggered_at,
      token_expires_at: req.token_expires_at,
      ...(req.resolved_at !== undefined ? { resolved_at: req.resolved_at } : {}),
    };

    // Populate denier details (reason + manager name/code) when the row is denied,
    // so the "already denied" surfaces can render informative copy instead of a
    // generic message. Cross-module read goes via auth/internal per ADR-034.
    const denyDetails: DenyDetails = {};
    if (effectiveStatus === "denied") {
      if (req.denied_at !== undefined) denyDetails.denied_at = req.denied_at;
      if (req.deny_reason !== undefined) denyDetails.deny_reason = req.deny_reason;
      if (req.denied_by_manager_id) {
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
  ): Promise<{ status: "pending" | "resolved" | "denied" | "expired" } | null> => {
    const req = await ctx.db.get(args.requestId);
    if (!req) return null;
    const status: "pending" | "resolved" | "denied" | "expired" =
      req.status === "pending" && req.token_expires_at <= Date.now()
        ? "expired"
        : req.status;
    return { status };
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
    status: "pending" | "resolved" | "denied" | "expired";
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
    const rows = await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", args.staffId))
      .collect();

    const pinResets = rows
      .filter((r) => r.kind === "staff_pin_reset" && r.triggered_at > cutoff)
      .sort((a, b) => b.triggered_at - a.triggered_at);

    if (pinResets.length === 0) return null;
    const req = pinResets[0];

    const status: "pending" | "resolved" | "denied" | "expired" =
      req.status === "pending" && req.token_expires_at <= Date.now() ? "expired" : req.status;

    let denied_by_manager_name: string | undefined;
    let denied_by_manager_code: string | undefined;
    if (status === "denied" && req.denied_by_manager_id) {
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
  ): Promise<Array<{ _id: string; name: string; code: string }> | null> => {
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
