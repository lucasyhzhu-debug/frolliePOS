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
  const raw = IDR.format(amount);
  return raw.replace(/^Rp[\s  ]*/u, "Rp ");
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
