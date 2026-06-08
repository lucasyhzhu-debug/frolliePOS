# Xendit Settlement & Reconciliation — API Reference

> **Purpose:** capture the *hard-won facts* about how Xendit exposes settlement
> (payout-to-merchant) data, so we never re-research this. Researched
> **2026-06-02** during the v0.5.3c (settlements) spec, against the live Xendit
> docs. Sources cited at the bottom.
>
> **Headline:** **There is no "settlement webhook."** Xendit does **not** push a
> callback when collected funds are paid out to your bank. Settlement is only
> knowable by **polling the List Transactions API** or **downloading reports**.
> This corrects the speculative "deduped on Xendit's settlement webhook" wording
> in [strategic-foundations §7](../ADR/000-strategic-foundations.md#7-settlement-as-a-second-stage-record)
> and [ADR-012](../ADR/012-settlements-visible-to-staff-and-managers.md), both
> written 2026-05-21 before this was verified — the same class of speculative
> Xendit assumption the ADR-036 spike already corrected for the payment path.

---

## TL;DR

| Question | Answer |
|---|---|
| Is there a settlement / payout-of-collected-funds webhook? | **No.** Xendit webhooks fire on *payment* events (a sale clearing) and *disbursement/payout* events (money you send out) — **not** on the daily settlement of your collected balance to your bank. |
| How do I know a payment has settled? | Each **transaction** carries a `settlement_status` (`PENDING` / `SETTLED` / `EARLY_SETTLED` / `null`) and a `settlement_date`. Read it via the **List Transactions API** (`GET /transactions`) or the dashboard/reports. |
| Xendit's recommended reconciliation method? | **Report/poll-based**, not webhook: the **Balance Report** + **Transactions Report** (CSV/PDF), or the List Transactions API. Match rows on your own `reference_id`. |
| Settlement timing? | Automatic on each transaction's `settlement_date` (typically **T+1** for QRIS/VA per [foundations §7](../ADR/000-strategic-foundations.md)); `EARLY_SETTLED` if posted ahead of schedule. |
| Is there a "settlement batch" object grouping many payments into one payout? | Not exposed as a clean API object. The **Balance Report is the Transactions Report filtered to settled rows**; grouping is done by you (e.g. by `settlement_date`). |

---

## The settlement model (per-transaction, not per-batch)

Xendit splits a transaction's lifecycle into two orthogonal statuses:

- **`transaction_status`** — did the payment/payout process successfully (e.g. `SUCCESS`).
- **`settlement_status`** — the *ledger-posting* phase, i.e. has the money landed
  in your withdrawable balance:
  - `PENDING` — captured; will post automatically on `settlement_date`.
  - `SETTLED` — funds posted on the scheduled date.
  - `EARLY_SETTLED` — funds posted **before** the scheduled date.
  - `null` — not applicable (voided/failed transactions).

Each transaction also exposes `settlement_date` (when funds post/posted) and a
`fee` (the Xendit MDR — ~0.7% QRIS, ~IDR 4,000 flat BCA VA per foundations §7).

**Net = amount − fee.** Gross/MDR/net for a payout day = aggregate the SETTLED
transactions sharing a `settlement_date`.

## How to read settlement data

### Option A — List Transactions API (the poll primitive) ✅ what POS uses

`GET /transactions` — Xendit's programmatic transaction ledger. Supports
filtering by `settlement_status`, transaction `types`/`channels`, and
created/updated date windows; paginated. Each row carries `reference_id`
(your merchant key), `settlement_status`, `settlement_date`, `fee`, `amount`,
`currency`, `channel_code`, `type`, timestamps.

> ⚠️ The exact query-param names + pagination cursor (`after_id`/`before_id` vs
> `limit`) and the full response field list were **not** fully verified in the
> 2026-06-02 pass (the `apidocs/list-transactions` page intermittently 404'd to
> the doc fetcher). Confirm the precise shape against a real `GET /transactions`
> response (or the OpenAPI at `https://docs.xendit.co/llms.txt`) **before**
> writing the parser — treat field names as asserted-not-verified, exactly as
> ADR-036 treats the BCA VA FVA callback shape.

### List Transactions — confirmed shape (2026-06-08, v0.7 Task 0)

Confirmed against **a real `GET /transactions` call on the live TEST key** (HTTP 200,
3 PENDING QRIS rows) + the OpenAPI page `apidocs/list-transactions.md`. These
correct several **asserted-not-verified** assumptions the v0.7 plan was drafted on —
the parser/adapter (Tasks 2 & 3) adopt the names below, not the plan's placeholders.

**Endpoint:** `GET https://api.xendit.co/transactions` · Basic auth (`secret_key:`).

**Envelope:** `{ has_more: boolean, data: [...], links: [...] }` (HATEOAS `links`, no
`paging` object). Pagination = `limit` (default 10) + `after_id` / `before_id`
cursors (the row's `id`). `has_more` drives the loop.

**Query params (exact):** `created[gte]` / `created[lte]` / `updated[gte]` /
`updated[lte]` (bracket notation — NOT `created_gte`), `types`, `statuses`,
`channel_categories`, `reference_id`, `currency`, `amount`, `limit`, `after_id`,
`before_id`. **There is NO `settlement_status` query filter** — it exists only on
the response row, so settled-status filtering MUST be done client-side in
`aggregateSettledByDate` (the plan's R1 fallback note was correct).

**Transaction row fields (confirmed present on a real row):**
`id, product_id, type, status, channel_category, channel_code, reference_id,
account_identifier, currency, amount, net_amount, net_amount_currency, cashflow,
settlement_status, business_id, created, updated, fee, payment_date,
estimated_settlement_time, channel_reference, product_data`.

Load-bearing corrections vs the plan's assumed shape:

1. **`fee` is an OBJECT, not a number:**
   `{ xendit_fee, value_added_tax, xendit_withholding_tax, third_party_withholding_tax, status }`.
   The plan assumed `fee: number`. **Use `net_amount` (Xendit-provided "amount after
   fees/VAT") directly**, and derive `mdr = amount - net_amount`. This reconciles to
   "what hit BCA" regardless of which fee components apply, and avoids guessing the
   MDR formula.
2. **There is NO `settlement_date` field.** The row carries `estimated_settlement_time`
   (a **UTC ISO timestamp**, e.g. `2026-06-10T04:34:39.259Z`) and `payment_date`.
   The settlement *bucket key* must be **derived**: take the WIB calendar date of
   `estimated_settlement_time` (`new Date(ts + WIB_OFFSET_MS).toISOString().slice(0,10)`).
   This **overrides the plan's R3 decision** ("settlement_date is already a calendar
   date, use verbatim") — it's a timestamp, so WIB re-bucketing IS required.
   *(Caveat: all observable TEST rows are PENDING; whether a SETTLED row gains a
   distinct actual-settlement field is unverifiable pre-KYB — kept as the N3
   live-verification follow-up. `estimated_settlement_time` is the best available
   bucketing source today.)*
3. **`cashflow` = `"MONEY_IN"` / `"MONEY_OUT"`** and `type` = `PAYMENT` /
   `DISBURSEMENT` / … A SETTLED `MONEY_OUT` payout is NOT a collected-sales
   settlement — the aggregator MUST filter to `cashflow === "MONEY_IN"` so payouts
   don't inflate the day's gross.
4. `settlement_status` values confirmed: `PENDING | SETTLED | EARLY_SETTLED | null`.
   On TEST keys pre-KYB every row is `PENDING` (no real payouts) → the aggregator
   yields zero settled days → the cron's audited `no_settlements` skip is the normal
   path today (R2).

### Option B — Reports (CSV/PDF)

- **Transactions Report** — full itemized transaction history incl. custom
  metadata; used to reconcile your balance at period end.
- **Balance Report** — a ledger of credits/debits/fees/taxes; **equivalent to
  the Transactions Report filtered to settled transactions**. Downloadable as
  CSV/PDF for any date range.

Xendit's own reconciliation guidance is **report-first**: download Balance +
Transactions reports, cross-reference, and confirm the balance change equals the
sum of debits/credits over the period. Matching is keyed on your
**`reference_id`** (merchant-generated), the payment id (`product_id` in
reports), and the payment-link id (`invoice_id`).

## What DOES have a webhook (so we don't confuse them)

Xendit webhooks exist for, e.g.:
- **Payment events** — `qr.payment` (QRIS), `virtual_account.payment` (FVA/BCA
  VA), invoice paid/expired. *(These are what `convex/payments/webhook.ts`
  consumes — see [the QRIS README](./README.md) + ADR-036.)*
- **Payout/disbursement events** — `payout.*` including `payout.reversed`
  (a succeeded payout bounced back to your balance). This is the **Payouts**
  product (money you *send out*), unrelated to settlement of collected sales.

None of these signal "your collected QRIS/VA balance was paid out to your bank."

## Implications for FrolliePOS (v0.5.3c)

1. **Ingress = nightly cron polling `GET /transactions`** (not a webhook),
   aggregating SETTLED rows by `settlement_date` into `pos_settlements`. Upsert
   by date with a multi-day lookback so a missed run self-heals.
2. **The join key already exists.** `pos_xendit_invoices.receipt_id` (bank RRN)
   and our `reference_id` (`pos-${txnId}`) were captured at payment time
   precisely as the settlement-report join key (ADR-036 consequence + SCHEMA.md).
   Reconciliation maps each settled Xendit txn back to a `pos_transaction`.
3. **KYB / TEST-mode caveat.** Until Xendit KYB clears, the integration runs on
   **TEST keys, where real payouts/settlements do not occur** — so settlement
   figures **cannot be live-verified** (mirrors ADR-036 Decision C for BCA VA).
   Build + shape-test against the API; gate live verification behind KYB; the
   manual settlement-entry fallback keeps `/settlements` usable in the interim.
4. **Naming guard.** `pos_settlements` (Xendit → merchant payout) is a *different*
   concept from `pos_refunds.settlement_status` (merchant → customer refund
   money-back, ADR-038). Same word, orthogonal ledgers.

## Sources (verified 2026-06-02)

- Transaction & settlement statuses — https://docs.xendit.co/docs/transaction-status
- List Transactions API — https://docs.xendit.co/apidocs/list-transactions
- Transaction reconciliation — https://docs.xendit.co/docs/reconciliations
- Transactions report — https://docs.xendit.co/reports/transaction
- Balance report — https://docs.xendit.co/reports/balance-report
- Webhook events — https://docs.xendit.co/webhook/events/
- Payout webhook (the *other* "settlement-ish" thing — not collected-funds settlement) — https://docs.xendit.co/apidocs/payout-webhook-notification
- LLM-friendly doc index (for re-verifying field shapes) — https://docs.xendit.co/llms.txt
