import { describe, it, expect } from "vitest";
import { renderLowStockAlert, renderRecountNotice } from "../telegramHtml";

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
