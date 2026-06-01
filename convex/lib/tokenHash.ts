"use node";

// Shared SHA-256 helper for hashing high-entropy tokens (32-byte URL-safe random,
// per ADR-029). Used by approvals (off-booth approval tokens) and refunds (refund
// approval tokens via the approval pipeline).
//
// Salt-less SHA-256 is appropriate here because the inputs are high-entropy: a
// 32-byte random produces 256 bits of search space — argon2id is reserved for
// LOW-entropy inputs like 4-digit PINs (ADR-004).
//
// Node-runtime only ("use node") — uses node:crypto which is unavailable in V8.

import { createHash } from "node:crypto";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
