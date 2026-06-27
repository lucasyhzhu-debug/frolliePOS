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

// v1.2 #10: manual-BCA tally appended to the EOD founders summary.
export type ManualBcaTally = {
  count: number;
  totalIdr: number;
  items: Array<{ paidAt: number; total: number; staffName: string; receiptNumber: string }>;
};

export const MANUAL_BCA_EOD_MAX_LINES = 30;

export type FoundersSummaryPayload = {
  dateLabel: string;
  totalSalesIdr: number;
  txnCount: number;
  flaggedCount: number;
  manualBca?: ManualBcaTally; // v1.2 #10
  /** v2.0 Spec-4: per-outlet breakdown appended when > 1 active outlet. */
  perOutlet?: Array<{
    outletLabel: string;
    totalSalesIdr: number;
    txnCount: number;
    flaggedCount: number;
  }>;
};

/** Shared helper: appends Manual BCA summary lines into an existing lines array.
 * Called by both renderOwnersSummary and renderStaffShiftSignoff. V8-safe. */
function renderManualBcaBlock(tally: ManualBcaTally, lines: string[]): void {
  if (tally.count <= 0) return;
  lines.push("", `🏦 <b>Manual BCA:</b> ${tally.count} txn · Rp ${formatIdr(tally.totalIdr)}`);
  const shown = tally.items.slice(0, MANUAL_BCA_EOD_MAX_LINES);
  for (const it of shown) {
    const when = escapeHtml(formatWibDateTime(it.paidAt));
    lines.push(`• ${when} · Rp ${formatIdr(it.total)} · ${escapeHtml(it.staffName)} (${escapeHtml(it.receiptNumber)})`);
  }
  const overflow = tally.items.length - shown.length;
  if (overflow > 0) lines.push(`…+${overflow} more — see POS`);
}

/**
 * Render the owners shift-summary (business rollup, with optional per-outlet
 * breakdown when more than one outlet is active).
 *
 * Single-outlet: the perOutlet array is absent (or length ≤ 1) — renders
 * identically to the old renderFoundersSummary.
 * Multi-outlet: a "── By outlet ──" section is appended beneath the totals.
 */
export function renderOwnersSummary(p: FoundersSummaryPayload): RenderedMessage {
  const lines = [
    `📊 <b>Frollie — ${escapeHtml(p.dateLabel)}</b>`,
    `<b>Sales:</b> Rp ${formatIdr(p.totalSalesIdr)}`,
    `<b>Transactions:</b> ${p.txnCount}`,
    `<b>Flagged for review:</b> ${p.flaggedCount}`,
  ];
  if (p.manualBca) renderManualBcaBlock(p.manualBca, lines);
  // Per-outlet breakdown — only rendered when more than one outlet is present.
  if (p.perOutlet && p.perOutlet.length > 1) {
    lines.push("", `<b>── By outlet ──</b>`);
    for (const o of p.perOutlet) {
      lines.push(
        `<b>${escapeHtml(o.outletLabel)}</b>: Rp ${formatIdr(o.totalSalesIdr)} · ${o.txnCount} txn${o.flaggedCount > 0 ? ` · ${o.flaggedCount} flagged` : ""}`,
      );
    }
  }
  return { text: lines.join("\n") };
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
// v2.0 Spec-4 Task 8: outlet_label added — shown in body when present;
// routing stays business-wide (role: "ops", no outletId).
export type SystemErrorPayload = {
  kind: string;
  message: string;
  route?: string;
  staff_code?: string;
  device_id?: string;
  app_version?: string;
  occurred_at: number;
  /** v2.0 Spec-4: originating outlet label, omitted for cron/system errors. */
  outlet_label?: string;
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
    p.outlet_label ? `outlet: ${escapeHtml(p.outlet_label)}` : null,
    escapeHtml(formatWibDateTime(p.occurred_at)),
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
  /** Set true for manual BCA transfers — appends a ⚠️ MANUAL check reminder. */
  manual_bca?: boolean;
};

// v1.0.1: live sales ticker — informational, no inline keyboard, silent notification.
export function renderTxnTicker(p: TxnTickerPayload): RenderedMessage {
  const shown = p.lines.slice(0, TICKER_MAX_LINES);
  const overflow = p.lines.length - shown.length;
  const itemLines = shown.map((l) => `${l.qty}× ${escapeHtml(l.name)}`);
  if (overflow > 0) itemLines.push(`…+${overflow} more`);
  const wib = escapeHtml(formatWibDateTime(p.paid_at));
  const tail: string[] = [
    `${escapeHtml(p.staff_name)} · ${escapeHtml(p.instrument)} · ${wib}`,
  ];
  if (p.manual_bca) {
    tail.push(`⚠️ <b>MANUAL</b> — check the BCA account before confirming stock.`);
  }
  return {
    text: [
      `🧾 #${escapeHtml(p.receipt_number)} · Rp ${formatIdr(p.total)}`,
      ...itemLines,
      ...tail,
    ].join("\n"),
  };
}

// v1.2 #6: per-shift staff signoff summary sent to the founders chat.
// Mirrors FoundersSummaryPayload but scoped to a single staff shift.
// `endedBy: "manager"` flags that a manager takeover displaced the staff
// (their count was unchecked); `outgoingUncounted` is set alongside it.
export type StaffShiftSignoffPayload = {
  dateLabel: string;
  staffName: string;
  shiftStartMs: number;
  shiftEndMs: number;
  durationMs: number;
  totalSalesIdr: number;
  txnCount: number;
  manualBca?: ManualBcaTally;
  endedBy: "self" | "manager";
  outgoingUncounted?: boolean;
};

// Format milliseconds as "Xj Ym" (jam / menit). Drops the minutes part when
// duration is an exact hour; drops jam part when < 1 hour.
function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours}j ${minutes}m`;
  if (hours > 0) return `${hours}j`;
  return `${minutes}m`;
}

export function renderStaffShiftSignoff(p: StaffShiftSignoffPayload): RenderedMessage {
  const lines: string[] = [];

  if (p.endedBy === "manager") {
    lines.push(`⚠️ <b>Diakhiri oleh manajer</b>`);
  }
  if (p.outgoingUncounted) {
    lines.push(`⚠️ <i>Stok keluar belum dihitung (tidak ada handover)</i>`);
  }

  lines.push(
    `👤 <b>Shift selesai — ${escapeHtml(p.staffName)}</b>`,
    `<b>Tanggal:</b> ${escapeHtml(p.dateLabel)}`,
    `<b>Durasi:</b> ${formatDuration(p.durationMs)}`,
    `<b>Penjualan:</b> Rp ${formatIdr(p.totalSalesIdr)}`,
    `<b>Transaksi:</b> ${p.txnCount}`,
  );

  if (p.manualBca) renderManualBcaBlock(p.manualBca, lines);

  return { text: lines.join("\n") };
}

// ── managers_daily_summary (v2.0 per-outlet managers chat) ──────────────────
// Per-outlet EOD summary sent to the managers chat for the specific outlet.
// Mirrors renderFoundersSummary's formatting but scoped to one outlet.
// No inline_keyboard — informational only.
export interface ManagersDailySummaryPayload {
  dateLabel: string;
  outletLabel: string;
  totalSalesIdr: number;
  txnCount: number;
  flaggedCount: number;
  manualBca?: ManualBcaTally;
}

export function renderManagersDailySummary(p: ManagersDailySummaryPayload): RenderedMessage {
  const lines = [
    `📊 <b>${escapeHtml(p.outletLabel)} — ${escapeHtml(p.dateLabel)}</b>`,
    `<b>Sales:</b> Rp ${formatIdr(p.totalSalesIdr)}`,
    `<b>Transactions:</b> ${p.txnCount}`,
  ];
  if (p.flaggedCount > 0) {
    lines.push(`<b>Flagged for review:</b> ${p.flaggedCount}`);
  }
  if (p.manualBca) renderManualBcaBlock(p.manualBca, lines);
  return { text: lines.join("\n") };
}

// ── owner_otp (v2.0 cockpit login, ADR-052) ─────────────────────────────────
// A private DM to the owner's bound Telegram chat carrying the 6-digit cockpit
// login code. Sent via sendTemplate with chatIdOverride (NOT a role broadcast).
// The code is numeric-only and rendered verbatim; the persisted telegram_log row
// is redacted at the send boundary (C3) so the code is never stored.
export interface OwnerOtpPayload {
  code: string;
  expires_minutes: number;
}

export function renderOwnerOtp(p: OwnerOtpPayload): RenderedMessage {
  return {
    text:
      `🔑 Your Frollie cockpit login code: <b>${escapeHtml(p.code)}</b>\n` +
      `Expires in ${p.expires_minutes} min. Ignore this message if you didn't request it.`,
  };
}

// v1.3.1: off-booth manager override approval template.
// Routes to `managers` (outlet-scoped); URL button → /approve/:token (ADR-035).
// Mirrors renderSpoilageApproval shape (RenderedMessage + inline_keyboard URL button).
export type ShiftOverridePayload = {
  outlet_label: string;
  stranded_staff_name: string;
  shift_started_at: number;
  sales_so_far_idr: number;
  txn_count: number;
  approve_url: string;
};

export function renderShiftOverride(p: ShiftOverridePayload): RenderedMessage {
  const text = [
    `<b>🔓 Manager override requested</b>`,
    `Outlet: <b>${escapeHtml(p.outlet_label)}</b>`,
    `Booth held by: <b>${escapeHtml(p.stranded_staff_name)}</b>`,
    `Sales so far: <b>Rp ${formatIdr(p.sales_so_far_idr)}</b> (${p.txn_count} txn)`,
    ``,
    `<i>Tap to review and release the booth. Expires in 60 min.</i>`,
  ].join("\n");
  return {
    text,
    inline_keyboard: [[{ text: "Open approval →", url: p.approve_url }]],
  };
}

// Crypto-random hex nonce. 8 chars = 4 bytes = ~4 billion values — plenty for POC.
// callback_data is limited to 64 bytes by Telegram so we keep the prefix short.
export function makeNonce(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
