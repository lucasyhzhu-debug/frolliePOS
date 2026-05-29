// convex/lib/constantTimeEqual.ts
// Ported from convex-telegram-bot-starter verbatim.

/**
 * Constant-time string compare. Use for secret comparisons (webhook tokens,
 * API keys) where timing-leak amplification could let an attacker probe each
 * character. Returns false immediately on length mismatch (the length itself
 * is not secret — the bytes are).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
