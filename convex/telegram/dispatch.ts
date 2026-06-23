// convex/telegram/dispatch.ts
//
// Generic role-routed Telegram dispatch helper. Extracted in v0.5.2 from the
// inventory low-stock + recount-notice dispatch actions which were structurally
// identical: resolve chat-id-by-role → if unbound, audit a `telegram.skipped`
// row and return; otherwise hand off to sendTemplate.
//
// V8 runtime (NO "use node"): this file only orchestrates ctx.runQuery /
// ctx.runMutation / ctx.runAction — no node-only imports.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal, api } from "../_generated/api";

/**
 * Resolve the Telegram chat for `role` via the chat registry and hand off to
 * `sendTemplate`. If the role has no bound chat, write a `telegram.skipped`
 * audit row and return without throwing — the canonical "fail-isolated dispatch"
 * pattern shared across inventory dispatches (low-stock, recount notice).
 *
 * Other errors (transient outage, sendTemplate failure) propagate so they
 * surface in the Convex dashboard.
 *
 * `payload` is typed `v.any()` because sendTemplate's runtime validator
 * re-checks the per-kind union — the lost compile-time check is the price
 * of one shared helper across multiple kinds.
 */
export const dispatchRoleAlert = internalAction({
  args: {
    role: v.string(),
    kind: v.string(),
    payload: v.any(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    let chatId: string;
    try {
      chatId = await ctx.runQuery(
        internal.telegram.chatRegistry.internal.getChatIdByRole,
        { role: args.role },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No Telegram chat assigned to role")) {
        await ctx.runMutation(internal.telegram.internal._auditTelegramSkip_internal, {
          reason: "role_unbound",
          role: args.role,
        });
        return;
      }
      throw err;
    }
    await ctx.runAction(api.telegram.send.sendTemplate, {
      role: args.role,
      // sendTemplate validates the kind union at runtime; cast through.
      kind: args.kind as never,
      payload: args.payload,
      idempotencyKey: args.idempotencyKey,
      chatIdOverride: chatId,
    });
  },
});
