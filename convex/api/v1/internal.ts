// convex/api/v1/internal.ts
import { internalMutation } from "../../_generated/server";
import { v } from "convex/values";
import { Id } from "../../_generated/dataModel";
import { sha256Hex } from "../../lib/sha256";

const DAY_MS = 86_400_000;

// Ops-run (npx convex run). Mints a token, stores only its hash, returns the raw
// token ONCE. See the deviation note in the plan header re: PIN vs ops issuance.
//
// `isTest` selects the human-readable prefix only — the token is opaque to
// consumers (stored as SHA-256, compared constant-time), so the prefix is an
// ops-hygiene discriminator to keep dev/prod credentials visually distinct
// (CONTRACT §7: frpos_live_ on prod, frpos_test_ on dev). Pass isTest:true when
// minting against a dev/test deployment; omit (default false) for prod.
export const _issueApiToken_internal = internalMutation({
  args: {
    label: v.string(),                          // human note for ops, "frollie-pro-prod"
    endpointAllowList: v.array(v.string()),
    rateLimitRpm: v.optional(v.number()),
    ttlDays: v.optional(v.number()),
    isTest: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ rawToken: string }> => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const b64url = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const prefix = args.isTest ? "frpos_test_" : "frpos_live_";
    const rawToken = `${prefix}${b64url}`;
    const now = Date.now();
    const ttl = Math.min(args.ttlDays ?? 365, 365);
    await ctx.db.insert("api_tokens", {
      hash: await sha256Hex(rawToken),
      label: args.label,
      scope: "frollie_pro_full",
      endpointAllowList: args.endpointAllowList,
      rateLimitRpm: args.rateLimitRpm ?? 60,
      issuedAt: now,
      expiresAt: now + ttl * DAY_MS,
    });
    return { rawToken };
  },
});

// Append-only access-log writer. Called once per request from each endpoint
// (success and catch paths). Never throws into the response path — a log-write
// failure must not turn a 200 into a 500, so callers wrap it in try/catch.
export const _logApiRequest_internal = internalMutation({
  args: {
    token_id: v.optional(v.id("api_tokens")),
    endpoint: v.string(),
    http_status: v.number(),
    error_code: v.optional(v.string()),
    returned_count: v.optional(v.number()),
    cursor_in: v.optional(v.string()),
    cursor_out: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("api_request_log", { ...args, at: Date.now() });
  },
});

export const _authAndCount_internal = internalMutation({
  args: { hash: v.string(), endpointPath: v.string() },
  handler: async (ctx, args): Promise<{
    error: boolean; status?: number; code?: string; tokenId?: Id<"api_tokens">;
  }> => {
    const tok = await ctx.db.query("api_tokens")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash)).first();
    const now = Date.now();
    if (!tok || tok.revokedAt || tok.expiresAt <= now)
      return { error: true, status: 401, code: "UNAUTHENTICATED" };
    if (!tok.endpointAllowList.includes(args.endpointPath))
      return { error: true, status: 403, code: "ENDPOINT_NOT_ALLOWED" };
    // RPM bucket: lazy per-minute window (no cron needed for correctness).
    const windowStart = now - (now % 60_000);
    const bucket = await ctx.db.query("api_rate_buckets")
      .withIndex("by_token_window", (q) =>
        q.eq("token_id", tok._id).eq("window_start", windowStart)).first();
    if (bucket && bucket.count >= tok.rateLimitRpm)
      return { error: true, status: 429, code: "RATE_LIMITED" };
    if (bucket) await ctx.db.patch(bucket._id, { count: bucket.count + 1 });
    else await ctx.db.insert("api_rate_buckets", { token_id: tok._id, window_start: windowStart, count: 1 });
    return { error: false, tokenId: tok._id };
  },
});

// Daily housekeeping: delete stale rate-limit buckets (>2 min old) and old
// request-log rows (>90 days). Correctness doesn't depend on this — rate
// windows self-expire logically — but it bounds table growth.
export const _purgeApiHousekeeping_internal = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const now = Date.now();
    const RATE_TTL = 2 * 60_000;            // rate buckets: 2 min
    const LOG_TTL = 90 * 86_400_000;        // request log: 90 days
    for (const b of await ctx.db.query("api_rate_buckets").withIndex("by_token_window").collect())
      if (b.window_start < now - RATE_TTL) await ctx.db.delete(b._id);
    for (const r of await ctx.db.query("api_request_log").withIndex("by_at", (q) => q.lt("at", now - LOG_TTL)).collect())
      await ctx.db.delete(r._id);
  },
});
