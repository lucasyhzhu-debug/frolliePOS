import { describe, it, expect } from "vitest";
import { renderReceipt, computeReceiptStatus, type ReceiptViewModel } from "../template";

const baseSettings = {
  business_name: "FROLLIE",
  address: "Pakuwon Mall, Surabaya",
  contact: "+62 821-xxxx-xxxx · frollie.id",
  instagram_handle: "@frollie.id",
  footer_text: "Terima kasih! 💛",
  logo_url: null,
};

function baseVm(): ReceiptViewModel {
  return {
    receipt_number: "R-2026-0058",
    paid_at: Date.parse("2026-05-31T07:32:00Z"), // 14:32 WIB
    subtotal: 150000,
    voucher_discount: 0,
    total: 150000,
    payment_method: "QRIS · GoPay",
    rrn: "240531143215",
    lines: [
      { product_name: "Dubai 1pc", qty: 3, unit_price: 50000, line_subtotal: 150000, refunded_qty: 0 },
    ],
    refunds: [],
    settings: baseSettings,
  };
}

describe("renderReceipt — paid-only (PR A)", () => {
  it("suppresses the LUNAS badge on a paid (no-refund) sale", () => {
    const html = renderReceipt(baseVm());
    expect(html).not.toContain("LUNAS");
    expect(html).not.toContain("SEBAGIAN DIKEMBALIKAN");
    expect(html).not.toContain("DIKEMBALIKAN");
  });

  it("still renders the SEBAGIAN DIKEMBALIKAN badge for a partial refund", () => {
    const vm = baseVm();
    vm.lines[0].refunded_qty = 1;
    vm.refunds = [{ refund_amount: 50000, refunded_at: Date.parse("2026-05-31T08:00:00Z") }];
    expect(renderReceipt(vm)).toContain("SEBAGIAN DIKEMBALIKAN");
  });

  it("still renders the DIKEMBALIKAN badge for a full refund", () => {
    const vm = baseVm();
    vm.lines[0].refunded_qty = 3;
    vm.refunds = [{ refund_amount: 150000, refunded_at: Date.parse("2026-05-31T08:00:00Z") }];
    expect(renderReceipt(vm)).toContain("DIKEMBALIKAN");
  });

  it("renders receipt number + WIB datetime", () => {
    const html = renderReceipt(baseVm());
    expect(html).toContain("R-2026-0058");
    expect(html).toContain("31 Mei 2026 · 14:32 WIB");
  });

  it("formats integer rupiah with dot thousands separator", () => {
    const html = renderReceipt(baseVm());
    expect(html).toContain("Rp 150.000");
  });

  it("renders voucher row when discount > 0 even if voucher_code is missing (defensive — silent gap is worse than placeholder)", () => {
    const html = renderReceipt({
      ...baseVm(),
      voucher_code: undefined,
      voucher_discount: 20000,
      total: 130000,
    });
    expect(html).toContain("Voucher");
    expect(html).toContain("-Rp 20.000");
  });

  it("formats non-finite money as 'Rp —' rather than 'Rp NaN'", () => {
    const html = renderReceipt({
      ...baseVm(),
      total: Number.NaN,
    });
    expect(html).toContain("Rp —");
    expect(html).not.toContain("Rp NaN");
  });

  it("renders voucher line only when voucher applied", () => {
    const noVoucher = renderReceipt(baseVm());
    expect(noVoucher).not.toContain("Voucher");

    const withVoucher = renderReceipt({
      ...baseVm(),
      voucher_code: "FROLLIE20",
      voucher_discount: 20000,
      total: 130000,
    });
    expect(withVoucher).toContain("Voucher (FROLLIE20)");
    expect(withVoucher).toContain("-Rp 20.000");
  });

  it("renders multi-line correctly", () => {
    const vm = baseVm();
    vm.lines.push({ product_name: "Mixed Box 4pcs", qty: 1, unit_price: 80000, line_subtotal: 80000, refunded_qty: 0 });
    vm.subtotal = 230000;
    vm.total = 230000;
    const html = renderReceipt(vm);
    expect(html).toContain("Dubai 1pc");
    expect(html).toContain("Mixed Box 4pcs");
    expect(html).toContain("Rp 230.000");
  });

  it("renders payment method + RRN as one middot line, dropping 'Dibayar via'/'RRN:' labels", () => {
    const html = renderReceipt({ ...baseVm(), payment_method: "QRIS", rrn: "RRN123" });
    expect(html).toContain("QRIS · RRN123");
    expect(html).not.toContain("Dibayar via");
    expect(html).not.toContain("RRN:");
  });

  it("renders method only when no RRN (no trailing middot)", () => {
    const html = renderReceipt({ ...baseVm(), payment_method: "Transfer Bank (manual)", rrn: undefined });
    expect(html).toContain("Transfer Bank (manual)");
    expect(html).not.toContain("Transfer Bank (manual) ·");
  });

  it("renders the em-dash method placeholder when no invoice resolved", () => {
    const html = renderReceipt({ ...baseVm(), payment_method: "—", rrn: undefined });
    expect(html).toContain("—");
    expect(html).not.toContain("Dibayar via");
  });

  it("includes Instagram CTA in footer", () => {
    const html = renderReceipt(baseVm());
    expect(html).toContain("Follow us on Instagram! @frollie.id");
  });

  it("escapes HTML in dynamic fields (XSS guard)", () => {
    const vm = baseVm();
    vm.lines[0].product_name = "<script>alert(1)</script>";
    const html = renderReceipt(vm);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("computeReceiptStatus", () => {
  it("returns paid when refunds empty", () => {
    expect(computeReceiptStatus(baseVm())).toBe("paid");
  });
});

describe("computeReceiptStatus refund branches", () => {
  it("returns partial_refund when some but not all line qty refunded", () => {
    const vm = baseVm();
    vm.lines[0].refunded_qty = 1; // refund 1 of 3
    vm.refunds = [{ refund_amount: 50000, refunded_at: Date.parse("2026-05-31T08:00:00Z") }];
    expect(computeReceiptStatus(vm)).toBe("partial_refund");
  });

  it("returns refunded when all line qty refunded", () => {
    const vm = baseVm();
    vm.lines[0].refunded_qty = 3; // refund all 3
    vm.refunds = [{ refund_amount: 150000, refunded_at: Date.parse("2026-05-31T08:00:00Z") }];
    expect(computeReceiptStatus(vm)).toBe("refunded");
  });
});
