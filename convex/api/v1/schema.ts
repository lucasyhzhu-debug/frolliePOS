import { defineTable } from "convex/server";
import { v } from "convex/values";

export const apiTables = {
  // Opaque bearer tokens for the external API (ADR-034). SHA-256 hashed at rest;
  // auth = hash incoming token → indexed by_hash lookup (no plaintext stored).
  api_tokens: defineTable({
    hash: v.string(),                                  // sha256Hex(rawToken)
    label: v.string(),                                 // human note for ops e.g. "frollie-pro-prod"
    scope: v.literal("frollie_pro_full"),              // union retained for forward-compat; one value in v1
    endpointAllowList: v.array(v.string()),            // e.g. ["/api/v1/transactions","/api/v1/refunds"]
    rateLimitRpm: v.number(),                          // default 60
    issuedAt: v.number(),
    expiresAt: v.number(),                             // mandatory; ≤ 365d
    rotatedFrom: v.optional(v.id("api_tokens")),
    revokedAt: v.optional(v.number()),
  }).index("by_hash", ["hash"]),

  // Per-token RPM counter. One row per (token, minute-window).
  api_rate_buckets: defineTable({
    token_id: v.id("api_tokens"),
    window_start: v.number(),                          // epoch ms floored to the minute
    count: v.number(),
  }).index("by_token_window", ["token_id", "window_start"]),

  // Append-only access log — ONE row per API request (success AND failure,
  // incl. unauthenticated attempts where token_id is null). NOT the business
  // audit_log (ADR-007 is state-changes only; pulls are reads). The token IS
  // the caller (look up api_tokens.label for a human name). Indexed for ops.
  api_request_log: defineTable({
    token_id: v.optional(v.id("api_tokens")),          // null = auth failed before a token resolved
    endpoint: v.string(),                              // "/api/v1/transactions" | "/api/v1/refunds"
    http_status: v.number(),                           // 200/400/401/429/500
    error_code: v.optional(v.string()),                // contract §4 code, when non-200
    returned_count: v.optional(v.number()),            // rows in the response page (200 only)
    cursor_in: v.optional(v.string()),                 // request cursor (opaque), if any
    cursor_out: v.optional(v.string()),                // nextCursor returned, if any
    at: v.number(),                                    // server Date.now()
  })
    .index("by_token_at", ["token_id", "at"])
    .index("by_at", ["at"]),
};
