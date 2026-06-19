# Staff Review: v1.2 #10 — Retire BCA VA + static-account manual transfer (PLAN)

**Date:** 2026-06-19
**Plan:** `docs/superpowers/plans/2026-06-19-v1.2-phase3-manual-bca.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, File Structure, 9 tasks with PARALLEL/SEQUENTIAL, per-task TDD + tests, Success Criteria, Rollback/Deployment, Self-Review all present)

---

## 1. Summary

**Overall Assessment:** Approve (minor improvements folded). Every flagged assumption was verified against real code and holds: `FieldMessage` API, `audit_log.metadata` is a JSON string, `_cancelActiveInvoiceForTxn_internal`/`requireSession`/`_listStaffNames_internal` signatures, the transactions test dir + helpers. No Critical issues. Two Improvements (the #12 `useIdempotency`-in-jsdom trap; making the evidence-gate verdict explicit) and a few test-hygiene Refinements.

## 2. Critical Issues (Must Fix)

None. The plan's signatures, funnel reuse, idempotency contract, schema additivity, and deploy-skew avoidance are all correct against current `main`.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| P1 | Task 8 FE test must mock `useIdempotency` → string (jsdom returns undefined → confirm silently disabled) | M | L |
| P2 | Make the Evidence-Before-Mitigation verdict explicit in the plan | L | L |

### P1: `useIdempotency` returns `undefined` in jsdom — the #12 exec trap

`handleManualConfirm` early-returns on `!manualConfirmKey`. Per own MEMORY `v12-phase2-inline-messaging-lessons`, `useIdempotency` resolves `undefined` under jsdom, which previously **disabled submit** in a component test and produced a false-green. Task 8's verify-first must explicitly instruct mocking `useIdempotency` to return a stable string so the confirm button actually fires. (Folded into Task 8.)

### P2: Evidence-Before-Mitigation gate — verdict

The plan touches payment + idempotency, so the gate (§4.9) applies. Verdict: **Evidence present, change is structural — no Task 0 needed.** The error-storm "fix" is grounded in a concrete, code-cited mechanism (the auto-create effect `charge.tsx:173-233` re-fires `createBcaVaCharge` → `XENDIT_VA_FAILED` `xendit.ts:96` → `toast.error` per attempt), and the remedy is a **structural removal** (hide the BCA VA tab → QRIS is the only auto-created instrument), not a timing/debounce/warm-up mitigation. The gate is satisfied; recording the verdict in the plan closes it. (Folded into the plan's constraints.)

## 4. Refinements (Optional)

- **R1:** Task 2's `_confirmPaid_internal` manual_bca test fits its natural home `convex/transactions/__tests__/confirmPaid.test.ts` better than `payments/onPaidPaths.test.ts` (both work; confirmPaid.test.ts already seeds the funnel). Folded as a note.
- **R2:** Task 6 can reuse `seedStaff`/`seedSession` from `convex/transactions/__tests__/_helpers.ts` instead of inline `t.run` seeding (DRY). Folded as a note.
- **R3:** Task 2 — the "if metadata is an object, drop JSON.parse" hedge is resolved: `audit_log.metadata` is `v.optional(v.string())` (`convex/audit/schema.ts:22`), so `JSON.parse` is correct unconditionally. Simplified.

## 5. Duplication Analysis

### Existing code to leverage (plan already cites these correctly)
| Code | Location | Use |
|------|----------|-----|
| Receipt-config CRUD | `convex/settings/public.ts` + `internal.ts` | Template for manual-BCA CRUD + `MANUAL_BCA_DEFAULTS` (Tasks 1/4) ✓ |
| `_onPaidManual_internal` read-back guard | `convex/payments/internal.ts:331` | `confirmManualBcaPayment` RECEIPT_UNCONFIRMED guard (Task 3) ✓ |
| `_cancelActiveInvoiceForTxn_internal` | `convex/payments/internal.ts:223` | I1 invoice supersede (Task 3) ✓ |
| `_dailySalesSummary_internal` scan | `convex/transactions/internal.ts:327` | Reconciliation query pattern (Task 6) ✓ |
| `seedStaff`/`seedSession`/`seedAwaiting`/`seedManagerSession` | `*/__tests__/_helpers.ts` | Test seeding (Tasks 2-7) ✓ |

### Potential duplication risks
- None. The plan reuses the funnel + existing cancel writer rather than re-implementing.

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|------|------------|-------|
| 1 (settings fields) | Good | Additive, no consumer yet — safe first |
| 2 (funnel source) | Good | Must precede 3/5/6 (shared `manual_bca` literal) — correctly ordered |
| 3 (confirm mutation) | Good | Depends on 2; I1 gated on `confirmed_via==="manual_bca"` is correct |
| 4 (CRUD) | Good | Depends on 1 |
| 5 (ticker) | Good | Depends on 2 |
| 6 (reconciliation) | Good | Depends on 2 |
| 7 (EOD) | Good | Depends on 6 |
| 8 (charge FE) | Good | Depends on 3/4; verify-first on FE harness is appropriate |
| 9 (docs) | Good | Last |

**Ordering issues:** none. **Missing phases:** none.

## 7. Specialist Agent Recommendations

| Tasks | Agent | Rationale |
|-------|-------|-----------|
| 1-7 (backend) | `convex-expert` | Funnel/index/idempotency surface |
| 8 (charge FE) | `frontend-integrator` | React + Convex hook wiring, FieldMessage |

(Advisory — execution dispatches via the `/clear` handoff.)

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch | ✅ `v1.2-phase3-manual-bca` worktree |
| Commit boundaries | ✅ one per task (9 atomic commits) |
| Pre-push typecheck/test/build | ✅ in Success Criteria |
| Rollback | ✅ additive schema + net-new mutation (deploy-skew-safe) |
| Deployment order | ✅ backend before FE, atomic squash PR |
| Migration safety | ✅ optional fields + additive literal — no migration |

## 9. Documentation Checkpoints

Task 9 covers ADR-036 amendment, SCHEMA.md (fields + `settings.manual_bca_updated` + `confirmed_via` literal), CHANGELOG. Adequate.

## 10. Testing Plan Assessment

**Verdict:** Adequate. Every new backend fn has happy + idempotent + auth-reject + edge (non-awaiting / empty-window / count===0) coverage with **runnable** convex-test code grounded in the project harness. FE is verify-first with a fixed behavior contract + E2E fallback (appropriate given Convex-hook mocking complexity).

### Test execution checkpoints
1. After each backend task (`npx vitest run <module>`).
2. After Task 8 (`npm run typecheck` + FE test/E2E).
3. Before merge: full `npx vitest run` + `npm run build`.

### Regression risk
- `_confirmPaid_internal` audit branch change → existing `manual`/`webhook` audit assertions (`onPaidPaths.test.ts`, `confirmPaid.test.ts`) must stay green (plan runs the full module).
- `instrumentLabel` signature change → `telegramHtml.test.ts` (plan updates it, R2 in spec).
- `renderFoundersSummary`/`renderTxnTicker` payload extension is optional/additive → existing render tests unaffected.

## 11. Edge Cases to Address (all covered by the plan)

- [x] Manual confirm on a webhook-already-paid txn → idempotent success, does NOT cancel the paying invoice (Task 3 `confirmed_via` gate)
- [x] Live-QR double-pay residual → I1 local cancel + documented (Task 3/9)
- [x] `enabled:false` hides tab but mid-flight confirm still commits (Task 3, no server enabled-gate)
- [x] Empty manual-BCA window → `{items:[], count:0, totalIdr:0}` + EOD section omitted (Tasks 6/7)
- [x] EOD overflow cap=30 with explicit note (Task 7)
- [x] `useIdempotency` undefined in jsdom → P1

## 12. Approval Conditions

**To approve:** none blocking — plan is approved.

**Folded before execution:**
1. P1 — Task 8 verify-first names the `useIdempotency` jsdom mock.
2. P2 — evidence-gate verdict recorded in the plan.
3. R1/R2/R3 — test-home note, helper reuse, JSON.parse de-hedge.

---

*Generated by /staffreview*
