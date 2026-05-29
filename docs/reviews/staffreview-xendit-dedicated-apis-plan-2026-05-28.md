# Staff Review: Xendit Dedicated-API Fix — Implementation Plan

**Date:** 2026-05-28
**Plan:** `docs/superpowers/plans/2026-05-28-xendit-dedicated-apis.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Minor note — see §0

---

## 0. Plan Structure Additions

All six required sections are present or covered:

- **Goal / Architecture / Tech Stack** ✅ (header).
- **File structure** ✅ (explicit table mapping every file to a change).
- **Implementation waves** ✅ ordered with PARALLEL/SEQUENTIAL marked — **but the Task 5 "PARALLEL to 2–4" label is wrong** (see Improvement 3).
- **Testing** ✅ per-task TDD with full test code.
- **Success Criteria** ⚠️ *distributed* across tasks (Task 4 Step 9 behavioral gate; Task 5 Step 6 + Task 6 Step 5 typecheck/build/full-test) rather than in one section. The single hard behavioral gate (dashboard simulate-payment) is correctly present. Acceptable; a one-line pointer to the spec's consolidated Success Criteria would help.
- **Rollback / Deployment** ⚠️ lives in the linked spec (§Rollback/deployment) and Task 4 Step 9 (deploy order) + Task 6. Not repeated in the plan. Acceptable given the cross-link.

No sections needed silent-adding. Validated with the two minor notes above.

## 1. Summary

**Overall Assessment: Revise**

This is a high-quality, no-placeholder plan — full code in every step, correct TDD ordering, the `Buffer`-vs-`btoa` runtime trap caught and documented, the deep-adapter boundary preserved, and the duplication (two inline auth-header builders) consolidated into the adapter. **One Critical blocks approval: the wave boundaries produce at least one broken intermediate commit** — Task 3 deletes `checkInvoiceStatus` while its frontend consumers survive until Task 4, *and* leaves `actions.test.ts` knowingly red on the BCA/retry cases. That contradicts the per-task green-commit model the plan itself recommends (subagent-driven, review between tasks). The fix is a small resequencing, not a redesign.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Task 3 produces a non-green commit: deletes `checkInvoiceStatus` (frontend still references it → typecheck break) and leaves `actions.test.ts` red on BCA/retry | Implementation / Testing / Git hygiene | Task 3 Steps 4–6 |

### Issue 1: Task 3 leaves a broken, non-green commit

Two independent breakages land in the Task 3 commit:

**(a) Frontend typecheck break.** Task 3 Step 4 deletes the `checkInvoiceStatus` action. But its consumers — `src/hooks/useStartupReconciliation.ts:44,69` and `src/hooks/useXenditPayment.ts:75,95` — are not removed until **Task 4** (Steps 5–6). The moment `checkInvoiceStatus` leaves `convex/payments/actions.ts`, `npx convex dev` regenerates `_generated/api` without it, so both hooks reference a non-existent `api.payments.actions.checkInvoiceStatus` → `npm run typecheck` / `npm run build` fail. Task 3 Step 5 only runs backend vitest, so the break isn't caught until later, and the Task 3 commit (Step 6) is shipped broken.

**(b) Known-red tests.** Task 3 Step 5's own "Expected" text says *"BCA cases in this file will fail — they still expect `/v2/invoices`; they are fixed in Task 5. The checkInvoiceStatus test, if any, is removed in this task."* Committing with knowingly-failing tests breaks the subagent-driven review model (the between-task reviewer sees red) and the green-commit principle. There may also be the `actions.test.ts` "staffreview Critical #1" dedup case (`actions.test.ts:81`) and any URL assertions that the plan does not mention updating (see Improvement 2).

**Why it matters:** the plan recommends subagent-driven execution with review between tasks — that model assumes each task's commit is independently green (typecheck + build + tests). A commit that fails typecheck or carries red tests can't be reviewed or `/gsd-undo`-bisected cleanly.

**Recommendation (small resequence, every commit green):**
- **Move the `checkInvoiceStatus` deletion (and `xenditGet`/`readJson` cleanup, and removal of any `checkInvoiceStatus` test) out of Task 3 and into Task 4**, alongside the hook-consumer removal and `_onPaidPolling_internal` deletion. Then the action and all its consumers disappear in one self-consistent commit.
- **In Task 3, update *all* `requestPayment`-related `actions.test.ts` cases to green** — not just the first. `requestPayment` Step 3 already wires *both* methods (`createQrisCharge`/`createBcaVaCharge`), so the **BCA `requestPayment` test belongs in Task 3** (assert `/callback_virtual_accounts`), leaving only the *retry* + BCA live-verification in Task 5. The retry path is unchanged in Task 3 (still `xenditPost` → `/v2/invoices`), so its existing test stays green until Task 5 flips it. Net: Task 3 commits green (QRIS + BCA `requestPayment` + dedup all pass; retry untouched), Task 4 commits green (action + consumers removed together), Task 5 commits green (retry switched + retry test updated).

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | No end-to-end test that the webhook *threads* `paid_amount` → mismatch flag | M | L |
| 2 | Task 3 underspecifies which `actions.test.ts` cases to update (≥3 exist) | M | L |
| 3 | Task 5 "PARALLEL to 2–4" label is wrong — retry sub-steps edit `actions.ts` | M | L |
| 4 | Adapter `createX` error path (`!res.ok` → throw) is untested | L | L |

### Improvement 1: Amount-mismatch is only tested at the funnel, not through the webhook

Task 2 tests `_confirmPaid_internal({ paid_amount })` directly, and Task 4's webhook test uses `amount: 25_000` which *matches* the seeded total — so nothing proves `parseXenditWebhook` → `_onPaidWebhook_internal` → `_confirmPaid_internal` actually threads `paid_amount` end-to-end. A regression that drops `paid_amount` from any link in that chain passes every test.

**Recommendation:** Add one webhook handler test in Task 4 with `data.amount` ≠ the seeded total, asserting the txn ends `paid` with `flags & PAYMENT_AMOUNT_MISMATCH` set. Proves the whole thread.

### Improvement 2: Enumerate the `actions.test.ts` cases to update

`actions.test.ts` has at least: the QRIS "posts to Xendit" case (Task 3 Step 1 covers it), the "staffreview Critical #1" same-key dedup case (`actions.test.ts:81` — asserts the forwarded `X-IDEMPOTENCY-KEY`, must still pass post-switch and may assert the old URL), and the BCA case. Task 3 rewrites only the first.

**Recommendation:** In Task 3, list every QRIS/BCA/dedup case and its required edit (endpoint `/qr_codes` or `/callback_virtual_accounts`, `api-version` header for QRIS, no `payment_methods` body). Confirm the dedup case asserts no second HTTP call (cache hit) rather than a specific URL.

### Improvement 3: Fix the Task 5 parallelism label

Task 5 is labelled "PARALLEL to Tasks 2–4," but Steps 3–5 edit `convex/payments/actions.ts` — the same file Task 3 edits — and depend on Task 3's adapter import. Only the UI sub-steps (Steps 1, 2, 6) are genuinely parallel.

**Recommendation:** Split Task 5 into **5a (UI: qrcode.react + charge.tsx render — PARALLEL to 2–4)** and **5b (retry path onto adapter + retry test — SEQUENTIAL after Task 3)**. Under subagent-driven execution (sequential with review) this is low-risk, but the label would mislead a parallel dispatch into an `actions.ts` conflict.

### Improvement 4: Test the adapter's failure path

`createQrisCharge`/`createBcaVaCharge` throw `XENDIT_QR_FAILED`/`XENDIT_VA_FAILED` on `!res.ok`. No test exercises this (the pure tests in Task 1 cover only builders/parser; the action tests use 200 responses).

**Recommendation:** Add one action test using `_xenditMockNextResponse({...}, 400)` asserting `requestPayment` rejects with the `XENDIT_*_FAILED` message. Confirms a Xendit 4xx surfaces cleanly rather than persisting a bad invoice.

## 4. Refinements (Optional)

- **FVA discriminator assumption.** `parseXenditWebhook`'s BCA branch keys on `p.callback_virtual_account_id && p.event === undefined`. If Xendit's FVA payment callback carries an `event` field, this misfires and the payload falls through to the QRIS branch (→ ignored). Already tagged "live-unverified," but call it out as the concrete thing to confirm against a real FVA callback before BCA is declared done.
- **Redundant `installFetchMock()`** in Task 5 Step 4's retry test — `_xenditMockReset()` alone suffices (the mock is already installed by `beforeEach`).
- **Redundant `XENDIT_CALLBACK_TOKEN` restore** in Task 4's missing-config test — `beforeEach` re-sets it before the next test.
- **`getCurrentInvoice` now returns `receipt_id`/`payment_source` to the client.** Staff-only POS, low sensitivity — fine; just note it (these are payer RRN + wallet type, not customer PII).

## 5. Duplication Analysis

### Existing code the plan correctly leverages
| Code | Location | How the plan uses it |
|------|----------|----------------------|
| `_confirmPaid_internal` funnel | `convex/transactions/internal.ts:135` | Reused; only an additive `paid_amount` arg. Correct. |
| `_persistInvoiceCommit_internal` / `_replaceInvoiceCommit_internal` | `convex/payments/internal.ts` | Reused for QR/VA persistence + local supersede. Correct. |
| `withIdempotency` + `_lookup_internal` | `convex/idempotency/internal.ts` | Action idempotency envelope kept. Correct. |
| `_xenditMock` harness | `convex/payments/__tests__/_xenditMock.ts` | Reused to assert endpoint + `api-version` header at the action level. Correct. |

### Duplication the plan eliminates (good)
- The inline Basic-auth builder appears **twice today** — `payments/actions.ts:41,57` and `transactions/actions.ts:66`. The plan routes all auth through the adapter's `authHeader()` (Task 5 Step 3 removes the `actions.ts` helpers; Task 4 Step 7 removes the `cancelTransaction` inline auth). Confirm `transactions/actions.ts` has no remaining `Buffer`/`XENDIT_BASE` reference after Task 4 (the plan says to verify via `tsc --noEmit` — good).

## 6. Phase / Wave Accuracy

| Wave | Assessment | Notes |
|------|------------|-------|
| 1 Adapter + pure tests | Good | Solid TDD; `api-version` regression test is the right call. |
| 2 Schema + flag + funnel | Good | Additive, schema validated via `convex dev --once`. Correct ordering (schema before writers). |
| 3 Thin QRIS action | **Needs adjustment** | Critical 1 — don't delete `checkInvoiceStatus` here; update all `requestPayment` tests (incl. BCA) here. |
| 4 Webhook + retire polling/recon | Good (absorb the Task-3 deletions) | Heaviest wave (webhook + internal + 2 hooks + cancel + tests) — coherent, keep together. Add the amount-thread test (Imp 1) + the `checkInvoiceStatus`/`xenditGet` deletion moved from Task 3. |
| 5 QR render + retry | Needs adjustment | Split 5a (UI, parallel) / 5b (retry, sequential after 3) — Improvement 3. |
| 6 ADRs + docs | Good | Cross-doc back-refs + progress-update + final full test. Complete. |

**Ordering issues:** Critical 1 (Task 3/4 boundary) + Improvement 3 (Task 5 label). **Missing phases:** none.

## 7. Specialist Agent Recommendations

| Wave | Recommended Agent | Rationale |
|------|-------------------|-----------|
| 1–4 backend | `convex-expert` | Runtime nuance (Buffer-in-node-action vs default-runtime webhook import), httpAction parsing, funnel edit. |
| 5a frontend | `ui-component-builder` or `frontend-integrator` | `qrcode.react` render + reactive charge screen. |
| Between tasks | `code-reviewer` | Money-path diff review per task (subagent-driven two-stage review). |

## 8. Git Workflow Assessment

### Branch & merge
| Check | Status |
|-------|--------|
| Feature branch specified | ✅ `feat/v0.3-sale-xendit` |
| Branch naming convention | ✅ |
| Merge strategy | ⚠️ implied (continues v0.3 branch) |

### Commit checkpoints
One per wave with `<type>(v0.3): ...` messages — natural boundaries. **Caveat:** Critical 1 means the Task 3 commit as written is not green. After the resequence, all six commits are green and independently revertible.

### Pre-push verification
- [x] `npm run build` — Task 5 Step 6, Task 6 Step 5
- [x] `npm run typecheck` — Task 5 Step 6, Task 6 Step 5 + `tsc --noEmit` checks in Tasks 3–5
- [⚠️] **Add a typecheck to Task 3 and Task 4 close-out** so the frontend-consumer break (Critical 1) can't slip through a backend-only test run.
- [x] Local + manual testing — Task 4 Step 9 (the behavioral gate)

### CI/CD & rollback
| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ in linked spec (incl. out-of-band Xendit dashboard config) |
| Deployment order | ✅ Task 4 Step 9 (backend → dashboard webhook → simulate → frontend) |
| Data backup | No (additive optional columns, no migration) |
| Migration safety | ✅ additive optional fields, validated `convex dev --once` (Task 2 Step 7) |

## 9. Documentation Checkpoints

| Wave | Docs |
|------|------|
| 6 | ADR-036 (new); back-refs on ADR-011/014/026 + §8; `docs/ADR/README.md`; `CLAUDE.md` (Xendit notes, rules #5/#18); `docs/SCHEMA.md` (new columns + flag + dual-meaning id); `docs/CHANGELOG.md`; `docs/PROGRESS.md` + `progress.html` regen. |

Complete — matches CLAUDE.md "How to add a feature" + the progress-tracker workflow.

## 10. Testing Plan Assessment

**Verdict: Adequate** (after Improvement 1 it becomes thorough)

### Planned tests
| Layer | What | Type | Status |
|-------|------|------|--------|
| Adapter | `buildQrisHeaders` (api-version), `buildQrisBody`, `buildBcaVaBody`, `parseXenditWebhook` (5 shapes) | vitest pure | planned ✅ |
| Funnel | `_confirmPaid_internal` amount-mismatch (set + not-set) | convex-test | planned ✅ |
| Webhook | 401 mismatch, 401 missing-config, QRIS SUCCEEDED + receipt_id/source, bad-JSON 200, unmatched 200 | convex-test `t.fetch` | planned ✅ |
| Action | QRIS `/qr_codes` + header; BCA `/callback_virtual_accounts`; retry unique-ref/no-expire; Critical#1 dedup | convex-test + `_xenditMock` | partial ⚠️ (Imp 2) |
| Manual | dashboard simulate-payment end-to-end | manual gate | planned ✅ (Task 4 Step 9) |

### Missing coverage (add)
| # | Test | Why | Approach |
|---|------|-----|----------|
| 1 | Webhook with mismatched amount → flag set | Proves `paid_amount` threads through the whole chain (Imp 1) | webhook `t.fetch` with `data.amount` ≠ seeded total |
| 2 | Adapter 4xx → action throws `XENDIT_*_FAILED` (Imp 4) | Bad Xendit response surfaces cleanly | `_xenditMockNextResponse({}, 400)` |
| 3 | Enumerate + update Critical#1 dedup + BCA cases (Imp 2) | Prevent red commit (Critical 1) | Task 3 |

### Regression risk
- `useStartupReconciliation.ts` / `useXenditPayment.ts` (typecheck break if `checkInvoiceStatus` removed before consumers — Critical 1).
- `actions.test.ts` BCA/retry/dedup cases (must be updated in the right wave to stay green).
- `cancelTransaction.test.ts` — any assertion of the Xendit `expire!` call must be removed (Task 4 Step 7 removes the call).
- `confirmPaid.test.ts` — existing cases unaffected (new arg is optional); verify the flags import path is `../flags`.

## 11. Edge Cases to Address

- [ ] Frontend typecheck across the Task 3/4 boundary (Critical 1).
- [ ] FVA callback that includes an `event` field → discriminator misfire (Refinement; verify live).
- [ ] Empty/whitespace `qr_string` → charge screen guard (covered, Task 5 Step 2).
- [ ] Webhook arrives for an already-cancelled txn → `_confirmPaid_internal:149` terminal-state alert still reached via the new match path (add/keep a case).
- [ ] `seedTxnAwaiting` seeded `total` value drives the mismatch test's `paid_amount` (Task 2 flags this — confirm it's 25_000).
- [ ] Two webhooks (a QRIS one + a leftover Invoice one for an old test invoice) → parser ignores the Invoice shape (covered by the "legacy flat Invoice ignored" test).

## 12. Approval Conditions

**To approve, address:**
1. **Critical 1** — resequence so every commit is green: move `checkInvoiceStatus`/`xenditGet` deletion to Task 4 (with the hook consumers); handle all `requestPayment` test updates (QRIS + BCA + dedup) in Task 3; add a typecheck gate to the Task 3 and Task 4 close-outs.

**Recommended before implementation:**
1. Improvement 1 — webhook amount-thread test.
2. Improvement 2 — enumerate the `actions.test.ts` edits.
3. Improvement 3 — split Task 5 into 5a (UI) / 5b (retry) or correct the parallelism label.
4. Improvement 4 — adapter 4xx error-path test.

---

*Generated by /staffreview*
