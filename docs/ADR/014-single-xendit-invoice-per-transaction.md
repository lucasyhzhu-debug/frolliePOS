# 014. Single Xendit invoice per transaction (explicit cancel on retry)

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Pay

> **Adjusted by [ADR-036](./036-xendit-dedicated-apis-inline.md)** (2026-05-28): prior invoice superseded locally (no Xendit cancel-API call for QR codes); `is_closed` + `is_single_use` on FVA prevent double-pay for BCA VA.

## Context

Staff shows a QR. Customer takes a minute to find their wallet. Staff notices the cart is wrong, cancels, edits, retries. Without explicit cancellation, the first Xendit invoice is orphaned — still active on Xendit's side, capable of receiving a payment that no longer corresponds to anything in the POS.

## Decision

On Charge, the POS creates a Xendit invoice and writes `pos_transactions.xendit_invoice_id`. On cancel/edit + retry, the POS **explicitly calls Xendit's cancel-invoice API** for the prior invoice before creating a new one. Same `txn_id`, new `xendit_invoice_id`. Prior invoice ids are kept in `pos_xendit_invoices` for audit.

## Alternatives considered

- **Don't cancel, just create a new invoice and ignore the old one.** Rejected: orphaned invoice can still be paid. Customer pays old QR → webhook fires → POS doesn't know what to do.
- **Don't allow cart edits after invoice creation.** Rejected: real-world flow needs edits; locking the cart hostile.
- **Single invoice ever, no retry.** Rejected: payment expires after 5 minutes by default; sometimes staff needs to regenerate.

## Consequences

- *Easier:* exactly one active Xendit invoice per transaction at any time. Webhook handler doesn't have to disambiguate "is this for the current or the cancelled invoice?".
- *Harder:* must handle Xendit cancel-API failures gracefully (retry, log, surface to manager if it persistently fails).
- *Audit table:* `pos_xendit_invoices { id, transaction_id, xendit_invoice_id, created_at, cancelled_at?, replaced_by?, status_at_cancel }`.
- *Race condition mitigation:* if the customer pays the about-to-be-cancelled invoice in the cancel-API-call window, the webhook arrives and the POS reconciles via [ADR-026](./026-reconciliation-on-reload.md) prompting "reclaim payment" rather than orphaning.
