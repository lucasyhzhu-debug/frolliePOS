// Pure, V8-safe reconstruction helpers for the nightly stock-recon cron.
// No Node imports — must be importable from a non-"use node" file.
//
// Consumed by:
//   - convex/inventory/internal.ts:_runStockRecon_internal (R4 — the cron's
//     internal mutation that rebuilds on_hand per active SKU from
//     pos_stock_movements and flags drift vs cached pos_stock_levels.on_hand).
//
// Kept stateless and ledger-agnostic so the test suite covers the math
// without needing a Convex test runtime.

export type MovementRow = { qty: number };

/** Signed sum of movement qtys. Negative qtys (sales, spoilage, refunds-out) subtract. */
export function reconstructOnHand(movements: MovementRow[]): number {
  let sum = 0;
  for (const m of movements) sum += m.qty;
  return sum;
}

/** Cache-minus-ledger delta. Drift iff delta !== 0. */
export function computeDrift(cached: number, reconstructed: number): { drift: boolean; delta: number } {
  const delta = cached - reconstructed;
  return { drift: delta !== 0, delta };
}
