# 023. Receipt number format `R-YYYY-NNNN`

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Receipts

## Context

Indonesian receipts need a stable, monotonic identifier separate from internal transaction ids. Customers reference it for support ("R-2026-0058 — that's the one"); accounting cross-references it against bank statements; future tax audits depend on it.

## Decision

Format: `R-YYYY-NNNN`. Counter resets each year. Allocated **atomically on transition to `paid`** — not on cart creation. Drafts and voided carts never burn a number.

## Alternatives considered

- **Sequential without year prefix (`R-000001`).** Rejected: harder to scan in long logs; year prefix gives instant context.
- **UUID-style ids.** Rejected: not human-readable, can't be communicated over phone, doesn't satisfy the "stable monotonic" intuition customers expect.
- **Allocate on cart create.** Rejected: would burn numbers on draft/void; gaps in the sequence look like missing records to auditors.

## Consequences

- *Easier:* receipt number = trustworthy "the Nth paid sale this year." Auditors love this.
- *No gaps in the sequence within a year.* Drafts and voids leave no trace in the receipt-number space.
- *Schema:* `pos_receipt_counters { year (unique), next }`. Allocation is `next++` inside the same mutation that flips transaction status to `paid` — atomic with the status change.
- *Year rollover:* on Jan 1 (Jakarta time), the next paid sale triggers the creation of a new counter row. No manual reset needed.
