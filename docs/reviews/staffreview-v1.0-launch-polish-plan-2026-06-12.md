# Staff Review: v1.0 Launch — Polish Slice + Go-Live (plan)

**Date:** 2026-06-12
**Plan:** `docs/superpowers/plans/2026-06-12-v1.0-launch-polish.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (goal, file changes, ordered tasks, tests, gates, rollback all present)

---

## 1. Summary

**Overall Assessment:** Revise (1 Critical in planned test code, 3 Improvements — all fixed inline in this pass)

The plan is concrete, grounded in a static audit that was verified against real code, and keeps the money path untouched. The one Critical is a planned test that would fail as written (mock shape vs `SpokeLayout → AppHeader → ConnDot` composition). Assumption verification against the codebase: helper names, deps, e2e references all checked — details below.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Task 4 stock test mocks `convex/react` wholesale (only `useQuery`) — `AppHeader`/`ConnDot` call `useConvex`, so the render crashes | Testing | Task 4 Step 1 |

### Issue 1: Stock test mock shape breaks on layout composition

`SpokeLayout` renders `AppHeader` (`src/components/layout/SpokeLayout.tsx:10`), which renders `ConnDot`, which calls `useConvex`. The planned `vi.mock("convex/react", () => ({ useQuery: vi.fn() }))` removes `useConvex`/`ConvexProvider` and the test fails at render, not at the assertion.

**Recommendation:** Use the partial-mock idiom already established in `src/routes/sale/charge.test.tsx:45` (`importOriginal` + override `useQuery` only) and wrap the render in a real `ConvexProvider` with a fake client (idiom from `drafts.test.tsx`). Plan updated with corrected code.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Task 3 test sketch names a nonexistent helper — real one is `renderAt(txnId)` (`charge.test.tsx:190`); awaiting-payment fixture at line 123 | M | L |
| 2 | Method toggle is shadcn `Tabs` (`charge.tsx:489`) — offline-disable lands on each `TabsTrigger disabled={!isOnline}`, not a generic "toggle control" | M | L |
| 3 | Task 5 must note: `e2e/specs/spoilage.spec.ts:49` reads `"<n> pcs"` off `/stock` rows — the empty-state branch must leave the rows branch byte-identical | M | L |

### Verified assumptions (the cheap-win checklist)

- `renderHook` available: `@testing-library/react@16.1.0` ✅ (`package.json:60`)
- No ConnDot unit test exists — Task 2's full-suite run is the only regression net needed ✅
- No e2e spec references the `Stock in` tile, `/stock/in`, or any version-tag hint text — tile removal + hint rewrite are e2e-safe ✅ (only `spoilage.spec.ts:49` touches `/stock`, via the rows format, unchanged)
- `charge.test.tsx` mocks `convex/react` partially via `importOriginal` and mocks `useSession`/`useXenditPayment` — the planned `useIsOnline` mock fits this file's idiom ✅
- `listInventory` row shape (`skuId`, `name`, `on_hand`, `status`) matches the planned mock ✅ (read from `src/routes/stock/index.tsx:18-24`)
- Tile **labels** are unchanged by Task 5 (only hints + one tile removed), so any label-based navigation in tests keeps working ✅

## 4. Refinements (Optional)

- `ConnDot`'s `"queued"` state was dead before the refactor and stays dead — leave it; removing is v1.0.1 noise.
- Task 2 Step 6 could use `npm run test` instead of `npx vitest run src`; either is fine.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| Partial `convex/react` mock | `src/routes/sale/charge.test.tsx:45` | Task 4 test (corrected) |
| `ConvexProvider` + fake client | `src/routes/sale/drafts.test.tsx` | Task 4 render wrapper |
| Dashed-border empty-state card | `src/routes/sale/drafts.tsx:108` | Task 4 markup mirrors it |
| ConnDot state logic | `src/components/layout/ConnDot.tsx` | Becomes `useIsOnline` (Task 2) — single source |

### Potential duplication risks
- None new; Task 2 *removes* a future duplication (charge would otherwise re-implement connection state).

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| T1 audit doc | Good | Static table already verified; e2e run is the browser confirmation |
| T2 → T3 | Good | Hook before consumer — correct dependency order |
| T4, T5 | Good | Independent of T2/T3; could run parallel but sequential is fine at this size |
| T6–T8 docs + QA + merge | Good | Runbook before CHANGELOG before gate |
| T9 ops | Good | Deploy → probe → Telegram → seed → smoke → tag; each gates the next |

**Ordering issues:** none. **Missing phases:** none.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| T2–T5 | main session or `ui-component-builder` | Small bounded UI edits in existing idiom |
| T9 | main session, human-in-loop | Prod actions with Lucas present |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ `feat/v1.0-launch-polish` |
| Branch naming follows convention | ✅ |
| Merge strategy documented | ✅ squash-PR + post-merge main sync |

Commit checkpoints: one per task (T1–T7), QA-fix commits in T8 — atomic. Pre-push: full gate in T7 Step 2 and re-run in T8 Step 3 ✅. Rollback: presentation-only revert + re-runnable deploys, documented ✅. Data backup: not needed (no schema/data writes). Migration safety: N/A.

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| T1 | `docs/reviews/v1.0-launch-audit-2026-06-12.md` |
| T6 | `docs/RUNBOOK.md` §7 |
| T7 | `docs/CHANGELOG.md` |
| T9 | `docs/PROGRESS.md` (+ `progress.html`) via `/progress-update` |

CHANGELOG draft: already in plan Task 7 ✅. CLAUDE.md: no rule changes (route removal is minor; optional line in v1.0.1).

## 10. Testing Plan Assessment

**Verdict:** Adequate

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Frontend | `useIsOnline` (3 cases: connected, flip, no-API fallback) | vitest renderHook | planned |
| Frontend | charge offline banner + disabled actions | vitest component (existing file) | planned |
| Frontend | `/stock` empty + populated | vitest component (new file, corrected mocks) | planned |
| Frontend | home tiles / router after removal | full-suite run + fix-forward | planned |
| Integration | full Playwright e2e | `npm run test:e2e` | planned (T7 gate) |
| Prod | money loop incl. refund + settle ack | manual smoke (T9 S6) | planned |

### Missing test coverage (must add)
None blocking — Critical 1's corrected test restores the planned coverage.

### Regression risk
- `spoilage.spec.ts` (reads `/stock` rows) — protected by leaving the rows branch untouched.
- Any test asserting home-tile hints — none found; full-suite run in T5 Step 3 is the net.

## 11. Edge Cases to Address

- [x] Offline mid-charge: banner copy explicitly says an already-scanned QR still confirms server-side (webhook), preventing double-scan behavior — matches RUNBOOK §7.2.
- [x] `/stock` empty on launch morning (pre-seed) — exactly Task 4.
- [x] `useIsOnline` on Convex clients without the state API → defaults online (no false blocking).
- [ ] Charge screen offline flicker on transient WS drops — accept; banner is informational and actions re-enable on reconnect.

## 12. Evidence-Before-Mitigation Gate

N/A in the flake sense — no timing/debounce/retry changes proposed. The audit's "fix list" cites verified code locations (stub at `src/routes/stock/in.tsx`, blank-list render at `src/routes/stock/index.tsx:17`, no offline guard in `charge.tsx` — grep-verified), so every fix addresses a directly observed mechanism.

## 13. Approval Conditions

**To approve, address (done inline this pass):**
1. Correct Task 4 test mocks (partial mock + ConvexProvider).

**Recommended (done inline):**
1. Task 3: name `renderAt` + fixture line; `TabsTrigger disabled`.
2. Task 5: spoilage-spec note.

---

*Generated by /staffreview*
