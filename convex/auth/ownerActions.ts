"use node";

import { action } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { verifyManagerPinOrThrow } from "./verifyPin";
import { mintUrlSafeToken } from "../lib/tokens";
import { sha256Hex } from "../lib/sha256";
import { withActionCache } from "../idempotency/action";

/**
 * Issue a one-time Telegram `/start <token>` bind link for an owner (WS2,
 * ADR-052). The link, opened in the owner's PRIVATE Telegram DM, binds that chat
 * to the target staff row (writes staff.telegram_user_id) so future cockpit OTPs
 * can be delivered there.
 *
 * Authorisation is a two-way gate (I1):
 *   - managerPin provided ⇒ manager-PIN funnel (verifyManagerPinOrThrow) — a
 *     booth manager bootstraps the FIRST owner before any cockpit session exists.
 *   - else ⇒ a live owner cockpit session (_assertCockpitSession_internal) — an
 *     owner re-binds / binds a peer once the plane is up.
 *
 * Idempotency (ADR-013/046): withActionCache runs the authCheck BEFORE the cache
 * lookup, then caches the { deepLink } so a replay returns the SAME link without
 * re-minting a token. The bind token is server-minted (mintUrlSafeToken, 32B),
 * hashed with the V8-safe async sha256Hex; only the hash is persisted.
 *
 * 60-minute TTL (mirrors the view-token convention, ADR-029). Audit
 * `owner.bind_link_issued` (source "system") is written by the commit internal.
 *
 * Errors: BIND_AUTH_REQUIRED (neither gate satisfied), INVALID_PIN /
 * MANAGER_SESSION_REQUIRED / NOT_MANAGER / SESSION_INVALID / LOCKED_OUT:<secs>
 * (PIN branch), NO_SESSION / NOT_COCKPIT_SESSION / SESSION_IDLE_TIMEOUT (cockpit
 * branch), TELEGRAM_BOT_USERNAME_MISSING.
 */
const BIND_TOKEN_TTL_MS = 60 * 60 * 1000; // 60 min (ADR-029 view-token convention)

export const issueOwnerTelegramBindLink = action({
  args: {
    idempotencyKey: v.string(),
    targetStaffId: v.id("staff"),
    sessionId: v.optional(v.id("staff_sessions")),
    managerPin: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ deepLink: string }> =>
    withActionCache(
      ctx,
      { key: args.idempotencyKey, mutationName: "auth.issueOwnerTelegramBindLink" },
      // ── authCheck (runs BEFORE the cache lookup, ADR-046) ──
      async () => {
        if (args.managerPin != null) {
          if (!args.sessionId) throw new Error("SESSION_INVALID");
          await verifyManagerPinOrThrow(ctx, {
            sessionId: args.sessionId,
            managerPin: args.managerPin,
            idempotencyKey: args.idempotencyKey,
          });
        } else if (args.sessionId) {
          await ctx.runQuery(internal.auth.ownerInternal._assertCockpitSession_internal, {
            sessionId: args.sessionId,
          });
        } else {
          throw new Error("BIND_AUTH_REQUIRED");
        }
      },
      // ── fn (cache miss only) ──
      async () => {
        const botUsername = process.env.TELEGRAM_BOT_USERNAME;
        if (!botUsername) throw new Error("TELEGRAM_BOT_USERNAME_MISSING");

        const raw = mintUrlSafeToken(32);
        const tokenHash = await sha256Hex(raw);
        await ctx.runMutation(internal.auth.ownerInternal._createBindLink_internal, {
          staffId: args.targetStaffId,
          tokenHash,
          expiresAt: Date.now() + BIND_TOKEN_TTL_MS,
          actorId: "system",
        });
        return { deepLink: `https://t.me/${botUsername}?start=${raw}` };
      },
    ),
});
