# 040. Voucher attribution on partial refunds: proportional, floor-rounded

**Date:** 2026-06-01
**Status:** Accepted
**Group:** Pay

## Context

Per [ADR-024](./024-discount-ordering-line-voucher-tax.md), discount ordering is line → voucher → tax. When a sale had a voucher and the customer refunds some lines, the refund amount must honour the proportional discount that line received. Without a locked rule, implementations could differ (refund list price vs. proportional) and bookkeeping diverges. The v0.5.1 voucher-math unit test needs a spec to reference.

## Decision

Per-line refund_amount, in integer rupiah:

```
refund_amount = floor(line_total × paid_total × refund_qty / (subtotal_pre_voucher × line.qty))
```

Single floor at the end — flooring the line total first and then multiplying by a fractional ratio (`refund_qty/line.qty`) produces non-integer rupiah on partial-line refunds. Sum across refunded lines = `total_refund`. Recompute against ORIGINAL totals each refund (stateless across multiple partial refunds). One helper `computeRefundAmount(line, txn, refundQty)` is used from both `_commitRefund_internal` and the receipt template's `net_retained` computation.

Source-field mapping (against `convex/transactions/schema.ts`):

| ADR-040 variable          | Schema field                              |
| ------------------------- | ----------------------------------------- |
| `paid_total`              | `pos_transactions.total` (post-voucher)   |
| `subtotal_pre_voucher`    | `pos_transactions.subtotal` (pre-voucher) |
| `line_total`              | `pos_transaction_lines.line_subtotal`     |
| `line.qty`                | `pos_transaction_lines.qty`               |
| `refund_qty`              | `pos_refunds.lines[i].qty`                |

## Worked example

- Sale: 3 × Dubai 1pc @ Rp 50.000 = Rp 150.000
- Voucher: -Rp 20.000
- Paid: Rp 130.000
- Refund 1 of 3 cookies
- refund_amount = floor(150.000 × 130.000 × 1 / (150.000 × 3)) = floor(43.333,33) = Rp 43.333

(IDR uses dot as thousands separator. `43.333` here means 43333 integer rupiah.)

## Alternatives considered

- **List price** (Rp 50.000 in the worked example): rejected — customer "consumes" more of the voucher discount than their fair share; bookkeeping-incorrect.
- **Manager-discretionary input**: rejected — introduces "what did Lucas refund?" inconsistency across staff; defeats audit goal.
- **Flooring per line then multiplying by qty ratio**: rejected — produces non-integer rupiah on partial-line refunds.

## Consequences

- Floor favours business by < 1 IDR per refund line; totals stay tidy.
- Multiple partial refunds compose without rounding drift (stateless math against original totals).
- Unit test (`convex/refunds/__tests__/voucher-math.test.ts`) is the spec — the worked example is encoded as a test case so any future formula drift breaks here.
- Edge: no-voucher sale → ratio = 1 → math degrades gracefully to `line_subtotal × refund_qty / line.qty` (no special case in code).
