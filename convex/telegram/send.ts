"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  renderManualPaymentApproval,
  renderFoundersSummary,
  renderStaffPinReset,
  type RenderedMessage,
} from "../lib/telegramHtml";

// ─── sendTemplate ─────────────────────────────────────────────────────────────
//
// Role-routed, per-kind typed payload, action-level idempotency, audited send
// failures. Replaces the POC v.any() / hardcoded TELEGRAM_CHAT_ID version.
//
// Mutations (_auditSendFailed_internal, logOutbound) live in telegram/internal.ts
// because "use node" files may only export actions.

export const sendTemplate = action({
  args: {
    role: v.string(),
    kind: v.union(
      v.literal("staff_pin_reset"),
      v.literal("manual_payment_override"),
      v.literal("shift_summary"),
    ),
    payload: v.union(
      // staff_pin_reset — matches StaffPinResetPayload in lib/telegramHtml.ts
      v.object({
        staff_name: v.string(),
        staff_code: v.string(),
        locked_at_iso: v.string(),
        request_url: v.string(),
      }),
      // manual_payment_override — matches ManualPaymentApprovalPayload
      v.object({
        amount_idr: v.number(),
        reason: v.string(),
        requester_name: v.string(),
        approve_url: v.string(),
      }),
      // shift_summary — matches FoundersSummaryPayload
      v.object({
        dateLabel: v.string(),
        totalSalesIdr: v.number(),
        txnCount: v.number(),
        flaggedCount: v.number(),
      }),
    ),
    idempotencyKey: v.string(),
    // Optional: caller-supplied chatId that skips the role-resolve query.
    // Use when the caller has already resolved the chatId (e.g. a cron that
    // checks role-binding first and wants to avoid a second lookup between
    // the binding check and the send — eliminating the unbind race window).
    // `role` is still required for audit logging even when this is set.
    chatIdOverride: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ message_id: number; ok: true }> => {
    // Step 1: action-level idempotency pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { message_id: number; ok: true };

    // Step 2: resolve chat id — prefer chatIdOverride if provided (race-safe
    // path), otherwise resolve from role (standard path).
    const chatId = args.chatIdOverride
      ? args.chatIdOverride
      : await ctx.runQuery(
          internal.telegram.chatRegistry.internal.getChatIdByRole,
          { role: args.role },
        );

    // Step 3: render the message
    let rendered: RenderedMessage;
    switch (args.kind) {
      case "staff_pin_reset":
        rendered = renderStaffPinReset(
          args.payload as {
            staff_name: string;
            staff_code: string;
            locked_at_iso: string;
            request_url: string;
          },
        );
        break;
      case "manual_payment_override":
        rendered = renderManualPaymentApproval(
          args.payload as {
            amount_idr: number;
            reason: string;
            requester_name: string;
            approve_url: string;
          },
        );
        break;
      case "shift_summary":
        rendered = renderFoundersSummary(
          args.payload as {
            dateLabel: string;
            totalSalesIdr: number;
            txnCount: number;
            flaggedCount: number;
          },
        );
        break;
    }

    // Step 4: send to Telegram
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error("TELEGRAM_BOT_TOKEN env var missing");
    }

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: rendered.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (rendered.inline_keyboard) {
      body.reply_markup = { inline_keyboard: rendered.inline_keyboard };
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseJson = await response.json();

    // Capture message_id for the debug trail
    const messageId: number | undefined = responseJson?.result?.message_id;

    // Step 5: on failure — audit + throw
    // I4: include resolved chatId so operators can tell from the audit row
    // whether chatIdOverride or role-resolve was the failing endpoint.
    if (!response.ok || !responseJson?.ok) {
      await ctx.runMutation(internal.telegram.internal._auditSendFailed_internal, {
        role: args.role,
        kind: args.kind,
        status: String(responseJson?.description ?? response.status),
        chat_id: typeof chatId === "string" ? chatId : undefined,
      });
      throw new Error(
        `TELEGRAM_SEND_FAILED: ${responseJson?.description ?? response.status}`,
      );
    }

    // Step 6: keep the outbound debug trail
    await ctx.runMutation(internal.telegram.internal.logOutbound, {
      template_kind: args.kind,
      payload_json: JSON.stringify({ request: body, response: responseJson }),
      message_id: messageId,
    });

    // Step 7: cache the result
    const result = { message_id: messageId as number, ok: true as const };
    await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
      key: args.idempotencyKey,
      mutationName: "telegram.sendTemplate",
      response: JSON.stringify(result),
    });

    // Step 8: return
    return result;
  },
});
