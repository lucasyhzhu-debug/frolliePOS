import { query } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { Doc } from "../_generated/dataModel";

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

/**
 * Resolve an approval request by its raw token (for the off-booth PIN-reset page).
 * ADR-029: token authorises VIEW — returns display fields only. token_hash is NEVER
 * included in the return value.
 *
 * Effective status rules (DB row is not mutated here; cleanup is a future job):
 *   - If row.status === "pending" && row.token_expires_at <= Date.now() → "expired"
 *   - Otherwise: row.status as-is.
 *
 * Staff name/code is resolved via ctx.runQuery on auth/internal to respect
 * the ADR-034 module boundary (approvals does not own the `staff` table).
 */
export const getByToken = query({
  args: { rawToken: v.string() },
  // Explicit return type breaks the cross-module circular inference (this handler
  // calls ctx.runQuery on the auth internal surface). Without it tsc -b collapses
  // the inferred type to `any`.
  handler: async (
    ctx,
    args,
  ): Promise<{
    kind: Doc<"pos_approval_requests">["kind"];
    subject_staff_name: string;
    subject_staff_code?: string;
    status: "pending" | "resolved" | "denied" | "expired";
    triggered_at: number;
    token_expires_at: number;
    resolved_at?: number;
  } | null> => {
    const hash = await sha256Hex(args.rawToken);

    const req = await ctx.db
      .query("pos_approval_requests")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", hash))
      .first();

    if (!req) return null;

    // subject_staff_id is always present for staff_pin_reset; other kinds (e.g.
    // manual_payment_override) won't have it. Guard before calling auth boundary.
    if (!req.subject_staff_id) return null;

    // Resolve staff via auth module boundary (ADR-034: approvals does not own `staff`)
    const staffInfo = await ctx.runQuery(
      internal.auth.internal._getStaffNameCode_internal,
      { staffId: req.subject_staff_id },
    );

    if (!staffInfo) return null;

    // Compute effective status without mutating the DB row
    const effectiveStatus: "pending" | "resolved" | "denied" | "expired" =
      req.status === "pending" && req.token_expires_at <= Date.now()
        ? "expired"
        : req.status;

    return {
      kind: req.kind,
      subject_staff_name: staffInfo.name,
      subject_staff_code: staffInfo.code,
      status: effectiveStatus,
      triggered_at: req.triggered_at,
      token_expires_at: req.token_expires_at,
      ...(req.resolved_at !== undefined ? { resolved_at: req.resolved_at } : {}),
    };
  },
});
