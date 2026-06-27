import { describe, it, expect, test } from "vitest";
import { renderOwnersSummary, renderLowStockAlert, renderRecountNotice, renderSystemError, renderTxnTicker, renderStaffShiftSignoff, renderShiftOverride } from "../telegramHtml";

describe("renderSystemError", () => {
  it("escapes HTML and has no buttons", () => {
    const m = renderSystemError({ kind: "crash", message: "<script>boom</script>", occurred_at: 0 });
    expect(m.text).toContain("&lt;script&gt;");
    expect(m.inline_keyboard).toBeUndefined();
  });
});

describe("renderTxnTicker", () => {
  it("formats money + lines, escapes names, no buttons", () => {
    const m = renderTxnTicker({
      receipt_number: "R-2026-0042", total: 320000,
      lines: [{ name: "Dubai <Cookie>", qty: 3 }], staff_name: "Bayu",
      instrument: "QRIS", paid_at: 0,
    });
    expect(m.text).toContain("320.000");
    expect(m.text).toContain("3× Dubai &lt;Cookie&gt;");
    expect(m.inline_keyboard).toBeUndefined();
  });
  it("truncates beyond 6 lines", () => {
    const lines = Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, qty: 1 }));
    const m = renderTxnTicker({ receipt_number: "R", total: 1, lines, staff_name: "X", instrument: "QRIS", paid_at: 0 });
    expect(m.text).toContain("…+3 more");
  });
  it("manual_bca: appends warning line when manual_bca=true", () => {
    const m = renderTxnTicker({
      receipt_number: "R-2026-0099", total: 150000,
      lines: [{ name: "Dubai 3pcs", qty: 1 }], staff_name: "Sari",
      instrument: "Manual BCA", paid_at: 0, manual_bca: true,
    });
    expect(m.text).toContain("MANUAL");
    expect(m.text).toContain("check the BCA account");
    expect(m.inline_keyboard).toBeUndefined();
  });
  it("manual_bca: NO warning line for normal QRIS ticker (no manual_bca field)", () => {
    const m = renderTxnTicker({
      receipt_number: "R-2026-0001", total: 50000,
      lines: [{ name: "Dubai 1pcs", qty: 1 }], staff_name: "Bayu",
      instrument: "QRIS", paid_at: 0,
    });
    expect(m.text).not.toContain("MANUAL");
    expect(m.inline_keyboard).toBeUndefined();
  });
});

describe("renderOwnersSummary manual-BCA section", () => {
  it("appends an itemized manual-BCA section when count > 0", () => {
    const m = renderOwnersSummary({
      dateLabel: "19 Jun 2026", totalSalesIdr: 500000, txnCount: 10, flaggedCount: 0,
      manualBca: {
        count: 2, totalIdr: 80000,
        items: [
          { paidAt: 1_700_000_000_000, total: 50000, staffName: "Lucas", receiptNumber: "R-2026-0001" },
          { paidAt: 1_700_000_100_000, total: 30000, staffName: "Mira", receiptNumber: "R-2026-0002" },
        ],
      },
    });
    expect(m.text).toContain("Manual BCA");
    expect(m.text).toContain("R-2026-0001");
    expect(m.text).toContain("Rp 80.000");
  });

  it("omits the manual-BCA section when count is 0", () => {
    const m = renderOwnersSummary({
      dateLabel: "19 Jun 2026", totalSalesIdr: 500000, txnCount: 10, flaggedCount: 0,
      manualBca: { count: 0, totalIdr: 0, items: [] },
    });
    expect(m.text).not.toContain("Manual BCA");
  });
});

test("renderStaffShiftSignoff shows hours, sales, manual-BCA, and the manager-ended flag", () => {
  const out = renderStaffShiftSignoff({
    dateLabel: "19 Jun 2026",
    staffName: "Budi",
    shiftStartMs: 0,
    shiftEndMs: 3_600_000,
    durationMs: 3_600_000,
    totalSalesIdr: 2_480_000,
    txnCount: 38,
    manualBca: {
      count: 1,
      totalIdr: 90_000,
      items: [{ paidAt: 1, total: 90_000, staffName: "Budi", receiptNumber: "R-1" }],
    },
    endedBy: "manager",
    outgoingUncounted: true,
  });
  expect(out.text).toContain("Budi");
  expect(out.text).toMatch(/1j/);          // duration rendered as "1j"
  expect(out.text).toContain("2.480.000"); // formatIdr
  expect(out.text).toMatch(/[Mm]anual.*BCA|BCA.*[Mm]anual/);
  expect(out.text).toMatch(/manajer/i);    // ended-by-manager flag
  expect(out.inline_keyboard).toBeUndefined();
});

test("renderStaffShiftSignoff: self sign-off has no manager flag", () => {
  const out = renderStaffShiftSignoff({
    dateLabel: "19 Jun 2026",
    staffName: "Sari",
    shiftStartMs: 0,
    shiftEndMs: 7_200_000,
    durationMs: 7_200_000,
    totalSalesIdr: 500_000,
    txnCount: 5,
    endedBy: "self",
  });
  expect(out.text).toContain("Sari");
  expect(out.text).toContain("2j");        // 2 hours
  expect(out.text).not.toContain("manajer");
  expect(out.text).not.toContain("Manual BCA"); // no manualBca provided
});

test("renderStaffShiftSignoff: duration < 1h shows only minutes", () => {
  const out = renderStaffShiftSignoff({
    dateLabel: "19 Jun 2026",
    staffName: "X",
    shiftStartMs: 0,
    shiftEndMs: 30 * 60_000,
    durationMs: 30 * 60_000,
    totalSalesIdr: 0,
    txnCount: 0,
    endedBy: "self",
  });
  expect(out.text).toContain("30m");
  expect(out.text).not.toMatch(/\dj/);
});

test("renderStaffShiftSignoff: omits manual-BCA section when count=0", () => {
  const out = renderStaffShiftSignoff({
    dateLabel: "19 Jun 2026",
    staffName: "X",
    shiftStartMs: 0,
    shiftEndMs: 3_600_000,
    durationMs: 3_600_000,
    totalSalesIdr: 100_000,
    txnCount: 1,
    manualBca: { count: 0, totalIdr: 0, items: [] },
    endedBy: "self",
  });
  expect(out.text).not.toContain("Manual BCA");
});

it("renders shift_override card with approve URL button", () => {
  const result = renderShiftOverride({
    outlet_label: "Block M", stranded_staff_name: "Sasi",
    shift_started_at: 1782526962094, sales_so_far_idr: 385000, txn_count: 5,
    approve_url: "https://pos.example/approve/RAW",
  });
  expect(result.text).toContain("Block M");
  expect(result.text).toContain("Sasi");
  expect(result.inline_keyboard?.[0]?.[0]?.url).toContain("https://pos.example/approve/RAW");
});

describe("telegramHtml v0.5.2 renderers", () => {
  it("renderLowStockAlert escapes the sku name and shows the numbers", () => {
    const m = renderLowStockAlert({ sku_name: "Dubai <8pc>", on_hand: 3, low_threshold: 20 });
    expect(m.text).toContain("Dubai &lt;8pc&gt;");
    expect(m.text).toContain("3");
    expect(m.text).toContain("20");
    expect(m.inline_keyboard).toBeUndefined();
  });
  it("renderRecountNotice lists each line's delta + renders WIB timestamp", () => {
    const m = renderRecountNotice({
      staff_name: "Sari", recorded_at_iso: "2026-06-01T10:00:00.000Z",
      lines: [{ sku_name: "Dubai", before: 50, after: 30, delta: -20 }],
    });
    expect(m.text).toContain("Sari");
    expect(m.text).toContain("Dubai");
    expect(m.text).toContain("-20");
    // 2026-06-01T10:00:00.000Z = 2026-06-01 17:00 WIB (UTC+7).
    // Note: byte-exact middle dot (U+00B7) — see formatWibDateTime.
    expect(m.text).toContain("01 Jun 2026 · 17:00 WIB");
    expect(m.inline_keyboard).toBeUndefined();
  });
  it("renderRecountNotice escapes staff_name and sku_name", () => {
    const m = renderRecountNotice({
      staff_name: "Si <admin>", recorded_at_iso: "2026-06-01T10:00:00.000Z",
      lines: [{ sku_name: "Dubai <8pc>", before: 10, after: 15, delta: 5 }],
    });
    expect(m.text).toContain("Si &lt;admin&gt;");
    expect(m.text).toContain("Dubai &lt;8pc&gt;");
    expect(m.text).toContain("+5");
  });
});
