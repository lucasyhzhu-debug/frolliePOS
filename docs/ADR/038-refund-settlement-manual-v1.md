# 038. Refund settlement: POS is system-of-record, money moves manually in v1

**Date:** 2026-05-31
**Status:** Accepted
**Group:** Pay

## Context

[ADR-008](./008-refunds-as-new-rows.md) specs refund **record-keeping**: a `pos_refunds` row, status computed on read, stock re-credit ([ADR-019](./019-refund-re-credits-stock.md)), manager approval, full audit. The v0.5.1 phase plan inherits that design verbatim.

But ADR-008 and the v0.5.1 plan are silent on the one thing a customer actually cares about: **how the money gets back to them.** Recording that a refund happened and *executing* the cash movement are two separate concerns, and only the first is specced. Closing that gap requires understanding how Xendit refunds work across our two payment rails ([ADR-036](./036-xendit-dedicated-apis-inline.md)) — and they are **not symmetric**:

- **QRIS** — Xendit exposes a refund endpoint (`POST /qr_codes/{qrpy_id}/refunds`, full or partial). **But it only works for certain issuers.** QRIS is an interoperable rail; the payer could be on GoPay, OVO, DANA, a bank app, etc. Xendit's own docs call out that unsupported issuers (e.g. GoPay) **reject the refund call**, leaving disbursement as the only path. So even QRIS cannot rely on the refund API alone.
- **BCA VA** — **no refund API exists at all.** "All virtual account transactions that have been paid by the end-customer cannot be refunded from Xendit's system." A VA payment is a one-way bank transfer into our balance; there is no instrument to reverse. The only programmatic way to return the money is a **fresh outbound payout** via the **Disbursements API** — which requires collecting the customer's bank account number + bank code (data the sale flow never captures), plus a new async lifecycle (disbursement callbacks, the 7am–11pm WIB operating window, insufficient-balance failures).

Integrating the Disbursements API (and the partially-applicable QRIS refund API, with its issuer-dependent fallback) is comparable in size to the rest of v0.5.1 combined. v1 is a single booth, 2–3 staff, digital-only, low refund volume. The operational cost of a manual bank transfer per refund is small; the engineering cost of automating it is not.

## Decision

**In v1, the POS is the refund system-of-record; the money is moved manually, out-of-band, by the operator.** No Xendit refund or Disbursements API call is made from POS code in v1.

Concretely, a v1 refund is:

1. Staff initiate the refund in-app → manager approves (inline at booth, or via the Telegram off-booth approval flow per [ADR-035](./035-telegram-as-internal-comms.md) — a new `refund` approval kind per the 4-touchpoint pattern).
2. On approval, POS writes the `pos_refunds` row, re-credits stock ([ADR-019](./019-refund-re-credits-stock.md)), and audits it (approver, reason, timestamp) — exactly as [ADR-008](./008-refunds-as-new-rows.md) specs. The **ledger** is complete and correct at this point; transaction status computes as `partial_refund` / `refunded` on read.
3. A new `pos_refunds.settlement_status` field tracks the **money movement** separately from the ledger: `pending` on creation. The refund UI shows the manager the exact amount and (for BCA VA) prompts them to perform the transfer in the Xendit / BCA dashboard.
4. The manager marks the refund settled once the transfer is done → `settlement_status: settled`, with a second audit stamp (who settled, when). A refund may sit `pending` indefinitely without blocking anything else; it surfaces on the manager view as outstanding.

The ledger event (refund recorded) and the settlement event (cash sent) are **decoupled**: the financial record is authoritative and immediate; the cash movement is a tracked, audited manual step. This mirrors the existing manual-payment-override shape ([ADR-005](./005-manager-pin-one-off.md) / [ADR-036](./036-xendit-dedicated-apis-inline.md) Decision B): "a human did the money thing out-of-band; the system records, gates, and audits it."

`settlement_status` is a forward-compatible seam: when v1.1 integrates automated payouts, the same field transitions `pending → settled` driven by a disbursement callback instead of a manager tap — no schema change, no re-modelling.

### Gating: settling is manager-session, not manager-PIN

The `markRefundSettled` action requires a **manager session only — not a fresh manager-PIN entry.** The financially material decision (authorising money to go back to the customer) is gated by manager-PIN at refund *approval* time, per [ADR-005](./005-manager-pin-one-off.md). Marking a refund settled is a bookkeeping acknowledgement that the already-authorised, out-of-band transfer completed — it moves no money and changes no ledger figure. A PIN re-prompt there would be ceremony without a security gain. The transition is still audited (who settled, when), so the action is attributable without being PIN-gated. (Contrast: *approving* the refund stays manager-PIN-gated — that is the money-authorising step.)

## Alternatives considered

- **Integrate the Disbursements API now (automated VA refunds).** Pros: customer gets money back without a manual step; works for any bank. Cons: requires collecting customer bank account + code at refund time (new UI, validation, a data field we don't have); new async lifecycle (callbacks, WIB operating window, balance-insufficient failures) larger than the rest of v0.5.1; unwarranted at single-booth volume. **Rejected for v1; the `settlement_status` seam keeps it a clean v1.1 graft.**
- **Integrate the QRIS refund API now (`POST /qr_codes/{id}/refunds`).** Pros: a real reversal for QRIS-supported issuers; no bank details needed. Cons: only works for *some* issuers — GoPay and others reject it, so we'd still need the manual/disbursement fallback. Adding the API does not remove the manual path; it adds a second, partially-applicable one. **Rejected for v1; revisit in v1.1 alongside disbursements.**
- **Flip `pos_transactions.status` to `refunded` (no separate row).** Already rejected by [ADR-008](./008-refunds-as-new-rows.md) — loses original terminal state, reason, approver, partial-refund composition. Unchanged here.
- **Don't track settlement at all — assume the manual transfer always happens.** Pros: simplest, no extra field. Cons: a refund recorded but never paid is invisible; no way to surface outstanding obligations or audit who sent the cash. **Rejected:** the whole point is to make the manual step explicit and auditable, not implicit.

## Consequences

- *Easier:* v0.5.1 ships the full refund **ledger** (rows, stock re-credit, computed status, approval, audit, receipts) without any Xendit refund/disbursement integration. The hardest, most error-prone part (a money-out API path) is deferred.
- *Easier:* the manual step is auditable and surfaced — a refund recorded but not yet transferred shows as `settlement_status: pending` on the manager view, so nothing falls through the cracks.
- *Harder:* operators must perform the bank transfer manually in the Xendit/BCA dashboard per refund, and remember to mark it settled. Acceptable at single-booth volume; revisited if refund volume grows.
- *Harder:* a refund's ledger state and its cash state can diverge transiently (ledger says refunded, money not yet sent). This is **intentional and modelled** by `settlement_status` — the divergence is visible, not hidden.
- *Forward-compatible:* the `settlement_status` field is the exact seam v1.1 automated disbursements plug into (`pending → settled` via callback instead of manual tap). No migration when that lands.
- *Breaks if wrong:* if refund volume turns out high enough that manual settlement becomes a bottleneck or a source of missed transfers, v1.1 disbursement automation is pulled forward. The `settlement_status` design means that's an additive change, not a rewrite.

## Affects other ADRs

- **Extends [ADR-008](./008-refunds-as-new-rows.md):** ADR-008 covers the refund ledger; this ADR adds the orthogonal `settlement_status` (money-movement) dimension and the v1 manual-settlement mechanism. ADR-008's "refunds are rows, status computed on read" is unchanged.
- **Relates to [ADR-036](./036-xendit-dedicated-apis-inline.md):** the asymmetric refund mechanics (QRIS issuer-dependent refund endpoint vs BCA VA disbursement-only) follow directly from the dedicated-API payment design. The manual-settlement model parallels ADR-036's manager-PIN manual-override fallback for missed webhooks.
- **Relates to [ADR-019](./019-refund-re-credits-stock.md):** stock re-credit fires at ledger time (refund recorded), independent of settlement state.
- **Extended by [ADR-039](./039-receipt-after-refund-display-contract.md):** the customer-facing receipt reflects the refund ledger but deliberately excludes `settlement_status`.
