// Shared formatters, escapers, and inline-markdown renderer.
// Pure functions, no side effects, no IO.

export const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);

// Render inline markdown. Order matters:
//   1. escape HTML
//   2. links (so labels can contain other tokens)
//   3. code spans (protect contents from further markdown)
//   4. strikethrough
//   5. bold (must come before single-* italic)
//   6. italic underscores (boundary-safe — won't trigger inside identifiers like pos_products)
//   7. italic asterisks (after bold so it doesn't trip on **...**)
export function renderInline(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>`,
  );
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(>\-—,:;])_([^_\n]+?)_(?=$|[\s,.:;!?)<\-—])/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(>])\*([^*\n]+?)\*(?=$|[\s,.:;!?)<])/g, "$1<em>$2</em>");
  return html;
}

export const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];
export const MONTHS_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
export const MONTHS_FRIENDLY = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function ordinal(n) {
  const s = ["th","st","nd","rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function ordinalWord(n) {
  const names = [
    "zeroth","first","second","third","fourth","fifth","sixth","seventh","eighth","ninth",
    "tenth","eleventh","twelfth","thirteenth","fourteenth","fifteenth","sixteenth","seventeenth","eighteenth","nineteenth",
    "twentieth","twenty-first","twenty-second","twenty-third","twenty-fourth","twenty-fifth","twenty-sixth","twenty-seventh","twenty-eighth","twenty-ninth",
    "thirtieth","thirty-first",
  ];
  return names[n] || ordinal(n);
}

const NUMBER_WORDS = [
  "zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty",
];

export function numberWord(n) {
  if (n >= 0 && n < NUMBER_WORDS.length) return NUMBER_WORDS[n];
  if (n < 100) {
    const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
    const t = Math.floor(n / 10);
    const o = n % 10;
    return o ? `${tens[t]}-${NUMBER_WORDS[o]}` : tens[t];
  }
  return String(n);
}

export function romanNumeral(n) {
  const map = [
    [1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],
    [50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"],
  ];
  let s = "";
  for (const [v, sym] of map) { while (n >= v) { s += sym; n -= v; } }
  return s;
}

export function formatLongDate(d) {
  const century = numberWord(Math.floor(d.getFullYear() / 100));
  const yearWithin = numberWord(d.getFullYear() % 100);
  return `${ordinalWord(d.getDate())} of ${MONTHS_LONG[d.getMonth()]}, ${century} ${yearWithin}`;
}

export function formatStampDate(d) {
  return `${String(d.getDate()).padStart(2, "0")} · ${MONTHS_SHORT[d.getMonth()]} · ${romanNumeral(d.getFullYear())}`;
}

export function formatHumanDate(iso) {
  const m = iso?.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const century = numberWord(Math.floor(d.getUTCFullYear() / 100));
  const yearWithin = numberWord(d.getUTCFullYear() % 100);
  return `the ${ordinalWord(d.getUTCDate())} of ${MONTHS_LONG[d.getUTCMonth()]}, ${century} ${yearWithin}`;
}

export function formatShippedShort(date) {
  if (!date) return "shipped";
  return `shipped ${date.getUTCDate()} ${MONTHS_FRIENDLY[date.getUTCMonth()]}`;
}

export function formatTarget(phase) {
  if (phase.status === "done") return formatShippedShort(phase.shippedDate);
  if (phase.target && phase.target.toLowerCase() !== "tbd") return `target ${phase.target}`;
  return "target TBD";
}

export function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

export function relativeDaysAgo(iso, today) {
  if (!iso) return "—";
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "—";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const n = daysBetween(d, todayUTC);
  if (n === 0) return "shipped today";
  if (n === 1) return "shipped yesterday";
  if (n < 7) return `shipped ${n} days ago`;
  if (n < 14) return `shipped a week ago`;
  if (n < 30) return `shipped ${Math.floor(n / 7)} weeks ago`;
  return `shipped ${Math.floor(n / 30)} months ago`;
}
