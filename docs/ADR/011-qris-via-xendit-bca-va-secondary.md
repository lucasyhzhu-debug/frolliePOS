# 011. QRIS via Xendit (primary); BCA VA secondary

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Pay

## Context

Indonesian retail payments. QRIS is a single dynamic QR that any wallet accepts (GoPay, OVO, DANA, plus most bank apps). BCA Virtual Account is a per-transaction account number that customers transfer to from their banking app — useful when QRIS isn't accepted by the customer's bank or wallet.

See [strategic foundations §2](./000-strategic-foundations.md#2-xendit-as-sole-payment-aggregator-with-bca-va-over-static-display) for the Xendit-vs-alternatives rationale.

## Decision

Xendit Invoice API is the single integration surface. **QRIS button** creates an invoice with `qr_string`. **BCA VA button** creates an invoice with `virtual_account`. Same webhook handler, same settlement record. QRIS is the visually primary action on the Charge screen; BCA VA is a secondary action (per UX-Q2 — addressed in the Charge wireframe).

## Alternatives considered

- **Separate QRIS API + BCA VA API calls (Xendit has both).** Rejected: doubles the integration surface and the webhook event types we have to switch on. Invoice API unifies them under one event.
- **Show BCA VA as a top-level button equal to QRIS.** Rejected: 95% of customers pay via QRIS. Equal-prominence buttons slow down the QRIS happy path. Per UX-Q2, BCA VA is demoted to a secondary "transfer instead?" option.

## Consequences

- *Easier:* one webhook handler. One settlement reconciliation. One UI state machine for "payment in progress."
- *Harder:* invoice abstraction hides some QRIS-vs-VA-specific UX surfaces (e.g., showing the VA account number prominently for transfer). Charge screen has to read `payment.method` and switch presentation accordingly.
- *MDR:* ~0.7% for QRIS, ~IDR 4,000 flat for BCA VA. Settled T+1 ([ADR-012](./012-settlements-visible-to-staff-and-managers.md)).
- *Idempotency:* see [ADR-013](./013-idempotency-keys.md) and [ADR-014](./014-single-xendit-invoice-per-transaction.md).
