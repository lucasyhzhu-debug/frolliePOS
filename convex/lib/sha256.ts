// V8-safe async SHA-256 (Web Crypto). Safe in the Convex default runtime AND
// "use node" actions — NOT "use node". For hashing high-entropy tokens
// (32-byte random) where index-lookup-by-hash is the auth mechanism; argon2id
// is reserved for low-entropy PINs (ADR-004). Mirrors approvals' former local copy.
export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
