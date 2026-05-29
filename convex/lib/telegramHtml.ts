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
  callback_data: string;
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

export type ApprovalPayload = {
  action_type: "refund" | "manual_pay" | "neg_stock";
  amount_idr: number;
  reason: string;
};

const ACTION_LABELS: Record<ApprovalPayload["action_type"], string> = {
  refund: "Refund",
  manual_pay: "Manual payment override",
  neg_stock: "Negative stock acknowledgment",
};

export function renderApproval(payload: ApprovalPayload, nonce: string): RenderedMessage {
  const text =
    `<b>${escapeHtml(ACTION_LABELS[payload.action_type])} approval</b>\n` +
    `<b>Amount:</b> Rp ${formatIdr(payload.amount_idr)}\n` +
    `<b>Reason:</b> <i>${escapeHtml(payload.reason)}</i>\n\n` +
    `Tap a button below.`;

  return {
    text,
    inline_keyboard: [
      [
        { text: "Approve ✅", callback_data: `approve:${nonce}` },
        { text: "Deny ❌", callback_data: `deny:${nonce}` },
      ],
    ],
  };
}

export type ShiftSummaryPayload = {
  staff_name: string;
  sales_idr: number;
  txn_count: number;
  hours: number;
};

export function renderShiftSummary(payload: ShiftSummaryPayload): RenderedMessage {
  const text =
    `<b>${escapeHtml(payload.staff_name)} · shift closed</b>\n` +
    `<b>Sales:</b> Rp ${formatIdr(payload.sales_idr)}\n` +
    `<b>Txns:</b> ${payload.txn_count}\n` +
    `<b>Hours:</b> ${payload.hours.toFixed(1)}`;

  return { text };
}

export type CustomPayload = {
  text: string;
  include_buttons: boolean;
};

export function renderCustom(payload: CustomPayload, nonce: string): RenderedMessage {
  const message: RenderedMessage = {
    text: escapeHtml(payload.text),
  };
  if (payload.include_buttons) {
    message.inline_keyboard = [
      [
        { text: "Test A", callback_data: `test_a:${nonce}` },
        { text: "Test B", callback_data: `test_b:${nonce}` },
      ],
    ];
  }
  return message;
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

  const text =
    `🚨 <b>Staff locked out</b>\n\n` +
    `${escapeHtml(payload.staff_name)} (<code>${escapeHtml(payload.staff_code)}</code>) failed PIN entry 3 times.\n` +
    `Locked at ${escapeHtml(lockedAtFormatted)} WIB.\n\n` +
    `<a href="${escapeHtml(payload.request_url)}">Tap to reset PIN →</a>\n\n` +
    `<i>This link expires in 60 minutes.</i>`;

  return { text };
}

// Crypto-random hex nonce. 8 chars = 4 bytes = ~4 billion values — plenty for POC.
// callback_data is limited to 64 bytes by Telegram so we keep the prefix short.
export function makeNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
