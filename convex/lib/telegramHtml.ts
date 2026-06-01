// Pure functions used by convex/telegram/send.ts to render Telegram messages.
// All user-supplied fields must pass through escapeHtml() because we use
// parse_mode: "HTML" — unescaped <, >, & will either crash the API parser
// (HTTP 400) or render as broken markup.
//
// sendTelegramHtml ported from convex-telegram-bot-starter for chatRegistry.ts

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

// Crypto-random hex nonce. 8 chars = 4 bytes = ~4 billion values — plenty for POC.
// callback_data is limited to 64 bytes by Telegram so we keep the prefix short.
export function makeNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
