# 008. Refunds are new rows, not status mutations

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Ops

## Context

The original transaction is a permanent record of what happened at the counter. Mutating its status to "refunded" loses information (when did the refund happen? who authorised it? what reason? full or partial?). Tax authorities (once Frollie is PKP-registered, per [strategic foundations §4](./000-strategic-foundations.md#4-ppn-schema-present-value-zero-until-pkp)) require refunds traceable to original sales with reason codes.

## Decision

`pos_refunds` is a separate table. The original `pos_transactions` row stays in its terminal paid state. Refund references `transaction_id` + the subset of lines being refunded. Transaction status is **computed on read** as `paid` / `partial_refund` / `refunded` based on the sum of refund amounts vs total. `pos_transaction_lines.refunded_qty` is denormalised for fast "available-to-refund" calculation on partial-refund-of-partial.

## Alternatives considered

- **Mutate `pos_transactions.status` to "refunded".** Rejected: loses the original sale's terminal state; can't distinguish "fully refunded yesterday" from "was paid yesterday, refunded today."
- **Status column + audit log entry, no separate refund row.** Rejected: audit log is a side-effect record, not a queryable financial entity. Reports filter on refund rows; treating refunds as first-class beats parsing audit rows.

## Consequences

- *Easier:* gross sales = sum(paid transactions). Refunds = sum(refunds). Net sales = the difference. No fragile status derivations.
- *Stock re-credit:* refunds write positive `pos_stock_movements` rows ([ADR-019](./019-refund-re-credits-stock.md)), source `refund`, mirroring the original sale's components.
- *Partial refunds compose:* a refund for 2 cookies on a 3-cookie sale leaves 1 cookie refundable; `refunded_qty` lets the UI compute the remaining-refundable per line without scanning all prior refunds.
- *Manager-PIN gated:* every refund passes through [ADR-005](./005-manager-pin-one-off.md), which after v0.4 routes through [ADR-027 WhatsApp approval](./027-wa-approval-via-staff-own-wa.md) when no manager is at the booth.
