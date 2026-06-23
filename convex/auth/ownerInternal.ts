// convex/auth/ownerInternal.ts
//
// Owner-auth (cockpit) internal queries/mutations — the V8-safe (non-"use node")
// half of the owner auth plane (ADR-052, "OTP authorises MANAGE"). Actions that
// need argon2 / external calls live in ownerActions.ts ("use node") and call
// through these. This module owns the `owner_auth_bindings` read/redeem path for
// the one-time Telegram `/start <token>` binding (WS2).
//
// High-entropy bind tokens are hashed with the V8-safe async sha256Hex
// (convex/lib/sha256.ts) at the call site; this module only ever sees the hash
// and looks up by exact `token_hash` (by_token_hash). Audit source is "system"
// (bot-mediated) — NOT "telegram_approval" (reserved for PIN approval flows).

import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { logAudit } from "../audit/internal";
import { requireCockpitSession } from "./sessions";

/**
 * Resolve a bind/remember binding row by its exact token_hash. Non-throwing —
 * returns null when no binding matches. Read-only; callers enforce validity.
 */
export const _lookupBinding_internal = internalQuery({
  args: { tokenHash: v.string() },
  handler: (ctx, { tokenHash }) =>
    ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .first(),
});

/**
 * Redeem a one-time Telegram bind token: bind the owner's private Telegram chat
 * to their staff row by writing `staff.telegram_user_id`. Single-use.
 *
 * Guards (in order):
 *  - BIND_PRIVATE_ONLY: redeem MUST be from a private DM — an OTP must never be
 *    deliverable to a group chat (the bound chat is the future OTP target).
 *  - BIND_INVALID: token unknown / wrong kind / already redeemed / expired.
 *  - TELEGRAM_ALREADY_BOUND: this Telegram user is already bound to a DIFFERENT
 *    staff row (one Telegram account → one staff identity).
 *
 * On success: mark the binding redeemed, stamp `staff.telegram_user_id`, audit
 * `owner.telegram_bound` (source "system"). Server time wins (ADR-031).
 */
export const _redeemBinding_internal = internalMutation({
  args: { tokenHash: v.string(), fromId: v.number(), chatType: v.string() },
  handler: async (ctx, { tokenHash, fromId, chatType }) => {
    // Private-DM only — the bound chat becomes the OTP delivery target (SEC).
    if (chatType !== "private") throw new Error("BIND_PRIVATE_ONLY");

    const now = Date.now();
    const b = await ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_token_hash", (q) => q.eq("token_hash", tokenHash))
      .first();
    if (
      !b ||
      b.kind !== "telegram_bind" ||
      b.redeemed_at != null ||
      b.expires_at < now
    ) {
      throw new Error("BIND_INVALID");
    }

    // One Telegram account ⇒ one staff identity. Re-binding the SAME staff is a
    // no-op-safe idempotent redeem; a DIFFERENT staff is a hard conflict.
    const dup = await ctx.db
      .query("staff")
      .withIndex("by_telegram_user_id", (q) => q.eq("telegram_user_id", fromId))
      .first();
    if (dup && dup._id !== b.staff_id) throw new Error("TELEGRAM_ALREADY_BOUND");

    await ctx.db.patch(b._id, { redeemed_at: now });
    await ctx.db.patch(b.staff_id, { telegram_user_id: fromId });
    await logAudit(ctx, {
      actor_id: b.staff_id,
      action: "owner.telegram_bound",
      entity_type: "staff",
      entity_id: b.staff_id,
      source: "system",
    });
    return { staff_id: b.staff_id };
  },
});

/**
 * Insert a fresh telegram_bind binding (called by the issuance action, which has
 * already minted the raw token and hashed it). Server-minted token only — the
 * action passes the pre-computed sha256 hash; this mutation never sees the raw.
 */
export const _createBindLink_internal = internalMutation({
  args: {
    staffId: v.id("staff"),
    tokenHash: v.string(),
    expiresAt: v.number(),
    actorId: v.union(v.id("staff"), v.literal("system")),
  },
  handler: async (ctx, { staffId, tokenHash, expiresAt, actorId }) => {
    const bindingId = await ctx.db.insert("owner_auth_bindings", {
      kind: "telegram_bind",
      staff_id: staffId,
      token_hash: tokenHash,
      expires_at: expiresAt,
      redeemed_at: null,
      created_at: Date.now(),
    });
    await logAudit(ctx, {
      actor_id: actorId,
      action: "owner.bind_link_issued",
      entity_type: "staff",
      entity_id: staffId,
      source: "system",
    });
    return { bindingId };
  },
});

/**
 * Action-context cockpit-session assert. Owner-cockpit-gated issuance uses this
 * as its authCheck (cannot import requireCockpitSession into a "use node" action
 * directly — that's a pure helper bound to QueryCtx; run it through a query).
 * Throws on a non-cockpit / non-owner / idle-timed-out session.
 */
export const _assertCockpitSession_internal = internalQuery({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, { sessionId }) => {
    const { staffId } = await requireCockpitSession(ctx, sessionId);
    return { staffId };
  },
});
