/**
 * WIB (Asia/Jakarta) is UTC+7 with no DST. Shared offset used by all helpers
 * here so they stay byte-identical when given the same UTC epoch.
 */
export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * Indonesian short month names, indexed 0-11 (Jan = 0). Used by the receipt
 * template via formatWibDateTime per ADR-039 §4.
 */
const ID_MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agt", "Sep", "Okt", "Nov", "Des"];

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
  const wibMs = timestamp + WIB_OFFSET_MS;
  return new Date(wibMs).getUTCFullYear();
}

/**
 * Convert a UTC epoch ms to its WIB calendar date label "YYYY-MM-DD" (UTC+7,
 * no DST). The single owner of the "epoch → WIB date string" idiom that the
 * settlement poll (cronActions lookback) and aggregator (lib) both need —
 * lib/time.ts owns the WIB helpers, so neither re-inlines the arithmetic.
 * Runtime-neutral: no Convex API.
 */
export function wibDateLabel(epochMs: number): string {
  const wib = new Date(epochMs + WIB_OFFSET_MS);
  const y = wib.getUTCFullYear();
  const m = wib.getUTCMonth();
  const d = wib.getUTCDate();
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Compute the WIB calendar day window for a given UTC epoch ms timestamp.
 *
 * WIB = UTC+7, no DST. A WIB day starts at 17:00 UTC of the *previous* UTC
 * date and ends at 17:00 UTC of the *same* UTC date.
 *
 * Returns:
 *   dayStartMs — epoch ms for 00:00 WIB (= 17:00 UTC previous day)
 *   dayEndMs   — epoch ms for 00:00 WIB next day (exclusive upper bound)
 *   dateLabel  — "YYYY-MM-DD" in WIB (the human-readable date for the day)
 *
 * Used by the founders shift-summary cron to scope the daily sales aggregate
 * to the correct WIB calendar day (ADR-031: server time wins, lib/time.ts owns
 * the WIB helpers). Runtime-neutral — no Convex API.
 *
 * Example: now = 2026-05-30 03:00 UTC = 2026-05-30 10:00 WIB
 *   dayStartMs = 2026-05-29 17:00 UTC  (start of WIB May 30)
 *   dayEndMs   = 2026-05-30 17:00 UTC  (start of WIB May 31)
 *   dateLabel  = "2026-05-30"
 */
export function wibDayWindow(now: number): {
  dayStartMs: number;
  dayEndMs: number;
  dateLabel: string;
} {
  // Shift `now` into WIB clock time so getUTC* methods give WIB calendar values.
  const wibNow = new Date(now + WIB_OFFSET_MS);
  const y = wibNow.getUTCFullYear();
  const m = wibNow.getUTCMonth();
  const d = wibNow.getUTCDate();
  // Start of this WIB day in UTC: midnight WIB = UTC midnight minus 7 h offset.
  const dayStartMs = Date.UTC(y, m, d) - WIB_OFFSET_MS;
  const dayEndMs = dayStartMs + 86_400_000;
  const dateLabel = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { dayStartMs, dayEndMs, dateLabel };
}

/**
 * Parse a "YYYY-MM-DD" WIB calendar label into that day's [start, end) ms window.
 *
 * Throws INVALID_DAY for any string that:
 *   - doesn't match the strict YYYY-MM-DD regex
 *   - represents an out-of-range or overflow date (e.g. "2026-02-30" rolls
 *     forward to March 2; we reject via round-trip check)
 *
 * Sibling of wibDayWindow (which takes an epoch ms, not a label). Lifted from
 * transactions/public.ts in v0.5.3a so any future caller that wants to scope a
 * query to a labelled WIB day shares one parser.
 */
export function parseWibDayLabel(label: string): { dayStartMs: number; dayEndMs: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) throw new Error("INVALID_DAY");
  const [y, m, d] = label.split("-").map(Number);
  const reconstructed = new Date(Date.UTC(y, m - 1, d));
  if (
    reconstructed.getUTCFullYear() !== y ||
    reconstructed.getUTCMonth() !== m - 1 ||
    reconstructed.getUTCDate() !== d
  ) {
    throw new Error("INVALID_DAY");
  }
  const dayStartMs = Date.UTC(y, m - 1, d) - WIB_OFFSET_MS;
  return { dayStartMs, dayEndMs: dayStartMs + 86_400_000 };
}

/**
 * Format a UTC epoch ms as a WIB-readable string in "DD MMM YYYY · HH:mm WIB" form.
 * Hand-written to avoid Intl quirks on the Convex runtime; WIB is fixed UTC+7 (no DST).
 * Indonesian month names per receipt template (ADR-039 §4).
 *
 * The middle dot is U+00B7 (·) — preserve it byte-exact, the receipt test asserts it.
 */
export function formatWibDateTime(epochMs: number): string {
  // Defensive: NaN / ±Infinity → "—". An invalid timestamp reaching the
  // renderer is a bug upstream, but printing "NaN NaN NaN" to a customer-facing
  // receipt is worse than printing a dash.
  if (!Number.isFinite(epochMs)) return "—";
  const wib = new Date(epochMs + WIB_OFFSET_MS);
  const dd = String(wib.getUTCDate()).padStart(2, "0");
  const mm = ID_MONTHS[wib.getUTCMonth()];
  const yyyy = wib.getUTCFullYear();
  const hh = String(wib.getUTCHours()).padStart(2, "0");
  const mi = String(wib.getUTCMinutes()).padStart(2, "0");
  return `${dd} ${mm} ${yyyy} · ${hh}:${mi} WIB`;
}
