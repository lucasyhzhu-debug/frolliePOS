# Staff Review: Launch-Day Ops Observability — PLAN (v1.0.1)

**Date:** 2026-06-17
**Plan:** `docs/superpowers/plans/2026-06-17-v1.0.1-launch-ops-observability.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — header, Global Constraints, Verify-First, 14 right-sized TDD tasks, Final verification, Deployment ordering, Rollback all present.

---

## 1. Summary

**Overall Assessment:** Approve (after the two signature fixes, now applied inline)

Strong, executable plan: real code in every step, TDD throughout, dependency-ordered, atomic commits. The gate's job — verifying flagged assumptions against real code — surfaced **two signature mismatches that would have broken Task 9 at compile/run time**. Both fixed inline. Everything else is sound.

## 2. Critical Issues (Must Fix) — both FIXED inline

### Issue 1: `_listStaffNames_internal` called with wrong args/return handling
Plan Task 9 called `_listStaffNames_internal({ staffIds: [...] })` and indexed the result as a map (`names[staff_id]`). The real function (`convex/auth/internal.ts:469`) takes **`args: {}`** and returns **`Array<{ _id, name }>`**. As written, Task 9 would fail typecheck and produce `undefined` staff names.
**Fix applied:** call with `{}`, resolve via `names.find((s) => s._id === txn.staff_id)?.name ?? "Staff"`.

### Issue 2: `_getPaidInvoiceForTxn_internal` wrong arg name
Plan used `{ txnId }`; the real arg (`convex/payments/internal.ts:399-400`) is **`{ transactionId }`**. Would fail validation at runtime.
**Fix applied:** `{ transactionId: args.txnId }`. (Confirmed it returns the full invoice row, which carries `method` for `instrumentFromInvoice`.)

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | `formatWibDateTime` returns full WIB datetime, not bare `HH:mm` | L | L |
| 2 | Task 3 forward-ref ordering note is correct — keep codegen between T3 and T6 | M | L |

### Improvement 1: WIB time label
The ticker mock shows `14:32`, but `convex/lib/telegramHtml.ts` already imports `formatWibDateTime` (full WIB date+time). Using it is fine and **consistent with every other template** (refund/recount/founders all use it). Don't mint an `HH:mm` helper for cosmetic parity — accept the full timestamp. (Plan's `renderTxnTicker` already calls `formatWibDateTime`; just don't treat the `HH:mm`-only example as a contract.) No code change required; noted so the implementer doesn't over-engineer.

### Improvement 2: codegen ordering between Task 3 and Task 6
Task 3's `_recordError_internal` schedules `internal.ops.actions.sendErrorAlert`, which doesn't exist until Task 6 — so `npx convex codegen`/typecheck won't be green until Task 6 lands. The plan already calls this out (Task 3 Step 4 note + Task 6 Step 4 regen). Correct as written; the executor should not "fix" the red typecheck between T3 and T6 — it resolves when T6 lands.

## 4. Refinements (Optional)
- Task 13: the `useRef` "already reported" guard on the boundary is good; ensure it keys on the error identity, not just a boolean, so a *different* later crash still reports.
- Consider logging the dropped-alert count somewhere visible (the spec's "no silent caps" principle) — but for one booth-day the `pos_error_reports.alerted=false` rows are queryable evidence, so this is genuinely optional.

## 5. Duplication Analysis
Plan correctly reuses `instrumentFromInvoice`, `_getPaidInvoiceForTxn_internal`, `_listStaffNames_internal`, `getChatIdByRole` (narrow-catch), `constantTimeEqual`, `isChunkLoadError`, `escapeHtml`/`formatIdr`/`formatWibDateTime`, `_getSettings_internal` read-default. No new duplication. ✅

## 6. Phase / Wave Accuracy
Ordering is correct: schema → pure lib → record mutation → role → templates → alert action → httpAction → settings default → ticker action+query → ticker hook → BE reporting → FE reporter → FE wiring → docs. Schema-before-consumers and templates-before-senders both honored. The T3↔T6 forward-ref is the only non-linear edge and is documented.

## 7. Specialist Agent Recommendations
| Tasks | Agent | Rationale |
|-------|-------|-----------|
| 1–11 (backend) | `convex-expert` | mutation/query/action/httpAction split, indexes, V8-safety, codegen ordering |
| 12–13 (frontend) | `frontend-integrator` | reporter helper + boundary/hook wiring |
| 14 (docs) | default | runbook/schema/changelog prose |
| close-out | `/triple-review` → `/simplify xhigh` | repo standard |

## 8. Git Workflow Assessment
| Check | Status |
|-------|--------|
| Feature branch / worktree | ✅ pipeline worktree |
| Atomic commit per task | ✅ one `git commit` per task |
| Pre-push typecheck/test | ✅ Final verification + per-task `vitest`/`typecheck` |
| Rollback | ✅ per-task revert; ticker hook isolatable (Task 10) |
| Deployment order | ✅ BE → set both tokens → FE → bind role |
| Migration safety | ✅ additive table + optional field |

## 9. Documentation Checkpoints
Task 14 covers RUNBOOK §5/§9, RUNBOOK-telegram, SCHEMA, CLAUDE.md role table, CHANGELOG. ✅ Complete.

## 10. Testing Plan Assessment
**Verdict:** Adequate. Covers: signature/dedup/storm-cap (T2/T3), role-unbound skip (T6), httpAction token (T7), settings default (T8), ticker no-audit + disabled skip (T9), exactly-once ticker on re-fire (T10), webhook 401-no-report regression (T11), endpoint swap (T12), boundary report/skip-chunk (T13). The guard tests for Improvements 1/4/6 from the spec review are present. Money path covered via the confirmPaid regression suite (T10 Step 4).

## 11. Edge Cases to Address
- [x] Manual confirm, no invoice → "Manual" (Task 9 `instrumentLabel`).
- [x] Re-fire of `_confirmPaid_internal` schedules no second ticker (Task 10 test).
- [x] 401 webhook → no report (Task 11 test).
- [x] Chunk-load error not reported (Task 13 global + boundary).
- [x] Settings row absent → ticker default-on (Task 8).
- [ ] `convex-test` `t.fetch` / `_scheduled_functions` availability — flagged in Tasks 7 & 10 as harness checks; executor adapts. (Acceptable: TDD will reveal harness shape immediately.)

## 12. Approval Conditions
**To approve:** Issues 1 & 2 — ✅ both fixed inline.
**Recommended:** Improvements 1 & 2 — both are "don't over-engineer / don't fight the forward-ref" notes, already reflected in the plan.

**Verdict: APPROVED for execution.**

---

*Generated by /staffreview*
