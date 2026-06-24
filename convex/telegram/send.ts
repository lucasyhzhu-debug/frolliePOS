"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  renderManualPaymentApproval,
  renderOwnersSummary,
  renderManagersDailySummary,
  renderStaffPinReset,
  renderRefund,
  renderLowStockAlert,
  renderRecountNotice,
  renderSpoilageApproval,
  renderStockDriftAlert,
  renderSystemError,
  renderTxnTicker,
  renderStaffShiftSignoff,
  renderOwnerOtp,
  type RenderedMessage,
  type LowStockAlertPayload,
  type ManagersDailySummaryPayload,
  type RecountNoticePayload,
  type SpoilageApprovalPayload,
  type StockDriftAlertPayload,
  type SystemErrorPayload,
  type TxnTickerPayload,
  type StaffShiftSignoffPayload,
  type OwnerOtpPayload,
} from "../lib/telegramHtml";
import { ROLE_SCOPE } from "./config";
import { resolveOutletChatId } from "./resolveOutletChat";

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
      v.literal("refund"),
      v.literal("low_stock_alert"),     // v0.5.2
      v.literal("recount_notice"),      // v0.5.2
      v.literal("spoilage"),            // NEW v0.6: spoilage approval
      v.literal("stock_drift_alert"),   // NEW v0.6 R5: stock-recon drift alert
      v.literal("system_error"),        // v1.0.1 ops alert
      v.literal("txn_ticker"),          // v1.0.1 sales ticker
      v.literal("staff_shift_signoff"), // v1.2 #6 per-shift summary → founders
      v.literal("owner_otp"),             // v2.0 cockpit login OTP DM (ADR-052)
      v.literal("managers_daily_summary"), // v2.0 per-outlet managers EOD summary
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
        manualBca: v.optional(v.object({
          count: v.number(), totalIdr: v.number(),
          items: v.array(v.object({
            paidAt: v.number(), total: v.number(),
            staffName: v.string(), receiptNumber: v.string(),
          })),
        })),
        // v2.0 Spec-4: per-outlet breakdown for multi-outlet owners rollup.
        perOutlet: v.optional(v.array(v.object({
          outletLabel: v.string(),
          totalSalesIdr: v.number(),
          txnCount: v.number(),
          flaggedCount: v.number(),
        }))),
      }),
      // refund — matches RefundPayload
      v.object({
        receipt_number: v.string(),
        total_refund: v.number(),
        lines: v.array(
          v.object({
            product_name: v.string(),
            refund_qty: v.number(),
            refund_amount: v.number(),
          }),
        ),
        reason: v.string(),
        request_url: v.string(),
      }),
      // low_stock_alert — matches LowStockAlertPayload in lib/telegramHtml.ts
      v.object({ sku_name: v.string(), on_hand: v.number(), low_threshold: v.number() }),
      // recount_notice — matches RecountNoticePayload
      v.object({
        staff_name: v.string(),
        recorded_at_iso: v.string(),
        lines: v.array(v.object({
          sku_name: v.string(), before: v.number(), after: v.number(), delta: v.number(),
        })),
      }),
      // spoilage — matches SpoilageApprovalPayload in lib/telegramHtml.ts
      v.object({
        spoilage_event_id: v.string(),
        lines: v.array(v.object({ sku_code: v.string(), qty: v.number() })),
        total_qty: v.number(),
        reason: v.string(),
        request_url: v.string(),
      }),
      // stock_drift_alert — matches StockDriftAlertPayload in lib/telegramHtml.ts
      v.object({
        drifted: v.array(
          v.object({
            sku_code: v.string(),
            delta: v.number(),
            cached: v.number(),
            reconstructed: v.number(),
          }),
        ),
        detected_at: v.number(),
      }),
      // system_error — matches SystemErrorPayload in lib/telegramHtml.ts
      v.object({
        kind: v.string(), message: v.string(),
        route: v.optional(v.string()), staff_code: v.optional(v.string()),
        device_id: v.optional(v.string()), app_version: v.optional(v.string()),
        occurred_at: v.number(),
        // v2.0 Spec-4 Task 8: originating outlet label (body-only, routing unchanged)
        outlet_label: v.optional(v.string()),
      }),
      // txn_ticker — matches TxnTickerPayload in lib/telegramHtml.ts
      v.object({
        receipt_number: v.string(), total: v.number(),
        lines: v.array(v.object({ name: v.string(), qty: v.number() })),
        staff_name: v.string(), instrument: v.string(), paid_at: v.number(),
        manual_bca: v.optional(v.boolean()),
      }),
      // staff_shift_signoff — matches StaffShiftSignoffPayload in lib/telegramHtml.ts
      v.object({
        dateLabel: v.string(),
        staffName: v.string(),
        shiftStartMs: v.number(),
        shiftEndMs: v.number(),
        durationMs: v.number(),
        totalSalesIdr: v.number(),
        txnCount: v.number(),
        manualBca: v.optional(v.object({
          count: v.number(), totalIdr: v.number(),
          items: v.array(v.object({
            paidAt: v.number(), total: v.number(),
            staffName: v.string(), receiptNumber: v.string(),
          })),
        })),
        endedBy: v.union(v.literal("self"), v.literal("manager")),
        outgoingUncounted: v.optional(v.boolean()),
      }),
      // owner_otp — matches OwnerOtpPayload in lib/telegramHtml.ts
      v.object({ code: v.string(), expires_minutes: v.number() }),
      // managers_daily_summary — matches ManagersDailySummaryPayload
      v.object({
        dateLabel: v.string(),
        outletLabel: v.string(),
        totalSalesIdr: v.number(),
        txnCount: v.number(),
        flaggedCount: v.number(),
        manualBca: v.optional(v.object({
          count: v.number(), totalIdr: v.number(),
          items: v.array(v.object({
            paidAt: v.number(), total: v.number(),
            staffName: v.string(), receiptNumber: v.string(),
          })),
        })),
      }),
    ),
    idempotencyKey: v.string(),
    disableNotification: v.optional(v.boolean()),
    // Optional: caller-supplied chatId that skips the role-resolve query.
    // Use when the caller has already resolved the chatId (e.g. a cron that
    // checks role-binding first and wants to avoid a second lookup between
    // the binding check and the send — eliminating the unbind race window).
    // `role` is still required for audit logging even when this is set.
    chatIdOverride: v.optional(v.string()),
    // v2.0 Spec-4: required when role is outlet-scoped (ROLE_SCOPE[role] === "outlet").
    // Callers MUST pass this for managers/inventory sends; business-scoped roles
    // (owners, ops) don't need it. chatIdOverride callers still SHOULD pass it —
    // it doesn't affect routing (the override wins) but IS threaded into the
    // _auditSendFailed_internal row so a failed send carries its outlet tag.
    outletId: v.optional(v.id("outlets")),
  },
  handler: async (ctx, args): Promise<{ message_id: number; ok: true }> => {
    // Step 1: action-level idempotency pre-check
    const cached = await ctx.runQuery(internal.idempotency.internal._lookup_internal, {
      key: args.idempotencyKey,
    });
    if (cached) return JSON.parse(cached) as { message_id: number; ok: true };

    // Step 2: resolve chat id.
    // Priority: chatIdOverride → outlet-scoped lookup → bare role lookup.
    // Outlet-scoped roles (managers, inventory) REQUIRE outletId; business-scoped
    // roles (owners, ops) and chatIdOverride callers skip the outlet path. A role
    // NOT in ROLE_SCOPE (the legacy "founders" alias, pre-backfill) is `undefined`
    // here → `!== "outlet"` → bare role path (business-wide) — the intended
    // fallthrough; such a caller never passes outletId.
    const isOutletScoped =
      ROLE_SCOPE[args.role as keyof typeof ROLE_SCOPE] === "outlet";
    // Guard hoisted out of the ternary: an outlet-scoped role with no resolved
    // chat MUST carry an outletId (chatIdOverride callers already have a chatId).
    if (isOutletScoped && !args.chatIdOverride && !args.outletId) {
      throw new Error(`OUTLET_REQUIRED_FOR_ROLE:${args.role}`);
    }
    const chatId = args.chatIdOverride
      ? args.chatIdOverride
      : isOutletScoped
        ? await resolveOutletChatId(ctx, args.role, args.outletId!)
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
        rendered = renderOwnersSummary(
          args.payload as {
            dateLabel: string;
            totalSalesIdr: number;
            txnCount: number;
            flaggedCount: number;
            manualBca?: {
              count: number; totalIdr: number;
              items: Array<{ paidAt: number; total: number; staffName: string; receiptNumber: string }>;
            };
            perOutlet?: Array<{
              outletLabel: string;
              totalSalesIdr: number;
              txnCount: number;
              flaggedCount: number;
            }>;
          },
        );
        break;
      case "refund":
        rendered = renderRefund(
          args.payload as {
            receipt_number: string;
            total_refund: number;
            lines: Array<{
              product_name: string;
              refund_qty: number;
              refund_amount: number;
            }>;
            reason: string;
            request_url: string;
          },
        );
        break;
      case "low_stock_alert":
        rendered = renderLowStockAlert(args.payload as LowStockAlertPayload);
        break;
      case "recount_notice":
        rendered = renderRecountNotice(args.payload as RecountNoticePayload);
        break;
      case "spoilage":
        rendered = renderSpoilageApproval(args.payload as SpoilageApprovalPayload);
        break;
      case "stock_drift_alert":
        rendered = renderStockDriftAlert(args.payload as StockDriftAlertPayload);
        break;
      case "system_error":
        rendered = renderSystemError(args.payload as SystemErrorPayload);
        break;
      case "txn_ticker":
        rendered = renderTxnTicker(args.payload as TxnTickerPayload);
        break;
      case "staff_shift_signoff":
        rendered = renderStaffShiftSignoff(args.payload as StaffShiftSignoffPayload);
        break;
      case "owner_otp":
        rendered = renderOwnerOtp(args.payload as OwnerOtpPayload);
        break;
      case "managers_daily_summary":
        rendered = renderManagersDailySummary(args.payload as ManagersDailySummaryPayload);
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
      disable_notification: args.disableNotification ?? false,
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
        outlet_id: args.outletId,
      });
      throw new Error(
        `TELEGRAM_SEND_FAILED: ${responseJson?.description ?? response.status}`,
      );
    }

    // Step 6: keep the outbound debug trail.
    // C3 (ADR-052): an owner_otp DM carries a low-entropy login code in
    // body.text — NEVER persist it to telegram_log. Redact the text and keep
    // only response.ok so the debug trail stays useful without leaking the code.
    const redacted = args.kind === "owner_otp";
    await ctx.runMutation(internal.telegram.internal.logOutbound, {
      template_kind: args.kind,
      payload_json: JSON.stringify(
        redacted
          ? {
              request: { ...body, text: "[redacted owner_otp]" },
              response: { ok: responseJson?.ok },
            }
          : { request: body, response: responseJson },
      ),
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
