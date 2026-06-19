import { convexSiteOrigin } from "./convexUrl";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export function rp(amount: number): string {
  // IDR formatter output varies by ICU version/platform:
  //   "Rp25.000"  — no space
  //   "Rp 25.000" — regular space
  //   "Rp 25.000" — non-breaking space
  //   "Rp  25.000" — nbsp + narrow nbsp (Node 22 on Windows)
  // Normalise: strip all Unicode whitespace between "Rp" and the digits,
  // then re-insert exactly one regular space.
  //
  // Negatives are handled explicitly so the output is always "-Rp N" regardless
  // of where the ICU locale puts the minus sign (some emit "Rp -N", some "-Rp N").
  // Used by the v0.5.1 refund-summary displays (e.g. "-Rp 43.333").
  const sign = amount < 0 ? "-" : "";
  const raw = IDR.format(Math.abs(amount));
  return sign + raw.replace(/^Rp[\s  ]*/u, "Rp ");
}

// Single-stall, single-timezone for v1. When multi-stall lands (post-v1),
// thread tz through `pos_settings` and refactor.
const JAKARTA_TZ = "Asia/Jakarta";

const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: JAKARTA_TZ,
});

export function fmtTime(epochMs: number): string {
  return TIME.format(new Date(epochMs));
}

const DATE = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
  timeZone: JAKARTA_TZ,
});

export function fmtDate(epochMs: number): string {
  return DATE.format(new Date(epochMs));
}

/**
 * Build the public receipt URL for a given token.
 *
 * The receipt is served by a Convex httpAction at
 * `https://<deployment>.convex.site/r/<token>` (PR A — receipts module). The
 * Convex client URL we have (`VITE_CONVEX_URL`) is the `.convex.cloud` WS
 * endpoint; we swap `.cloud` for `.site` to hit the HTTP routing surface.
 *
 * Falls back to a same-origin `/r/<token>` only when the env is missing
 * (dev-only escape hatch); the SPA route is a stub today, so the dev user at
 * least sees the not-implemented placeholder rather than nothing.
 */
export function buildReceiptUrl(token: string): string {
  const convexUrl = import.meta.env.VITE_CONVEX_URL as string | undefined;
  if (!convexUrl) {
    return `/r/${token}`;
  }
  // VITE_CONVEX_URL is the bare `.convex.cloud` WS origin; swap to `.site` for
  // the httpAction surface via the shared helper (single source for the swap).
  return `${convexSiteOrigin(convexUrl)}/r/${token}`;
}

export function fmtRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 30_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function parseIntStrict(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}
