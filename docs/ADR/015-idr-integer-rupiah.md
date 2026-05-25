# 015. IDR as integer rupiah; no floats

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Pay

## Context

Indonesian Rupiah doesn't have sub-units (no cents). Storing currency as floats introduces classic floating-point bugs (`0.1 + 0.2 ≠ 0.3`), drift in totals, and rounding fights with the tax engine.

## Decision

All amounts (`price`, `subtotal`, `discount_amount`, `tax_amount`, `total`, `unit_price`, etc.) stored as **integer rupiah**. Formatted on render via `Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR" })` — produces `Rp 25.000`. Server validates positive integers only on every write.

## Alternatives considered

- **Float (number).** Rejected: floating-point + currency = bugs. Industry-known anti-pattern.
- **Decimal / BigInt / dedicated money library.** Rejected: overkill for a currency without sub-units. Plain JS integers cover the realistic value range (max safe integer ≈ 9 × 10¹⁵, well past any realistic Indonesian rupiah amount).
- **Cents-as-integer abstraction.** Rejected: rupiah has no cents. Adding a fake "minor unit" introduces confusion (multiply by 100 everywhere) for no benefit.

## Consequences

- *Easier:* arithmetic is unambiguous. Discount math = `subtotal - discount_amount`. Sum of line totals matches the displayed total exactly.
- *Harder:* division (percentage discounts, settlement MDR splits) requires explicit rounding. Convention: **round half-up to the nearest integer rupiah** for discount math; tax amounts round to integer per line then sum.
- *Display layer:* a single formatter in `src/lib/format.ts` is the only place that converts integer → display string. Components never call `toLocaleString` directly.
- *Validation:* Convex schema uses `v.number()` (Convex doesn't distinguish int/float at the type level), with `args` validators enforcing integer + non-negative + plausible-upper-bound checks.
