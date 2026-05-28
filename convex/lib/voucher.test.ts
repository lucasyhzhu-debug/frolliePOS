import { describe, it, expect } from "vitest";
import { computeVoucherDiscount } from "./voucher";

describe("computeVoucherDiscount (ADR-024 / ADR-015)", () => {
  it("percentage: floors to integer rupiah", () => {
    expect(computeVoucherDiscount("percentage", 10, 25_000)).toBe(2_500);
    // 19 * 5% = 0.95 → floor → 0 (sub-threshold cart, never negative)
    expect(computeVoucherDiscount("percentage", 5, 19)).toBe(0);
    // 33333 * 15% = 4999.95 → floor → 4999 (never rounds up past the cart)
    expect(computeVoucherDiscount("percentage", 15, 33_333)).toBe(4_999);
  });

  it("amount: caps at the cart subtotal (never discounts more than the cart)", () => {
    expect(computeVoucherDiscount("amount", 10_000, 25_000)).toBe(10_000);
    expect(computeVoucherDiscount("amount", 50_000, 30_000)).toBe(30_000); // capped
    expect(computeVoucherDiscount("amount", 30_000, 30_000)).toBe(30_000); // exact
  });

  it("zero / boundary inputs", () => {
    expect(computeVoucherDiscount("percentage", 0, 25_000)).toBe(0);
    expect(computeVoucherDiscount("amount", 0, 25_000)).toBe(0);
    expect(computeVoucherDiscount("percentage", 100, 25_000)).toBe(25_000); // 100% off
    expect(computeVoucherDiscount("amount", 5_000, 0)).toBe(0); // empty cart
  });
});
