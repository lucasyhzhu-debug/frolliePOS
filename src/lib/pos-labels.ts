/** Shared display labels for POS surfaces. Keep in sync with the receipt template. */

export const INSTRUMENT_LABEL: Record<"qris" | "bca_va" | "unknown", string> = {
  qris: "QRIS",
  bca_va: "BCA VA",
  unknown: "—",
};

export const REFUND_BADGE = {
  none: { label: "LUNAS", cls: "bg-emerald-100 text-emerald-800 border-transparent" },
  partial: { label: "SEBAGIAN DIKEMBALIKAN", cls: "bg-amber-100 text-amber-800 border-transparent" },
  full: { label: "DIKEMBALIKAN", cls: "bg-red-100 text-red-800 border-transparent" },
} as const;

/**
 * Confirmation-source label for the history detail card.
 * "polling" is a legacy literal for pre-ADR-036 rows; v0.4+ writers emit only
 * "webhook" / "manual" / null. Kept so archived v0.3 receipts render.
 */
export const CONFIRMED_VIA_LABEL: Record<"webhook" | "polling" | "manual", string> = {
  webhook: "Otomatis (webhook)",
  polling: "Otomatis (polling)",
  manual: "Manual (manajer)",
};
