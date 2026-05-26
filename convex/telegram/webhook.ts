import { httpAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

// Telegram-delivered callback shape we care about.
// Full schema: https://core.telegram.org/bots/api#update
type TelegramCallbackQuery = {
  update_id: number;
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
};

export const telegramWebhook = httpAction(async (ctx, request) => {
  // 1. Verify the secret token — Telegram echoes whatever we passed to setWebhook
  //    back in this header on every delivery. Reject anything else as spoofed.
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response("unauthorized", { status: 401 });
  }

  // 2. Parse body. If we can't parse it, 400 — telegram won't retry on 4xx.
  let update: TelegramCallbackQuery;
  try {
    update = (await request.json()) as TelegramCallbackQuery;
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // 3. Only handle callback_query updates in the POC. allowed_updates filter
  //    on setWebhook should prevent anything else from arriving, but be defensive.
  const cq = update.callback_query;
  if (!cq) {
    return new Response("ignored", { status: 200 });
  }

  // 4. Dedupe by update_id. Telegram retries on non-200 responses for up to
  //    24h; without dedupe, a single press could create many log rows.
  await ctx.runMutation(internal.telegram.webhook.recordCallback, {
    update_id: update.update_id,
    callback_data: cq.data,
    from_user: cq.from.username ? `@${cq.from.username}` : cq.from.first_name ?? "unknown",
    message_id: cq.message?.message_id,
    payload_json: JSON.stringify(update),
  });

  // 5. Always acknowledge the callback so Telegram stops the spinner on the
  //    user's button. Failure to call answerCallbackQuery leaves the spinner
  //    running indefinitely (visible UX bug).
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN env var missing — secret was set but token wasn't");
    return new Response("server misconfiguration", { status: 500 });
  }
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cq.id }),
  });

  // 6. Edit the original message to reflect the action. Strip the buttons by
  //    sending an empty inline_keyboard.
  if (cq.message && cq.data) {
    const isApprove = cq.data.startsWith("approve:");
    const isDeny = cq.data.startsWith("deny:");
    const verb = isApprove ? "✅ Approved" : isDeny ? "❌ Denied" : "👉 Selected";
    const userLabel = cq.from.username ? `@${cq.from.username}` : cq.from.first_name ?? "unknown";

    const editRes = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        text: `${verb} by ${userLabel}`,
        reply_markup: { inline_keyboard: [] },
      }),
    });
    if (!editRes.ok) {
      console.warn(
        "editMessageText failed (message may have been deleted before button press):",
        editRes.status,
        await editRes.text(),
      );
    }
  }

  return new Response("ok", { status: 200 });
});

export const recordCallback = internalMutation({
  args: {
    update_id: v.number(),
    callback_data: v.optional(v.string()),
    from_user: v.string(),
    message_id: v.optional(v.number()),
    payload_json: v.string(),
  },
  handler: async (ctx, args) => {
    // Idempotency: if we've seen this update_id before, do nothing.
    const existing = await ctx.db
      .query("telegram_log")
      .withIndex("by_update_id", (q) => q.eq("update_id", args.update_id))
      .first();
    if (existing) return;

    await ctx.db.insert("telegram_log", {
      direction: "in",
      payload_json: args.payload_json,
      update_id: args.update_id,
      callback_data: args.callback_data,
      from_user: args.from_user,
      message_id: args.message_id,
      created_at: Date.now(),
    });
  },
});
