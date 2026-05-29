# Staff Review: `feat/v0.3-sale-xendit` — Xendit dedicated-API fix

**Date:** 2026-05-29
**Branch:** `feat/v0.3-sale-xendit` (`baffdfd`..`4d64217`)
**Lens:** Deep-module / surface-API discipline (ADR-034) + plan-to-implementation fidelity
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan reviewed against:** `docs/superpowers/plans/2026-05-28-xendit-dedicated-apis.md`

---

## 1. Summary

**Module-depth verdict: the change made the affected modules DEEPER.** A genuinely deep adapter (`convex/payments/xendit.ts`) now absorbs every Xendit protocol detail — endpoints, the load-bearing `api-version` header, Basic auth, both request-body shapes, response field-mapping, and the two distinct webhook envelopes — behind a four-function surface (`createQrisCharge`, `createBcaVaCharge`, `parseXenditWebhook`, + three pure `build*` helpers). The two callers that previously hand-rolled this protocol (`actions.ts`, `webhook.ts`) shrank to thin orchestration: `actions.ts` lost 149→shrunk, `webhook.ts` went from validating-a-flat-shape to a 49-line token-verify + delegate + funnel. Net: complexity moved *into* one module and *out of* its consumers — the textbook ADR-034 win. The deletion of the polling runtime (the `checkInvoiceStatus` action, `xenditGet`/`xenditPost`/`readJson` helpers, `_onPaidPolling_internal`, the reconciliation poll) removed ~828 lines while the new functionality landed in ~735 — the codebase is smaller *and* more correct.

**Overall assessment: APPROVE.** All 6 plan tasks were executed faithfully and every prior-review Critical/Improvement is addressed in code. Backend tests (63), hook tests (40), `tsc --noEmit`, and `npm run build` all green at HEAD. The one item the change *cannot* close — confirming the live BCA FVA callback shape — is correctly and explicitly partitioned as live-unverified (Decision C), not silently shipped as done. No Critical or Important issues. A few Minor/Nitpick observations below, none blocking.

The architectural seam is well-positioned for the v1.1 Frollie Pro graft: `receipt_id` (bank RRN) is captured as the future settlement join key and lives on the payments-owned `pos_xendit_invoices` row — never leaking into the transactions schema or the API surface contract. A provider swap or settlement sync stays behind the adapter boundary.

---

## 2. Critical Issues (Must Fix)

**None.**

The two Critical issues from the prior design review are both resolved in code:
- **Design-review Critical 1 (polling orphans + ADR-026 defeated):** `useStartupReconciliation.ts` is gutted to a no-op shell (option a — explicit downgrade), `checkInvoiceStatus`/`xenditGet`/`_onPaidPolling_internal` are deleted *with* their consumers in one green commit (`bf46df6`), and ADR-026 carries the back-reference + ADR-036 documents the downgrade. Verified: no `checkInvoiceStatus`/`xenditGet`/`_onPaidPolling` symbols remain anywhere in `convex/`.
- **Design-review Critical 2 (`api-version` untested):** `buildQrisHeaders()` is extracted as a pure function and `xendit.test.ts:14` asserts `api-version === "2022-07-31"`; `actions.test.ts:79` asserts it again at the action/HTTP level. A future edit that drops the header now fails two tests loudly.

The plan-review Critical 1 (Task 3 non-green intermediate commit) is also resolved — the commit sequence (`1136500`→`4d64217`) shows the `checkInvoiceStatus` deletion landed in the webhook commit (`bf46df6`) alongside the hook consumers, exactly the prescribed resequence.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | The amount-mismatch flag is set but nothing surfaces it operationally yet | M | M (future phase) |
| 2 | Webhook is now the SOLE automatic path — the deploy-time "webhook fires" gate is a manual checklist item, not enforced | M | L |

### Improvement 1: `PAYMENT_AMOUNT_MISMATCH` is captured but has no read-side surface

`_confirmPaid_internal` correctly honors-and-flags (step 5b: `flags |= PAYMENT_AMOUNT_MISMATCH` when `paid_amount !== txn.total`), and it is tested end-to-end through the webhook (`webhook.test.ts:108`). This is the right design for a money path — never reject money that already moved, flag it for a human. But the flag is write-only today: no manager dashboard, daily summary, or query reads `flags & PAYMENT_AMOUNT_MISMATCH`. ADR-036's own consequence note ("daily dashboard surfaces manual-override counts") implies a surveillance surface that does not exist yet.

This is **not a defect in this change** — the flag's read-side belongs to a later reporting phase (v0.5 dashboard). Recommendation: ensure the v0.5 dashboard backlog explicitly lists "surface `PAYMENT_AMOUNT_MISMATCH` + manual-override counts" so the flag does not become silent dead metadata. The bit is cheap insurance; the risk is forgetting to ever look at it.

### Improvement 2: The single-point-of-failure (webhook) has no automated liveness signal

With polling and reconciliation retired (Decisions B/F), the webhook is the only automatic confirmation path. The plan's Task 4 Step 9 makes "dashboard simulate-payment writes paid end-to-end" a hard *manual* gate, and the rollback note flags the out-of-band Xendit dashboard webhook-URL config. That is correct and honest. But operationally, a dashboard webhook misconfiguration (or a Convex deployment whose `.site` URL drifted) degrades every sale to manual override, possibly unnoticed for a shift.

This is an accepted, documented trade (ADR-036 §Consequences: "webhook reliability is the primary investment"). Recommendation for a future phase: a lightweight liveness signal — e.g., the daily founders summary already exists (ADR-033); add a "X% of today's sales auto-confirmed via webhook vs manual" line so a dead webhook shows up as an anomalous manual-override spike the same day. No action required on this branch.

---

## 4. Refinements (Optional / Nitpick)

- **`getCurrentInvoice` now returns `receipt_id` + `payment_source` to the client.** The reactive query returns the whole `pos_xendit_invoices` row, so the bank RRN and paying wallet reach the charge screen. The plan review already flagged this as acceptable (staff-only POS, payer RRN/wallet are not customer PII). Confirmed acceptable — but worth a one-line note in `PUBLIC_API.md` when that doc lands, so these never accidentally bleed into the external Frollie Pro surface (the API surface uses `toApiShape()` translation per ADR-034 L2, so the boundary is structurally protected — this is belt-and-suspenders).

- **`crypto.randomUUID()` in the `"use node"` retry path.** `retryWithFreshInvoice` uses `crypto.randomUUID()` for the unique ref suffix; this is globally available in Convex's node runtime and the build/typecheck confirm it resolves. Fine. (Noted only because the prior design review raised btoa/Buffer runtime traps — this one is clean.)

- **The "COMPLETED" status fallback in `parseXenditWebhook`** (`xendit.ts:148`) is a defensive Invoice-API leftover; QR Codes v2 only emits `SUCCEEDED`. It is correctly commented as a defensive fallback and costs nothing. Keep.

- **Permissive QRIS parse is the right call and is well-defended.** `parseXenditWebhook` intentionally keys paid-detection off `data.status === "SUCCEEDED"` rather than gating on `event === "qr.payment"`. The inline comment (`xendit.ts:139-144`) explains the asymmetry correctly: a false negative (dropping a real payment) is the costly money-path failure; a false positive (a non-qr.payment envelope carrying `SUCCEEDED` to this endpoint) is near-impossible. This is a deliberate, documented trade, not a sloppy parser. Do not "harden" it into an event-label gate without live-verifying the label — the comment says exactly this.

- **`_confirmPaid_internal`'s `source` union still carries `"polling"`** (`internal.ts:138`). This is intentional per the plan's CRITICAL note 3 — the runtime is gone but the enum label is kept for an existing idempotent-refire test and a possible future working-endpoint reconciliation. Removing it would be churn. The funnel docstring (`internal.ts:114`) still says "webhook, polling, manual" — mildly stale prose now that polling has no live caller, but harmless and arguably accurate (the label still routes). Leave it.

- **`flags` accumulation order in the funnel is correct.** NEG_STOCK re-check (step 5) → PAYMENT_AMOUNT_MISMATCH (step 5b) → VOUCHER_OVER_REDEEMED (step 6) → single `patch(..., { flags })` (step 7). All three bits OR into one local and commit atomically. No clobbering. Good.

---

## 5. Deep-Module Discipline Assessment (ADR-034 — the core lens)

**Is `xendit.ts` genuinely deep?** Yes. The interface-to-implementation ratio is favourable: ~6 exported names hide endpoint URLs, the api-version regression trap, Basic-auth construction, two request body schemas, two response field-mappings, and a two-envelope discriminating parser. A caller never sees a Xendit URL, header, or raw response field. The module has no top-level side effects (env/fetch/Buffer referenced only inside function bodies), which is what lets the default-runtime webhook import it without a `"use node"` directive — a subtle but correct runtime-boundary decision carried faithfully from the plan's CRITICAL note 1.

**Is too much exported?** The three `build*` helpers (`buildQrisHeaders`/`buildQrisBody`/`buildBcaVaBody`) are exported only for unit tests. This is the classic "expose internals for testability" tension. **Verdict: justified, not a leak.** The `api-version` header is the single most silent-failure-prone detail in the whole integration; making it independently assertable as a pure function is worth the slightly-wider surface. No production caller imports the `build*` helpers — only `xendit.test.ts` does (verified). The exports are test seams, not consumer API. An alternative (injectable `fetch`) would have been more "encapsulated" but heavier; the pure-builder approach is the pragmatic right call for v1.

**Did the callers genuinely get thinner?** Yes, measurably. `actions.ts` `requestPayment`/`retryWithFreshInvoice` are now: cache pre-check → session auth → resolve txn → `createXxxCharge(...)` → commit funnel. `webhook.ts` is: token-verify → `parseXenditWebhook(raw)` → `_onPaidWebhook_internal` (wrapped so a throw can't 500). Neither references a Xendit protocol detail. Complexity moved into the deep module; the callers are orchestration shells. This is the depth increase.

**Information leakage upward?** Minimal and clean. `ChargeResult` (`{ providerId, qrString?, vaNumber?, statusAtCreate }`) and `WebhookParse` (`{ paid, matchKey, amount?, receiptId?, source? }`) are *provider-neutral* abstractions — they do not echo Xendit's wire shapes (no `qr_id`, no `callback_virtual_account_id`, no nested `data.payment_detail`). The dual-meaning `xendit_invoice_id` column stores the provider id generically and is documented (schema comment + SCHEMA.md §238). A second payment provider could produce the same `ChargeResult`/`WebhookParse` without touching any caller. That is the abstraction working.

**Cross-module coupling.** Within sanctioned bounds:
- `webhook.ts` (payments) imports `xendit.ts` (payments) — intra-module, fine.
- `payments/internal.ts` `_resolveAndConfirm` reaches into `transactions` only via `internal.transactions.internal._confirmPaid_internal` (the sanctioned funnel) and `_setCurrentInvoice_internal` (the owning-module pointer-patch). It never `ctx.db`-writes `pos_transactions` directly — the active-invoice pointer goes through `transactions._setCurrentInvoice_internal`, correctly documented as the ADR-034 cross-module write boundary. No reach-around.
- The webhook's paid path patches `receipt_id`/`payment_source` on the *payments-owned* invoice row directly (correct — payments owns `pos_xendit_invoices`) and routes the txn confirm through the funnel. Boundary respected.

---

## 6. Graft Integrity (Frollie Pro independence)

The new columns do **not** lock in anything that complicates the v1.1 cross-deployment integration:

- `receipt_id` is described as "Frollie Pro settlement join key" but lives on the POS-internal `pos_xendit_invoices` table, not on a shared schema and not on the API surface. When the v1.1 settlement sync materialises, it reads this through the versioned `convex/api/v1/` HTTP surface with a `toApiShape()` translation (ADR-034 L2) — the internal column name is free to change. The string is a *bank-issued* RRN, inherently stable and provider-meaningful, so it is a sound durable join key regardless of POS internals.
- `payment_source` (DANA/OVO/BCA) is descriptive metadata, not a contract. Free to evolve.
- The adapter is exactly the right seam for a future provider swap or settlement-report pull: provider detail terminates at `xendit.ts`; everything above it speaks `ChargeResult`/`WebhookParse`. A Frollie Pro settlement reconciliation feature would consume the captured `receipt_id` via the API surface, not by reaching into Xendit's shapes.

No graft risk introduced. If anything, capturing the RRN now *improves* graft readiness versus the original "no schema change" stance.

---

## 7. Plan Fidelity

All 6 tasks honoured, with the prior reviews' conditions met:

| Task | Intent | Status |
|------|--------|--------|
| 1 Adapter + pure tests | Deep adapter, `api-version` regression test | Done (`1136500`, `9048a14`). 8 pure cases green. Permissive-parse rationale added as a defensive comment (exceeds plan). |
| 2 Schema + flag + funnel | Additive `receipt_id`/`payment_source`, `PAYMENT_AMOUNT_MISMATCH`, `paid_amount` arg | Done (`4ff7570`). Schema additive-only; funnel honor-and-flag; funnel tests green. |
| 3 Thin `requestPayment` both methods | QR Codes + FVA via adapter | Done (`016f67a`, `e8dbfc3`). All `requestPayment` tests updated (QRIS, BCA→FVA, dedup, 4xx for *both* methods, session-invalid). |
| 4 Webhook + retire polling/recon | Rewrite parse, 401-on-missing-config, always-200, delete polling surface + consumers together, remove cancel `expire!` | Done (`bf46df6`, `7cdd51a`). End-to-end amount-mismatch-thread test present. `cancelTransaction` test rewritten to assert no Xendit HTTP + no spurious audit row. |
| 5a QR render | `qrcode.react`@^4 + `<QRCodeSVG>` with empty-payload guard | Done (`5f44381`, `90442dd`). Added a11y `role="img"` label (exceeds plan). |
| 5b Thin retry | Adapter + unique ref + local supersede + delete residual helpers | Done (`8a5b113`, `b84d2ec`). Retry test asserts unique `-r-` ref, no `expire`, local supersede via `replaced_by_invoice_id`. |
| 6 Docs | ADR-036 + back-refs on 011/014/026/§8 + README/CHANGELOG/SCHEMA/CLAUDE | Done (`4011232`, `4d64217`). All four back-references verified present. |

**Scope creep / shortcuts:** None negative. The extra commits (`9048a14`, `e8dbfc3`, `7cdd51a`, `b84d2ec`, `90442dd`, `4d64217`) are tightening (more test coverage, error-level logging on the webhook commit-failure guard, a11y label, a stale-comment doc fix) — all in the spirit of the prior reviews' Improvements, none expanding scope. The prior-review Improvements (amount-mismatch, RRN capture, deploy gate, FVA-unverified tag, retry-ref uniqueness, ADR cross-refs, `qrcode.react`@^4) are each traceable to code.

---

## 8. Architectural Risks

- **Webhook as sole automatic path.** Resilient *enough* for v1 given: (a) the funnel is idempotent + amount-guarded, so duplicate/late/stale-QR webhooks are safe; (b) manual override is a real, tested fallback; (c) the dashboard simulate-payment is a mandatory deploy gate. The residual risk (silent dead webhook for a shift) is documented and accepted — see Improvement 2 for a cheap future liveness signal. Not fragile by construction; fragile only to *operational* misconfiguration, which the deploy gate targets.
- **Reconciliation no-op shell.** `useStartupReconciliation` reduced to an empty body that still takes its `sessionId` param and keeps its `RootLayout` mount point + ADR-026 docstring. This is a clean re-introduction seam, not dead weight — a future working-endpoint reconciliation drops straight in without re-threading the mount. The `by_line_and_sku` movement-dedup index (ADR-026) still guards any future second confirmation path. Correct downgrade.
- **Real-time correctness on the charge screen.** With polling gone, the reactive `useQuery(getById)` flipping `txn.status` to `"paid"` is the only thing that drives `computePhase` → `{kind:"paid"}` → success navigation. This is sound: Convex reactive subscriptions are the canonical mechanism, the webhook writes `status: "paid"` inside the funnel transaction, and the subscription re-fires on commit. The `computePhase` helper is pure and unit-tested. Stale-QR retry is handled because the superseded invoice row keeps its `xendit_invoice_id`, so a late payment on it still resolves via `by_xendit_invoice_id` → same txn → idempotent funnel.

---

## 9. Over/Under-Engineering

- **Honor-and-flag mismatch design:** appropriately simple, not hiding a problem. It is the correct money-path discipline (never reject moved money; flag for a human). DYNAMIC QR + `is_closed` FVA make a mismatch genuinely unlikely, so this is a defensive net, not load-bearing logic. The only gap is the missing read-side surface (Improvement 1) — future phase.
- **No over-abstraction.** The adapter is the *minimum* earned interface — no speculative provider-registry, no strategy pattern, no premature multi-provider plumbing. Exactly right for v1 with one provider.
- **No quick hacks eroding depth.** The local-supersede-on-retry (Decision E) is the simplest correct semantics now that QR codes have no remote expire, and it is safe by the funnel's idempotency. The webhook always-200 + 401-on-missing-config is the minimal correct contract for an at-least-once delivery channel.

---

## 10. Verification Performed

- `npx vitest run convex/payments convex/transactions` → **63 passed** (12 files).
- `npx vitest run src/hooks` → **40 passed** (incl. `useXenditPayment` 9, `useStartupReconciliation` 3).
- `npx tsc --noEmit` → clean.
- `npm run build` → built, PWA precache generated.
- Grep confirms zero residual `xenditGet`/`xenditPost`/`readJson`/`checkInvoiceStatus`/`_onPaidPolling` symbols (only comments/test-names referencing the removed `expire!`).
- All four ADR back-references (011/014/026/§8) verified present; SCHEMA.md documents the new columns + flag + dual-meaning id.

Not performed (out of scope for a static review, and correctly deferred by Decision C): live Xendit dashboard simulate-payment for QRIS and the BCA FVA callback-shape confirmation. These are the documented manual deploy gates.

---

## 11. Approval

**APPROVE — no blocking conditions.**

Carry forward to a future phase (not this branch):
1. Read-side surface for `PAYMENT_AMOUNT_MISMATCH` + manual-override counts (Improvement 1).
2. Webhook liveness signal in the daily summary (Improvement 2).
3. The one genuinely-deferred live check: BCA FVA `createBcaVaCharge` + the `event === undefined` discriminator in `parseXenditWebhook` against a real simulated callback before BCA is declared done (Decision C — already tracked).

---

*Generated by /staffreview*
