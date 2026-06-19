# 036. Xendit inline QRIS via QR Codes API + BCA VA via FVA API

**Date:** 2026-05-28
**Status:** Accepted
**Group:** Pay

## Context

The v0.3 payments path was non-functional. `requestPayment` called `POST /v2/invoices` (the Invoice API) and read `data.qr_string` / `data.account_number`, but the Invoice API only returns a hosted `invoice_url` — both fields come back `undefined`. The webhook checked a flat `body.status === "PAID"` keyed on `body.id`, but Xendit's QR Codes webhook delivers `{ event, data: { status: "SUCCEEDED", qr_id } }`. **No payment could complete.** Empirically confirmed via a live diagnostic spike using a working QRIS integration from `product_master` Phase 84 (reference bundle at `docs/xendit-reference/`).

Three root bugs, in order of impact:

1. **Wrong API.** The Invoice API returns a hosted checkout page, not a raw QR payload or inline VA number. Inline QRIS requires the **QR Codes API** (`POST /qr_codes`); an inline BCA VA number requires the **Virtual Accounts (Fixed VA) API** (`POST /callback_virtual_accounts`).
2. **Missing `api-version` header.** The QR Codes `qr.payment` webhook only fires if `api-version: 2022-07-31` is pinned at QR-creation time. Without it, paid callbacks never arrive.
3. **Webhook shape mismatch.** QR Codes v2 delivers `{ event, data: { status: "SUCCEEDED", qr_id } }` — status is `SUCCEEDED` (not `PAID`), nested under `data`, keyed on `qr_id`. The FVA payment callback is a different flat shape.

**Spec:** `docs/superpowers/specs/2026-05-28-xendit-dedicated-apis-design.md`. **Diagnostic bundle:** `docs/xendit-reference/`.

## Decision

### Decision A — Dedicated APIs, inline rendering

QRIS → **QR Codes API** (`POST /qr_codes`); BCA VA → **Virtual Accounts (Fixed VA) API** (`POST /callback_virtual_accounts`). Both render **inside the POS** (scannable QR + copyable VA number). No redirect to a hosted invoice page.

The Xendit protocol is hidden behind a single **deep adapter module** (`convex/payments/xendit.ts` — see Decision D). The action and webhook handlers are thin and never reference a Xendit URL, header, or response field directly.

This **supersedes ADR-011** (which assumed the Invoice API as the single surface for both methods) and **adjusts ADR-014** (see Decision E).

### Decision B — Retire the polling leg for QRIS and BCA VA

The diagnostic spike confirmed that polling the QR Codes API never reads "paid" — polling is not a viable confirmation path for QR or FVA. The reactive Convex subscription already flips the charge screen to "paid" the instant the webhook writes, so polling adds nothing.

**Removed:** the 2 s polling loop in `useXenditPayment`, the `checkInvoiceStatus` action, `_onPaidPolling_internal`, and the `xenditGet` helper. Confirmation paths for QRIS/FVA are now:

- **Webhook (primary)** — Xendit POSTs `qr.payment` / `virtual_account.payment` to `convex/payments/webhook.ts`.
- **Manager-PIN manual override (fallback)** — unchanged from the original three-path model.

This **amends strategic-foundations §8** (the polling leg of the three-path model is retired for these methods). The 60 s wall-clock ceiling timer and the three ceiling CTAs (Retry / Manager override / Cancel) remain on the charge screen as the manual-fallback surface.

### Decision C — BCA VA partitioned as code-complete, live-unverified

The reference bundle proves QRIS only. BCA VA (FVA endpoint + `virtual_account.payment` callback) is documented by Xendit but unverified in this effort. Both methods are shipped in this change, but BCA VA is explicitly tagged as code-complete-pending-live-verification. QRIS ships confirmed-working; BCA VA ships ready for a dashboard "simulate payment" test before BCA is declared done.

### Decision D — Isolate the Xendit protocol behind a deep adapter (ADR-034)

Per ADR-034, all Xendit protocol detail (endpoints, `api-version` header, Basic auth, request bodies, response field-mapping, and the two distinct webhook shapes) lives behind a single deep adapter module with a narrow surface:

- `createQrisCharge(ref, amount, idemKey)` → `{ providerId, qrString }`
- `createBcaVaCharge(ref, amount, idemKey)` → `{ providerId, vaNumber }` *(live-unverified)*
- `parseXenditWebhook(rawBody)` → `{ paid, matchKey, amount?, receiptId?, source? }`
- `buildQrisBody(ref, amount)`, `buildBcaVaBody(ref, amount)`, `buildQrisHeaders()` (pure — exported for tests)

The `api-version: 2022-07-31` header is **load-bearing** and is extracted into the pure `buildQrisHeaders()` function precisely so a test can assert it is present — dropping it silently kills all webhook delivery with a green build.

### Decision E — Retry/cancel supersede locally (adjusts ADR-014)

The Invoice API's `POST /invoices/{id}/expire!` cancel call does not apply to QR codes. New semantics:

- **Retry:** mint a fresh QR/VA (using a unique `reference_id` suffix per attempt), mark the prior `pos_xendit_invoices` row cancelled + `replaced_by_invoice_id` **locally** (no Xendit cancel API call for QR). Safe because `_confirmPaid_internal` is idempotent and amount-guarded if a stale QR pays.
- **Cancel** (`cancelTransaction`): the `/invoices/{id}/expire!` call is dropped. `xendit_invoice_id_current` now holds a QR/FVA id, so that endpoint would 404 and write a spurious failed-cancel audit row on every cancel. The "paid after cancel" alert path in `_confirmPaid_internal` (`payment.confirmed_on_terminal`) still protects against stale QR payments.
- For BCA VA: an optional best-effort FVA close lives in the (unverified) BCA wave.

### Decision F — ADR-026 reconciliation-on-reload downgraded to manual-only recovery

Retiring polling (Decision B) is not just removing a loop — `useStartupReconciliation` (ADR-026) was a consumer of `checkInvoiceStatus`. Two independent reasons it cannot survive as-is:

1. It called the action being removed (would cause a compile break).
2. After the switch, `xendit_invoice_id_current` holds a QR/FVA id, so `GET /v2/invoices/{id}` 404s. More fundamentally, per the diagnostic spike, **a QR never reports paid on a status poll** at all — reconciliation-via-poll for QRIS is architecturally impossible.

**Decision (option a):** gut the poll from `useStartupReconciliation` — keep the hook as a thin no-op shell (preserving the `RootLayout` mount point and the ADR-026 reference for a future working-endpoint reconciliation) and accept that **missed-webhook recovery for QRIS/FVA is manager-PIN manual override only**. This is an explicit downgrade of the ADR-026 guarantee. **Amends ADR-026.**

Rejected option (b): reconcile via a working endpoint (Xendit QR-payments lookup / Payments API) — preserves automatic recovery but is unverified Xendit territory; deferred to a future revision if missed-webhook incidents occur in practice.

The `by_line_and_sku` movement-dedup index (ADR-026 §double-movement) still protects against any future re-introduction of a second confirmation path.

### Non-decisions (kept deliberately)

- **Env vars unchanged:** `XENDIT_SECRET_KEY` + `XENDIT_CALLBACK_TOKEN`.
- **Runtime unchanged:** `actions.ts` stays `"use node"` (the manual-override path needs argon2 via `verifyPinOrThrow`). The adapter is runtime-agnostic (`btoa`, no top-level side effects).
- **Schema change is additive only:** two optional columns on `pos_xendit_invoices` (`receipt_id`, `payment_source`) and one new flag bit (`PAYMENT_AMOUNT_MISMATCH`). No migration (Convex optional fields are backward-compatible).

## Alternatives considered

- **Hosted Invoice URL (redirect)** — one surface, minimal code, honors ADR-011 as written. Rejected: customer leaves the POS screen; reactive in-app "paid" flip is lost. Worst booth UX.
- **Invoice API rendering its own QR** — not supported; the Invoice API never hands back a raw `qr_string`.
- **Reconcile-on-reload via a working Xendit endpoint (Decision F option b)** — preserves automatic missed-webhook recovery. Rejected for this effort: unverified Xendit territory; deferred if incidents warrant it.
- **Keep polling, just poll a different endpoint** — QR payment status polling is architecturally not reliable per the diagnostic spike and Xendit documentation. Rejected.

## Consequences

- *Inline booth UX preserved.* Staff see a scannable QR or a copyable VA number without leaving the app.
- *`api-version: 2022-07-31` header is load-bearing.* The `buildQrisHeaders()` pure function + unit test assert its presence. Dropping the header silently kills webhook delivery.
- *Webhook is now the SOLE automatic confirmation path for QRIS and FVA.* The webhook-fires deploy gate (verify `api-version` + callback URL config before declaring the deployment done) is mandatory because polling is gone.
- *RRN and payment source captured.* `receipt_id` (bank RRN — join key to the Xendit settlement report) and `payment_source` (paying wallet/bank — DANA/OVO/BCA) are written as optional columns on `pos_xendit_invoices` when the webhook carries them.
- *Amount mismatch honored and flagged.* `_confirmPaid_internal` accepts `paid_amount`; when `paid_amount ≠ txn.total`, the payment is honored and `flags |= PAYMENT_AMOUNT_MISMATCH` is set (mirrors the reference honor-and-flag rule; DYNAMIC QR + `is_closed` FVA make a mismatch unlikely but this is a money path).
- *`xendit_invoice_id` has dual meaning.* The column stores the QR Codes `id` for QRIS invoices and the FVA `id` for BCA VA invoices — it is the webhook match index (`by_xendit_invoice_id`) in both cases.
- *Webhook always returns 200.* Non-2xx on an unmatchable or post-error payload creates a permanent Xendit retry loop. Missing config or wrong token → 401 (was 500) so both conditions self-heal once fixed.
- *Missed-webhook recovery for QRIS/FVA is manager-PIN manual override only.* This is a deliberate downgrade of the ADR-026 automatic-recovery guarantee. Mitigation: webhook reliability is the primary investment; daily dashboard surfaces manual-override counts to flag any sustained degradation.
- *BCA VA is code-complete but live-unverified.* Field names in the FVA parser are asserted from Xendit FVA docs and must be confirmed against a real callback before BCA is declared done.

## Affects other ADRs

- **Supersedes [ADR-011](./011-qris-via-xendit-bca-va-secondary.md)** (2026-05-28): replaces the unified Invoice API surface with dedicated QR Codes API (QRIS) + Virtual Accounts FVA API (BCA VA).
- **Adjusts [ADR-014](./014-single-xendit-invoice-per-transaction.md)** (2026-05-28): prior invoice is superseded locally (no Xendit cancel-API call for QR); `is_closed` + `is_single_use` on FVA prevent double-pay for BCA VA.
- **Amends [ADR-026](./026-reconciliation-on-reload.md)** (2026-05-28): `useStartupReconciliation` poll body gutted; reconciliation-on-reload for QRIS/FVA is now manual-only recovery (manager-PIN override).
- **Amends [strategic-foundations §8](./000-strategic-foundations.md#8-three-path-payment-confirmation-operational-pattern)** (2026-05-28): polling leg retired for QRIS and BCA VA; confirmation paths are webhook (primary) + manager-PIN manual override (fallback).
- **Amended below** (2026-06-19, v1.2 #10): dynamic BCA VA hidden; Manual BCA added as a staff-self-confirm out-of-band tender; deviation from ADR-005 manager-PIN manual override documented with compensating controls.

---

## Amended 2026-06-19 — v1.2 #10: Manual BCA tender + dynamic BCA VA hidden

### A — Payment method set as of v1.2 #10

The live payment-method set is now:

| Method | Provider | Confirmation path |
|---|---|---|
| **QRIS** | Xendit QR Codes API | Webhook (primary); manager-PIN manual override (fallback) |
| **Manual BCA** | Out-of-band bank transfer | Staff self-confirm via attestation (`confirmManualBcaPayment`) |

**Dynamic BCA VA (Xendit FVA) is hidden from the charge screen** — the BCA VA tab that previously appeared alongside QRIS has been removed from the FE. The feature was code-complete but not live-verified, and a pending decision to resolve FVA UX before enabling it produced an error-toast storm on the charge screen. Hiding the tab eliminates the storm while the decision is pending.

**`createBcaVaCharge`, the FVA webhook parser, and the `BCA_VA` literal are RETAINED in the codebase** and must not be deleted:

1. **Deploy-skew safety:** `confirmManualBcaPayment` is a net-new mutation; the FVA mutation (`createBcaVaCharge`) exists at the same path it always has. Removing it creates a function-type change at a known name — deploy-skew-fatal for any client still on the old FE during a rolling deploy.
2. **Historical rows:** `pos_xendit_invoices` rows with `method="bca_va"` exist from pre-v1.2 #10 development and smoke-test sessions; the FVA parser in `webhook.ts` must remain to handle late-arriving callbacks on those rows.

Re-enabling the dynamic BCA VA tab is a FE config change (un-hide the tab); the backend is unchanged.

### B — Staff self-confirm: deviation from ADR-005 manager-PIN manual override

The original manual override (Decision B, "fallback" path) required a **manager PIN** — only a manager could attest that a payment was received out-of-band. `confirmManualBcaPayment` deviates from this: **any authenticated staff member** can attest a Manual BCA transfer.

**Rationale for the deviation:** the manual BCA flow targets a booth where the staff member physically holds the phone and can see the banking app. The transfer amount and sender name are visible on the merchant's BCA account before the confirm button is pressed. Requiring a manager PIN for every manual BCA sale would serialize every sale on manager availability — a prohibitive UX cost for a two-to-three person booth.

**Compensating controls (replacing the manager-PIN gate):**

1. **EOD reconciliation itemization** — every `confirmed_via="manual_bca"` sale is listed individually in the founders EOD summary with `{ paidAt, total, staffName, receiptNumber }`, so managers can cross-check against the BCA statement the next morning.
2. **Clock-out reconciliation** — the same itemization appears on the shift hand-off context, so discrepancies surface at shift end before the next person starts.
3. **Telegram ticker flag** — the manager ticker marks manual-BCA sales with a `MANUAL` flag, so managers monitoring live can spot unexpected manual confirms immediately.
4. **Audit log** — `payment.confirmed` is emitted with `confirmed_via:"manual_bca"` and `staff_id`, providing a full audit trail.

Sales are marked `confirmed_via="manual_bca"` (distinct from `"manual"` which is the manager-PIN override path) so reporting can separate the two.

### C — Live-QR double-pay residual (I1)

When a staff member confirms a Manual BCA transfer, `confirmManualBcaPayment` **cancels the active QRIS invoice locally** (marks the `pos_xendit_invoices` row cancelled + `replaced_by_invoice_id=null`). However, it **cannot expire the QR code on Xendit's side** — the QR string remains scannable until Xendit's own 5-minute TTL expires.

**Residual risk:** if a customer scans and pays the QRIS QR during the window between the staff self-confirm and the Xendit TTL expiry, `_confirmPaid_internal` will receive a second `qr.payment` webhook on an already-paid transaction. The existing `payment.confirmed_on_terminal` guard in `_confirmPaid_internal` detects this and logs a `payment.confirmed_on_terminal` audit row rather than double-committing stock or double-issuing a receipt number.

**Backstop:** the EOD reconciliation (control 1 above) will surface the Xendit payout for the QR amount alongside the manual-BCA receipt, allowing the manager to identify and resolve any double-payment with the customer.
