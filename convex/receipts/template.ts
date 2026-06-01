// Server-side receipt HTML renderer. Pure function — no DB access. Called from
// receipts/internal._renderReceipt_internal, which fetches all required data and
// hands it to this renderer. Hardcoded layout per ADR-039 §4 + brainstorm Q5.
// PR A: paid-only (refunds[] always empty). PR B: refunds[] populated, refund
// block + status header added.

import { formatWibDateTime } from "../lib/time";
import { escapeHtml } from "../lib/html";
import { refundStatus, type RefundStatus } from "../refunds/lib";

// Business identity pulled from pos_settings via _getSettings_internal in the
// render caller (v0.5.3b — was hardcoded pre-T13). Defaults in
// settings/internal.RECEIPT_DEFAULTS are byte-identical to the pre-v0.5.3b
// constants so an absent/partial row renders receipts identically.
export type ReceiptSettings = {
  business_name: string;
  address: string;
  contact: string;
  instagram_handle: string;          // e.g. "@frollie.id"
  footer_text: string;               // v0.5.3b configurable; default "Terima kasih! 💛"
  logo_url: string | null;           // v0.5.3b uploaded logo; null → emoji fallback
};

export type ReceiptLine = {
  product_name: string;
  qty: number;
  unit_price: number;
  line_subtotal: number;
  refunded_qty: number;              // 0 if no refunds against this line
  // PR B adds: refund_annotation?: string ("1 dari 3 dikembalikan (31 Mei · 14:45)")
};

export type ReceiptRefundSummary = {
  refund_amount: number;
  refunded_at: number;               // for the public receipt; settled_at NEVER included
};

export type ReceiptViewModel = {
  receipt_number: string;
  paid_at: number;
  subtotal: number;
  voucher_code?: string;
  voucher_discount: number;          // 0 if no voucher
  total: number;                      // post-voucher
  payment_method: string;             // "QRIS · GoPay" / "BCA VA" — built upstream
  rrn?: string;                       // Xendit receipt_id
  lines: ReceiptLine[];
  refunds: ReceiptRefundSummary[];   // EMPTY in PR A; PR B populates
  settings: ReceiptSettings;
};

const STATUS_LABELS = {
  paid: { label: "LUNAS", bg: "#d1fae5", fg: "#065f46" },
  partial_refund: { label: "SEBAGIAN DIKEMBALIKAN", bg: "#fef3c7", fg: "#92400e" },
  refunded: { label: "DIKEMBALIKAN", bg: "#fee2e2", fg: "#991b1b" },
} as const;

export type ReceiptStatus = keyof typeof STATUS_LABELS;

const STATUS_BY_REFUND: Record<RefundStatus, ReceiptStatus> = {
  none: "paid",
  partial: "partial_refund",
  full: "refunded",
};

/**
 * Compute the receipt status purely from refunds vs lines.
 * - No refunds: paid
 * - Some refund but not all line qty refunded: partial_refund
 * - All line qty refunded: refunded
 */
export function computeReceiptStatus(vm: ReceiptViewModel): ReceiptStatus {
  return STATUS_BY_REFUND[refundStatus(vm.lines, vm.refunds.length > 0)];
}

/** Indonesian-locale integer rupiah formatter (dot-separated thousands). */
function rp(amount: number): string {
  // Defensive: NaN / ±Infinity → "Rp —". A non-finite money value reaching the
  // renderer is a bug upstream, but printing "Rp NaN" to a customer-facing
  // receipt is worse than printing a dash.
  if (!Number.isFinite(amount)) return "Rp —";
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const parts = String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}Rp ${parts}`;
}

/** Render the receipt HTML page. Returns a complete document. */
export function renderReceipt(vm: ReceiptViewModel): string {
  const status = computeReceiptStatus(vm);
  const statusStyle = STATUS_LABELS[status];

  const linesHtml = vm.lines
    .map((l) => {
      const annotation = l.refunded_qty > 0
        ? `<div style="font-size:10px;color:#dc2626;font-style:italic">↳ ${l.refunded_qty} dari ${l.qty} dikembalikan</div>`
        : "";
      return `
        <div style="display:flex;justify-content:space-between;margin-bottom:6px">
          <div>${l.qty} × ${escapeHtml(l.product_name)}<br>
            <span style="font-size:11px;color:#6b7280">@ ${rp(l.unit_price)}</span>
            ${annotation}
          </div>
          <div style="font-weight:600">${rp(l.line_subtotal)}</div>
        </div>`;
    })
    .join("");

  // Render the voucher row whenever a discount was applied, even if voucher_code
  // is missing/empty — otherwise the discount silently vanishes from the receipt
  // and the subtotal-to-total gap becomes unexplained. Fall back to an em-dash
  // placeholder for the code when absent.
  const voucherHtml = vm.voucher_discount > 0
    ? `<div style="display:flex;justify-content:space-between;margin-bottom:4px;color:#dc2626"><span>Voucher (${vm.voucher_code ? escapeHtml(vm.voucher_code) : "—"})</span><span>${rp(-vm.voucher_discount)}</span></div>`
    : "";

  const refundsBlock = vm.refunds.length === 0
    ? ""
    : `
      <div style="border-top:1px dashed #d1d5db;margin-top:10px;padding-top:10px;font-size:13px;background:#fef3c7;padding:10px;border-radius:6px;color:#92400e">
        <div style="font-weight:600;margin-bottom:4px">Pengembalian</div>
        ${vm.refunds.map((r) => `<div style="display:flex;justify-content:space-between;font-size:12px"><span>${formatWibDateTime(r.refunded_at)}</span><span>${rp(-r.refund_amount)}</span></div>`).join("")}
      </div>`;

  const netRetained = vm.total - vm.refunds.reduce((s, r) => s + r.refund_amount, 0);
  const netRetainedBlock = vm.refunds.length === 0
    ? `<div style="display:flex;justify-content:space-between;font-weight:700;font-size:15px;margin-top:8px;padding-top:8px;border-top:2px solid #1d1d1f"><span>TOTAL</span><span>${rp(vm.total)}</span></div>`
    : `
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-top:6px"><span>Total awal</span><span>${rp(vm.total)}</span></div>
      <div style="display:flex;justify-content:space-between;font-weight:700;font-size:15px;margin-top:10px;padding-top:8px;border-top:2px solid #1d1d1f"><span>NET DIBAYAR</span><span>${rp(netRetained)}</span></div>`;

  // ADR-039 §4: settlement timeline is internal bookkeeping, never on the
  // customer-facing receipt. The customer sees only that a refund happened.
  const refundFooter = vm.refunds.length === 0
    ? "Simpan struk ini untuk refund / penukaran"
    : "Pengembalian dana telah diproses";

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Struk ${escapeHtml(vm.receipt_number)} — ${escapeHtml(vm.settings.business_name)}</title>
<style>
body { margin:0; padding:24px; background:#f3f4f6; font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif; color:#1d1d1f; }
.receipt { max-width:380px; margin:0 auto; background:#ffffff; border-radius:12px; padding:24px; box-shadow:0 4px 12px rgba(0,0,0,0.08); }
</style>
</head>
<body>
<div class="receipt">
  <div style="text-align:center;margin-bottom:16px;padding-bottom:14px;border-bottom:1px dashed #d1d5db">
    <div style="font-size:14px;color:#0f766e;font-weight:700;letter-spacing:1px;margin-bottom:4px">${vm.settings.logo_url
      ? `<img src="${escapeHtml(vm.settings.logo_url)}" alt="" style="height:32px;vertical-align:middle;margin-right:6px">`
      : "🍪"} ${escapeHtml(vm.settings.business_name)}</div>
    <div style="font-size:11px;color:#6b7280;line-height:1.4">${escapeHtml(vm.settings.address)}<br>${escapeHtml(vm.settings.contact)}</div>
  </div>
  <div style="text-align:center;background:${statusStyle.bg};color:${statusStyle.fg};padding:6px;border-radius:6px;font-size:13px;font-weight:600;margin-bottom:14px">${statusStyle.label}</div>
  <div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-bottom:14px">
    <span>${escapeHtml(vm.receipt_number)}</span>
    <span>${formatWibDateTime(vm.paid_at)}</span>
  </div>
  <div style="font-size:13px;border-top:1px dashed #d1d5db;padding-top:10px">${linesHtml}</div>
  <div style="border-top:1px dashed #d1d5db;margin-top:10px;padding-top:10px;font-size:13px">
    <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span>Subtotal</span><span>${rp(vm.subtotal)}</span></div>
    ${voucherHtml}
    ${netRetainedBlock}
  </div>
  ${refundsBlock}
  <div style="margin-top:12px;font-size:12px;color:#6b7280;text-align:center;padding-top:10px;border-top:1px dashed #d1d5db">
    Dibayar via ${escapeHtml(vm.payment_method)}
    ${vm.rrn ? `<br><span style="font-size:10px">RRN: ${escapeHtml(vm.rrn)}</span>` : ""}
  </div>
  <div style="margin-top:14px;font-size:11px;color:#6b7280;text-align:center;line-height:1.5">
    ${escapeHtml(vm.settings.footer_text)}<br>
    <span style="font-size:10px">${refundFooter}</span><br><br>
    <span style="font-size:11px">Follow us on Instagram! ${escapeHtml(vm.settings.instagram_handle)}</span>
  </div>
</div>
</body>
</html>`;
}
