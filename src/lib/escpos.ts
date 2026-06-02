import EscPosEncoder from "esc-pos-encoder";
import type { ReceiptViewModel, ReceiptStatus } from "../../convex/receipts/template";
import { rp, fmtDate, fmtTime } from "./format";

const COLS = 32; // 58mm @ Font A

/** Drop characters the thermal head can't render (emoji, etc.). */
function ascii(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "").trim();
}

/** Left text + right-aligned amount padded to COLS. */
function row(left: string, right: string): string {
  const l = ascii(left);
  const pad = Math.max(1, COLS - l.length - right.length);
  return l + " ".repeat(pad) + right;
}

/**
 * Build the Instagram URL the printed QR encodes (v0.5.4 — was the digital
 * receipt /r/<token> URL; the booth wanted a follow-us QR instead, ADR-043
 * amended). Derived from the `instagram_handle` receipt setting so it stays
 * editable via /mgr/receipt with no code change:
 *   "@frollie.id"            → "https://www.instagram.com/frollie.id/"
 *   "frollie.id"             → "https://www.instagram.com/frollie.id/"
 *   "https://linktr.ee/x"    → passed through unchanged (already a URL)
 *   "" / "@"                 → null (no QR rendered)
 */
export function instagramUrl(handle: string): string | null {
  const raw = handle.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const h = raw.replace(/^@/, "").trim();
  if (!h) return null;
  return `https://www.instagram.com/${h}/`;
}

export function encodeReceipt(
  vm: ReceiptViewModel,
  _status: ReceiptStatus,
  statusLabel: string,
): Uint8Array {
  const e = new EscPosEncoder();
  e.initialize();

  // Header — business name (large), then address only if configured. Empty
  // fields are skipped so clearing a value in /mgr/receipt removes the line
  // rather than printing a blank one.
  e.align("center").bold(true).width(2).height(2).line(ascii(vm.settings.business_name)).width(1).height(1).bold(false);
  const address = ascii(vm.settings.address);
  if (address) e.line(address);
  e.line("-".repeat(COLS));
  e.line(`[ ${ascii(statusLabel)} ]`);
  e.align("left");
  e.line(row(vm.receipt_number, `${fmtDate(vm.paid_at)} ${fmtTime(vm.paid_at)}`));
  e.line("-".repeat(COLS));

  for (const l of vm.lines) {
    e.line(row(`${l.qty} x ${ascii(l.product_name)}`, rp(l.line_subtotal)));
    e.line(`  @ ${rp(l.unit_price)}`);
    if (l.refunded_qty > 0) e.line(`  -> ${l.refunded_qty} dari ${l.qty} dikembalikan`);
  }

  e.line("-".repeat(COLS));
  e.line(row("Subtotal", rp(vm.subtotal)));
  if (vm.voucher_discount > 0) {
    e.line(row(`Voucher (${ascii(vm.voucher_code ?? "-")})`, rp(-vm.voucher_discount)));
  }
  e.bold(true).width(1).height(2).line(row("TOTAL", rp(vm.total))).width(1).height(1).bold(false);

  if (vm.refunds.length > 0) {
    e.line("Pengembalian:");
    for (const r of vm.refunds) e.line(row(fmtDate(r.refunded_at), rp(-r.refund_amount)));
    const net = vm.total - vm.refunds.reduce((s, r) => s + r.refund_amount, 0);
    e.bold(true).line(row("NET DIBAYAR", rp(net))).bold(false);
  }

  e.line(`Dibayar via ${ascii(vm.payment_method)}`);
  if (vm.rrn) e.line(`RRN: ${ascii(vm.rrn)}`);

  // Footer — Instagram follow QR (derived from the handle), then the
  // configurable footer line. Both come from /mgr/receipt settings.
  e.align("center");
  const ig = instagramUrl(vm.settings.instagram_handle);
  if (ig) {
    e.qrcode(ig);
    const handle = ascii(vm.settings.instagram_handle);
    e.line(handle ? `Follow ${handle}` : "Follow us on Instagram");
  }
  const footer = ascii(vm.settings.footer_text);
  if (footer) e.line(footer);
  e.newline().newline().newline();

  return e.encode();
}

/** Shared fixture — feeds golden tests AND useThermalPrinter.testPrint(). */
export const SAMPLE_RECEIPT: {
  viewModel: ReceiptViewModel;
  status: ReceiptStatus;
  statusLabel: string;
} = {
  status: "paid",
  statusLabel: "LUNAS",
  viewModel: {
    receipt_number: "R-2026-0042",
    paid_at: 1_780_000_000_000,
    subtotal: 325_000,
    voucher_discount: 0,
    total: 325_000,
    payment_method: "QRIS",
    lines: [
      { product_name: "Dubai 8pcs", qty: 2, unit_price: 120_000, line_subtotal: 240_000, refunded_qty: 0 },
      { product_name: "Mixed Box 4pcs", qty: 1, unit_price: 85_000, line_subtotal: 85_000, refunded_qty: 0 },
    ],
    refunds: [],
    settings: {
      business_name: "FROLLIE",
      address: "Pakuwon Mall, Surabaya",
      contact: "frollie.id",
      instagram_handle: "@frollie.id",
      footer_text: "Terima kasih! 💛",
      logo_url: null,
    },
  },
};
