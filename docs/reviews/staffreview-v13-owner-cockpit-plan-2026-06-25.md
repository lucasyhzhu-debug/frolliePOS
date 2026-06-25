# Staff Review: v13 Owner Cockpit — Implementation Plan

**Date:** 2026-06-25
**Plan:** `docs/superpowers/plans/2026-06-25-v13-owner-cockpit.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, Global Constraints, Task List, Execution Strategy, File Structure, per-task TDD steps, Verify-First checklist, Self-Review all present)

---

## 1. Summary

**Overall Assessment:** Approve (2 inline fixes applied).

The plan covers all six Spec-3 streams with real, grounded code. This gate's job — verifying the plan's flagged assumptions against shipped code — confirmed **5 of 7 correct as written** (`withActionCache` 4-arg shape, `_assertCockpitSession_internal → {staffId}`, `wibDayWindow → {dayStartMs,dayEndMs,dateLabel}`, `staff.by_active`, `logAudit` stringifies internally) and caught **2 field/index name drifts**, both fixed inline.

## 2. Critical Issues (Must Fix) — FIXED INLINE

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `DaySummary` fields are `gross`/`refundsTotal`/`net`/`count` — plan T7 used `txnCount`/`refundTotal` | Logic/Naming | T7 |

### Issue 1: Dashboard field names
`computeDaySummary` returns `DaySummary` with `{ gross, refundsTotal, net, count, ... }` (`convex/transactions/lib.ts:68`). T7 read `s.txnCount` and `s.refundTotal`, which don't exist → typecheck + runtime failure. **Fixed:** T7 now reads `s.gross` / `s.count` / `s.refundsTotal` (the consolidated return keeps the friendly `txnCount`/`refundTotal` key names mapped from `s.count`/`s.refundsTotal`).

## 3. Improvements (Recommended) — FIXED INLINE

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | `pos_stock_levels` has `by_outlet_sku`, not `by_outlet` | M | L |

### Improvement 1: Stock-skip test index
T5's atomic-rollback/skip-stock test queried `pos_stock_levels.withIndex("by_outlet", …)` — that index doesn't exist; the table has `by_outlet_sku` (`["outlet_id","inventory_sku_id"]`, `convex/inventory/schema.ts:40`). **Fixed:** the assertion now uses `by_outlet_sku` with a partial range on `outlet_id`. Verify-first item 5 updated to the real index name.

## 4. Refinements (Optional)

- T5 test seeds `pos_stock_levels` with illustrative fields — the executor should match the real `pos_stock_levels` field set (verify-first item 5 flags this).
- The cache stores `JSON.stringify({ outlet_id })`; the `Id` round-trips as a string — T6's `{ outlet_id: string }` return type is correct.

## 5. Duplication Analysis

✅ The plan already maximizes reuse (the spec staffreview's whole point): `withActionCache`, `_assertCockpitSession_internal`, `_listActiveOutlets_internal`, `_fetchDayWindow_internal`, `computeDaySummary`, `wibDayWindow`, `grantOutletAccessRow` (extracted from the existing internal). No new duplication introduced. `_listAssignableStaff_internal` is genuinely new (no existing projection returns `{_id,name,code,role}` without pin_hash for a cockpit caller).

## 6. Phase / Wave Accuracy

| Wave | Assessment | Notes |
|------|------------|-------|
| 1 (T1–T4) | Good | 4 modules, no shared files — true parallel; none regens api |
| 2 (T5→T6) | Good | shared `cockpit/outlets.ts` correctly serialized |
| 3 (T7) | Good | solo; regen after |
| 4 (T8–T11) | Good | `src/router.tsx` (T10→T11) + `RootLayout.tsx` (T8) serialization called out |
| 5 (T12 + close-out) | Good | docs + `/triple-review`→`/simplify xhigh` in main session |

**Ordering issues:** none. **Missing phases:** none.

## 7. Specialist Agent Recommendations

| Wave | Agent | Rationale |
|------|-------|-----------|
| 1–3 (BE) | `convex-expert` | clone + cross-outlet readers are Convex-shaped (ROADMAP tag) |
| 4 (FE) | `/frontend-design` per task | standing rule; switcher/dashboard/wizard are net-new UI |
| close-out | `/triple-review`, `/simplify` | main-session QA gate |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch | ✅ pipeline worktree off synced `main` |
| Commit boundaries | ✅ one commit per task, templates given |
| Pre-push verification | ✅ `npm run typecheck && npx vitest run` before merge |
| Rollback | ✅ cockpit module + route subtree independent (spec §344) |
| Deployment order | ✅ no schema table change; audit-union widening additive |
| Migration safety | ✅ forward-only |

## 9. Documentation Checkpoints

T12 covers CHANGELOG + API_REFERENCE + ROADMAP removal + CLAUDE.md module row + SCHEMA.md (verb/source). ✅

## 10. Testing Plan Assessment

**Verdict:** Adequate. Every BE function has TDD steps (helpers, atomic mutation incl. atomic-rollback + OUTLET_CODE_TAKEN + created_by + skip-stock, action idempotency + auth-rejection, dashboard fan-out). FE tasks carry render/interaction/validation tests. Money assertions use known values.

### Regression risk
- T4 refactors `_grantOutletAccess_internal` onto the new helper — re-run `npx vitest run convex/auth` (existing grant tests must stay green; behavior/args unchanged).
- T1 widens the audit union — re-run audit module tests.
- T9 replaces the placeholder `cockpit/index.tsx` — update its existing test (`src/routes/cockpit/__tests__/index.test.tsx`).

## 11. Edge Cases to Address

- [x] `OUTLET_CODE_TAKEN` before any write (T5)
- [x] Atomic rollback on mid-clone throw (T5)
- [x] Blank-mode settings seed (T5)
- [x] Owner skipped + dedup in grant (T4/T5)
- [x] Non-cockpit session → `NOT_COCKPIT_SESSION` (T6)
- [x] Idempotent createOutlet re-run (T6)
- [ ] Cockpit idle-timeout keepalive wired in `CockpitShell` (T8) — owner-smoke after merge

## 12. Approval Conditions

**To approve:** Issue 1 (dashboard field names) + Improvement 1 (stock index) — **both fixed inline.**

**Recommended before implementation:** honor the Verify-First checklist (the 5 confirmed items need no re-check; items adapt test-seed field sets to reality).

**Verdict:** Plan is **execution-ready.** Dispatch via subagent-driven-development, wave-gated.

---

*Generated by /staffreview*
