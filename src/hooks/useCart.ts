/**
 * useCart — Zustand cart store with sessionStorage persistence.
 *
 * Design decisions:
 *
 * CLIENT-ONLY STATE: The cart is a local-only concern while the user is
 * building a sale. It is committed to Convex exactly once via `commitCart`
 * (called by the Sale screen's "Save / Charge" action). Before that point,
 * nothing in the cart touches the backend.
 *
 * SESSION STORAGE RATIONALE: sessionStorage (not localStorage) is used so
 * that:
 *   - A hard refresh (F5) keeps the cart — no surprise empty cart.
 *   - Closing the tab / browser discards it — no stale cart from last shift.
 *   - Multiple tabs are isolated — each tab has its own cart in progress.
 *
 * VOUCHER DISCOUNT: This store only records the applied voucher *code*.
 * The discount amount is computed by the Sale screen against the live
 * voucher catalog, not stored here. This keeps the cart source of truth
 * clean even if a voucher's value changes between opens.
 *
 * SUBTOTAL: Stored as a plain derived field that is recomputed on every
 * mutation that touches `lines` (addLine, setQty, loadFromDraft, clear).
 * A `get subtotal()` accessor on the Zustand state object is NOT used
 * because Zustand evaluates the state creator once at store creation — the
 * getter would always return the initial 0, not the current value. Storing
 * subtotal as a recomputed plain field is the idiomatic Zustand v5 pattern
 * for derived data that must be reactive.
 *
 * PARTIALIZE: Only {lines, voucherCode} are persisted. `subtotal` is
 * excluded — it is always recomputed from `lines` on hydration.
 *
 * TEST RESET: `__resetCartForTests()` resets the singleton store state and
 * clears sessionStorage. Call it in `beforeEach` to isolate tests.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Id } from "../../convex/_generated/dataModel";

export type CartLine = {
  /** Integer rupiah — snapshot of the price at the time the line was added. */
  unitPrice: number;
  productId: Id<"pos_products">;
  qty: number;
};

type CartState = {
  lines: CartLine[];
  voucherCode?: string;
  /** Pre-computed sum of qty × unitPrice for all lines (integer rupiah). */
  subtotal: number;

  addLine: (productId: Id<"pos_products">, unitPrice: number) => void;
  setQty: (productId: Id<"pos_products">, qty: number) => void;
  setVoucher: (code: string) => void;
  clearVoucher: () => void;
  loadFromDraft: (lines: CartLine[], voucherCode?: string) => void;
  clear: () => void;
};

/** Recompute subtotal from a lines array (integer rupiah). */
function computeSubtotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
}

const EMPTY_STATE = {
  lines: [] as CartLine[],
  voucherCode: undefined as string | undefined,
  subtotal: 0,
};

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      ...EMPTY_STATE,

      addLine(productId, unitPrice) {
        set((state) => {
          const existing = state.lines.find((l) => l.productId === productId);
          let nextLines: CartLine[];
          if (existing) {
            nextLines = state.lines.map((l) =>
              l.productId === productId ? { ...l, qty: l.qty + 1 } : l,
            );
          } else {
            nextLines = [...state.lines, { productId, qty: 1, unitPrice }];
          }
          return { lines: nextLines, subtotal: computeSubtotal(nextLines) };
        });
      },

      setQty(productId, qty) {
        set((state) => {
          const nextLines =
            qty <= 0
              ? state.lines.filter((l) => l.productId !== productId)
              : state.lines.map((l) =>
                  l.productId === productId ? { ...l, qty } : l,
                );
          return { lines: nextLines, subtotal: computeSubtotal(nextLines) };
        });
      },

      setVoucher(code) {
        set({ voucherCode: code });
      },

      clearVoucher() {
        set({ voucherCode: undefined });
      },

      loadFromDraft(lines, voucherCode) {
        set({ lines, voucherCode, subtotal: computeSubtotal(lines) });
      },

      clear() {
        set({ lines: [], voucherCode: undefined, subtotal: 0 });
      },
    }),
    {
      name: "frollie-cart",
      storage: createJSONStorage(() => sessionStorage),
      // Only persist the raw data; subtotal is always recomputed on rehydration.
      partialize: (state) => ({
        lines: state.lines,
        voucherCode: state.voucherCode,
      }),
      // After hydration, recompute subtotal from the persisted lines.
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.subtotal = computeSubtotal(state.lines);
        }
      },
    },
  ),
);

/**
 * Test-only: reset the singleton Zustand store to empty state and clear
 * sessionStorage. Call in `beforeEach` to prevent state leakage between tests.
 */
export function __resetCartForTests(): void {
  sessionStorage.clear();
  // Merge reset: do NOT pass true (replace) — that wipes the action functions.
  // Passing false (default) merges only the data fields, preserving actions.
  useCart.setState({ ...EMPTY_STATE });
}
