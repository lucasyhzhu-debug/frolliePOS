/**
 * Shared display labels for POS surfaces (on-screen). User-facing text is keyed
 * (ADR-049) — the consuming component resolves the key via t(). The PRINTED
 * receipt (escpos/template) keeps its own labels and is out of i18n scope.
 */
import type { TranslationKey } from "@/lib/i18n";

export const INSTRUMENT_LABEL: Record<"qris" | "bca_va" | "unknown", string> = {
  qris: "QRIS",
  bca_va: "BCA VA",
  unknown: "—",
};

// Refund-status badge: i18n key + semantic-token classes. Resolve label via t(labelKey).
export const REFUND_BADGE = {
  none: { labelKey: "history.badgePaid", cls: "bg-success/15 text-success border-success/30" },
  partial: { labelKey: "history.badgePartialRefund", cls: "bg-warning/15 text-warning border-warning/30" },
  full: { labelKey: "history.badgeRefunded", cls: "bg-error/15 text-error border-error/30" },
} as const satisfies Record<string, { labelKey: TranslationKey; cls: string }>;

/**
 * Confirmation-source label key for the history detail card. Resolve via t().
 * "polling" is a legacy literal for pre-ADR-036 rows; v0.4+ writers emit only
 * "webhook" / "manual" / "manual_bca" / null. Kept so archived v0.3 receipts render.
 * "manual_bca" = staff-confirmed manual bank transfer (v1.2 #10).
 */
export const CONFIRMED_VIA_LABEL: Record<
  "webhook" | "polling" | "manual" | "manual_bca",
  TranslationKey
> = {
  webhook: "history.confirmedWebhook",
  polling: "history.confirmedPolling",
  manual: "history.confirmedManual",
  manual_bca: "history.confirmedManualBca",
};
