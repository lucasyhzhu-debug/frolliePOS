// Shared URL-safe token mint. Used by:
//   - approvals/actions.ts (off-booth approval tokens, 32 bytes per ADR-029)
//   - transactions/internal.ts _confirmPaid (receipt tokens per ADR-021)
// Node-only ("use node" callers): node:crypto.randomBytes is unavailable in V8 runtime.
// Pure function — accepts byte count, returns base64url string.

import { randomBytes } from "node:crypto";

export function mintUrlSafeToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
