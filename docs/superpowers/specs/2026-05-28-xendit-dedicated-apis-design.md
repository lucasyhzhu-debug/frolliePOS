# Xendit dedicated-API integration (inline QRIS + BCA VA) — Design Spec

> **Status:** Draft — staffreview pass applied 2026-05-28 (see [`docs/reviews/staffreview-xendit-dedicated-apis-design-2026-05-28.md`](../../reviews/staffreview-xendit-dedicated-apis-design-2026-05-28.md))
> **Date:** 2026-05-28
> **Phase:** v0.3 (bug-fix / unblock — payments path was non-functional)
> **Preceded by:** [v0.3 sale + Xendit design](./2026-05-27-v0.3-sale-xendit-design.md) (the integration this fix corrects)
> **Diagnostic source:** [`docs/xendit-reference/`](../../xendit-reference/) — a verbatim working QRIS integration from `product_master` (Recipe Master) Phase 84, live + webhook-confirmed on Xendit TEST keys.
> **Brainstorm record:** Captures decisions from the 2026-05-28 brainstorming session. Key decisions: (A) dedicated Xendit APIs with inline rendering — QR Codes API for QRIS, Virtual Accounts (FVA) API for BCA VA — chosen over hosted-invoice redirect; (B) polling leg retired for these methods (webhook + manual override remain); (C) BCA VA partitioned as code-complete-but-live-unverified; (D) Xendit protocol isolated behind a deep adapter module per ADR-034; (E) retry/cancel supersede locally; (F) ADR-026 reconciliation-on-reload downgraded to manual-only recovery (QR poll is architecturally impossible). Rationale per decision below.
> **Staffreview applied:** 2 Critical fixed (ADR-026 reconciliation resolved → Decision F; `api-version` header now assertable + tested). 6 Improvements folded in (amount-mismatch flag, RRN/source capture via additive columns, webhook-fires deploy gate, FVA-parser tagged unverified, retry-`ref` uniqueness, ADR cross-refs). Success Criteria + Rollback/Deployment sections added.

## Goal

The v0.3 payments path is non-functional. `requestPayment` calls `POST /v2/invoices` (the Invoice API) and reads `data.qr_string` / `data.account_number`, but the Invoice API returns only a hosted `invoice_url` — both fields come back `undefined`. The webhook checks a flat `body.status === "PAID"` keyed on `body.id`, but Xendit's QR Codes webhook delivers `{ event, data: { status: "SUCCEEDED", qr_id } }`. **No payment can complete today.**

Make QRIS and BCA VA work end-to-end with **inline** rendering (a scannable QR and a copyable VA number shown in the POS, no redirect), confirmed via webhook, with the existing manager-PIN manual override as the fallback. Preserve everything already correct: the `_confirmPaid_internal` funnel, action-level idempotency, single-active-invoice (ADR-014), and audit logging.

## Root cause (from the diagnostic)

Three bugs, in order of impact:

1. **Wrong API.** `POST /v2/invoices` returns a hosted checkout page, not a raw QRIS payload or an inline VA number. Inline QRIS requires the **QR Codes API** (`POST /qr_codes`); an inline BCA VA number requires the **Virtual Accounts API** (`POST /callback_virtual_accounts`).
2. **Missing `api-version` header.** The QR Codes `qr.payment` webhook only fires if `api-version: 2022-07-31` is pinned at QR-creation time. Without it the paid callback may never arrive.
3. **Webhook matches the wrong shape.** QR Codes v2 delivers `{ event, data: { status: "SUCCEEDED", qr_id } }` — status is `SUCCEEDED` (not `PAID`), nested under `data`, keyed on `qr_id`. The FVA payment callback is a *different*, flat shape again.

What is **not** broken (keep as-is): `_confirmPaid_internal` (idempotent receipt allocation, stock movement, voucher redemption, NEG_STOCK re-check), the idempotency cache pre-check + `X-IDEMPOTENCY-KEY` passthrough, single-active-invoice + audit logging.

## Decisions

### Decision A — Dedicated APIs, inline rendering (chosen)

QRIS → **QR Codes API**; BCA VA → **Virtual Accounts (Fixed VA) API**. Both render inside the POS. Rejected alternatives:

- **Hosted Invoice URL for both** (one surface, honors ADR-011 as written): minimal code, but the customer leaves the POS screen and the reactive in-app "paid" flip is lost. Worst booth UX.
- **Invoice API rendering its own QR**: not supported — the Invoice API never hands back a raw `qr_string`.

This **supersedes ADR-011's** "single invoice surface for QRIS + BCA VA", **adjusts ADR-014** (see Decision E), and (with Decisions B + F) **amends strategic-foundations §8 and ADR-026**. Captured in new **ADR-036**.

### Decision B — Retire the polling leg for these methods

The diagnostic's production spike confirmed the QR **never reads "paid" on a status poll** — polling the QR Codes API is theater. FVA payment status is likewise not reliably pollable. The reactive Convex subscription already flips the charge screen to "paid" the instant the webhook writes, so polling adds nothing for UX.

**Remove** the 2 s polling loop (`useXenditPayment`'s interval, `checkInvoiceStatus` action, `_onPaidPolling_internal`, the `xenditGet` helper). Confirmation paths become **webhook (primary) + manager-PIN manual override (fallback)**. This **deviates from strategic-foundations §8's** three-path (webhook/polling/manual) model for these methods — documented as an amendment in ADR-036.

### Decision C — BCA VA partitioned as live-unverified

The reference bundle proves only QRIS. BCA VA (same Xendit account, FVA endpoint + `virtual_account.payment` callback) is documented but unverified here. Build both in this effort, but **partition BCA VA into its own wave/commit**, explicitly flagged as code-complete-pending-live-verification. QRIS ships confirmed-working; BCA VA ships ready for a live test (dashboard "simulate payment"). Matches the standing preference to defer only live-API-verification items.

### Decision D — Isolate the Xendit protocol behind a deep adapter (ADR-034)

Per ADR-034, the Xendit protocol detail (endpoints, the `api-version` header, Basic auth, request bodies, response field-mapping, **and** the two distinct webhook shapes) is hidden behind one **deep module** with a narrow surface. The action and webhook handlers become thin and never reference a Xendit URL or header. No `provider.ts` interface layer is added — that is premature abstraction for a single provider (YAGNI); the single adapter *is* the abstraction.

### Decision E — Retry/cancel supersede locally (ADR-014 adjustment)

The Invoice `POST /invoices/{id}/expire!` call does not exist for QR codes. New semantics:

- **Retry**: mint a fresh QR/VA and mark the prior `pos_xendit_invoices` row cancelled + `replaced_by_invoice_id` **locally** (the existing replace-commit). No Xendit cancel call for QR. Safe because `_confirmPaid_internal` is idempotent and amount-guarded if a stale QR somehow pays.
- **Cancel** (`transactions.actions.cancelTransaction`): drop the best-effort `expire!` — `xendit_invoice_id_current` now holds a QR/FVA id, so `POST /invoices/{id}/expire!` would 404 and write a spurious failed-cancel audit row on every cancel (the call is no-throw best-effort, so it doesn't crash, but it's wrong). For BCA VA, an optional best-effort FVA close lives in the (unverified) BCA wave. The "paid after cancel" alert path already exists in `_confirmPaid_internal:149-160` (`payment.confirmed_on_terminal`).

### Decision F — ADR-026 reconciliation-on-reload downgrades to manual-only recovery (staffreview Critical 1)

Retiring polling (Decision B) is not just removing a loop — `useStartupReconciliation.ts:44` (ADR-026 reconciliation-on-reload, mounted in `RootLayout`) is a **fourth consumer** of `checkInvoiceStatus`. It re-checks recent `awaiting_payment` txns on app mount via `GET /v2/invoices/{id}` to recover a webhook missed while the device was offline/closed.

Two independent reasons this can't survive as-is: (1) it consumes the action being removed (compile break); (2) after the switch `xendit_invoice_id_current` holds a **QR/FVA id**, so the invoice GET 404s — and per the diagnostic's spike, **a QR never reports paid on a status poll** at all. Reconciliation-via-poll for QRIS is architecturally impossible, not merely orphaned.

**Decision (option a):** Gut the poll from `useStartupReconciliation` — keep the hook as a thin no-op shell (or remove its body) and accept that **missed-webhook recovery for QRIS/FVA is manager-PIN manual override only**. This is an explicit downgrade of the ADR-026 guarantee, **amended in ADR-036**. Rejected option (b): reconcile via a *working* endpoint (Xendit QR-payments lookup / Payments API) — preserves automatic recovery but is unverified Xendit territory; deferred (revisit if missed-webhook incidents occur in practice). Mitigation for (a): Decision B's webhook is now the sole automatic path, so Improvement-3's webhook-fires deploy gate (below) is mandatory, and the movement-dedup index (`by_line_and_sku`, ADR-026 §double-movement) still protects against any future re-introduction of a second confirmation path.

### Non-decisions (kept deliberately)

- **Env vars unchanged**: keep `XENDIT_SECRET_KEY` + `XENDIT_CALLBACK_TOKEN` (the reference's renames are optional; skipping them avoids a deployment env migration).
- **Runtime**: `actions.ts` stays `"use node"` (the manual-override path needs argon2 via `verifyPinOrThrow`). The adapter is runtime-agnostic (`btoa`, no top-level side effects) so the default-runtime webhook can import its pure parser.
- **Schema change is additive only** (staffreview Improvement 2): two optional columns on `pos_xendit_invoices` (`receipt_id`, `payment_source`) and one new flag bit (`PAYMENT_AMOUNT_MISMATCH`). No breaking change, no migration (Convex optional fields are backward-compatible).

## Architecture

### Module shape (per ADR-034 — deep adapter, thin handlers)

```
convex/payments/                # owns pos_xendit_invoices
  xendit.ts        # NEW — deep adapter. Narrow surface; hides ALL Xendit protocol.
                   #   createQrisCharge(ref, amount, idemKey) -> { providerId, qrString }
                   #   createBcaVaCharge(ref, amount, idemKey) -> { providerId, vaNumber }
                   #   parseXenditWebhook(rawBody) -> { paid; matchKey; amount?; receiptId?; source? }
                   #   buildQrisBody(ref, amount) / buildBcaVaBody(ref, amount)  (pure — for tests)
                   #   buildQrisHeaders() -> { ..., "api-version": "2022-07-31" }  (pure — for tests)
                   #   Runtime-agnostic: btoa auth, no top-level fetch/env/side effects.
  actions.ts       # THIN — auth + idempotency pre-check + adapter call + commit.
                   #   requestPayment, retryWithFreshInvoice, manuallyConfirmPayment.
                   #   checkInvoiceStatus + xenditGet REMOVED (polling retired).
  webhook.ts       # THIN — constant-time token verify + parseXenditWebhook + _onPaidWebhook_internal.
                   #   No knowledge of the two event shapes (lives in the adapter).
  internal.ts      # _persistInvoiceCommit / _replaceInvoiceCommit / _onPaidWebhook /
                   #   _onPaidManual.  _onPaidPolling REMOVED.  _onPaidWebhook now also
                   #   records receipt_id/payment_source on the invoice row + threads
                   #   paid_amount into _confirmPaid_internal.
  public.ts        # getCurrentInvoice (unchanged — reactive sub for charge screen).
  schema.ts        # +receipt_id?, +payment_source? on pos_xendit_invoices (additive).

convex/transactions/
  actions.ts       # cancelTransaction: REMOVE the /invoices/{id}/expire! call (Decision E).
  internal.ts      # _confirmPaid_internal: accept optional paid_amount; flag mismatch.
  flags.ts         # +PAYMENT_AMOUNT_MISMATCH = 1<<2.

src/hooks/
  useXenditPayment.ts        # remove polling interval/timeout + checkInvoiceStatus call.
  useStartupReconciliation.ts # Decision F — gut the poll; thin no-op shell.
```

Cross-module discipline (already honored, preserved): the active-invoice pointer is patched via `transactions._setCurrentInvoice_internal`; payment confirmation funnels through `transactions._confirmPaid_internal`; audit via `audit.logAudit`. The amount-mismatch comparison happens **inside** `_confirmPaid_internal` (transactions owns `pos_transactions.total` + `flags`) — payments passes `paid_amount` in rather than reading the txn total across the boundary. `receipt_id`/`payment_source` are written on the payments-owned invoice row. No cross-module table access introduced.

### The deep adapter surface (`convex/payments/xendit.ts`)

Why deep: the action calls `createQrisCharge(ref, amount, idemKey)` and gets back `{ providerId, qrString }`. It never sees `https://api.xendit.co/qr_codes`, the `api-version` header, the auth scheme, or the response JSON shape. The webhook calls `parseXenditWebhook(body)` and gets `{ paid, matchKey, amount?, receiptId?, source? }`; it never learns there are two event envelopes. All Xendit-specific complexity is behind these calls.

- **`createQrisCharge`**: `POST /qr_codes`, headers from `buildQrisHeaders()` (includes `api-version: 2022-07-31`); body `{ reference_id, external_id, type: "DYNAMIC", currency: "IDR", amount }`. Returns `{ providerId: json.id, qrString: json.qr_string }`.
  - **`ref` uniqueness (staffreview Improvement 5):** initial create uses `reference_id = "pos-<txnId>"`; **retry uses a unique suffix** (`"pos-<txnId>-r<attempt>"` or a uuid) so a regenerate can't collide with the prior QR's reference. Matching is on the globally-unique `qr_id`, so `reference_id` reuse wouldn't break *matching* — but a unique ref avoids any Xendit-side duplicate-reference ambiguity. The builder takes `ref` as a parameter; the action owns the suffix.
- **`buildQrisHeaders()`** (pure, exported for tests — staffreview Critical 2): returns the QR-create header set **including `api-version: 2022-07-31`**. Extracted as a pure function precisely so a test can assert the header is present — dropping it silently kills all webhook delivery with a green build (the exact bug being fixed). See Testing.
- **`createBcaVaCharge`** *(BCA wave — live-unverified)*: `POST /callback_virtual_accounts`; body `{ external_id: "pos-<txnId>", bank_code: "BCA", name: "Frollie POS", expected_amount: amount, is_closed: true, is_single_use: true }`. Returns `{ providerId: json.id, vaNumber: json.account_number }`. `is_closed` + `expected_amount` enforce exact-amount; `is_single_use` blocks double-pay.
- **`parseXenditWebhook`** (pure, unit-testable): discriminates two shapes and extracts amount + reconciliation fields —
  - QRIS *(reference-proven)*: `body.event === "qr.payment"` (payload at `body.data`); `paid = data.status === "SUCCEEDED" || "COMPLETED"`; `matchKey = data.qr_id ?? data.id`; `amount = data.amount`; `receiptId = data.payment_detail?.receipt_id`; `source = data.payment_detail?.source`.
  - BCA VA *(live-unverified — staffreview Improvement 4; field names asserted from Xendit FVA docs, must be confirmed against a real callback before BCA is declared done)*: flat FVA callback (`body.callback_virtual_account_id` present, no `event`); `paid = true` (callback arrival = paid); `matchKey = body.callback_virtual_account_id`; `amount = body.amount`; `receiptId = body.payment_id`.
  - Unrecognised / unparseable → `{ paid: false, matchKey: null }`. The QRIS branch is kept cleanly separable so a wrong FVA assumption cannot regress QRIS.
- Auth uses `btoa(\`${XENDIT_SECRET_KEY}:\`)` (key as username, empty password). Reads env **inside** functions, never at module top level.
- **Idempotency caveat (staffreview Refinement):** the Convex `_lookup_internal` cache is the primary double-commit guard. Whether `/qr_codes` honors `X-IDEMPOTENCY-KEY` is unverified; if it doesn't, a crash *between* the Xendit POST and the commit mutation orphans one unpaid QR (harmless — it's superseded on the next attempt). We accept this small window rather than engineer around it.

### Webhook handler flow (`webhook.ts`)

1. Verify `x-callback-token` via the existing constant-time compare against `XENDIT_CALLBACK_TOKEN`. Missing config or mismatch → **401, no state change** (the only response that correctly forces a Xendit redelivery while self-healing on fix). *Behavior change:* the current handler returns `500` when the config is missing; align it to `401` so a missing-config and a wrong-token look identical to Xendit and both self-heal once fixed (per the diagnostic).
2. `const { paid, matchKey, amount, receiptId, source } = parseXenditWebhook(await request.text())`.
3. If `paid && matchKey`: `await ctx.runMutation(internal.payments.internal._onPaidWebhook_internal, { xendit_invoice_id: matchKey, paid_amount: amount, receipt_id: receiptId, payment_source: source })`, wrapped in try/catch.
4. **Always return 200** for paid/no-match/unparseable/caught-error (a non-2xx on an unmatchable or post-record-error payload creates a permanent Xendit retry loop). Bad JSON → 200 no-op (was 400 — changed, since a malformed body never parses on retry).

`_onPaidWebhook_internal` → `_resolveAndConfirm` resolves `matchKey` against the `by_xendit_invoice_id` index, patches `receipt_id`/`payment_source` onto the invoice row, then calls `_confirmPaid_internal({ source: "webhook", paid_amount })`. `_confirmPaid_internal` honors the payment unconditionally and, when `paid_amount !== txn.total`, sets `flags |= PAYMENT_AMOUNT_MISMATCH` (staffreview Improvement 1 — mirrors the reference's honor-and-flag rule; DYNAMIC QR + `is_closed` FVA make a mismatch unlikely, but this is a money path).

### Schema — additive only

`pos_xendit_invoices` already has `xendit_invoice_id` (+ `by_xendit_invoice_id` index), `qr_string`, and `va_number`. The QR Codes `id` and the FVA `id` both store in `xendit_invoice_id`; that index *is* the webhook match index (add a one-line comment documenting the dual meaning — staffreview Refinement). `qr_string` ← QR payload; `va_number` ← FVA `account_number`.

**Additive columns** (staffreview Improvement 2 — Convex optional fields, no migration): `receipt_id: v.optional(v.string())` (the bank RRN, the join key to the Xendit settlement report for Frollie Pro reconciliation) and `payment_source: v.optional(v.string())` (paying wallet/bank — DANA/OVO/BCA). **New flag bit** in `transactions/flags.ts`: `PAYMENT_AMOUNT_MISMATCH = 1 << 2`.

### Frontend (`src/routes/sale/charge.tsx`, `src/hooks/useXenditPayment.ts`, `src/hooks/useStartupReconciliation.ts`)

- Add **`qrcode.react`** (pin **^4** — v4 declares React 19 peer support; v3 does not); render `<QRCodeSVG value={invoice.qr_string} />` in the QRIS tab, replacing the raw-string `<code>` dump (unusable at a booth). Guard an empty/whitespace `qr_string` (don't render an empty QR). On TEST keys the payload is not wallet-scannable — verify via the dashboard "simulate payment" button.
- `useXenditPayment`: remove the polling interval/timeout and the `checkInvoiceStatus` action call. Keep the reactive `getById` + `getCurrentInvoice` subscriptions and `computePhase` (the "paid" flip is driven by the webhook write, reactively). The 60 s wall-clock ceiling timer (route-owned) and the three ceiling CTAs (Retry / Manager override / Cancel) stay — they are the manual-fallback surface.
- `useStartupReconciliation` (Decision F): gut the poll body — it can no longer call `checkInvoiceStatus`. Keep the hook as a thin no-op shell (preserves the `RootLayout` mount point and the ADR-026 reference for a future working-endpoint reconciliation) or remove it entirely; either way drop the `listRecentAwaitingPayment` → poll loop.

## Testing (CLAUDE.md rule 7 — money paths require tests)

- **`buildQrisHeaders` unit test** (staffreview Critical 2): asserts the returned headers include `api-version: 2022-07-31`. This is the single most regression-prone, silent-failure detail — a dropped header builds clean, renders a QR, and never detects payment. The test fails loudly if the header is absent/wrong.
- **`parseXenditWebhook` unit tests** (pure, no Convex runtime): QRIS `SUCCEEDED` envelope → `{paid:true, matchKey:qr_id, amount, receiptId, source}`; QRIS non-SUCCEEDED → `{paid:false}`; flat FVA callback → `{paid:true, matchKey:callback_virtual_account_id, amount}`; a leftover Invoice-shaped `{id,status:"PAID"}` → `{paid:false}` (assert the old shape is now ignored); unparseable/empty/unknown → `{paid:false, matchKey:null}`.
- **`buildQrisBody` / `buildBcaVaBody`** unit tests: shape + required fields (`type: "DYNAMIC"`, `currency: "IDR"`, `is_closed`, `expected_amount`, `is_single_use`); retry `ref` carries a unique suffix.
- **Webhook handler tests** (existing pattern, rewritten for the new shape): bad/missing token → 401 no mutation; missing-config → 401 (was 500); valid + paid → mutation called once with the right `matchKey` + `paid_amount`; bad JSON → 200 no-op; unmatched key → 200 (mutation no-ops via `_resolveAndConfirm`'s silent drop).
- **`_confirmPaid_internal` amount-mismatch test** (staffreview Improvement 1): `paid_amount !== txn.total` → status flips to `paid` AND `flags & PAYMENT_AMOUNT_MISMATCH` is set; `paid_amount === txn.total` → no mismatch flag. The existing funnel tests (receipt allocation, movement, voucher, idempotent re-fire) stay green (now called with an extra optional arg).
- **`receipt_id`/`payment_source` recorded** test: webhook with `payment_detail` → invoice row carries `receipt_id` + `payment_source`.
- The existing `payments` webhook/handler tests asserting the old flat `{id,status:"PAID"}` shape **will fail and are rewritten** (expected regression).

## ADR updates (staffreview Improvement 6 — cross-document, don't just create 036)

- **New ADR-036** — "Xendit inline QRIS via QR Codes API + BCA via FVA API". Records Decisions A–F.
- Add "superseded/amended by ADR-036" back-references to: **ADR-011** (single surface — superseded), **ADR-014** (cancel-via-API → local supersede — adjusted), **ADR-026** (reconciliation-on-reload → manual-only — amended, Decision F), **strategic-foundations §8** (polling leg retired for these methods — amended, Decision B).
- Update `docs/ADR/README.md` index (new ADR-036 entry).
- Update `CLAUDE.md`: Xendit-integration-notes (Invoice API → QR Codes/FVA), business-rule #5 + §8 polling note, business-rule #18 reconciliation note.
- Update `docs/SCHEMA.md`: new `receipt_id`/`payment_source` columns + `PAYMENT_AMOUNT_MISMATCH` flag + the dual-meaning `xendit_invoice_id` note.
- Update `docs/CHANGELOG.md` in the same PR.

## Out of scope

- Renaming env vars to the reference's `XENDIT_API_KEY` / `XENDIT_WEBHOOK_TOKEN`.
- Switching `actions.ts` off `"use node"`.
- A provider-agnostic `QrisProvider` interface (single provider — YAGNI).
- Live BCA VA verification (Decision C — ships code-complete, verified later).
- Automatic missed-webhook reconciliation for QRIS (Decision F — manual-only for now; revisit via a working Xendit QR-payments endpoint if incidents occur).
- Prod cutover (dev/staging only, per the v0.3 spec).

## Build sequence (waves)

Waves are **SEQUENTIAL** except wave 4 (frontend), which is **PARALLEL** to waves 2–3 (independent of the webhook/polling backend). One commit per wave (see staffreview §8 for messages).

1. **[SEQ] Adapter + QRIS create + schema/flags** — `xendit.ts` (`createQrisCharge`, `buildQrisBody`, `buildQrisHeaders`, `parseXenditWebhook`), additive `receipt_id`/`payment_source` columns, `PAYMENT_AMOUNT_MISMATCH` flag, thin `requestPayment`/`retryWithFreshInvoice` QRIS branch (retry uses a unique `ref`). + `buildQrisHeaders` / `buildQrisBody` / `parseXenditWebhook` unit tests.
2. **[SEQ, after 1] Webhook rewire + amount-mismatch** — `webhook.ts` uses `parseXenditWebhook`; `_onPaidWebhook_internal` threads `paid_amount`/`receipt_id`/`payment_source`; `_confirmPaid_internal` accepts `paid_amount` + flags mismatch; missing-config → 401. + handler + funnel-mismatch + reconciliation-record tests.
3. **[SEQ, after 2] Polling + reconciliation removal** — drop `checkInvoiceStatus`, `_onPaidPolling_internal`, `xenditGet`, the `useXenditPayment` interval, and the `useStartupReconciliation` poll (Decision F). Remove `cancelTransaction`'s `/invoices/{id}/expire!` call (Decision E).
4. **[PARALLEL to 2–3] Frontend QR render** — `qrcode.react`@^4 + charge screen (empty-`qr_string` guard).
5. **[SEQ, after 1] BCA VA wave (partitioned, live-unverified)** — `createBcaVaCharge`, FVA branch in actions, FVA branch of `parseXenditWebhook` (tagged unverified), optional best-effort FVA close on cancel.
6. **[SEQ, last] ADR-036 + cross-doc back-refs + CHANGELOG/SCHEMA/CLAUDE.md updates.**

## Success criteria

- `npm run typecheck` + `npm run build` pass.
- `npx vitest run convex/payments convex/transactions` green (incl. the new `buildQrisHeaders`, `parseXenditWebhook`, amount-mismatch, and reconciliation-record tests).
- **Behavioral (the proof the fix exists):** on the dev deployment with the QR Codes webhook URL configured, a **dashboard "simulate payment"** on a QR created by `requestPayment` writes `pos_transactions.status = "paid"` with a `receipt_number`, a single stock movement, and `receipt_id`/`payment_source` on the invoice row — **with no manual action** — and the charge screen flips to success reactively.
- The webhook-fires verification (above) is a **hard gate** (staffreview Improvement 3): with polling + reconciliation gone, the webhook is the sole automatic confirmation path; shipping without proving it fires means every sale silently falls back to manual override.
- BCA VA: compiles, `buildBcaVaBody` + FVA-parser unit tests green; live detection deferred (Decision C).

## Rollback / deployment

**Deployment order:** (1) `npx convex deploy` the backend (adapter + webhook + schema columns). (2) In the **Xendit dashboard → Settings → Webhooks**, set the **QR Codes** callback URL to `https://<deployment>.convex.site/payments/webhook` and copy the **Verification Token** into `XENDIT_CALLBACK_TOKEN` (`npx convex env set`); for the BCA wave also set the **Virtual Account** callback. (3) Run a dashboard simulate-payment to confirm `api-version` + the webhook fires end-to-end. (4) Deploy the frontend with the correct `VITE_CONVEX_URL`.

**Rollback:** `git revert` restores the Invoice-API code; the additive schema columns are harmless if left (Convex optional fields). **Out-of-band:** the Xendit dashboard webhook URL / event-type config is not under git — a full rollback must also revert the dashboard webhook settings. No data migration to unwind.
