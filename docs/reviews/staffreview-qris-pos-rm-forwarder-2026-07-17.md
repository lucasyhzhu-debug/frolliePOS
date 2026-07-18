# Staff Review — QRIS POS→RM Forwarder

**Branch:** `feature/qris-pos-rm-forwarder` (base `main` d8ef73d → head 77f0f7a)
**Repo:** FrolliePOS (prod `savory-zebra-800`)
**Reviewer:** staff-engineer review (plan fidelity + architecture + rollout)
**Date:** 2026-07-17
**Spec:** `docs/superpowers/specs/2026-07-16-qris-pos-rm-forwarder.md`
**Plan:** `docs/superpowers/plans/2026-07-16-qris-pos-rm-forwarder.md`

---

## Summary

A clean, disciplined implementation of the transactional-outbox forwarder that re-POSTs genuine QRIS
paid-callbacks landing on the shared-Xendit-account POS webhook over to Recipe Master. The diff is 610
lines across the 7 planned files; no scope creep, no stray edits to unrelated code, and the POS money
path is provably untouched.

**Verification (run during review):**
- `npx vitest run` over the 3 payments test files → **37 passed** (0 fail). The convex-test "should not
  directly call other Convex functions" stderr lines are harness noise from `t.mutation`/`t.action`, not
  failures.
- `npx tsc -p convex --noEmit` → **exit 0**.

Every T1–T5 task landed as specified, and all five staffreview refinements (Impr#1–5), the C1 invariant,
and LOW-6/LOW-7 are honored. LOW-5 is functionally satisfied by pre-existing coverage but the literal
spec test item was not added as a new dedicated test (see Minor #1).

**Verdict: SHIP.** No critical or important defects. Three minors and two nitpicks below are optional
follow-ups; none block merge. The pending live-env steps are correctly out-of-scope for headless work
and are NOT falsely claimed done.

---

## Critical Issues

None.

---

## Improvements (Important)

**None blocking.** One rollout-coupling item to keep visible (already acknowledged in spec §8.1, not a
code defect):

- **Cross-repo contract is the single go-live dependency.** Every forward carries
  `x-callback-token = XENDIT_CALLBACK_TOKEN` + `x-frollie-forward-secret = FROLLIE_FORWARD_SECRET` and
  POSTs to the hardcoded `https://decisive-wombat-7.convex.site/api/xendit/qr-payment`. If RM's shipped
  Phase-1 endpoint path or the `x-frollie-forward-secret` header name differ, **every** forward 401s →
  terminal `failed` + ops alert. The design handles this exactly right (401 is terminal, alerts fire),
  so it degrades loudly rather than silently — but the pre-go-live cross-check against
  `product_master convex/integrations/qris/webhooks.ts` (spec §8.1) must actually happen before flipping
  `FROLLIE_FORWARD_ENABLED=true`. Correctly flagged as "not verifiable inside FrolliePOS."

---

## Refinements (Minor / Nitpick)

### Minor

1. **LOW-5 namespace test not added as a new dedicated test (spec §4.4 / §7).** The spec asked to "Add a
   POS unit test pinning the `pos-` prefix" so a future ref-format change fails loudly against RM's
   `MMDD-NNN` namespace. No new test was added. The invariant IS covered by pre-existing
   `convex/payments/__tests__/actions.test.ts:91,96,255,256`, which pin `reference_id === pos-${s.txn}` —
   so a ref-format change would still break the suite. Functionally satisfied, but the literal
   spec-required test (with a comment tying POS refs to RM disjointness) was not executed as written.
   Given the "never skip a specified step" bar, recommend adding a one-line invariant test/comment;
   non-blocking because coverage already exists.

2. **Off-by-one in final `attempts` on max-attempts failure (observability only).**
   `_markFailed_internal` patches `attempts: row.attempts` using the pre-increment stored value. A row
   that exhausted all 5 delivery tries persists `attempts: 4`, under-reporting the try count by one in
   the audit trail. No functional impact (status is correctly `failed`, ops report fires). The 401
   terminal path correctly leaves `attempts: 0` (it never retried). The max-attempts test asserts
   `status: "failed"` but doesn't assert the final count, so this is invisible today.

3. **Only HTTP 401 is treated as terminal.** `res.status === 401` → terminal; any other non-ok (incl.
   403) → retryable and burns all 5 attempts before `failed`. Spec specified 401, so this matches — but
   if RM's forward-secret gate ever returns **403** (a common choice for "authenticated-but-forbidden"),
   a misconfigured secret would retry pointlessly for ~20 min before failing. Consider treating 403 as
   terminal alongside 401.

### Nitpick

4. `_markFailed_internal` re-reads the row and then writes `attempts: row.attempts` — a redundant no-op
   patch of an unchanged field. Can be dropped (only `status` + `last_error` need patching).

5. Ops route strings are consistent (`convex/payments/forwarder` vs webhook's `convex/payments/webhook`)
   per the spec Refinement — good, no change needed; noted for completeness.

---

## Detailed fidelity check

### Plan tasks
| Task | Status | Evidence |
|------|--------|----------|
| T1 — `kind` pure annotation, paid/matchKey byte-identical, 6 `.toEqual` call sites updated + C1 test | ✅ | `xendit.ts:139-192`; refund detection derived alongside, never feeds `paid`/`matchKey`. `xendit.test.ts` C1 invariant tests at :106, :124, :151 (refund precedence over both bca_va and qr_payment, paid values byte-identical). |
| T2 — outbox table + `by_xendit_qr_id` + `by_status_next` | ✅ | `schema.ts:40-51`; auto-wired via `...paymentsTables`, no root-schema edit. |
| T3 — `forwarder.ts` enqueue(dedup)+deliver(retry/backoff/401-terminal/ops) + tests | ✅ | `forwarder.ts`; default runtime, no `"use node"`; dedup via index `.first()`; exp backoff 60s·2^(n-1) cap 10min. `forwarder.test.ts` 8 tests. |
| T4 — wire behind `kind==="qr_payment" && matchKey && FROLLIE_FORWARD_ENABLED` | ✅ | `webhook.ts:78-88`; POS paid path (54-69) unchanged; enqueue throw wrapped + reported. |
| T5 — typecheck + `test:convex` green | ✅ | verified: `tsc -p convex` exit 0; 37 tests pass. |

### Spec refinements
| Refinement | Status | Note |
|------------|--------|------|
| C1 — `kind` never alters paid/matchKey | ✅ | Derived before branch bodies; branches return unchanged values. C1 tests assert byte-identical. |
| Impr#1 — update existing `.toEqual` + C1 paid-unchanged test | ✅ | 6 call sites carry `kind`; C1 asserts exact fields, not just `kind`. |
| Impr#2 — both indexes | ✅ | `by_xendit_qr_id` (dedup, OCC-safe) + `by_status_next` (future sweeper). |
| Impr#3 — do NOT reuse `cronRetry.isTransientError`; retry ANY non-terminal; longer backoff | ✅ | `handleRetryable` retries on any non-terminal; exponential, longer than cron's linear. |
| Impr#4 — forward gate mirrors `paid && matchKey` | ✅ | `kind==="qr_payment" && matchKey`; test `matchKey null → NO enqueue` at `webhook.test.ts:361`. |
| Impr#5 — inline enqueue-throw residual acknowledged | ✅ | Comment `webhook.ts:76-77`; wrapped in try/catch + ops report. Not mitigated in v1 (as specified). |
| LOW-5 — `pos-` prefix / namespace disjoint | ◑ | Functionally covered by pre-existing `actions.test.ts`; no NEW dedicated test (Minor #1). |
| LOW-6 — SSRF hardcoded const target | ✅ | `RM_QR_WEBHOOK` const, never payload-derived (`forwarder.ts:22`). |
| LOW-7 — POS→RM-only invariant comments on both handlers | ✅ | `schema.ts:35-37`, `forwarder.ts:19-21`, `webhook.ts:72-73`. |

### Architecture
- **Transactional outbox is sound.** Insert + `scheduler.runAfter` commit atomically inside
  `_enqueueForward_internal`; retry reschedule is likewise atomic inside `_markRetry_internal`. The four
  internal helper mutations/query exist only because an action can't touch `ctx.db` — idiomatic Convex,
  not over-engineering.
- **Scheduler-loss residual correctly DEFERRED, not dropped.** `by_status_next` index is built (cheap)
  to enable an optional future sweeper; the sweeper itself is not built, matching spec §6/§8. Called out
  as a follow-up, not silently omitted.
- **POS↔RM availability coupling removed.** No inline awaited fetch to RM; POS always-200 contract
  preserved. Enqueue is a cheap local mutation.
- **Secrets never persisted.** Outbox row has no secret field; `x-callback-token` +
  `x-frollie-forward-secret` re-read from env at send time (`forwarder.ts:147-149`).
- **Refund defense-in-depth.** `kind` refund detection wins over bca_va/qr_payment labels for the
  *forward* decision only; a refund never enqueues (`webhook.test.ts:313`), and RM's Phase-1 refund gate
  is the second line.

### Over/under-engineering
- Not over-engineered. Helper-mutation split is required by Convex's action/db boundary. Exponential
  backoff + cap is proportional to a cross-service redeploy window.
- Mild YAGNI: `by_status_next` index with no consumer yet — but spec-sanctioned, near-zero cost, and it
  unblocks the deferred sweeper. Acceptable.
- Under-engineering: only the LOW-5 dedicated test (Minor #1).

### Ops / rollout readiness
- **Kill-switch present + correct.** `FROLLIE_FORWARD_ENABLED === "true"` gates the enqueue
  (`webhook.ts:78`), disables forwarding instantly with zero POS impact, tested both on and off
  (`webhook.test.ts:265,290`).
- **Pending live-env steps NOT falsely claimed done.** Setting `FROLLIE_FORWARD_SECRET` /
  `FROLLIE_FORWARD_ENABLED` on both deployments, the POS prod deploy, the live smoke test, and
  reconciling stuck order `0716-001` are all flagged "pending: needs live env / prod creds" in plan
  §(d)/Rollback. The headless work (through T5) is complete and green.
- **Docs pending at merge.** CHANGELOG + CLAUDE.md forwarder note are listed as merge-time updates and
  are not yet in the diff — expected, not a defect.

---

## Verdict

**SHIP.** The money path is provably untouched, all security refinements are honored, tests and typecheck
are green, and rollout gating (kill-switch + terminal-401 + ops alerting) is correct. Address Minor #1
(add the explicit LOW-5 namespace test) for literal spec completeness and optionally the two cosmetic
minors (#2 attempts off-by-one, #3 403-terminal) as a follow-up — none block merge. Do the cross-repo
endpoint/header check (spec §8.1) before flipping the kill-switch in prod.
