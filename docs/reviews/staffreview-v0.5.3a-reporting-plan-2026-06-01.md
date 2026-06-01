# Staff Review: v0.5.3a Reporting — Implementation Plan

**Date:** 2026-06-01
**Plan:** `docs/superpowers/plans/2026-06-01-v0.5.3a-reporting.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal / File Structure / Waves / Tasks-with-TDD / Success Criteria / Rollback all present)

---

## 1. Summary

**Overall Assessment:** Revise (2 correctness bugs in plan code, 2 improvements — all fixed inline)

The plan is well-decomposed (4 waves, pure-first, TDD, real signatures) and spec-complete. But three of the four assumptions it flagged for verification turned out to be **wrong as written in the plan's code** — verifying them now (rather than at execution) saves the implementer two compile-fail cycles. All are mechanical fixes applied to the plan.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `pos_refunds` has **no `amount` field** — it's `total_refund` (per-row) / `refund_amount` (per-line) | Logic (compile bug) | Task 4 `_fetchDayWindow_internal` |
| 2 | `useSession()` returns a discriminated `SessionState`, **not** `{ sessionId, role }` — the frontend destructuring won't compile | Logic (compile bug) | Tasks 9, 10 |

### Issue 1: Wrong refund field name

`convex/refunds/schema.ts:16` defines `total_refund: v.number()` (sum per refund row); per-line amounts are `lines[].refund_amount` (`:14`). The plan's Task 4 computes `refunds.reduce((s, r) => s + r.amount, 0)` — `r.amount` does not exist and will be `undefined` → `NaN`.

**Fix:** `refundsTotal = refunds.reduce((s, r) => s + r.total_refund, 0)`. Index `by_transaction` exists (`:34`) ✓.

### Issue 2: `useSession` shape

`src/hooks/useSession.ts:15-22` returns:
```ts
type SessionState =
  | { status: "loading" | "none"; sessionId: null; staff: null }
  | { status: "active"; sessionId: Id<"staff_sessions">; staff: { _id; name; role: "staff"|"manager" } };
```
The plan's `const { sessionId, role } = useSession()` is wrong — there is no top-level `role`, and `sessionId` is `null` unless `status === "active"`.

**Fix (applied to Tasks 9 & 10):**
```tsx
const session = useSession();
const sessionId = session.status === "active" ? session.sessionId : null;
const role = session.status === "active" ? session.staff.role : "staff";
```
Then gate queries on `sessionId ? {...} : "skip"` (already done) and read `role` from the derived value.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Specify the instrument resolver precisely (method enum + multi-invoice + normalization) | M | L |
| 2 | Tests use the `NEG_STOCK` constant, not literal `1` | L | L |

### Improvement 1: Instrument resolver is under-specified

`pos_xendit_invoices.method` is `v.union("QRIS","BCA_VA")` (`payments/schema.ts:10`) — **uppercase**, and there can be **multiple invoice rows per txn** (supersede leaves `cancelled_at` + `replaced_by_invoice_id`, `schema.ts:19-21`). The plan's `_instrumentForTxn_internal` must:
- resolve the **active** invoice — match `pos_transactions.xendit_invoice_id_current` against `pos_xendit_invoices.by_xendit_invoice_id`, OR pick the non-cancelled row `by_transaction`;
- **normalize** `"QRIS"→"qris"`, `"BCA_VA"→"bca_va"`, none→`"unknown"`.

This stays in `payments/` (ADR-034); `transactions` calls it via the internal surface. Plan updated to name the method mapping + active-invoice resolution explicitly.

### Improvement 2: Use the flag constant in tests

Task 2's empty/flag test uses `flags: 1`. Import and use `NEG_STOCK` from `transactions/flags.ts` so the test survives a bit-value change. (Verify `NEG_STOCK`'s value while there.)

## 4. Refinements (Optional)

- **`getById` is unauthenticated** (`transactions/public.ts:27` — takes only `txnId`, no session). 3a's new `getTransactionDetail` is correctly session+scope-gated, so this is not a 3a regression — but note for a future cleanup phase that the older `getById` bypasses the scope rule. Out of scope here.
- Consider whether `listDayTransactions` returning full `DayTxn[]` (with lines) is heavier than the list needs; the spec's "lightweight per-line summary" open item. At single-booth volume it's fine; leave as-is.

## 5. Duplication Analysis

No new duplication. The plan correctly reuses `wibDayWindow`, `by_status_created`, `_resolveSession*`, `_lazyMintReceiptToken_internal`, `refunds/lib.ts`, and extracts `refundStatus` once. ✓

## 6. Phase / Wave Accuracy

| Wave | Assessment | Notes |
|------|------------|-------|
| W1 helpers | Good | pure, parallel, TDD |
| W2 backend | Good | T3 (auth resolver) correctly precedes T5–T7 that consume it |
| W3 frontend | Good after Issue 2 fix | depends on W2 surface |
| W4 docs | Good | PROGRESS retrofit deferred to plan-time per CLAUDE.md ✓ |

## 7. Specialist Agent Recommendations

| Wave | Agent | Rationale |
|------|-------|-----------|
| W1–W2 | `convex-expert` | Convex query/index/runtime-split + test idioms |
| W3 | `frontend-integrator` + `ui-component-builder` | hook wiring + dashboard cards |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Commit per task | ✅ each task ends in a scoped commit |
| Pre-push verification | ✅ T8 Step 6 + T9/T10 build gates |
| Rollback | ✅ documented, zero schema change |
| Deploy order | ✅ backend before frontend |

## 9. Documentation Checkpoints

✅ Task 12 covers CLAUDE.md / SCHEMA.md / CHANGELOG.md / PROGRESS.md + html rebuild.

## 10. Testing Plan Assessment

**Verdict:** Adequate. Backend paths (helpers, role-gating, collapse, mint idempotency, scope reject, empty-day) all have named tests with fixtures. Frontend smoke is optional per project stance. After Improvement 2 the flag test is robust.

### Regression risk
- `computeReceiptStatus` refactor (T1) — existing receipt refund-projection test must stay green (labels unchanged). Called out in T1 Step 5.
- `_ensureReceiptTokenForPaidTxn_internal` gains a second caller (`shareReceipt`) — lazy-mint tests cover idempotency; T8 extends for the booth-staff actor.

## 11. Edge Cases to Address

- [x] Empty day → all-zero summary (T2 test) ✓
- [x] Staff past-day → collapse to today (T5 test) ✓
- [x] Re-tap share → same token (T8 test) ✓
- [x] Non-paid share → reject (T8 test) ✓
- [ ] Multiple invoices per txn → instrument resolves the active one (Improvement 1) — now specified.

## 12. Approval Conditions

**To approve, address:** Issues 1 & 2 (both applied to the plan).
**Recommended:** Improvements 1 & 2 (both applied).

---

*Generated by /staffreview*
