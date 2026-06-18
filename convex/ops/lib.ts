// V8-safe pure helpers for the ops error pipe. No "use node", no crypto.subtle.

export const MESSAGE_MAX = 500;
export const STACK_MAX = 2000;
export const DEDUP_WINDOW_MS = 5 * 60_000;
export const GLOBAL_ALERT_COOLDOWN_MS = 10_000;

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// Strip volatile substrings so logically-identical errors share a signature:
// hex (0x..), long digit runs, and uuid-ish tokens collapse to a constant.
export function normalizeMessage(message: string): string {
  return message
    .replace(/0x[0-9a-fA-F]+/g, "0x#")
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F-]{20,}/g, "#uuid")
    .replace(/\d+/g, "#")
    .trim()
    .slice(0, MESSAGE_MAX);
}

// djb2 — deterministic, fast, V8-safe. Sufficient for a dedup key (not crypto).
function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export function errorSignature(input: { kind: string; route?: string; message: string }): string {
  return djb2(`${input.kind}|${input.route ?? ""}|${normalizeMessage(input.message)}`);
}
