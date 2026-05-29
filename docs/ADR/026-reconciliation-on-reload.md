# 026. Reconciliation on reload

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Sync

> **Amended by [ADR-036](./036-xendit-dedicated-apis-inline.md)** (2026-05-28): `useStartupReconciliation` poll body gutted; missed-webhook recovery for QRIS/FVA is manual-only (manager-PIN override) — polling QRIS status is architecturally impossible.

## Context

Power loss, browser crash, or accidental refresh mid-sale: a transaction may have been paid in Xendit but not yet decremented locally. Or the cart may have an active Xendit invoice that the device no longer knows about. Without an explicit reconciliation pass on startup, these orphan states accumulate.

## Decision

On app startup, run a reconciliation pass:

1. Query "transactions where `status = awaiting_payment` AND `created_at > now() - 5min`".
2. For each, call Xendit `GET /v2/invoices/{id}` to check current status.
3. If Xendit says `PAID` → run the completion path (flip status, decrement stock, write audit, generate receipt — all idempotent via [ADR-013](./013-idempotency-keys.md)).
4. If Xendit says `EXPIRED` or 5 minutes elapsed → mark voided with reason `reload_reconciliation_timeout`.

Stock movements have a **unique constraint on `(transaction_line_id, inventory_sku_id)`** so reconciliation can't double-decrement.

## Alternatives considered

- **No reconciliation, accept orphan states.** Rejected: staff would see "pending payment" for old transactions forever; manual cleanup falls on managers.
- **Reconcile on every page load, not just startup.** Rejected: unnecessary noise; once-per-app-launch is enough.
- **Server-side reconciler runs on schedule.** Considered as a complement (and is, see the nightly reaper in [ADR-032](./032-saved-drafts-purge-24h.md) territory). Client-side on-load handles the immediate case where the customer is still at the counter.

## Consequences

- *Easier:* power-loss recovery is automatic. Staff returns to the app and sees consistent state.
- *Harder:* requires a Xendit API call per pending transaction on startup. Bounded to "within last 5 minutes" so the worst case is small.
- *Unique constraint as backstop:* even if the same reconciliation runs twice (e.g., two tabs), stock can't double-decrement.
- *UX prompt:* if reconciliation finds a paid txn the staff already gave up on ("we already gave the customer a refund manually because the QR seemed expired"), surface a "txn #058 was actually paid — reclaim or refund?" prompt rather than silently completing.
