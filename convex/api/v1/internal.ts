// convex/api/v1/internal.ts
import { internalMutation } from "../../_generated/server";
import { v } from "convex/values";
import { Id } from "../../_generated/dataModel";
import { sha256Hex } from "../../lib/sha256";

const DAY_MS = 86_400_000;

// Ops-run (npx convex run). Mints a token, stores only its hash, returns the raw
// token ONCE. See the deviation note in the plan header re: PIN vs ops issuance.
export const _issueApiToken_internal = internalMutation({
  args: {
    label: v.string(),                          // human note for ops, "frollie-pro-prod"
    endpointAllowList: v.array(v.string()),
    rateLimitRpm: v.optional(v.number()),
    ttlDays: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ rawToken: string }> => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const b64url = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const rawToken = `frpos_live_${b64url}`;
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
