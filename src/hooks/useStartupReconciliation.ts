import type { Id } from "../../convex/_generated/dataModel";

/**
 * ADR-026 reconciliation-on-reload — DOWNGRADED (Decision F, ADR-036).
 *
 * The QR Codes API never reports "paid" on a status poll, so poll-based
 * reconciliation is architecturally impossible. Missed-webhook recovery is now
 * the manager-PIN manual override only. This shell preserves the RootLayout
 * mount point for a future working-endpoint reconciliation (Xendit QR-payments
 * lookup) without re-introducing a dead poll.
 */
export function useStartupReconciliation(_sessionId: Id<"staff_sessions"> | undefined) {
  // intentionally no-op
}
