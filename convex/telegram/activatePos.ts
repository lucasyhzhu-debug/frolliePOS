// convex/telegram/activatePos.ts
//
// `/activatepos` — managers mint a device setup code from Telegram. Gated to the
// chat bound to the "managers" role (the same chat that receives /approve cards).
// Mirrors the buildRegistryCommands factory shape; the chat-role gate lives in the
// action because dispatch has only a Scheduler (no query ctx).

import type { Scheduler } from "convex/server";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { CommandRegistration } from "./commands";
import { sendTelegramHtml, escapeHtml } from "../lib/telegramHtml";
import { formatWibDateTime } from "../lib/time";

export function buildActivatePosCommand(scheduler: Scheduler): CommandRegistration[] {
  return [
    {
      name: "activatepos",
      dispatch: async (msg) => {
        await scheduler.runAfter(0, internal.telegram.activatePos.handleActivatePos, {
          chatId: msg.chatId,
          chatTitle: msg.title,
          fromId: msg.fromId,
        });
      },
    },
  ];
}

export const handleActivatePos = internalAction({
  args: {
    chatId: v.string(),
    chatTitle: v.string(),
    fromId: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing");

    // Chat-role gate: only the chat bound to "managers" may mint codes.
    // Narrow catch (mirrors dispatch.ts:42-51): treat ONLY an unbound role as a
    // silent no-op; rethrow anything else so transient failures surface in the
    // Convex dashboard instead of looking like an auth rejection.
    let managersChatId: string;
    try {
      managersChatId = await ctx.runQuery(
        internal.telegram.chatRegistry.internal.getChatIdByRole,
        { role: "managers" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No Telegram chat assigned to role")) return; // unbound — silent
      throw err; // unexpected — surface it
    }
    if (managersChatId !== args.chatId) return;

    try {
      const { code, expiresAt } = await ctx.runMutation(
        internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal,
        { chatTitle: args.chatTitle, fromId: args.fromId },
      );
      const baseUrl = process.env.POS_BASE_URL;
      const until = escapeHtml(formatWibDateTime(expiresAt));
      const where = baseUrl
        ? `On the new phone/browser, open ${escapeHtml(baseUrl)}/activate and enter the code.`
        : `On the new phone/browser, open the POS /activate page and enter the code.`;
      const html = [
        `🔓 Device setup code: <b>${code}</b>`,
        `Valid until ${until} (1 hour).`,
        where,
      ].join("\n");
      await sendTelegramHtml(token, args.chatId, html);
    } catch (err) {
      // Issuance or send failed (collision exhaustion, network) — never leave
      // the manager with silence.
      console.warn("[telegram] /activatepos issuance failed", err);
      try {
        await sendTelegramHtml(
          token,
          args.chatId,
          "⚠️ Couldn't generate a setup code — please try again.",
        );
      } catch {
        /* best-effort */
      }
    }
  },
});
