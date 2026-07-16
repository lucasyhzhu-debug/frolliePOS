# SPEC — QRIS paid-callback forwarder (POS → Recipe Master)

**Slug:** `2026-07-16-qris-pos-rm-forwarder`
**Repo (execution):** `FrolliePOS` (prod `savory-zebra-800`)
**Companion (already shipped):** `product_master` / Frollie Pro (prod `decisive-wombat-7`) — Phase 1 hardening merged (`1cdaa942`, CHANGELOG 2.4.2).
**Status:** SPEC → staffreview → plan → staffreview → land.

---

## 1. Problem

One Xendit account is shared by two backends. Xendit's "QR code paid & refunded" webhook is **account-level (one URL)** and is pointed at the POS (`savory-zebra-800.convex.site/payments/webhook`). Recipe Master (Frollie Pro) also creates QRs on this account; when they're paid, Xendit delivers the event to the **POS**, which no-ops on the unknown ref, so Recipe Master orders never auto-reconcile.

Proven dead-end (order `0716-001`, 2026-07-16): Xendit v2 QR API **accepts a per-QR `callback_url` but ignores it for routing**. The paid event still went to the account webhook. Per-QR routing cannot work.

## 2. Goal

Make Recipe Master QR orders auto-reconcile **without** changing the Xendit dashboard webhook and **without** altering POS payment behaviour, by having the POS webhook **forward genuine QR-payment callbacks** to the Recipe Master endpoint, durably.

## 3. Non-goals

- No change to the POS's own payment processing, matching, or its always-200 Xendit contract.
- No change to the Xendit dashboard webhook config.
- No BCA-VA / FVA forwarding (Recipe Master is QRIS-only).
- Not the Xendit sub-account isolation option (tracked separately as the "more robust" alternative to review after this ships).

## 4. Design

### 4.1 Discriminate the event kind — as a PURE ANNOTATION (refund gate — HIGH-2)

`parseXenditWebhook` (`convex/payments/xendit.ts`) returns `{ paid, matchKey, amount, receiptId, paymentSource }` and **deliberately** keys "paid" off `status === "SUCCEEDED"`, NOT off the `event` label. The load-bearing comment at `xendit.ts:150-156` forbids turning this into an event-label gate without live-verifying the label — because a wrong label assumption would silently drop a REAL payment (the costly money-path false-negative). `webhook.ts:52,54` destructure `{ paid, matchKey }` and gate the POS's own `_onPaidWebhook_internal` on `if (paid && matchKey)`.

**CRITICAL CONSTRAINT (staffreview C1):** the `kind` field MUST be a **pure annotation that never alters `paid` / `matchKey` / any existing field**. The existing branches must produce their current values **byte-identical**; `kind` is derived alongside them. This keeps the POS money path literally unchanged and honors the `xendit.ts:150-156` contract. The refund-envelope shape (`event ~ "refund"`) is **not live-verified** — so it may ONLY gate the *forward* decision, never `paid`.

```ts
export type WebhookKind = "qr_payment" | "bca_va" | "refund" | "ignored";
export type WebhookParse = {
  paid: boolean;              // UNCHANGED semantics
  matchKey: string | null;    // UNCHANGED semantics
  kind: WebhookKind;          // NEW — annotation only, never feeds paid/matchKey
  amount?: number;
  receiptId?: string;
  paymentSource?: string;
};
```

`kind` derivation (does NOT reorder or gate the existing paid logic):
- refund detected (`event`/`data.type`/`p.type` contains `"refund"`) → `kind: "refund"`. **`paid`/`matchKey` still computed by the normal branches** (a refund of an already-paid POS txn stays the harmless status-guarded no-op it is today).
- FVA branch matched (`callback_virtual_account_id && event === undefined`) → `kind: "bca_va"`.
- QR SUCCEEDED/COMPLETED branch matched → `kind: "qr_payment"`.
- else → `kind: "ignored"`.

**Forward gate:** enqueue ONLY when `kind === "qr_payment" && matchKey` (staffreview Impr#4 — mirror the POS's own `paid && matchKey` guard so a SUCCEEDED QR envelope missing both ids can't create a null-keyed outbox row). A refund that a false-negative label-check lets through as `qr_payment` is absorbed by RM's Phase-1 refund gate (defense-in-depth, §5).

**Existing-test impact (staffreview Impr#1):** `convex/payments/__tests__/xendit.test.ts` asserts exact shapes via `.toEqual` (5 assertions). Adding the required `kind` field breaks all five — the plan MUST budget updating them, PLUS add a test asserting `paid`/`matchKey` are **exactly as today** for a refund envelope (the C1 invariant), not merely that `kind==="refund"`.

### 4.2 Transactional outbox (durability — HIGH-1, availability — MEDIUM-4)

**Do NOT inline an awaited `fetch` to Recipe Master** (couples the POS's 200-contract to RM availability) and **do NOT fire-and-forget** (Convex drops dangling promises; a lost forward has no Xendit redelivery because the POS already 200'd). Use an outbox:

New table **`pos_qris_forward_outbox`** in `convex/payments/schema.ts` (staffreview Refinement: `pos_` prefix matches every payments-domain table — `pos_xendit_invoices`, `pos_error_reports`, `pos_transactions`). **No root-schema edit** — `convex/schema.ts:36` already spreads `...paymentsTables`, so a table added to `payments/schema.ts` auto-wires.

| field | type | notes |
|---|---|---|
| `raw_payload` | `string` | the exact raw body to re-POST |
| `xendit_qr_id` | `string` | dedup + audit (from `matchKey`) |
| `status` | `"pending" \| "delivered" \| "failed"` | terminal: delivered/failed |
| `attempts` | `number` | incremented per try |
| `last_error` | `optional(string)` | truncated |
| `created_at` | `number` | |
| `next_attempt_at` | `number` | backoff schedule |
| `delivered_at` | `optional(number)` | |

Indexes (staffreview Impr#2): **`by_xendit_qr_id` on `["xendit_qr_id"]`** (the dedup read — without it enqueue degrades to a `.collect()` scan; also makes the read-then-insert dedup OCC-race-safe) AND `by_status_next` on `["status","next_attempt_at"]` (optional future sweeper for due `pending` rows if scheduler state is lost). Not outlet-scoped → the `frollie-internal/index-leads-with-outlet_id` lint (scoped to `OUTLET_SCOPED` tables only, `eslint.config.js:94-118`) does NOT apply. `_enqueueForward_internal`/`_deliverForward` live in `payments/forwarder.ts` (not `public.ts`) → the `idempotency-required` lint (scoped to `public.ts`, `idempotency-required.js:16`) does NOT apply. **Do NOT store the forward secret in the row** (Convex data is dashboard-visible) — re-read from env at send time.

Flow:
1. In `xenditWebhook` (`convex/payments/webhook.ts`), AFTER the existing (unchanged) POS processing at `webhook.ts:54-69` and inside the same try (preserves always-200), if `kind === "qr_payment" && matchKey`, call a new internal mutation `_enqueueForward_internal({ raw_payload, xendit_qr_id })`. It dedups via `by_xendit_qr_id` (if a row for that qr id already exists → return, no duplicate), inserts one `pending` row, and `ctx.scheduler.runAfter(0, internal.payments.forwarder._deliverForward, { id })`. (Pattern proven: `ops/internal.ts:65` schedules an action from an internalMutation, and `webhook.ts:56` already `runMutation`s from the httpAction.) **Residual (staffreview Impr#5):** the enqueue mutation itself runs inline in the httpAction — if it throws (transient Convex), the outer `try/catch` at `webhook.ts:70` reports + still 200s, so that one forward is lost with no Xendit redelivery. The insert is cheap/atomic so the window is small; acknowledged, not mitigated in v1 (the optional `by_status_next` sweeper would be the follow-up).
2. `_deliverForward` (action, **default runtime — NO `"use node"`**; it needs only `fetch` + `process.env`, both in V8; must NOT import xendit.ts's Buffer-using create funcs) reads the row; if not `pending` → return (idempotent). POST `raw_payload` to the RM endpoint with headers `x-callback-token` (re-read from env — the shared Xendit token; POS auth is a static header compare with no body-HMAC, `webhook.ts:18-25`, so re-POSTing the raw body is valid) + `x-frollie-forward-secret` (re-read from `FROLLIE_FORWARD_SECRET`). On `res.ok` → `delivered` + `delivered_at`. On **any non-terminal failure** (RM 5xx / connection / timeout) → `attempts++`, `next_attempt_at` = bounded backoff, reschedule; after `MAX_ATTEMPTS` → `failed` + ops report. A **401** is **terminal** (token/secret misconfig — retry won't help) → `failed` + immediate ops report.
   - **Retry classifier (staffreview Impr#3):** do NOT reuse `cronRetry.ts`'s `isTransientError` — it matches only the substring `"no available workers"` (`cronRetry.ts:50`) and would classify an RM outage as non-transient, i.e. never retry the exact failure the outbox exists to survive. Retry on ANY non-terminal delivery failure up to `MAX_ATTEMPTS`; only the `RESILIENT_MAX_ATTEMPTS`/delay CONSTANTS may be borrowed, and prefer a longer/exponential backoff than the cron's 60s·(n+1) linear (an RM redeploy can exceed 2 min).
   - **Ops report (staffreview Refinement):** `_recordError_internal({ kind: "backend", route: "convex/payments/forwarder", message })` (align the `route` prefix with `webhook.ts:12`'s `"convex/payments/webhook"`). Note it always writes the row but the Telegram alert is dedup + storm-capped (`ops/internal.ts:23-67`) — so "immediate ops report" = row recorded, alert subject to storm-cap.

Idempotency: the RM target is already idempotent (Phase 1 — keyed on `paymentStatus`/status, first-writer-wins), so an over-delivery is safe; the outbox's job is *at-least-once*.

### 4.3 Forward target + secrets (MEDIUM, SSRF)

- Target: **hardcoded `const RM_QR_WEBHOOK = "https://decisive-wombat-7.convex.site/api/xendit/qr-payment"`** — never payload-derived (SSRF-safe).
- Headers: `x-callback-token` = the received/env Xendit token; `x-frollie-forward-secret` = `process.env.FROLLIE_FORWARD_SECRET`. RM's Phase-1 gate requires the forward secret once `FROLLIE_FORWARD_SECRET` is set on `decisive-wombat-7`.
- **INVARIANT (LOW-7):** forwarding is strictly POS → RM. The POS forwarder must never be pointed back, and RM must never forward. Assert in a code comment on both handlers.

### 4.4 Namespace guard (LOW-5)

POS `external_id` is `pos-${txnId}`; RM's is `MMDD-NNN` — disjoint, so a forwarded POS event no-ops on RM and vice-versa. Add a POS unit test pinning the `pos-` prefix so a future ref-format change fails loudly.

## 5. Security requirements → design map (Fable review)

| Finding | Mitigation in this spec |
|---|---|
| HIGH-1 lost payments (fire-and-forget) | §4.2 transactional outbox + scheduler retry + ops alert on failure/401 |
| HIGH-2 refund marked paid | §4.1 refund `kind` gate; only `qr_payment` forwarded |
| MEDIUM-3 forgery via shared token | §4.3 second `x-frollie-forward-secret` (RM Phase-1 gate); token/secret re-read from env, never stored in outbox |
| MEDIUM-4 availability coupling | §4.2 no inline awaited fetch; POS 200 unchanged |
| LOW-5 namespace collision | §4.4 `pos-` prefix test |
| LOW-6 SSRF | §4.3 hardcoded const target |
| LOW-7 loop | §4.3 POS→RM-only invariant comments |

## 6. Edge cases

- **Redelivery from Xendit** (same qr_id twice): enqueue is idempotent on `xendit_qr_id`; if already `delivered`, no re-enqueue.
- **RM down / 5xx**: outbox retries with backoff; POS unaffected.
- **401 from RM** (token/secret mismatch): terminal + ops alert (retry won't fix a misconfig).
- **Refund of an RM order**: not forwarded (kind gate). RM's Phase-1 refund gate is a second line if one ever slips through.
- **BCA VA / FVA payment**: `kind: "bca_va"` → not forwarded.
- **Malformed JSON**: `kind: "ignored"` → not forwarded (POS already 200s).
- **Scheduler loss** (rare): `by_status_next` index allows an optional sweeper cron later; not required for v1 (call out as a follow-up, not built here).

## 7. Test plan (POS-side, vitest + convex-test)

- **Update the 5 existing `xendit.test.ts` `.toEqual` assertions** to include the new `kind` field (they exact-match today and will otherwise fail — staffreview Impr#1).
- `parseXenditWebhook` new cases: genuine `qr.payment` SUCCEEDED → `kind:"qr_payment"`; refund envelope → `kind:"refund"`; BCA VA → `kind:"bca_va"`; junk → `kind:"ignored"`.
- **C1 invariant test (money-path):** a refund envelope leaves `paid` / `matchKey` **byte-identical to today** (NOT merely `kind==="refund"`) — proves `kind` never altered the POS paid path.
- **Forward-gate test:** a SUCCEEDED QR envelope with NO `qr_id`/`id` (→ `matchKey:null`) does NOT enqueue (Impr#4).
- `pos-${txnId}` prefix invariant test (LOW-5 — POS refs disjoint from RM's `MMDD-NNN`; ref lives at `actions.ts:68`).
- `_enqueueForward_internal`: inserts exactly one pending row; a second call with the same `xendit_qr_id` does NOT insert a duplicate (dedup via `by_xendit_qr_id`).
- `_deliverForward`: mocked 200 → `delivered` + `delivered_at`; 500 → `attempts++`, rescheduled, still `pending`; after `MAX_ATTEMPTS` → `failed` + ops report; 401 → `failed` + ops report immediately (terminal, not retried).
- Webhook handler: a `qr_payment` body enqueues; `refund` / `bca_va` / `ignored` / kill-switch-off does NOT enqueue; POS's own `_onPaidWebhook_internal` path stays invoked exactly as before (no regression — anchor against existing `webhook.test.ts`).

## 8. Ops / rollout

1. Generate one shared secret; set **`FROLLIE_FORWARD_SECRET` (same value)** on BOTH prod deployments: `savory-zebra-800` (POS) and `decisive-wombat-7` (RM). Order-safe either way (before the POS deploy nothing forwards; RM rejecting a not-yet-sent forward is a no-op). Recommended: set RM's env first, then POS's, then deploy POS.
2. Deploy POS (`vercel --prod` + Convex deploy for `savory-zebra-800`).
3. **Live smoke test:** create a real ≥Rp 1.500 Recipe Master order → Generate QRIS → pay → confirm it flips to PaymentReceived + "QRIS Paid" row, AND a POS QRIS sale still reconciles on the POS as before. Also reconcile stuck order `0716-001` manually (its event predates the forwarder).
4. Verify no `pos_qris_forward_outbox` rows stuck `pending` after the test (all `delivered`).

### 8.1 Kill-switch + rollback (staffreview §7)

- **Kill-switch:** gate the enqueue on an env flag **`FROLLIE_FORWARD_ENABLED === "true"`** (in addition to `kind`). Flipping it off in prod disables forwarding instantly (no redeploy) with ZERO impact on POS payments — cheaper than reverting a deploy if forwarding misbehaves.
- **Rollback:** the forwarder is purely additive and gated on `kind==="qr_payment" && matchKey && FROLLIE_FORWARD_ENABLED`. Reverting the POS Convex/Vercel deploy removes it entirely; the POS paid path is untouched at every step, so rollback is safe with no data migration.
- **Cross-repo pre-go-live check (not verifiable inside FrolliePOS):** confirm the hardcoded target path `/api/xendit/qr-payment` and the `x-frollie-forward-secret` header name against the shipped RM Phase-1 code (`product_master` `convex/integrations/qris/webhooks.ts`). (Direction is already precedented — this POS exposes `/api/v1/{transactions,refunds}` "Frollie Pro consumer" routes at `http.ts:52-59`.)

## 9. Cross-repo notes

- Code + tests + handoff land in **FrolliePOS**. Planning docs (this spec + the plan) land on **FrolliePOS `main`** (doc-only). RM side is already shipped.
- FrolliePOS `main` currently has unrelated uncommitted work — commit ONLY the new doc files.
- Verify commands: `npm run typecheck` (`tsc -b && tsc -p convex`), `npm run test:convex`. Deploy: `vercel --prod` + Convex deploy for prod.
- Money-path/security: use `opus` for implementation + review subagents.
```
