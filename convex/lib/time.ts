/**
 * Convert a UTC epoch ms to the WIB calendar year (UTC+7, no DST).
 *
 * Used by transactions.internal._allocateReceiptNumber_internal to prefix
 * receipt numbers with the correct year as expected by the booth, accounting,
 * and customers. A sale at 03:00 WIB Jan 1 = 20:00 UTC Dec 31 — the receipt
 * MUST say R-{newYear}-0001 even though the UTC year is still old. See
 * staffreview Critical Issue #2 (2026-05-27).
 *
 * Runtime-neutral: no Convex API. Safe to import from any module + test env.
 */
export function wibYear(timestamp: number = Date.now()): number {
  const wibMs = timestamp + 7 * 60 * 60 * 1000;
  return new Date(wibMs).getUTCFullYear();
}
