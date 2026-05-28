# Xendit QRIS Integration — Reference Bundle

> **Source:** Frollie Recipe Master (`product_master`), Phase 84 — a QRIS-via-Xendit
> integration that is **live and webhook-confirmed** (currently on Xendit TEST keys,
> shipping flag-OFF pending Xendit KYB). This bundle exists because FrolliePOS is
> "having issues with the APIs." The short version: **you're calling the wrong Xendit
> API for inline QRIS, and your webhook is matching the wrong status field.**
>
> **Date bundled:** 2026-05-28
> Everything under `reference-impl/` is a **verbatim copy** of working code. It is
> documentation only — none of it is compiled by FrolliePOS (it lives under `docs/`,
> outside both the Convex build and `tsconfig.app.json`'s `include`). Import paths are
> relative to the *source* repo's tree.

---

## TL;DR — why your Xendit calls aren't working

Your current `convex/payments/actions.ts` does:

```ts
// POST /v2/invoices  →  read data.qr_string
const payload = { external_id, amount, payment_methods: ["QRIS"], description };
const { ok, data } = await xenditPost("/v2/invoices", payload, idempotencyKey);
// ...
qr_string: data.qr_string,   // ← almost always undefined
```

Three concrete bugs, in order of impact:

| # | Bug | Symptom | Fix |
|---|-----|---------|-----|
| **1** | **Invoice API doesn't return a `qr_string`.** `POST /v2/invoices` returns a hosted `invoice_url` (a checkout page), not a raw QRIS payload you can render inline. `data.qr_string` is `undefined`. | Blank / missing QR on the Charge screen. | Use the **QR Codes API** — `POST /qr_codes` — which returns `{ id, qr_string }`. See `reference-impl/xendit.ts`. |
| **2** | **Missing `api-version` header.** The QR Codes `qr.payment` webhook event **only fires** if you pin `api-version: 2022-07-31` at QR-creation time. Without it Xendit applies the account default and the paid callback may never arrive. | QR renders (after fix #1) but payment is **never detected** — webhook silent. | Send `"api-version": "2022-07-31"` on the create call. |
| **3** | **Webhook matches the wrong status + shape.** Your `webhook.ts` checks a top-level `body.status === "PAID"` and matches `body.id`. The QR Codes v2 webhook delivers `{ event, data: { status: "SUCCEEDED", qr_id, ... } }` — status is **`SUCCEEDED`** (not `PAID`), nested under `data`, keyed on `qr_id`. | Webhook arrives (200) but does nothing — status check never matches. | Read `payload.data ?? payload`, accept `SUCCEEDED` (and `COMPLETED` as a fallback), match on `data.qr_id ?? data.id`. See `reference-impl/webhooks.ts`. |

**The design fork you have to decide first** (it determines everything else):

- **Inline QRIS** (render the QR yourself, in your POS) → **QR Codes API**. This is what the reference implements and what ADR-011's "QRIS button shows a QR" wording implies.
- **Hosted checkout** (redirect/show Xendit's `invoice_url` page) → **Invoice API**. One surface for QRIS *and* BCA VA, but the customer sees Xendit's page, not your QR.

You cannot get a raw `qr_string` out of the Invoice API. If you want the inline experience (you do — ADR-011), QRIS must go through the QR Codes API. See **[BCA VA note](#bca-va-the-honest-tradeoff)** below for how that interacts with your "single invoice surface" ADR.

---

## The proven working pattern (QR Codes API v2)

### 1. Create the QR — `reference-impl/xendit.ts`

```
POST https://api.xendit.co/qr_codes
Authorization: Basic base64("<API_KEY>:")     ← key as username, EMPTY password
Content-Type:  application/json
api-version:   2022-07-31                       ← REQUIRED (see bug #2)

{ "reference_id": "<your-ref>", "type": "DYNAMIC", "currency": "IDR", "amount": 35000 }
```

Response: `{ "id": "qr_...", "qr_string": "00020101021226...6304XXXX", ... }`

- Render `qr_string` as a QR image (the reference uses `qrcode.react`'s `QRCodeSVG`).
- Store `id` (`qr_...`) — it is **globally unique** and is your webhook match key.
- Xendit's own `expires_at` is unreliable for UX; the reference imposes its **own 30-min
  window** (`QR_EXPIRY_MS`) instead.

### 2. Receive payment — `reference-impl/webhooks.ts`

The **only** paid signal. The QR never reads "paid" on a status poll (spike-confirmed),
so this webhook is mandatory — there is no poll fallback in the reference.

```jsonc
// POST <your-convex-http>/api/xendit/qr-payment
// header: x-callback-token: <XENDIT_WEBHOOK_TOKEN>
{
  "event": "qr.payment",
  "data": {
    "id": "qr_...",            // or "qr_id" — match key
    "qr_id": "qr_...",
    "status": "SUCCEEDED",     // ← NOT "PAID"
    "amount": 35000,
    "reference_id": "<your-ref>",
    "payment_detail": { "receipt_id": "...", "source": "DANA" }  // SINGULAR
  }
}
```

Handler contract (all hard-won — see the inline comments in `webhooks.ts`):

1. **Verify `x-callback-token` first, constant-time.** Missing token *or* missing config
   → **401, no state change**. (A non-2xx is the only thing that makes Xendit redeliver.)
2. **Parse defensively** — a malformed body must not 500. Unwrap `payload.data ?? payload`.
3. **`status === "SUCCEEDED"` (or `"COMPLETED"`)** → record + transition. Anything else → 200 no-op.
4. **Wrap the mutation in try/catch** and still return **200** — an unhandled throw becoming
   a 500 creates a permanent Xendit retry loop.
5. **Unmatchable payload → 200** (it'll never match on retry either; log for manual review).

### 3. The transactional core — `reference-impl/mutations.ts`

`recordPaidAndTransition` is the real-money surface. The non-obvious rules:

- **Payment-durable:** write the payment row `paid` **before** attempting the order
  transition / stock reserve. If the reserve throws, you keep the paid row, revert the
  order status, and flag `needsReview` — you never lose a payment you actually received.
- **Idempotency by status guard, not webhook dedup.** Xendit *legitimately* redelivers.
  If the order is already in the paid state, replay is a no-op.
- **Match on the globally-unique QR id first.** Only fall back to your business ref
  (`reference_id`) if the id misses — and when you do, scope to the *active* row, never a
  blind `.first()` over all history. (In FrolliePOS this is simpler — see adaptation map.)
- **Amount mismatch / superseded QR → honor + flag `needsReview`**, don't reject. The
  customer's money already moved.

### 4. The reactive UX — `reference-impl/QrisChargeDialog.tsx`

The dialog state is **derived from a live Convex subscription**, not local toggles. When
the webhook writes `status: "paid"`, the query re-runs and the dialog flips to "Payment
Received" with **no polling and no manual refresh**. That reactive flip is the whole
point of doing this on Convex — copy the pattern even though FrolliePOS's Charge screen
is a different component.

---

## Side-by-side: your code vs. the working reference

| Concern | FrolliePOS now (`convex/payments/`) | Working reference (Phase 84) |
|---|---|---|
| QRIS create endpoint | `POST /v2/invoices` (Invoice API) | `POST /qr_codes` (QR Codes API) |
| QR payload field read | `data.qr_string` (undefined on Invoice API) | `json.qr_string` (present on QR Codes API) |
| `api-version` header | *(none)* | `2022-07-31` (**required for webhook**) |
| Auth | `Buffer.from("key:").toString("base64")` under `"use node"` | `btoa("key:")` **no** `"use node"` ¹ |
| Webhook paid check | `body.status === "PAID"`, match `body.id` | `data.status === "SUCCEEDED"`, match `data.qr_id ?? data.id` |
| Webhook envelope | flat `{ id, status }` | `{ event, data: {...} }` → read `payload.data ?? payload` |
| Misconfigured token | returns **500** | returns **401** (500 risks a retry storm) ² |
| Payment detection | webhook **+ polling** (`GET /v2/invoices/{id}`) | webhook-only (QR never reads paid on poll) |
| Env var (key) | `XENDIT_SECRET_KEY` | `XENDIT_API_KEY` |
| Env var (webhook) | `XENDIT_CALLBACK_TOKEN` | `XENDIT_WEBHOOK_TOKEN` |

¹ Both work. The reference deliberately avoids `"use node"` because that runtime **drops
`btoa`** (forcing `Buffer`); staying on the default Convex runtime keeps the module
import-safe and `btoa` available. If you keep `"use node"` + `Buffer`, that's fine — just
know why the reference doesn't.

² On a *missing* token config, 500 is arguably OK (it's a deploy error). The reference
returns 401 even then so a *wrong* token and a *missing* config look identical to Xendit
and both self-heal once fixed, without distinguishing timing.

> **What your code already gets right** (keep it — the reference has weaker versions of
> these): action-level idempotency via `X-IDEMPOTENCY-KEY` + a `pos_idempotency` cache
> pre-check, the single-active-invoice + explicit-cancel-on-retry flow (ADR-014), and the
> audit-logged commit. None of that is the problem. The problem is purely *which Xendit
> API* and *which webhook fields*.

---

## Environment variables

Set these on your Convex deployment (`npx convex env set NAME value`, or the dashboard):

| Var | Purpose | Notes |
|---|---|---|
| `XENDIT_API_KEY` | Secret API key for Basic auth | Use the **TEST** key (`xnd_development_...`) until KYB clears, then the live key. Rename from your current `XENDIT_SECRET_KEY` or keep your name — just be consistent. |
| `XENDIT_WEBHOOK_TOKEN` | Verification token for the `x-callback-token` header | Dashboard → **Settings → Webhooks → Verification Token**. Same token across all webhook types. Your current name is `XENDIT_CALLBACK_TOKEN`. |
| `QRIS_ENABLED` | Feature flag (`"true"` to enable) | The reference re-checks this server-side in both the action and the config query (defense-in-depth). Optional for you. |

---

## Webhook setup (the step that's easy to miss)

1. Deploy the HTTP route. In the reference it's registered in `convex/http.ts` as:
   ```ts
   http.route({ path: "/api/xendit/qr-payment", method: "POST", handler: handleXenditQrPayment });
   ```
   FrolliePOS already registers `/payments/webhook` → reuse that path or add the new one.
2. In the **Xendit dashboard → Settings → Webhooks**, set the **QR Codes** callback URL to
   `https://<your-deployment>.convex.site/payments/webhook` (use your real Convex **`.site`**
   HTTP host, not the `.cloud` API host).
3. Copy the **Verification Token** into `XENDIT_WEBHOOK_TOKEN`.
4. **Test it with Xendit Test Mode → simulate payment** on a created QR. This is how the
   reference confirmed `status: "SUCCEEDED"` and the `{ event, data }` envelope live.
   > On TEST keys the `qr_string` is a placeholder and is **not** scannable by a real
   > wallet — that's expected. Use the dashboard "simulate" button to drive the webhook.

---

## Adaptation map — reference (`orders`) → FrolliePOS (`pos_transactions`)

The reference is a **delivery-order** system; FrolliePOS is a **POS**. The Xendit mechanics
are identical — only the surrounding nouns differ.

| Reference concept | FrolliePOS equivalent | Note |
|---|---|---|
| `orders` table, `orderNumber` (MMDD-NNN) | `pos_transactions`, `external_id = pos-${txnId}` | **Your ref is already globally unique** (a Convex id), so you can drop the reference's "externalId resets daily / scope to active row" complexity entirely — match purely on the QR id, with `reference_id` as a clean unique fallback. |
| `qrisPayments` table | your existing `pos_xendit_invoices` | Add a `qr_string` column (populate from the QR Codes response) and store the `qr_codes` `id` in `xendit_invoice_id`. Your `by_xendit_invoice_id` index then *is* the webhook match index — just read `body.data.id`. |
| `createQrisInvoice` action (token + `requireRole`) | your `requestPayment` action | Swap the endpoint to `/qr_codes` + the v2 body + `api-version` header. Keep your session-auth + idempotency-cache pre-check. |
| `recordPaidAndTransition` mutation | your `_onPaidWebhook_internal` → `_confirmPaid_internal` | Your funnel already status-guards (`awaiting_payment → paid`), which is the same idempotency discipline. Just feed it the correctly-parsed `data.id`. |
| `requireRole(ctx, token, [...])` | `getSession(sessionId)` | Different auth model; same intent (authorize before minting). |
| status `AwaitingPayment → PaymentReceived` | `awaiting_payment → paid` | Same transition shape. |
| `QrisChargeDialog.tsx` | your Charge screen | Adopt the **derive-state-from-subscription** pattern; the file itself is order-detail-specific. |

**Minimal change to unblock you** (if you keep the Invoice-API scaffolding for BCA VA):
add a *separate* QRIS path that calls `/qr_codes`, stores the `id` + `qr_string`, and
teach `webhook.ts` to read `body.data?.status === "SUCCEEDED"` + match `body.data?.id`.
Don't rip out your idempotency/audit work — it's good.

---

## BCA VA: the honest tradeoff

Your ADR-011 wants **one invoice surface** for QRIS *and* BCA VA. That's a real tension
with the QR Codes API, which is QRIS-only. Three honest options:

1. **QR Codes API for QRIS + Invoice/VA API for BCA VA** (two surfaces, two webhook event
   types: `qr.payment` and `virtual_account.payment`). You get inline QRIS *and* a VA
   number. Costs you the "single surface" simplicity ADR-011 wanted. **Recommended** if
   inline QRIS UX matters (it does for a booth).
2. **Invoice API for both** (one surface) → accept a **hosted `invoice_url`** page instead
   of an inline QR. Simplest integration, worst booth UX (staff/customer leave your screen).
3. **Invoice API for both, render the QR from the hosted page's QR** — not supported; the
   Invoice API doesn't hand you the raw `qr_string`.

This reference only covers **QRIS via the QR Codes API** (option 1's QRIS half), because
that's what's proven in production. The VA half is the same Xendit account, a different
endpoint, and a `virtual_account.payment` webhook event — straightforward once QRIS works.
Revisit ADR-011/ADR-014 with this constraint in mind; their "single invoice" assumption
predates knowing the Invoice API can't feed an inline QR.

---

## File index

```
docs/xendit-reference/
├── README.md                       ← this file (start here — diagnosis + working pattern)
├── qris-protocol-research.md       Protocol background: EMVCo TLV, NMID, MPM vs CPM, dynamic vs static ¹
└── reference-impl/                 ← verbatim working code (NOT compiled)
    ├── provider.ts                 Provider-agnostic interface (swap aggregators later)
    ├── xendit.ts                   QR Codes API adapter — the create call + auth + api-version
    ├── webhooks.ts                 httpAction + constant-time token verify + SUCCEEDED parse
    ├── mutations.ts                Payment-durable, idempotent paid-transition core
    ├── queries.ts                  order_staff-safe subscription + config (auth alignment)
    ├── actions.ts                  createQrisInvoice — auth-gated mint, supersede-on-regenerate
    ├── schema-snippet.ts           qrisPayments table + businessSettings.qrisNmid
    └── QrisChargeDialog.tsx        Reactive "waiting → paid" UX, derived from subscription
```

¹ `qris-protocol-research.md` is the source repo's pre-implementation research. Read its
**§1, §2, §4** for the aggregator-agnostic fundamentals (TLV payload, NMID, dynamic vs
static QR). **Skip / discount §3** — it documents a *poll-based* aggregator (qris.online /
InterActive) that was **not** chosen; the shipped integration is Xendit's webhook-based QR
Codes API as described in this README. The doc's own header banner flags this too.
