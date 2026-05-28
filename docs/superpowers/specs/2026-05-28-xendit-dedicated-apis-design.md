# Xendit dedicated-API integration (inline QRIS + BCA VA) — Design Spec

> **Status:** Draft — awaiting user review
> **Date:** 2026-05-28
> **Phase:** v0.3 (bug-fix / unblock — payments path was non-functional)
> **Preceded by:** [v0.3 sale + Xendit design](./2026-05-27-v0.3-sale-xendit-design.md) (the integration this fix corrects)
> **Diagnostic source:** [`docs/xendit-reference/`](../../xendit-reference/) — a verbatim working QRIS integration from `product_master` (Recipe Master) Phase 84, live + webhook-confirmed on Xendit TEST keys.
> **Brainstorm record:** Captures decisions from the 2026-05-28 brainstorming session. Key decisions: (A) dedicated Xendit APIs with inline rendering — QR Codes API for QRIS, Virtual Accounts (FVA) API for BCA VA — chosen over hosted-invoice redirect; (B) polling leg retired for these methods (webhook + manual override remain); (C) BCA VA partitioned as code-complete-but-live-unverified; (D) Xendit protocol isolated behind a deep adapter module per ADR-034. Rationale per decision below.

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

This **supersedes ADR-011's** "single invoice surface for QRIS + BCA VA" and **adjusts ADR-014** (see Decision E). Captured in new **ADR-036**.

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
- **Cancel** (`transactions.actions.cancelTransaction`): drop the best-effort `expire!`. For BCA VA, an optional best-effort FVA close lives in the (unverified) BCA wave. The "paid after cancel" alert path already exists in `_confirmPaid_internal`.

### Non-decisions (kept deliberately)

- **Env vars unchanged**: keep `XENDIT_SECRET_KEY` + `XENDIT_CALLBACK_TOKEN` (the reference's renames are optional; skipping them avoids a deployment env migration).
- **Runtime**: `actions.ts` stays `"use node"` (the manual-override path needs argon2 via `verifyPinOrThrow`). The adapter is runtime-agnostic (`btoa`, no top-level side effects) so the default-runtime webhook can import its pure parser.
- **No schema change** (see below).

## Architecture

### Module shape (per ADR-034 — deep adapter, thin handlers)

```
convex/payments/                # owns pos_xendit_invoices
  xendit.ts        # NEW — deep adapter. Narrow surface; hides ALL Xendit protocol.
                   #   createQrisCharge(ref, amount, idemKey) -> { providerId, qrString }
                   #   createBcaVaCharge(ref, amount, idemKey) -> { providerId, vaNumber }
                   #   parseXenditWebhook(rawBody) -> { paid: boolean; matchKey: string | null }
                   #   buildQrisBody(ref, amount) / buildBcaVaBody(ref, amount)  (pure — exported for tests)
                   #   Runtime-agnostic: btoa auth, no top-level fetch/env/side effects.
  actions.ts       # THIN — auth + idempotency pre-check + adapter call + commit.
                   #   requestPayment, retryWithFreshInvoice, manuallyConfirmPayment.
                   #   checkInvoiceStatus + xenditGet REMOVED (polling retired).
  webhook.ts       # THIN — constant-time token verify + parseXenditWebhook + _onPaidWebhook_internal.
                   #   No knowledge of the two event shapes (lives in the adapter).
  internal.ts      # _persistInvoiceCommit / _replaceInvoiceCommit / _onPaidWebhook /
                   #   _onPaidManual.  _onPaidPolling REMOVED.
  public.ts        # getCurrentInvoice (unchanged — reactive sub for charge screen).
  schema.ts        # UNCHANGED.
```

Cross-module discipline (already honored, preserved): the active-invoice pointer is patched via `transactions._setCurrentInvoice_internal`; payment confirmation funnels through `transactions._confirmPaid_internal`; audit via `audit.logAudit`. No cross-module table access introduced.

### The deep adapter surface (`convex/payments/xendit.ts`)

Why deep: the action calls `createQrisCharge(ref, amount, idemKey)` and gets back `{ providerId, qrString }`. It never sees `https://api.xendit.co/qr_codes`, the `api-version` header, the auth scheme, or the response JSON shape. The webhook calls `parseXenditWebhook(body)` and gets `{ paid, matchKey }`; it never learns there are two event envelopes. All Xendit-specific complexity is behind these calls.

- **`createQrisCharge`**: `POST /qr_codes`, headers include `api-version: 2022-07-31`; body `{ reference_id: "pos-<txnId>", external_id: "pos-<txnId>", type: "DYNAMIC", currency: "IDR", amount }`. Returns `{ providerId: json.id, qrString: json.qr_string }`.
- **`createBcaVaCharge`** *(BCA wave)*: `POST /callback_virtual_accounts`; body `{ external_id: "pos-<txnId>", bank_code: "BCA", name: "Frollie POS", expected_amount: amount, is_closed: true, is_single_use: true }`. Returns `{ providerId: json.id, vaNumber: json.account_number }`. `is_closed` + `expected_amount` enforce exact-amount; `is_single_use` blocks double-pay.
- **`parseXenditWebhook`** (pure, unit-testable): discriminates two shapes —
  - QRIS: `body.event === "qr.payment"` (payload at `body.data`); `paid = data.status === "SUCCEEDED" || "COMPLETED"`; `matchKey = data.qr_id ?? data.id`.
  - BCA VA: flat FVA callback (`body.callback_virtual_account_id` present, no `event`); `paid = true` (callback arrival = paid); `matchKey = body.callback_virtual_account_id`.
  - Unrecognised / unparseable → `{ paid: false, matchKey: null }`.
- Auth uses `btoa(\`${XENDIT_SECRET_KEY}:\`)` (key as username, empty password). Reads env **inside** functions, never at module top level.

### Webhook handler flow (`webhook.ts`)

1. Verify `x-callback-token` via the existing constant-time compare against `XENDIT_CALLBACK_TOKEN`. Missing config or mismatch → **401, no state change** (the only response that correctly forces a Xendit redelivery while self-healing on fix). *Behavior change:* the current handler returns `500` when the config is missing; align it to `401` so a missing-config and a wrong-token look identical to Xendit and both self-heal once fixed (per the diagnostic).
2. `const { paid, matchKey } = parseXenditWebhook(await request.text())`.
3. If `paid && matchKey`: `await ctx.runMutation(internal.payments.internal._onPaidWebhook_internal, { xendit_invoice_id: matchKey })`, wrapped in try/catch.
4. **Always return 200** for paid/no-match/unparseable/caught-error (a non-2xx on an unmatchable or post-record-error payload creates a permanent Xendit retry loop). Bad JSON → 200 no-op (was 400 — changed, since a malformed body never parses on retry).

`_onPaidWebhook_internal` → `_resolveAndConfirm` resolves `matchKey` against the `by_xendit_invoice_id` index → `_confirmPaid_internal({ source: "webhook" })`. Unchanged except it now receives a correctly-parsed key.

### Schema — no change

`pos_xendit_invoices` already has `xendit_invoice_id` (+ `by_xendit_invoice_id` index), `qr_string`, and `va_number`. The QR Codes `id` and the FVA `id` both store in `xendit_invoice_id`; that index *is* the webhook match index. `qr_string` ← QR payload; `va_number` ← FVA `account_number`. No migration.

### Frontend (`src/routes/sale/charge.tsx`, `src/hooks/useXenditPayment.ts`)

- Add **`qrcode.react`**; render `<QRCodeSVG value={invoice.qr_string} />` in the QRIS tab, replacing the raw-string `<code>` dump (unusable at a booth). On TEST keys the payload is not wallet-scannable — verify via the dashboard "simulate payment" button.
- `useXenditPayment`: remove the polling interval/timeout and the `checkInvoiceStatus` action call. Keep the reactive `getById` + `getCurrentInvoice` subscriptions and `computePhase` (the "paid" flip is driven by the webhook write, reactively). The 60 s wall-clock ceiling timer (route-owned) and the three ceiling CTAs (Retry / Manager override / Cancel) stay — they are the manual-fallback surface.

## Testing (CLAUDE.md rule 7 — money paths require tests)

- **`parseXenditWebhook` unit tests** (pure, no Convex runtime): QRIS `SUCCEEDED` envelope → `{paid:true, matchKey:qr_id}`; QRIS non-SUCCEEDED → `{paid:false}`; flat FVA callback → `{paid:true, matchKey:callback_virtual_account_id}`; unparseable/empty/unknown → `{paid:false, matchKey:null}`.
- **`buildQrisBody` / `buildBcaVaBody`** unit tests: shape + required fields (`type: "DYNAMIC"`, `currency: "IDR"`, `is_closed`, `expected_amount`, `is_single_use`).
- **Webhook handler tests** (existing pattern): bad/missing token → 401 no mutation; valid + paid → mutation called once with the right `matchKey`; bad JSON → 200 no-op; unmatched key → 200 (mutation no-ops via `_resolveAndConfirm`'s silent drop).
- The `_confirmPaid_internal` funnel tests are unchanged and continue to pass (the fix doesn't touch the funnel).

## ADR updates

- **New ADR-036** — "Xendit inline QRIS via QR Codes API + BCA via FVA API". Records Decision A; **supersedes ADR-011** (single surface), **adjusts ADR-014** (local supersede vs API cancel — Decision E), **amends strategic-foundations §8** (polling leg retired for these methods — Decision B).
- Update `docs/CHANGELOG.md` in the same PR.
- `docs/SCHEMA.md`: no schema change, but note the dual use of `xendit_invoice_id` (QR id / FVA id) if it aids future readers.

## Out of scope

- Renaming env vars to the reference's `XENDIT_API_KEY` / `XENDIT_WEBHOOK_TOKEN`.
- Switching `actions.ts` off `"use node"`.
- A provider-agnostic `QrisProvider` interface (single provider — YAGNI).
- Live BCA VA verification (Decision C — ships code-complete, verified later).
- Prod cutover (dev/staging only, per the v0.3 spec).

## Build sequence (waves)

1. **Adapter + QRIS create** — `xendit.ts` (`createQrisCharge`, `buildQrisBody`, `parseXenditWebhook`), thin `requestPayment`/`retryWithFreshInvoice` QRIS branch. + unit tests.
2. **Webhook rewire** — `webhook.ts` uses `parseXenditWebhook`; `_onPaidWebhook_internal` fed `matchKey`. + handler tests.
3. **Polling removal** — drop `checkInvoiceStatus`, `_onPaidPolling_internal`, `xenditGet`, and the `useXenditPayment` interval.
4. **Frontend QR render** — `qrcode.react` + charge screen.
5. **BCA VA wave (partitioned, live-unverified)** — `createBcaVaCharge`, FVA branch in actions, FVA discrimination already in `parseXenditWebhook`, optional best-effort FVA close on cancel.
6. **ADR-036 + CHANGELOG + cancel-path `expire!` removal.**
