import { describe, it, expect } from "vitest";
import { validateVoucherAgainst } from "../voucherValidate";

type V = {
  _id: string;
  code: string;
  type: "percentage" | "amount";
  value: number;
  active: boolean;
  expires_at?: number;
  min_cart_value?: number;
};

const NOW = 1_700_000_000_000;

describe("validateVoucherAgainst", () => {
  const base: V = { _id: "vid", code: "WELCOME", type: "amount", value: 5000, active: true };

  it("returns NOT_FOUND when voucher is null", () => {
    expect(validateVoucherAgainst(null, 10000, NOW)).toEqual({
      valid: false, discountAmount: 0, reason: "NOT_FOUND",
    });
  });

  it("returns INACTIVE when active=false", () => {
    expect(validateVoucherAgainst({ ...base, active: false }, 10000, NOW)).toEqual({
      valid: false, discountAmount: 0, reason: "INACTIVE",
    });
  });

  it("returns EXPIRED when expires_at <= now (strict, boundary expired)", () => {
    expect(validateVoucherAgainst({ ...base, expires_at: NOW }, 10000, NOW)).toEqual({
      valid: false, discountAmount: 0, reason: "EXPIRED",
    });
    expect(validateVoucherAgainst({ ...base, expires_at: NOW - 1 }, 10000, NOW)).toEqual({
      valid: false, discountAmount: 0, reason: "EXPIRED",
    });
    expect(validateVoucherAgainst({ ...base, expires_at: NOW + 1 }, 10000, NOW)).toEqual({
      valid: true, discountAmount: 5000, voucherId: "vid",
    });
  });

  it("returns MIN_CART_VALUE when subtotal < min_cart_value", () => {
    expect(validateVoucherAgainst({ ...base, min_cart_value: 20000 }, 19999, NOW)).toEqual({
      valid: false, discountAmount: 0, reason: "MIN_CART_VALUE",
    });
    expect(validateVoucherAgainst({ ...base, min_cart_value: 20000 }, 20000, NOW)).toEqual({
      valid: true, discountAmount: 5000, voucherId: "vid",
    });
  });

  it("computes amount discount capped at subtotal", () => {
    expect(validateVoucherAgainst({ ...base, type: "amount", value: 50000 }, 30000, NOW)).toEqual({
      valid: true, discountAmount: 30000, voucherId: "vid",
    });
  });

  it("computes percentage discount floored", () => {
    expect(validateVoucherAgainst({ ...base, type: "percentage", value: 33 }, 1000, NOW)).toEqual({
      valid: true, discountAmount: 330, voucherId: "vid",
    });
    expect(validateVoucherAgainst({ ...base, type: "percentage", value: 33 }, 1001, NOW)).toEqual({
      valid: true, discountAmount: 330, voucherId: "vid",
    });
  });
});
