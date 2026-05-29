# Staff Review: Xendit dedicated-API integration (inline QRIS + BCA VA)

**Date:** 2026-05-28
**Plan:** `docs/superpowers/specs/2026-05-28-xendit-dedicated-apis-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Sections added — see §0

---

## 0. Plan Structure Additions

The spec is strong on Goal, Decisions, Architecture, File Changes (module shape + touch-points), Testing, and an ordered Build sequence. Two required sections were missing and are added here:

- **Success Criteria** (added): typecheck + `npm run build` pass; `npx vitest run convex/payments` green; **a QRIS payment detected end-to-end via the Xendit dashboard "simulate payment" button writes `pos_transactions.status = "paid"` with no manual action** (this is the single behavioral proof the whole fix exists for); the charge screen flips to success reactively. BCA VA: code compiles + parser unit tests green (live detection deferred per Decision C).
- **Rollback / Deployment** (added): see §8. The spec has no deployment-ordering or revert note, and this change has an out-of-band step (Xendit dashboard webhook URL) that a pure `git revert` does not undo.

Build-sequence waves are listed but not marked PARALLEL/SEQUENTIAL (they are sequential with one parallelizable pair — noted in §6).

## 1. Summary

**Overall Assessment: Revise**

The core design is sound and correctly diagnosed: switch QRIS to the QR Codes API, switch BCA VA to the FVA API, fix the webhook shape, isolate the protocol behind a deep adapter. The module shape honors ADR-034 well and the "keep the funnel/idempotency/audit" instinct is right. **Two Critical gaps block approval:** (1) the spec retires the polling action but never addresses `useStartupReconciliation` / ADR-026, which both *consumes* that action and is *architecturally defeated* by the API switch; (2) the `api-version` header — the single most load-bearing, silent-failure-prone detail in the whole fix — has no test. Both are closable without reshaping the design.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Polling removal orphans + ADR-026 reconciliation-on-reload is defeated by the API switch | Logic / Architecture | Decision B, wave 3 |
| 2 | `api-version: 2022-07-31` header has no test — a silent regression kills all payment detection | Testing | §Testing |

### Issue 1: Polling removal breaks `useStartupReconciliation` (ADR-026)

Decision B / wave 3 says to remove `checkInvoiceStatus`, `_onPaidPolling_internal`, and `xenditGet`. But `checkInvoiceStatus` has a **fourth consumer the spec never mentions**: `src/hooks/useStartupReconciliation.ts:44,69` calls `api.payments.actions.checkInvoiceStatus` for every recent `awaiting_payment` txn on app mount. This hook *is* ADR-026 ("reconciliation on reload"), mounted in `RootLayout`. Removing the action breaks the hook at compile time.

Deeper problem: even if you kept it, it does `GET /v2/invoices/{id}` (`useStartupReconciliation.ts:13`), and after the switch `xendit_invoice_id_current` holds a **QR code id** (`qr_...`) or FVA id — not an invoice id — so the call 404s. And per the diagnostic's own production spike, **a QR never reports paid on a status poll** (README §"Receive payment"). So reconciliation-on-reload via polling is not merely orphaned — it is *fundamentally impossible* for QRIS through this mechanism.

Consequence the spec must own: with polling gone **and** reconciliation defeated, the **only** recovery for a webhook missed while the device was offline/closed is the manager-PIN manual override. That may be acceptable, but it's a real downgrade of the ADR-026 guarantee and must be a decision, not an accident.

**Recommendation:** Add an explicit "ADR-026 reconciliation" subsection to the spec deciding one of:
- **(a) Downgrade to manual recovery** — gut `useStartupReconciliation`'s poll, document that QRIS/FVA missed-webhook recovery is manual-override-only, and amend ADR-026 in ADR-036. Simplest, honest.
- **(b) Reconcile via a *working* endpoint** — Xendit's QR payments lookup (`GET /qr_codes/{id}/payments` or the Payments API) rather than the invoice GET. Preserves automatic recovery but is unverified territory (treat like the BCA wave — code-complete, live-verified later).
Either way, `useStartupReconciliation.ts` is now in the file-changes list, and ADR-026 gets an explicit amendment in ADR-036's "supersedes/amends" list.

### Issue 2: The `api-version` header has no test

The spec's testing section covers `parseXenditWebhook`, the body builders, and the webhook handler — good. But the **most dangerous detail in the entire fix is untested**: per the diagnostic (README bug #2), the `qr.payment` webhook *only fires* if `api-version: 2022-07-31` is sent at QR-creation time. A future refactor that drops or mistypes that header produces **zero test failures, a clean build, a rendering QR, and silently no payment detection** — the exact failure mode you're fixing now, reintroduced invisibly.

**Recommendation:** Make the header assertable. Either extract a pure `buildQrisHeaders()` (or have `createQrisCharge` accept an injectable `fetch` and assert the request carries `api-version: 2022-07-31`), and add a unit test that fails if the header is absent/wrong. This is cheap insurance on a regression-prone, silent-failure path and belongs in wave 1.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Webhook discards paid amount — no amount-mismatch defense | M | L |
| 2 | RRN (`receipt_id`) + paying source dropped — weaker reconciliation | M | M |
| 3 | Webhook is now the *sole* automatic path — add an explicit "webhook fires" deploy/verify gate | H | L |
| 4 | FVA webhook field names asserted from memory — verify before relying | M | L |
| 5 | QR `reference_id` uniqueness on retry is unspecified | M | L |
| 6 | Patch ADR-011/014 + §8 + ADR/README, not just create ADR-036 | L | L |

### Improvement 1: No amount verification on the webhook

`parseXenditWebhook` returns only `{ paid, matchKey }`, dropping `amount`. `_confirmPaid_internal` is keyed purely on txn status, so FrolliePOS confirms whatever Xendit says is paid without checking the amount matches `txn.total`. The reference treats this as a hard-won safety rule (`decideWebhookOutcome`, mutations.ts C7): honor the payment but flag `needsReview` on mismatch. DYNAMIC QR + `is_closed` FVA enforce exact amount at creation, so the risk is low — but this is a money path, and `pos_transactions.flags` already has a bitset built for exactly this kind of flag.

**Recommendation:** Thread `amount` through the parser and `_confirmPaid_internal`; on mismatch, honor + set a `PAYMENT_AMOUNT_MISMATCH` flag (new bit in `transactions/flags.ts`). If you decline (to hold "no schema change"), state the reliance on Xendit's amount enforcement explicitly in the spec as an accepted risk.

### Improvement 2: RRN + paying source discarded

The reference captures `payment_detail.receipt_id` (the bank RRN) and `source` (DANA/OVO/BCA) on the paid row — the keys to reconciling POS sales against the Xendit settlement report later. The spec's "no schema change" decision drops both. For a booth feeding Frollie Pro revenue, the RRN is the join key to the bank statement.

**Recommendation:** At minimum note the tradeoff. Ideally add `receipt_id` + `payment_source` optional columns to `pos_xendit_invoices` (additive, no migration risk in Convex) and record them in the paid path. Reframes the "no schema change" claim as "no *breaking* schema change."

### Improvement 3: Webhook is now a single point of failure — gate it

With polling and reconciliation gone (Issue 1), a misconfigured Xendit dashboard webhook URL means **payments never auto-confirm** and staff fall back to manual override for every sale, possibly without noticing the webhook is dead. The reference's README §"Webhook setup" step 4 (dashboard simulate-payment) is the proof it works.

**Recommendation:** Promote "QRIS dashboard simulate-payment writes `paid` end-to-end" to a hard Success Criterion (done in §0) **and** a deployment step in §8 — the webhook URL must be set on the QR Codes callback and verified before this is considered shipped.

### Improvement 4: FVA webhook shape is asserted, not verified

The parser's BCA branch (`body.callback_virtual_account_id`, flat, no `event`, arrival = paid) is stated with specific field names that the reference bundle does **not** cover (it's QRIS-only). Decision C partitions the BCA *create/verify* as unproven, but the *parser field names* are baked into wave-1 code.

**Recommendation:** Tag the FVA branch of `parseXenditWebhook` with the same "live-unverified" flag as the rest of the BCA wave; verify the exact callback shape against Xendit's FVA docs / a real simulated callback before BCA is declared done. Keep the QRIS branch (which *is* reference-proven) cleanly separable so a wrong FVA assumption can't regress QRIS.

### Improvement 5: QR `reference_id` on retry

Current retry deliberately makes the invoice ref unique (`actions.ts:172`, `pos-${txnId}-retry-${randomUUID()}`). The spec's `buildQrisBody(ref, amount)` takes a fixed `ref = pos-${txnId}`. Matching is on the globally-unique `qr_id`, so reference reuse doesn't break *matching* — but whether the QR Codes API rejects or silently reuses a duplicate `reference_id` on a regenerate is unverified.

**Recommendation:** Decide and document the retry-time `ref` (e.g., `pos-${txnId}-${attempt}` or a uuid suffix) so wave 1 + wave 5 don't each guess. One line in the adapter spec.

### Improvement 6: Cross-document the ADR change

Creating ADR-036 isn't enough: ADR-011, ADR-014, strategic-foundations §8, **and** ADR-026 (per Issue 1) need "superseded/amended by ADR-036" pointers, and `docs/ADR/README.md` index needs the new entry. The repo's ADR culture treats these back-references as load-bearing.

## 4. Refinements (Optional)

- Pin `qrcode.react` ^4 — v4 declares React 19 peer support; v3 does not.
- Mark waves PARALLEL/SEQUENTIAL (§6).
- The dual-purpose `xendit_invoice_id` column (QR id *or* FVA id) is a mild smell but acceptable under ADR-034 L3 ("data is private"); a one-line comment on the column documenting the dual meaning would help future readers.
- Verify whether `/qr_codes` honors `X-IDEMPOTENCY-KEY`. The Convex `_lookup_internal` cache is the primary double-commit guard, so this is belt-and-suspenders — but if unsupported, a crash between the Xendit POST and the commit mutation orphans an unpaid QR (low harm; it's superseded). Note it as a known small window rather than engineering around it.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `_confirmPaid_internal` funnel | `convex/transactions/internal.ts:135` | Reused as-is — the fix only feeds it a correct `matchKey`. Correct call. |
| `withIdempotency` + `_lookup_internal` pre-check | `convex/idempotency/internal.ts`, `payments/actions.ts:87` | Keep; the thin action retains the same idempotency envelope. |
| Constant-time token compare | `convex/payments/webhook.ts:31-34` | Keep verbatim; only the parse downstream changes. |
| Replace-commit (supersede prior invoice) | `payments/internal.ts:101` `_replaceInvoiceCommit_internal` | Reused for Decision E local-supersede; no new lifecycle code needed. |

### Potential duplication risks
- The reference's `xendit.ts` uses `btoa`; the existing actions use `Buffer`. Don't end up with two auth-header builders — the new adapter should be the *only* place auth headers are built, and `cancelTransaction`'s inline `Buffer.from(...)` auth (`transactions/actions.ts:66`) should route through the adapter too (it currently hand-rolls the same auth + a now-invalid `/invoices/{id}/expire!` call — see §11).

## 6. Phase / Wave Accuracy

| Wave | Assessment | Notes |
|------|------------|-------|
| 1 Adapter + QRIS create | Good | Add the `api-version` header test (Issue 2) and the retry-`ref` decision (Imp 5) here. |
| 2 Webhook rewire | Good | Sequential after 1 (needs `parseXenditWebhook`). |
| 3 Polling removal | **Needs adjustment** | Must include `useStartupReconciliation` / ADR-026 resolution (Issue 1), not just the three listed call sites. |
| 4 Frontend QR render | Good | Parallelizable with wave 2/3 (independent of webhook). |
| 5 BCA VA (unverified) | Good | Tag the FVA *parser* branch unverified too (Imp 4). |
| 6 ADR-036 + CHANGELOG + cancel `expire!` removal | Good | Expand ADR cross-refs (Imp 6); fold the `cancelTransaction` change explicitly (§11). |

**Ordering:** 1 → 2 → 3 sequential; 4 can run parallel to 2/3; 5 after 1; 6 last. **Missing:** an ADR-026 reconciliation wave (fold into wave 3).

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Waves 1–3, 5 (backend) | `convex-expert` | Convex action/webhook/runtime nuances (btoa vs Buffer, httpAction default runtime, idempotency wrap). |
| Wave 4 (frontend) | `frontend-integrator` | Wiring `qrcode.react` + reactive subscription into the charge screen. |
| Post-implementation | `code-reviewer` / `/gsd-code-review` | Money-path code review before merge. |

## 8. Git Workflow Assessment

### Branch & merge strategy
| Check | Status |
|-------|--------|
| Feature branch specified | ✅ on `feat/v0.3-sale-xendit` already |
| Branch naming follows convention | ✅ |
| Merge strategy documented | ⚠️ implied (continues v0.3 branch) |

### Commit checkpoints (one per wave)
1. Adapter + QRIS create + tests → `feat(v0.3): xendit QR Codes adapter for inline QRIS`
2. Webhook rewire + tests → `fix(v0.3): parse QR Codes webhook shape (SUCCEEDED/data/qr_id)`
3. Polling + ADR-026 reconciliation resolution → `refactor(v0.3): retire QRIS polling; reconcile via <decision>`
4. Frontend QR render → `feat(v0.3): render scannable QRIS via qrcode.react`
5. BCA VA wave → `feat(v0.3): BCA VA via FVA API (live-unverified)`
6. ADRs + CHANGELOG + cancel path → `docs(v0.3): ADR-036 + supersede ADR-011/014, amend §8/ADR-026`

### Pre-push verification
- [x] `npm run build` / `npm run typecheck` — must be in the plan
- [x] `npx vitest run convex/payments` — parser + handler + builder tests
- [ ] **Add:** Xendit dashboard simulate-payment manual gate (Improvement 3)

### CI/CD & rollback
| Concern | Status |
|---------|--------|
| Rollback strategy | ❌ missing — added below |
| Deployment order | ⚠️ added below |
| Data backup needed | No (no schema migration) |
| Migration safety | ✅ no schema change (modulo Improvement 2 additive columns) |

**Deployment order (added):** (1) `npx convex dev`/`deploy` the backend (adapter + webhook). (2) In the Xendit dashboard, set the **QR Codes** (and, for the BCA wave, **Virtual Account**) callback URL to `https://<deployment>.convex.site/payments/webhook` and copy the Verification Token into `XENDIT_CALLBACK_TOKEN`. (3) Confirm `api-version` via a dashboard simulate-payment. (4) Deploy frontend.
**Rollback (added):** `git revert` restores the Invoice-API code, **but** the Xendit dashboard webhook URL/event-type change is out-of-band — note it so a revert also reverts the dashboard config. No data migration to unwind.

## 9. Documentation Checkpoints

| Wave | Docs to update |
|------|----------------|
| 6 | New ADR-036; "superseded/amended by 036" notes on ADR-011, ADR-014, ADR-026, strategic-foundations §8; `docs/ADR/README.md` index; `docs/CHANGELOG.md`; `CLAUDE.md` Xendit-integration-notes (Invoice API → QR Codes/FVA) + business-rule #5/§8 polling note; `docs/SCHEMA.md` dual-meaning note (+ new columns if Improvement 2 taken). |

### CHANGELOG draft
~~~markdown
## 2026-05-28 — Xendit inline payments fix (v0.3)
- QRIS now uses the Xendit QR Codes API (inline scannable QR) instead of the Invoice API
- BCA VA now uses the Virtual Accounts (FVA) API for an inline VA number (live-unverified)
- Webhook parses the QR Codes v2 shape (`data.status: "SUCCEEDED"`, match on `qr_id`)
- Retired QRIS status polling; webhook + manager override are the confirmation paths
- ADR-036 supersedes ADR-011, adjusts ADR-014, amends strategic-foundations §8 + ADR-026
~~~

## 10. Testing Plan Assessment

**Verdict: Insufficient** (good coverage of the pure functions; two material gaps)

### Planned tests
| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend | `parseXenditWebhook` (QRIS/FVA/garbage) | vitest pure | planned ✅ |
| Backend | `buildQrisBody` / `buildBcaVaBody` | vitest pure | planned ✅ |
| Backend | webhook handler (401 / paid / bad-JSON / unmatched) | convex-test | planned ✅ |
| Backend | `_confirmPaid_internal` | convex-test | existing, unchanged ✅ |

### Missing test coverage (must add)
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | `api-version: 2022-07-31` header present on QR create | Silent total failure of payment detection if dropped (Issue 2) | Pure `buildQrisHeaders()` or injectable-`fetch` assertion |
| 2 | `useStartupReconciliation` after polling change | ADR-026 behavior must be intentional, not broken-by-omission (Issue 1) | Hook test or explicit removal + documented downgrade |
| 3 | Amount-mismatch handling (if Improvement 1 taken) | Money-path safety net | parser + funnel test with mismatched amount |

### Regression risk
- `useStartupReconciliation.ts` (compile break on action removal).
- `cancelTransaction` (`transactions/actions.ts:61-86`) calls `/invoices/{id}/expire!` on what is now a QR/FVA id → 404; must be removed (it's a no-throw best-effort, so it won't crash, but it logs a spurious failed-cancel audit row every cancel).
- Existing `payments` webhook/handler tests asserting the old flat `{id,status:"PAID"}` shape will fail and must be rewritten (expected).

## 11. Edge Cases to Address

- [ ] Webhook arrives for a txn already cancelled (customer paid a stale QR after cancel) — `_confirmPaid_internal:149-160` already alerts via `payment.confirmed_on_terminal`; confirm the new match path still reaches it.
- [ ] `cancelTransaction` with `xendit_invoice_id_current` now a QR id — remove the `expire!` call (§10 regression).
- [ ] Two webhooks (QRIS + a leftover Invoice webhook for an old test invoice) hitting the same endpoint — parser returns `{paid:false}` for the unrecognized Invoice shape; confirm that's the intent (it is, but assert it in a test).
- [ ] Empty/whitespace `qr_string` from Xendit → charge screen renders an empty QR; guard the render.
- [ ] FVA overpayment/underpayment — `is_closed:true` should preclude it; confirm Xendit rejects rather than firing a mismatched callback.
- [ ] Manager override still works when the webhook is dead (the now-primary recovery path) — already covered by existing manual-override tests; keep them green.

## 12. Approval Conditions

**To approve, address:**
1. **Issue 1** — decide and document the ADR-026 reconciliation story; put `useStartupReconciliation` in the file-changes list and ADR-026 in ADR-036's amends list.
2. **Issue 2** — add a test asserting the `api-version: 2022-07-31` header on QR create.

**Recommended before implementation:**
1. Improvement 3 — promote the dashboard simulate-payment to a hard success criterion + deploy gate (cheap, high value now that the webhook is the sole automatic path).
2. Improvement 1 or an explicit accepted-risk note on amount verification.
3. Improvement 4 — tag the FVA parser branch live-unverified.

---

*Generated by /staffreview*
