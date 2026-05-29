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

type StaffPinResetResult = {
  kind: "staff_pin_reset";
  subject_staff_name: string;
  subject_staff_code?: string;
  status: EffectiveStatus;
  triggered_at: number;
  token_expires_at: number;
  resolved_at?: number;
};

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
};

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
