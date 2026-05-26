/**
 * Bearer-token authentication middleware for the external API surface
 * (ADR-034 §"API authentication model"). STUB ONLY in v0.2.1.
 *
 * Full implementation lands in v0.3 alongside the first endpoint. Spec:
 *   - argon2id-hashed tokens stored in convex/api/v1/_tokens table
 *   - constant-time comparison (crypto.timingSafeEqual or equivalent)
 *   - rotation via overlapping 7-day window
 *   - per-token rate limit (60 req/min default)
 *   - explicit endpoint allow-list (no patterns/regex)
 *   - PII scope gating (frollie_pro_full vs frollie_pro_aggregate_only)
 *
 * See docs/PUBLIC_API.md for the contract.
 */
export async function verifyBearerToken(_request: Request): Promise<never> {
  throw new Error(
    "External API authentication not implemented in v0.2.1. " +
    "First endpoint + auth implementation ships in v0.3. " +
    "See docs/PUBLIC_API.md and ADR-034 §'API authentication model'."
  );
}
