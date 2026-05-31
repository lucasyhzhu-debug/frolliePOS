import type { Doc } from "../_generated/dataModel";

export type EffectiveStatus = "pending" | "resolved" | "denied" | "expired";

/**
 * Single canonical derivation of an approval request's user-visible status.
 *
 * The schema tracks three real states (pending / resolved / denied). The fourth —
 * "expired" — is a virtual state derived from token_expires_at vs. now. This
 * helper centralises that derivation so the 5 reader sites (getByToken,
 * getRequestStatus, getRecentPinResetForStaff, /approve UI, ApprovalPending)
 * can never drift.
 *
 * The `now` parameter is for test determinism. Default is Date.now().
 */
export function effectiveStatus(
  row: Pick<Doc<"pos_approval_requests">, "status" | "token_expires_at">,
  now: number = Date.now(),
): EffectiveStatus {
  if (row.status !== "pending") return row.status;
  return row.token_expires_at <= now ? "expired" : "pending";
}

/** Hard cap on failed PIN attempts per approval token. See v0.5.0 spec §5. */
export const TOKEN_PIN_ATTEMPT_CAP = 5;
