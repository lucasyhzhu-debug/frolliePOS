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

    // Accept ANY per-outlet managers chat (was: equality vs the single getChatIdByRole("managers")).
    // Now that "managers" is per-outlet there are MULTIPLE managers chats; gate on the row's role
    // field instead of a single-chat equality check. No outlet threading — minted code stays
    // outlet-less (device→outlet binding is post-activation manager-PIN assignDeviceOutlet).
    const row = await ctx.runQuery(internal.telegram.chatRegistry.internal.getChatRow, { chatId: args.chatId });
    if (!row || row.role !== "managers" || row.archivedAt !== undefined) return; // not a managers chat — silent no-op

    // Mint the code. Narrow the catch to the EXPECTED failure (collision
    // exhaustion) so the manager gets a clear "try again" — but rethrow anything
    // unexpected (schema mismatch, runtime fault) so it surfaces in the Convex
    // dashboard instead of masquerading as a transient issuance hiccup.
    let code: string;
    let expiresAt: number;
    try {
      ({ code, expiresAt } = await ctx.runMutation(
        internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal,
        { chatTitle: args.chatTitle, fromId: args.fromId },
      ));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== "CODE_COLLISION") throw err; // unexpected — surface it
      console.warn("[telegram] /activatepos code-collision exhaustion", err);
      await sendTelegramHtml(
        token,
        args.chatId,
        "⚠️ Couldn't generate a setup code — please try again.",
      ).catch(() => {
        /* best-effort */
      });
      return;
    }

    // Code is minted and persisted. A send failure here is a DELIVERY problem,
    // not a generation problem — say so accurately (a second attempt would mint a
    // redundant code; both expire harmlessly in 15min). Let Convex log the failure.
    const baseUrl = process.env.POS_BASE_URL;
    const until = escapeHtml(formatWibDateTime(expiresAt));
    const where = baseUrl
      ? `On the new phone/browser, open ${escapeHtml(baseUrl)}/activate and enter the code.`
      : `On the new phone/browser, open the POS /activate page and enter the code.`;
    const html = [
      `🔓 Device setup code: <b>${code}</b>`,
      `Valid until ${until} (15 minutes).`,
      where,
    ].join("\n");
    await sendTelegramHtml(token, args.chatId, html);
  },
});
