import { describe, it, expect } from "vitest";
import { NEG_STOCK, VOUCHER_OVER_REDEEMED, hasFlag, withFlag } from "./flags";

describe("transaction flags", () => {
  it("NEG_STOCK = bit 0, VOUCHER_OVER_REDEEMED = bit 1, no overlap", () => {
    expect(NEG_STOCK).toBe(1);
    expect(VOUCHER_OVER_REDEEMED).toBe(2);
    expect(NEG_STOCK & VOUCHER_OVER_REDEEMED).toBe(0);
  });

  it("hasFlag detects set bits", () => {
    expect(hasFlag(NEG_STOCK | VOUCHER_OVER_REDEEMED, NEG_STOCK)).toBe(true);
    expect(hasFlag(0, NEG_STOCK)).toBe(false);
    expect(hasFlag(VOUCHER_OVER_REDEEMED, NEG_STOCK)).toBe(false);
  });

  it("withFlag OR-s without removing other flags", () => {
    expect(withFlag(VOUCHER_OVER_REDEEMED, NEG_STOCK)).toBe(3);
    expect(withFlag(NEG_STOCK, NEG_STOCK)).toBe(1); // idempotent
  });
});
