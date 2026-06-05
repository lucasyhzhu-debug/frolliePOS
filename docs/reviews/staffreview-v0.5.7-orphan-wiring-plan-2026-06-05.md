# Staff Review: v0.5.7 — Orphaned-function wiring (PLAN)

**Date:** 2026-06-05
**Plan:** `docs/superpowers/plans/2026-06-05-v0.5.7-orphan-wiring.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — Goal, File-structure, TDD tasks, Testing, Success criteria, Rollback all present.

---

## 1. Summary

**Overall Assessment:** Approve (with one Improvement applied)

The plan is execution-ready: real signatures, exact line targets, TDD steps with expected fail/pass, atomic per-part commits, correct backend-first ordering. All flagged assumptions verified against code and hold. One **Improvement** (not a blocker): the Part A audit-route test diverges from the established sibling-mgr-test mocking pattern — aligning it removes a small fragility. No Critical issues.

## 2. Critical Issues (Must Fix)

None. The execution-time risks I probed all clear:

- **`ctx.runQuery` inside a `query` is valid here** — `transactions.public.listRecentAwaitingPayment` (`public.ts:396`) already does exactly this (`ctx.runQuery(internal.auth.internal._resolveSession_internal, ...)`). Task 1's `ctx.runQuery(internal.auth.internal._listStaffNames_internal, {})` is the same pattern. ✓
- **`__test_log` accepts the system-source row** — its `sourceValidator` (`audit/internal.ts:6-12`) includes `v.literal("system")` and `actor_id` is `v.union(v.id("staff"), v.literal("system"))`. The `{ actor_id: "system", source: "system" }` insert validates. ✓
- **`getFunctionName` dispatch substrings don't collide** — `api.audit.public.list` → name contains `"audit"`; `auth.public.getSession` → `"...getSession"` (does NOT contain `"audit"`: `auth` ≠ `audit`). `listRecentAwaitingPayment` is a distinct substring. No cross-matching. ✓
- **`FunctionReturnType<typeof api.audit.public.list>[number]` carries `actor_name`** — Convex infers the return type from the handler (no explicit `returns` validator), so the mapped `& { actor_name: string }` flows through. Same mechanism `refunds-pending.tsx:36` and `history/$txnId` rely on. ✓
- **Exact line targets confirmed:** `router.tsx:67` (`MgrStock` import) + `:121` (`mgr/stock` route); `home.tsx:7/50/86-93`; `mgr/home.tsx:22` (`Stock drift` NAV_CARD); `refund/detail.tsx:3/65-67/253/284-290/116`; `ApprovalPending.tsx:13/21/49-58`. All accurate. ✓

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Align the Part A audit-route test with the sibling-mgr-test `getSession`-dispatch pattern | M | L |

### Improvement 1: Audit-route test should follow the established mgr-test mocking pattern

The plan's Task 2 test wholesale-mocks `@/hooks/useSession` (`vi.mock("@/hooks/useSession", ...)`). The route tree renders `MgrAudit → SpokeLayout → AppHeader`, and **`AppHeader` calls `useSession()`** (`AppHeader.tsx:18`). Because `AppHeader` imports *only* `useSession` (not `clearSession`/`storeSession`), the wholesale mock happens to satisfy it — so this would **function** — but:

1. **It diverges from every sibling mgr-route test.** `refunds-pending.test.tsx`, `stock.test.tsx`, `spoilage.test.tsx`, `dashboard.test.tsx` all use the **`getSession`-dispatch** pattern: mock `convex/react`, dispatch `getSession → mockSessionReturn` + the page query, set `localStorage[SESSION_KEY]`, and let the *real* `useSession` (and `AppHeader`'s) run. Consistency matters for maintenance.
2. **It's more fragile** — if a future refactor makes `AppHeader` (or any tree member) import another `useSession` export, the wholesale mock silently omits it.

**Recommendation:** Rewrite Task 2's test to mirror `src/routes/mgr/__tests__/refunds-pending.test.tsx`: mock `convex/react` dispatching `audit → mockRows` and `getSession → mockSessionReturn`; wrap in `ConvexProvider + MemoryRouter`; `localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID)`; keep the `<Route path="/">` redirect sentinel (the route uses `<Navigate>`, unlike refunds-pending's inline message). (Applied to the plan inline — see revision commit.)

*(The Part B home test legitimately keeps hook-boundary mocking — `home.tsx` drives many side-effecting hooks (IDB `useIdempotency`/`useCatalogCache`, Web-Bluetooth `PrinterSheet`, timer `useRecountNudge`); isolating the banner via hook mocks is the robust choice there, and `home` imports both `useSession` + `clearSession`, which the mock provides. No change needed.)*

## 4. Refinements (Optional)

- Part A `AuditCard`: `entity_id` for some verbs is a Convex `_id` string — fine to show raw; no friendlier label exists. Leave as-is.
- Part A glyph `❡` — confirm it renders in the app font; fall back to `⧉` or `≣` if not. Cosmetic.
- Task 6 doc steps are prose (find-the-row) rather than exact diffs — acceptable for CLAUDE.md/CHANGELOG; executor has enough context.

## 5. Duplication Analysis

No duplication. The plan correctly **extends** `audit.public.list` (not a parallel query), **reuses** `_listStaffNames_internal` (the exact `transactions/internal.ts:593` pattern), clones `useRecountNudge`'s shape for the new hook, and mirrors `refunds-pending.tsx` for the spoke. `ApprovalPending` gains one optional prop rather than a wrapper. ✓

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| Task 1 (A backend) | Good | Correctly SEQUENTIAL-first — FE row type depends on it. |
| Tasks 2/3/4/5 | Good | Independent files; could parallelize but sequential is fine for one executor. Task 5 depends on Task 4 (prop must exist). |
| Task 6/7 (docs/verify) | Good | Last. |

**Ordering issues:** none. **Missing phases:** none.

## 7. Specialist Agent Recommendations

| Work | Agent | Rationale |
|------|-------|-----------|
| All tasks | TDD subagents via `superpowers:subagent-driven-development` | Plan is fully spelled out; one subagent per task + review fits. |
| (Alt) Task 1 | `convex-expert` | If splitting backend out. |
| (Alt) Tasks 2-5 | `frontend-integrator` | Hook/route/component wiring. |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch | ✅ worktree `worktree-v0.5.7-orphan-wiring` |
| Atomic commits | ✅ one per task with `feat(v0.5.7):` / `docs(v0.5.7):` templates |
| Pre-push typecheck/build/lint | ✅ Task 7 |
| Rollback | ✅ FE + additive field; per-commit `git revert` |

## 9. Documentation Checkpoints

| Item | Planned? |
|------|----------|
| CLAUDE.md file-locations (+`/mgr/audit`, +`useAwaitingPaymentRecovery`) | ✅ Task 6 |
| docs/CHANGELOG.md v0.5.7 | ✅ Task 6 |
| docs/PROGRESS.md + progress.html | ⏳ pipeline step 6 (post-plan, separate) |
| docs/API_REFERENCE.md (`actor_name` on `audit.public.list`) | ➕ recommend adding to Task 6 |

## 10. Testing Plan Assessment

**Verdict:** Adequate.

| Layer | What | Type | Status |
|-------|------|------|--------|
| Backend | `audit.public.list` attaches `actor_name` (staff + system) | convex-test | planned |
| FE | audit page: manager rows / non-manager redirect / filter arg / load-more | vitest | planned |
| FE | `useAwaitingPaymentRecovery`: loading / empty / max-by-created_at | vitest | planned |
| FE | home banner: show w/ link / hide | vitest | planned |
| FE | `ApprovalPending`: cancel only in pending + only with onCancel; click calls it | vitest | planned |

**Coverage note (host gate):** the refund-host manager-gate is a trivial ternary fully covered by the component contract (button renders iff `onCancel` truthy). The plan explicitly accepts this rather than a heavy route-integration test — reasonable; `/triple-review` may add one.

### Regression risk
- `audit.test.ts` existing manager-read test still asserts `rows.length` — unaffected by the additive `actor_name`. ✓
- `refund/detail.tsx` change is additive (new hook + handler + one prop) — existing refund tests unaffected; re-run `src/routes/refund/__tests__/` in Task 7's full suite.

## 11. Edge Cases to Address

- [x] Part A unknown `actor_id` → falls back to raw id (covered in impl).
- [x] Part B `latest` = max `created_at` via reduce, not `[0]`.
- [x] Part C one-shot UUID key; non-manager never gets `onCancel`.
- [ ] Confirm `npm run build`'s `tsc -b` includes test files; if so the typed mocks must compile (they do — `Task 7 Step 1` `tsc --noEmit` catches first).

## 12. Approval Conditions

**To approve:** none blocking.
**Recommended before implementation:**
1. Apply Improvement #1 (audit-test pattern alignment) — done inline in the plan revision.
2. Add `docs/API_REFERENCE.md` `actor_name` note to Task 6 (optional).

---

*Generated by /staffreview*
