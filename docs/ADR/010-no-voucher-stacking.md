# 010. No voucher stacking

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Ops

## Context

Discount combinatorics get gnarly fast (does "20% off" apply before or after "−Rp 10k"? does a staff discount stack with a customer voucher? what about line-level vs cart-level?). Each combination is a fairness debate, a tax-calculation edge case, and a bug surface.

## Decision

A cart has **at most one discount source**: a voucher code OR a manual %/Rp adjustment. UI surfaces them as a single picker. Schema reflects this: `pos_transactions` carries `discount_amount` + `discount_source` (`voucher_code` | `manual_pct` | `manual_amount`) — not multiple discount rows.

## Alternatives considered

- **Allow stacking with explicit ordering rules.** Rejected: explains every staff training session forever; one more thing to get wrong.
- **Allow one cart-level + one line-level.** Rejected: still doubles the surface; line-level discounts in v1 are not requested by the business.

## Consequences

- *Easier:* discount math is one branch: `(subtotal - discount_amount)`. Receipt template shows one discount line.
- *Harder:* if the business later needs stacking (e.g., loyalty + promo combo), this reverses with a schema migration (discounts become rows). Not v1.
- *Manual %/Rp gating:* manual discounts are manager-PIN-gated by default (`pos_discounts.requires_manager: true` for the manual variants). Staff-applicable discounts come from `pos_discounts` with `requires_manager: false` and the voucher table.
- *Related:* [ADR-024](./024-discount-ordering-line-voucher-tax.md) (the ordering rule that still applies when line-level discounts exist on a single discount source).
