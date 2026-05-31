// Shared HTML escaper for HTML5 document contexts (receipts, future
// public-facing HTML surfaces). Escapes the full XML set (&, <, >, ", ')
// so the same function is safe in both element-text and attribute-value
// positions.
//
// NOT used by Telegram message rendering — Telegram's parse_mode: "HTML"
// only recognises &, <, > as entities; escaping quotes would pollute
// messages with literal &quot; / &#39; text. See convex/lib/telegramHtml.ts
// for the Telegram-specific (lighter) escape.

/** HTML-escape a string for safe interpolation in element text or attribute values. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
