// src/lib/i18n/__tests__/t.test.ts
import { describe, it, expect } from "vitest";
import { t } from "../t";
import { en } from "../dictionaries/en";
import { id } from "../dictionaries/id";

describe("t()", () => {
  it("looks up a plain key per locale", () => {
    expect(t("en", "home.newSale")).toBe("New sale");
    expect(t("id", "home.newSale")).toBe("Penjualan baru");
  });

  it("interpolates {params}", () => {
    expect(t("en", "locale.toggleLabel", { current: "English", next: "Bahasa" }))
      .toBe("Language: English. Tap to switch to Bahasa.");
  });

  it("selects English plural by count, Indonesian stays _other", () => {
    expect(t("en", "home.catalogSummary_other", { count: 1, skus: 1 })).toBe("1 product · 1 SKUs");
    expect(t("en", "home.catalogSummary_other", { count: 12, skus: 3 })).toBe("12 products · 3 SKUs");
    expect(t("id", "home.catalogSummary_other", { count: 1, skus: 1 })).toBe("1 produk · 1 SKU");
  });

  it("leaves unknown {params} braces intact", () => {
    expect(t("en", "home.newSale", { unused: "x" })).toBe("New sale");
  });
});

describe("dictionary parity", () => {
  it("en and id have identical keysets", () => {
    expect(Object.keys(id).sort()).toEqual(Object.keys(en).sort());
  });
});
