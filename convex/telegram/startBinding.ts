// convex/telegram/startBinding.ts
//
// `/start <token>` deep-link binding (v2.0 owner-auth, WS2, ADR-052). A Telegram
// deep link (https://t.me/<bot>?start=<token>) delivers the bind token as the
// `/start` argument. The arg-aware command (acceptsArgs: true) head-matches and
// forks on the tail:
//   - empty tail  ⇒ the bare-/start help reply (preserves the registry behaviour)
//   - non-empty   ⇒ redeem the bind token, binding the sender's PRIVATE chat to
//                   the owner's staff row (writes staff.telegram_user_id).
//
// This factory REPLACES the registry's bare `/start` (see http.ts) so there is
// exactly ONE `start` registration — the arg-aware one. The `register` command
// from buildRegistryCommands is unaffected.
//
// Binding is private-DM only (_redeemBinding_internal throws BIND_PRIVATE_ONLY
// for group chats) — the bound chat becomes the future OTP delivery target, and
// an OTP must never land in a group. The high-entropy token is hashed with the
// V8-safe async sha256Hex before lookup.

import type { Scheduler } from "convex/server";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { CommandRegistration } from "./commands";
import { sendTelegramHtml } from "../lib/telegramHtml";
import { sha256Hex } from "../lib/sha256";

/** Strip the `/start` (+ optional @bot) head and return the trimmed tail. */
function parseStartTail(text: string): string {
  return text.replace(/^\/start(@[A-Za-z0-9_]+)?/, "").trim();
}

export function buildStartBindingCommand(scheduler: Scheduler): CommandRegistration[] {
  return [
    {
      name: "start",
      acceptsArgs: true,
      dispatch: async (msg) => {
        const tail = parseStartTail(msg.text);
        if (!tail) {
          // Bare /start — preserve the registry intro reply.
          await scheduler.runAfter(
            0,
            internal.telegram.chatRegistry.internal.replyStartHelp,
            { chatId: msg.chatId },
          );
          return;
        }
        // Deep-link with a bind token — redeem off-thread.
        await scheduler.runAfter(0, internal.telegram.startBinding.handleStartWithToken, {
          chatId: msg.chatId,
          fromId: msg.fromId,
          chatType: msg.chatType,
          token: tail,
        });
      },
    },
  ];
}

/**
 * Redeem a `/start <token>` bind link and reply in the originating chat. On any
 * failure (private-only violation, invalid/expired/redeemed token, already-bound
 * Telegram account, or a missing sender id) reply with a single generic message
 * — never leak WHICH guard failed. Never echoes the token. Success ⇒ confirm.
 */
export const handleStartWithToken = internalAction({
  args: {
    chatId: v.string(),
    fromId: v.optional(v.number()),
    chatType: v.string(),
    token: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN missing");

    const generic = "❌ Link expired or already used.";
    try {
      if (args.fromId == null) throw new Error("NO_SENDER");
      const tokenHash = await sha256Hex(args.token);
      await ctx.runMutation(internal.auth.ownerInternal._redeemBinding_internal, {
        tokenHash,
        fromId: args.fromId,
        chatType: args.chatType,
      });
      await sendTelegramHtml(
        botToken,
        args.chatId,
        "✅ Telegram linked. You can now request a cockpit login code.",
      );
    } catch (err) {
      // Redeem failures are expected (expired/reused link, group chat, dup
      // account). Reply generically; let Convex log the real reason.
      console.warn("[telegram] /start bind redeem failed", err);
      await sendTelegramHtml(botToken, args.chatId, generic).catch(() => {
        /* best-effort reply */
      });
    }
  },
});
