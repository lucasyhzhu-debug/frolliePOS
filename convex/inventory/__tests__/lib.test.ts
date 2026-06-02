import { describe, it, expect } from "vitest";
import { reconstructOnHand, computeDrift } from "../lib";

describe("inventory/lib", () => {
  it("reconstructOnHand: empty → 0", () => {
    expect(reconstructOnHand([])).toBe(0);
  });
  it("reconstructOnHand: signed sum", () => {
    expect(reconstructOnHand([{ qty: 10 }, { qty: -3 }, { qty: -2 }])).toBe(5);
  });
  it("reconstructOnHand: all positives", () => {
    expect(reconstructOnHand([{ qty: 5 }, { qty: 10 }, { qty: 2 }])).toBe(17);
  });
  it("reconstructOnHand: all negatives", () => {
    expect(reconstructOnHand([{ qty: -1 }, { qty: -2 }, { qty: -3 }])).toBe(-6);
  });

  it("computeDrift: equal → no drift", () => {
    expect(computeDrift(7, 7)).toEqual({ drift: false, delta: 0 });
  });
  it("computeDrift: cache > ledger → positive delta", () => {
    expect(computeDrift(10, 7)).toEqual({ drift: true, delta: 3 });
  });
  it("computeDrift: cache < ledger → negative delta", () => {
    expect(computeDrift(5, 7)).toEqual({ drift: true, delta: -2 });
  });
  it("computeDrift: both zero → no drift", () => {
    expect(computeDrift(0, 0)).toEqual({ drift: false, delta: 0 });
  });
});
