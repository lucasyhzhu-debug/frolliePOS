import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCart, __resetCartForTests } from "./useCart";
import type { Id } from "../../convex/_generated/dataModel";

// Make type-safe fake Ids for tests (no real Convex runtime needed).
const pid = (n: number) => `products:${n}` as Id<"pos_products">;

describe("useCart", () => {
  beforeEach(() => {
    // Reset the Zustand singleton AND sessionStorage to isolate tests.
    __resetCartForTests();
  });

  it("addLine: new product sets qty to 1", () => {
    const { result } = renderHook(() => useCart());
    act(() => {
      result.current.addLine(pid(1), 1000);
    });
    expect(result.current.lines).toHaveLength(1);
    expect(result.current.lines[0]).toMatchObject({
      productId: pid(1),
      qty: 1,
      unitPrice: 1000,
    });
  });

  it("addLine: existing product increments qty", () => {
    const { result } = renderHook(() => useCart());
    act(() => {
      result.current.addLine(pid(1), 1000);
      result.current.addLine(pid(1), 1000);
    });
    expect(result.current.lines).toHaveLength(1);
    expect(result.current.lines[0].qty).toBe(2);
  });

  it("setQty: replaces qty for existing line", () => {
    const { result } = renderHook(() => useCart());
    act(() => {
      result.current.addLine(pid(1), 500);
      result.current.setQty(pid(1), 5);
    });
    expect(result.current.lines[0].qty).toBe(5);
  });

  it("setQty: qty <= 0 removes the line", () => {
    const { result } = renderHook(() => useCart());
    act(() => {
      result.current.addLine(pid(1), 500);
      result.current.setQty(pid(1), 0);
    });
    expect(result.current.lines).toHaveLength(0);
  });

  it("subtotal sums qty * unitPrice across all lines", () => {
    const { result } = renderHook(() => useCart());
    act(() => {
      result.current.addLine(pid(1), 1000); // 1 × 1000 = 1000
      result.current.addLine(pid(2), 500);  // 1 × 500  = 500
      result.current.setQty(pid(1), 3);     // 3 × 1000 = 3000
    });
    // 3000 + 500 = 3500
    expect(result.current.subtotal).toBe(3500);
  });

  it("setVoucher / clearVoucher", () => {
    const { result } = renderHook(() => useCart());
    act(() => {
      result.current.setVoucher("PROMO10");
    });
    expect(result.current.voucherCode).toBe("PROMO10");
    act(() => {
      result.current.clearVoucher();
    });
    expect(result.current.voucherCode).toBeUndefined();
  });

  it("clear empties lines and voucher", () => {
    const { result } = renderHook(() => useCart());
    act(() => {
      result.current.addLine(pid(1), 1000);
      result.current.setVoucher("SAVE5");
      result.current.clear();
    });
    expect(result.current.lines).toHaveLength(0);
    expect(result.current.voucherCode).toBeUndefined();
  });

  it("loadFromDraft replaces lines and voucherCode", () => {
    const { result } = renderHook(() => useCart());
    act(() => {
      result.current.addLine(pid(1), 1000);
      result.current.loadFromDraft(
        [
          { productId: pid(2), qty: 3, unitPrice: 750 },
          { productId: pid(3), qty: 1, unitPrice: 2000 },
        ],
        "DRAFT20",
      );
    });
    expect(result.current.lines).toHaveLength(2);
    expect(result.current.lines[0]).toMatchObject({ productId: pid(2), qty: 3, unitPrice: 750 });
    expect(result.current.voucherCode).toBe("DRAFT20");
  });

  it("persists lines and voucherCode to sessionStorage across re-instantiation", () => {
    // First hook instance: add a line and set a voucher.
    const first = renderHook(() => useCart());
    act(() => {
      first.result.current.addLine(pid(1), 1200);
      first.result.current.setVoucher("PERSIST");
    });
    first.unmount();

    // Second hook instance: should rehydrate from sessionStorage.
    const second = renderHook(() => useCart());
    expect(second.result.current.lines).toHaveLength(1);
    expect(second.result.current.lines[0]).toMatchObject({
      productId: pid(1),
      qty: 1,
      unitPrice: 1200,
    });
    expect(second.result.current.voucherCode).toBe("PERSIST");
  });
});
