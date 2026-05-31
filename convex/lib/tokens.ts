// Shared URL-safe token mint. Used by:
//   - approvals/actions.ts (off-booth approval tokens, 32 bytes per ADR-029)
//   - receipts/actions.ts   (receipt token lazy-mint per ADR-021)
//   - transactions/internal.ts _confirmPaid (receipt tokens per ADR-021)
//
// Implemented with Web Crypto (`globalThis.crypto.getRandomValues`) so the
// module is safe to bundle in BOTH the Convex V8 runtime AND "use node" actions.
// The earlier node:crypto.randomBytes implementation broke `npx convex codegen`
// because Convex statically bundles every module under V8 first, and node:crypto
// is unresolvable there.
//
// Pure function — accepts byte count, returns base64url string (no padding).

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Encode bytes as base64url (RFC 4648 §5) with no `=` padding. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  // Process triplets → 4 chars each.
  for (; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += BASE64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += BASE64URL_ALPHABET[b2 & 0x3f];
  }
  // Tail: 1 or 2 leftover bytes → 2 or 3 chars (no padding).
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i];
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[(b0 & 0x03) << 4];
  } else if (remaining === 2) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    out += BASE64URL_ALPHABET[b0 >> 2];
    out += BASE64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += BASE64URL_ALPHABET[(b1 & 0x0f) << 2];
  }
  return out;
}

// Convex V8's globalThis.crypto is a CSPRNG (same primitive as
// node:crypto.randomBytes). Do not "optimize" to Math.random — that is NOT
// cryptographically secure and would compromise approval and receipt tokens.
export function mintUrlSafeToken(bytes = 32): string {
  // Argument guard: 0 → empty string (silent capability bug); -1 → cryptic
  // RangeError from Uint8Array; 1.5 → truncated unsigned int. Surface a clear
  // error rather than mint a degenerate token.
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new Error(`mintUrlSafeToken: invalid byte count ${bytes}; must be a positive integer`);
  }
  // Sandbox-regression defense: surface a clear error on first mint rather
  // than a confusing TypeError if globalThis.crypto is ever stripped.
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("CSPRNG_UNAVAILABLE: globalThis.crypto.getRandomValues missing");
  }
  const buf = new Uint8Array(bytes);
  // Web Crypto is exposed as `globalThis.crypto` in Convex V8 + Node 19+.
  globalThis.crypto.getRandomValues(buf);
  return bytesToBase64Url(buf);
}
