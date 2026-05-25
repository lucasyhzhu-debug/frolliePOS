# 018. Negative stock allowed at sale, flagged

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Stock

## Context

Booth velocity > pre-sale blocking. Kitchen replenishes faster than UI refresh — staff might bring 12 cookies from the back, sell three, then the cached inventory reads `9 left` even though the actual shelf has 9. If we hard-block sales when computed inventory goes to zero, staff face a false out-of-stock at the exact moment the customer is ready to pay.

## Decision

A sale that would push an SKU's `on_hand` below zero is **allowed**. The server writes the `pos_stock_movement` row, decrements `pos_stock_levels.on_hand` (which may go negative), and sets `pos_transactions.flags |= NEG_STOCK`. UI surfaces a "low — confirm?" prompt to staff at the sale moment but **does not hard-block**. Manager home screen surfaces flagged transactions; reconciler can prompt manager to either stock-in or refund after the fact.

## Alternatives considered

- **Hard-block sales at zero.** Rejected: false out-of-stock at the counter is worse than negative-but-flagged.
- **Soft-block (require manager PIN to sell into negative).** Rejected: counter line waits while manager arrives; same UX cost as hard-block.
- **Allow without flag.** Rejected: loses signal. We want to know which transactions need a reconciliation prompt.

## Consequences

- *Easier:* counter velocity preserved. Staff never has to explain "the screen says zero but I have a tray right here."
- *Harder:* `on_hand` can be negative. Reports and UI must handle this (red text, warning icon, "investigate" prompt on manager home).
- *Flag enum:* `pos_transactions.flags` is a bitset (`NEG_STOCK = 1 << 0`, future flags get more bits).
- *UX-Q4 resolved:* red dot on cart tile signals "low" without blocking. Full inventory detail lives on Stock Check.
- *Reconciliation:* manager dashboard surfaces "txns with NEG_STOCK in the last 24h" — actionable list to either stock-in (correct the count) or refund (admit the over-sell).
