# 024. Discount ordering: line → voucher → tax

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Receipts

## Context

Even with [no voucher stacking](./010-no-voucher-stacking.md), the order in which discounts and tax apply matters once PPN turns on ([strategic foundations §4](./000-strategic-foundations.md#4-ppn-schema-present-value-zero-until-pkp)). Different orders produce different total tax and therefore different totals.

## Decision

Three-step ordering, always:

1. **Line discounts** applied per-line. `line_net = line_subtotal - line_discount`.
2. **Cart-level voucher** (the single source per [ADR-010](./010-no-voucher-stacking.md)) applied to the sum of line nets. `cart_after_voucher = sum(line_nets) - voucher_discount`.
3. **Tax** computed on the net result. `tax = cart_after_voucher × tax_rate` (per-line in v1.1+ when `tax_category` differs per product; flat in v1 with `tax_rate = 0`).

Final total = `cart_after_voucher + tax`.

## Alternatives considered

- **Tax first, then discount.** Rejected: standard Indonesian retail convention applies tax to the discounted price; otherwise customers pay tax on money they didn't pay.
- **Voucher before line discounts.** Rejected: line discounts are per-item context; voucher is per-cart. Conceptually line-first makes the cart math additive.

## Consequences

- *Easier:* receipt template can list the three sections in display order matching computation order. Easier for staff and customers to understand.
- *Schema:* `pos_transactions` stores `subtotal` (sum of line subtotals), `line_discounts_total`, `voucher_discount`, `tax_amount`, `total` — all recomputable from line data, but stored to avoid re-derivation on every read.
- *Invariant:* `total = subtotal - line_discounts_total - voucher_discount + tax_amount`. Validated on every transaction write.
- *PPN trigger:* when Frollie crosses the PKP threshold, default `tax_rate` flips and the three-step still holds.
