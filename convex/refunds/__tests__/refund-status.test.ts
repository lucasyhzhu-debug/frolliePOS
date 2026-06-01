import { describe, it, expect } from "vitest";
import { refundStatus } from "../lib";

const line = (qty: number, refunded_qty?: number) => ({ qty, refunded_qty });

describe("refundStatus", () => {
  it("returns none when there are no refunds", () => {
    expect(refundStatus([line(3)], false)).toBe("none");
  });
  it("returns full when every line qty is refunded", () => {
    expect(refundStatus([line(3, 3), line(2, 2)], true)).toBe("full");
  });
  it("returns partial when some but not all qty is refunded", () => {
    expect(refundStatus([line(3, 1), line(2, 2)], true)).toBe("partial");
  });
  it("treats undefined refunded_qty as 0", () => {
    expect(refundStatus([line(3)], true)).toBe("partial");
  });
});
