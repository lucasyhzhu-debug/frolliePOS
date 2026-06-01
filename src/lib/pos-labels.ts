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
