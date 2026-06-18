// convex/lib/apiCursor.ts
// Opaque cursor: base64url(JSON{p:orderKeyMs, c:creationTime}). Consumers treat
// it as a black box (CONTRACT §3). V8-safe — uses btoa/atob, no node:Buffer.
type Decoded = { orderKeyMs: number; creationTime: number };

const b64urlEncode = (s: string) =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s: string) => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
};

export function encodeCursor(orderKeyMs: number, creationTime: number): string {
  return b64urlEncode(JSON.stringify({ p: orderKeyMs, c: creationTime }));
}

export function decodeCursor(s: string): Decoded {
  try {
    const o = JSON.parse(b64urlDecode(s));
    if (typeof o.p !== "number" || typeof o.c !== "number") throw new Error();
    return { orderKeyMs: o.p, creationTime: o.c };
  } catch {
    throw new Error("BAD_CURSOR");
  }
}
