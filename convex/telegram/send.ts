import { v } from "convex/values";
import { action, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  renderApproval,
  renderShiftSummary,
  renderCustom,
  makeNonce,
  type RenderedMessage,
} from "../lib/telegramHtml";

// Convex actions run in a Node-like runtime and can make external HTTP calls
// via the standard fetch API. Mutations cannot — that's why this is an action.
//
// POC: idempotency-key wrapping intentionally omitted per spec §Out of scope
// (docs/superpowers/specs/2026-05-25-telegram-poc-design.md). Will be added
// when the POC graduates and replaces ADR-027.

export const sendTemplate = action({
  args: {
    kind: v.union(
      v.literal("approval"),
      v.literal("shift_summary"),
      v.literal("custom"),
    ),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      throw new Error(
        "Telegram env vars missing. Run `npx convex env set TELEGRAM_BOT_TOKEN ...` and `... TELEGRAM_CHAT_ID -- ...`.",
      );
    }

    let rendered: RenderedMessage;
    const nonce = makeNonce();
    switch (args.kind) {
      case "approval":
        rendered = renderApproval(args.payload, nonce);
        break;
      case "shift_summary":
        rendered = renderShiftSummary(args.payload);
        break;
      case "custom":
        rendered = renderCustom(args.payload, nonce);
        break;
    }

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: rendered.text,
      parse_mode: "HTML",
    };
    if (rendered.inline_keyboard) {
      body.reply_markup = { inline_keyboard: rendered.inline_keyboard };
    }

    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const responseJson = await response.json();

    // Capture message_id so a later editMessageText (from the webhook) can target it.
    const messageId: number | undefined = responseJson?.result?.message_id;

    await ctx.runMutation(internal.telegram.send.logOutbound, {
      template_kind: args.kind,
      payload_json: JSON.stringify({ request: body, response: responseJson }),
      message_id: messageId,
    });

    if (!response.ok || !responseJson?.ok) {
      throw new Error(
        `Telegram sendMessage failed: ${response.status} ${JSON.stringify(responseJson)}`,
      );
    }

    return { message_id: messageId, ok: true };
  },
});

export const logOutbound = internalMutation({
  args: {
    template_kind: v.string(),
    payload_json: v.string(),
    message_id: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("telegram_log", {
      direction: "out",
      template_kind: args.template_kind,
      payload_json: args.payload_json,
      message_id: args.message_id,
      created_at: Date.now(),
    });
  },
});
