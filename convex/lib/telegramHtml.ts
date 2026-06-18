// Pure functions used by convex/telegram/send.ts to render Telegram messages.
// All user-supplied fields must pass through escapeHtml() because we use
// parse_mode: "HTML" — unescaped <, >, & will either crash the API parser
// (HTTP 400) or render as broken markup.
//
// sendTelegramHtml ported from convex-telegram-bot-starter for chatRegistry.ts

import { formatWibDateTime } from "./time";

interface TelegramSendResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

/**
 * POST to Telegram sendMessage with parse_mode: HTML.
 * Throws on transport error, non-OK HTTP, or ok:false in the JSON body.
 */
export async function sendTelegramHtml(
  token: string,
  chatId: string,
  html: string,
): Promise<{ message_id: number }> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram sendMessage HTTP ${res.status}: ${body}`);
  }
  const json = (await res.json()) as TelegramSendResponse;
  if (!json.ok || !json.result) {
    throw new Error(`Telegram sendMessage failed: ${json.description ?? "unknown"}`);
  }
  return json.result;
}

export type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type RenderedMessage = {
  text: string;
  inline_keyboard?: InlineKeyboardButton[][];
};

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeHtml(input: string): string {
  return input.replace(/[&<>]/g, (ch) => HTML_ENTITIES[ch] ?? ch);
}

// Indonesian Rupiah formatter — integer only, dot thousands separator.
// Matches src/lib/format.ts convention (see ADR-015).
export function formatIdr(amount: number): string {
  return new Intl.NumberFormat("id-ID").format(Math.round(amount));
}

export type ManualPaymentApprovalPayload = {
  amount_idr: number;
  reason: string;
  requester_name: string;
  approve_url: string;
};

export function renderManualPaymentApproval(p: ManualPaymentApprovalPayload): RenderedMessage {
  const text =
    `💳 <b>Manual payment approval</b>\n` +
    `<b>Amount:</b> Rp ${formatIdr(p.amount_idr)}\n` +
    `<b>Requested by:</b> ${escapeHtml(p.requester_name)}\n` +
    `<b>Reason:</b> <i>${escapeHtml(p.reason)}</i>\n\n` +
    `<i>Open the link, enter your manager PIN to approve or deny. Expires in 60 min.</i>`;
  return { text, inline_keyboard: [[{ text: "Open approval →", url: p.approve_url }]] };
}

export type FoundersSummaryPayload = {
  dateLabel: string;
  totalSalesIdr: number;
  txnCount: number;
  flaggedCount: number;
};

export function renderFoundersSummary(p: FoundersSummaryPayload): RenderedMessage {
  return {
    text:
      `📊 <b>Frollie — ${escapeHtml(p.dateLabel)}</b>\n` +
      `<b>Sales:</b> Rp ${formatIdr(p.totalSalesIdr)}\n` +
      `<b>Transactions:</b> ${p.txnCount}\n` +
      `<b>Flagged for review:</b> ${p.flaggedCount}`,
  };
}

export type StaffPinResetPayload = {
  staff_name: string;
  staff_code: string;
  locked_at_iso: string;
  request_url: string;
};

export function renderStaffPinReset(payload: StaffPinResetPayload): RenderedMessage {
  const lockedAtFormatted = new Date(payload.locked_at_iso).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // v0.4: deliver the action link as an inline_keyboard URL button (matches
  // renderManualPaymentApproval). Inline <a href="..."> tags get silently
  // dropped by Telegram for some http://localhost URLs in group messages —
  // the URL button always renders and Telegram opens the URL externally.
  const text =
    `🚨 <b>Staff locked out</b>\n\n` +
    `${escapeHtml(payload.staff_name)} (<code>${escapeHtml(payload.staff_code)}</code>) failed PIN entry 3 times.\n` +
    `Locked at ${escapeHtml(lockedAtFormatted)} WIB.\n\n` +
    `<i>This link expires in 60 minutes.</i>`;

  return {
    text,
    inline_keyboard: [[{ text: "Tap to reset PIN →", url: payload.request_url }]],
  };
}

export type RefundPayload = {
  receipt_number: string;
  total_refund: number;
  lines: Array<{ product_name: string; refund_qty: number; refund_amount: number }>;
  reason: string;
  request_url: string;
};

export function renderRefund(p: RefundPayload): RenderedMessage {
  const linesText = p.lines
    .map(
      (l) =>
        `• ${l.refund_qty} × ${escapeHtml(l.product_name)} — Rp ${formatIdr(l.refund_amount)}`,
    )
    .join("\n");

  const text = [
    `💸 <b>Permintaan pengembalian dana</b>`,
    `Struk: <code>${escapeHtml(p.receipt_number)}</code>`,
    `Total: <b>Rp ${formatIdr(p.total_refund)}</b>`,
    ``,
    linesText,
    ``,
    `Alasan: ${escapeHtml(p.reason)}`,
    ``,
    `<i>Buka tautan untuk setujui (login + PIN diperlukan).</i>`,
  ].join("\n");

  return {
    text,
    inline_keyboard: [[{ text: "✓ Tinjau & setujui", url: p.request_url }]],
  };
}

export interface LowStockAlertPayload {
  sku_name: string;
  on_hand: number;
  low_threshold: number;
}
export function renderLowStockAlert(p: LowStockAlertPayload): RenderedMessage {
  const name = escapeHtml(p.sku_name);
  return {
    text:
      `⚠️ <b>Stok menipis</b>\n` +
      `SKU: <b>${name}</b>\n` +
      `Sisa: <b>${p.on_hand}</b> pcs (ambang: ${p.low_threshold})`,
  };
}

export interface RecountNoticePayload {
  staff_name: string;
  recorded_at_iso: string;
  lines: Array<{ sku_name: string; before: number; after: number; delta: number }>;
}
export function renderRecountNotice(p: RecountNoticePayload): RenderedMessage {
  const rows = p.lines
    .map((l) => `• ${escapeHtml(l.sku_name)}: ${l.before} → ${l.after} (${l.delta >= 0 ? "+" : ""}${l.delta})`)
    .join("\n");
  // v0.5.2 simplify: render the timestamp inline (was accepted in the payload
  // but discarded). Operators reading the alert outside the booth need to know
  // WHEN the recount was recorded, not just who did it.
  const when = escapeHtml(formatWibDateTime(new Date(p.recorded_at_iso).getTime()));
  return {
    text: `📝 <b>Penghitungan ulang stok</b> oleh ${escapeHtml(p.staff_name)} · ${when}\n${rows}`,
  };
}

// v0.6 S2: spoilage-approval template. Off-booth Telegram-approval path —
// manager taps "Open approval →", lands on /approve/:token, enters PIN to
// resolve. URL button (not callback_data) per ADR-035 + business rule #10.
// Payload shape mirrors RefundPayload (lines + total + reason + request_url).
export type SpoilageApprovalPayload = {
  spoilage_event_id: string;
  lines: Array<{ sku_code: string; qty: number }>;
  total_qty: number;
  reason: string;
  request_url: string;
};

export function renderSpoilageApproval(p: SpoilageApprovalPayload): RenderedMessage {
  const linesText = p.lines
    .map((l) => `• ${escapeHtml(l.sku_code)} × ${l.qty}`)
    .join("\n");
  const text = [
    `🗑️ <b>Permintaan persetujuan spoilage</b>`,
    `Event: <code>${escapeHtml(p.spoilage_event_id)}</code>`,
    ``,
    linesText,
    ``,
    `Total: <b>${p.total_qty}</b> pcs`,
    `Alasan: <i>${escapeHtml(p.reason)}</i>`,
    ``,
    `<i>Buka tautan untuk setujui (login + PIN diperlukan). Berakhir dalam 60 menit.</i>`,
  ].join("\n");
  return {
    text,
    inline_keyboard: [[{ text: "✓ Tinjau & setujui", url: p.request_url }]],
  };
}

// v0.6 R5/R6: stock-drift alert. Informational — no URL button (ADR-044 spirit:
// the cron is a passive observer; resolution happens at the booth via the
// manager's /mgr/stock-recon route, not via a Telegram action). R5 lands this
// minimal renderer so its cron entry-point typechecks end-to-end; R6 may
// enrich the body without touching the sendTemplate union signature.
export type StockDriftAlertPayload = {
  drifted: Array<{
    sku_code: string;
    delta: number;
    cached: number;
    reconstructed: number;
  }>;
  detected_at: number; // epoch ms — formatted into WIB inline
};

export function renderStockDriftAlert(p: StockDriftAlertPayload): RenderedMessage {
  const rows = p.drifted
    .map(
      (d) =>
        `• <b>${escapeHtml(d.sku_code)}</b>: cache ${d.cached} vs ledger ${d.reconstructed} (Δ ${d.delta >= 0 ? "+" : ""}${d.delta})`,
    )
    .join("\n");
  const when = escapeHtml(formatWibDateTime(p.detected_at));
  const text = [
    `📊 <b>Stok drift terdeteksi</b> · ${when}`,
    `${p.drifted.length} SKU dengan selisih cache vs ledger:`,
    ``,
    rows,
    ``,
    `<i>Buka /mgr/stock-recon di POS untuk meninjau & resolve.</i>`,
  ].join("\n");
  return { text };
}

// v1.0.1: ops error alert — informational, no inline keyboard.
export type SystemErrorPayload = {
  kind: string;
  message: string;
  route?: string;
  staff_code?: string;
  device_id?: string;
  app_version?: string;
  occurred_at: number;
};

export function renderSystemError(p: SystemErrorPayload): RenderedMessage {
  const lines = [
    `🚨 <b>POS error</b> · ${escapeHtml(p.kind)}`,
    p.route ? `Route: <code>${escapeHtml(p.route)}</code>` : null,
    `${escapeHtml(p.message)}`,
    [p.staff_code ? `staff ${escapeHtml(p.staff_code)}` : null,
     p.device_id ? `dev ${escapeHtml(p.device_id)}` : null,
     p.app_version ? `v${escapeHtml(p.app_version)}` : null]
      .filter(Boolean).join(" · ") || null,
    formatWibDateTime(p.occurred_at),
  ].filter(Boolean);
  return { text: lines.join("\n") };
}

export const TICKER_MAX_LINES = 6;

export type TxnTickerPayload = {
  receipt_number: string;
  total: number;
  lines: Array<{ name: string; qty: number }>;
  staff_name: string;
  instrument: string;
  paid_at: number;
};

// v1.0.1: live sales ticker — informational, no inline keyboard, silent notification.
export function renderTxnTicker(p: TxnTickerPayload): RenderedMessage {
  const shown = p.lines.slice(0, TICKER_MAX_LINES);
  const overflow = p.lines.length - shown.length;
  const itemLines = shown.map((l) => `${l.qty}× ${escapeHtml(l.name)}`);
  if (overflow > 0) itemLines.push(`…+${overflow} more`);
  const wib = formatWibDateTime(p.paid_at);
  return {
    text: [
      `🧾 #${escapeHtml(p.receipt_number)} · Rp ${formatIdr(p.total)}`,
      ...itemLines,
      `${escapeHtml(p.staff_name)} · ${escapeHtml(p.instrument)} · ${wib}`,
    ].join("\n"),
  };
}

// Crypto-random hex nonce. 8 chars = 4 bytes = ~4 billion values — plenty for POC.
// callback_data is limited to 64 bytes by Telegram so we keep the prefix short.
export function makeNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
