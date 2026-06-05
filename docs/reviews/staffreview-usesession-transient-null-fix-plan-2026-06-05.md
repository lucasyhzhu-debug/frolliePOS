# Staff Review: `useSession` transient-null fix (PLAN) — issue #44

**Date:** 2026-06-05
**Plan:** `docs/superpowers/plans/2026-06-05-issue-44-usesession-transient-null-fix.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — Goal, File Structure, Tasks with TDD steps, Success Criteria, Rollback all present.

---

## 1. Summary

**Overall Assessment:** Revise (2 Critical, 3 Improvements, 4 Nits — all small, all addressable inline).

The plan is structurally sound, sequences correctly (Task 0 verifies the hypothesis before Task 1 commits the fix; Task 3 removes the workaround AFTER the fix lands; Task 4 un-skips specs LAST so any flake surfaces under the new code path). Code snippets use real signatures and the constant-naming is consistent. The two Critical findings are both narrow:

1. **Task 2 Step 4's "storeSession mid-window" test will fail when executed** — with a static `null` mock, `storeSession("s_new")` cancels the original timer but the effect re-runs and starts a *new* timer for the new id; at +2000ms the assertion that `s_new` survives will fail. Needs the mock to flip during the act.
2. **`refund.spec.ts` un-skip instructions are off by one line** in three places (block size, Files-touched line range, "delete lines 4-12 then change next line" sequence) — an implementer following literally would delete the `test.skip` line they're supposed to change.

Both are surgical edits in the plan. After they're addressed, the plan is approvable for execution.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Test #5 (`storeSession mid-window`) will FAIL when run — leaks a new timer that clears `s_new` | Testing | Task 2 Step 4 |
| 2 | `refund.spec.ts` line numbers off by one + self-contradicting delete instructions | Implementation | File Structure row, Task 4 Files block, Task 4 Step 1 |

### Issue 1: `storeSession mid-window` test is broken as written

The test in Task 2 Step 4 sets `mockUseQuery.mockReturnValue(null)` once and never flips it. Trace through what actually happens:

- t=0: `localStorage = "s_old"`, mock=null. `renderHook` → effect: `validation===null && stored!=null` → schedules timer **T1** at t=1500.
- t=500 (`advanceTimersByTime(500)`): T1 pending; seed present. ✓
- `storeSession("s_new", …)` fires: writes `localStorage = "s_new"`, calls `notify("s_new")` → `setStored("s_new")` in every listener → React schedules re-render.
- act-flush: re-render runs with `stored="s_new"`, `validation` **still `null`** (mock unchanged). Effect dep changed (`stored`: "s_old"→"s_new") → cleanup cancels T1 ✓ → effect body re-runs → **schedules a new timer T2 at t=500+1500=2000**.
- t=2500 (`advanceTimersByTime(2000)`): **T2 fires** → `localStorage.removeItem(SESSION_KEY)` + `notify(null)`.
- Assertion `expect(localStorage.getItem(SESSION_KEY)).toBe("s_new")` → **FAIL** (it's `null`).

In production this never bites because the moment `storeSession(newId)` fires, the next render's `useQuery(getSession, {sessionId: newId})` flips `validation` from `null` to `undefined` (subscription reset → loading) within React's same commit cycle, and the effect early-returns on `validation !== null`. The unit-test mock has no such mechanism.

**Recommendation:** mirror the production flow inside the same `act()` — flip the mock to `undefined` (loading) when storeSession fires:

```typescript
  it("cancels the pending clear when a fresh login arrives mid-window", async () => {
    localStorage.setItem(SESSION_KEY, "s_old");
    mockUseQuery.mockReturnValue(null);

    const { rerender } = renderHook(() => useSession());

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(localStorage.getItem(SESSION_KEY)).toBe("s_old");

    // Fresh login: storeSession writes the new id; the Convex subscription
    // resets to "loading" (undefined) as the query args change.
    act(() => {
      mockUseQuery.mockReturnValue(undefined);
      storeSession(
        "s_new",
        "st_new" as import("../../convex/_generated/dataModel").Id<"staff">,
      );
      rerender();
    });

    // The new effect cycle early-returns (validation === undefined), so no
    // new timer is scheduled. The new id survives past the original deadline.
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(localStorage.getItem(SESSION_KEY)).toBe("s_new");
  });
```

Also rename the test title from "storeSession(newId) mid-pending-timer cancels the clear" to **"…when a fresh login arrives mid-window"** to reflect what the test actually exercises (storeSession + the validation transition that accompanies it in real use).

This also means the spec's Risk 3 wording is half-right: storeSession alone doesn't fully cancel the clear; it cancels *the original* timer but starts a new one. The full safety property is "storeSession + the new query's loading state". The spec text isn't a blocker (the test now demonstrates the real property), but you may want to tweak the spec's Risk 3 wording for accuracy.

### Issue 2: `refund.spec.ts` un-skip instructions are off by one line + self-contradicting

The actual layout in `e2e/specs/refund.spec.ts`:

```
 1: import { test, expect } from "../fixtures";
 2: import { simulateQrisPaid } from "../helpers/xendit-simulate";
 3: (blank)
 4: // SKIPPED: session-loss-on-hard-nav. The signedInAsLucas fixture passes
 5: // (heading + tile + URL all confirm signed-in), but page.goto("/sale") inside
 6: // the spec lands on /login — reproducible on every signedInAs*-fixture spec.
 7: // Likely a Convex client transient null on the session-validation query during
 8: // WS reconnect → useSession.isDead effect clears localStorage. Needs dedicated
 9: // investigation, tracked as the "e2e session-on-hard-nav" follow-up.
10: // Business logic IS covered: convex/refunds/__tests__/refund-status.test.ts +
11: // the refunds module's other unit tests.
12: test.skip("refund: paid sale → mgr refund 1 line with PIN → refund row + receipt updated", async ({ signedInAsLucas: page }) => {
```

The comment block is **8 lines** (4-11). The `test.skip` is on **line 12**, not 13.

The plan says, in three different places:

1. **File Structure row (line 24):** "delete the 9-line `// SKIPPED:` block" — wrong count (8 lines).
2. **Task 4 Files block (line 527):** "`e2e/specs/refund.spec.ts:4-12` (delete the 9-line block) + the `test.skip` on line 13" — both numbers wrong: range 4-12 already includes the `test.skip` (it's on 12), and "line 13" doesn't have `test.skip`.
3. **Task 4 Step 1 (lines 534-536):** "Delete lines 4-12 (the entire `// SKIPPED:` block, which spans from …refunds module's other unit tests). Then on the next line, change `test.skip` → `test`" — internally contradictory: lines 4-12 deletes the comment block AND the `test.skip` line; "next line" after that would be the function body, not a `test.skip` to rename.

An implementer following the plan literally would:
- (a) Delete lines 4-12, removing the comment + `test.skip` line.
- (b) Try to change `test.skip` on the "next line" — but the next line is now the function body, not a `test.skip`.

Result: either they realise mid-task and improvise, or they leave the spec in a broken state.

**Recommendation:** correct all three:

- File Structure row: change "9-line" → "8-line".
- Task 4 Files block: change "`e2e/specs/refund.spec.ts:4-12` (delete the 9-line block) + the `test.skip` on line 13" → "`e2e/specs/refund.spec.ts:4-11` (delete the 8-line block) + the `test.skip` on line 12".
- Task 4 Step 1: change "Delete lines 4-12" → "Delete lines 4-11", and "on the next line, change" stays correct (line 12 becomes "the next line").

The other 5 specs are correctly numbered — I verified `sale-bca-va.spec.ts` (4-5), `sale-qris.spec.ts` (4-5), `spoilage.spec.ts` (3-4), `voucher-offline.spec.ts` (4-5), `voucher-online.spec.ts` (4-5). Only `refund.spec.ts` has the off-by-one.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Wrap Task 0's `console.warn` in an `eslint-disable-next-line` to satisfy `no-console` if active | M | L |
| 2 | Reword Task 1 Step 5 as "insert above line 7" (vs "replace lines 7-13") to avoid Edit-tool ambiguity | M | L |
| 3 | Note in Task 0 that `pull_request` events fire on draft PRs by default — `gh pr ready` is review-status only | L | L |

### Improvement 1: ESLint `no-console` may break Task 0 / `npm run lint`

Task 0's instrumentation uses `console.warn(tag)`. Most React/Vite projects ship with `eslint:recommended` or the strict equivalent, which doesn't ban `console`, but Frollie's `npm run lint` script (`eslint . && bash tools/ci/assert-strict-idempotency-rule.sh`) plus the heavy custom rules in this repo suggest a tightened config. If `no-console` is on, Task 0's instrumentation will fail `npm run lint` and the draft PR's CI may red-light before the e2e workflow even runs.

**Recommendation:** add a defensive `// eslint-disable-next-line no-console` directly above the `console.warn` line in Task 0's instrumentation snippet. Cost: one line of code. Benefit: Task 0 doesn't accidentally fail at lint and waste a CI cycle. The whole block is stripped at the end of Task 0, so the disable lives ≤ 1 commit.

Alternative if `no-console` isn't on: harmless extra comment, ignore.

### Improvement 2: "Replace lines 7-13" is functionally an INSERT — clarify

Task 1 Step 5 says "Replace `src/hooks/useSession.ts:7-13`" and then provides a snippet that includes lines 7-13 **verbatim** as the trailing block, preceded by the new constant + comment. A literal find-and-replace on lines 7-13 would work because the replacement content contains lines 7-13. But:

- An Edit tool that errors on "old_string not unique" could flag the trailing block as matching the constant-free version still in the file (it doesn't, after the edit — but if a partial Edit is retried).
- A reader scanning quickly sees "replace lines 7-13" and the snippet's tail half is "the same code I already have" — confusing.

**Recommendation:** reword to "Insert above line 7 (before the existing `// Module-level subscriber set…` comment) the new constant + leading comment:" and only show the *new* block (constant + comment) in the snippet, not the surrounding context. The reader's mental model is clean ("I'm adding 9 lines above line 7"), and the Edit is unambiguous.

### Improvement 3: `gh pr ready` clarification

Task 5 step 5 says `git push; gh pr ready` and Task 0 step 3 says the workflow fires on PR. Worth noting in Task 0 explicitly: GitHub's `pull_request` event fires on draft PRs by default (`opened`, `synchronize`). The `gh pr ready` in Task 5 is the review-status conversion, not a CI trigger. This avoids the implementer worrying "do I need to mark the draft PR ready before Task 0 step 4?". The answer is no — Task 0's verification works on the draft.

**Recommendation:** one-line note at the end of Task 0 step 2: "Draft PRs trigger `pull_request` workflow events by default; no need to mark ready yet."

## 4. Refinements (Optional)

- **Naming consistency note misses `"s_old"`, `"s_new"`, `"st_new"`.** The "Naming used consistently across tasks" block (lines 32-36) lists `"s_seed"` / `"st_seed"` but the storeSession test introduces `"s_old"` / `"s_new"` / `"st_new"`. Trivially add to the list.
- **`vi.fn<[], unknown>()`** works but is unusual; `vi.fn()` (untyped) or `vi.fn<[], any>()` is more conventional for a mock that returns multiple shapes across tests. Cosmetic.
- **Step 3 of Task 4 lists 7 numbered steps including typecheck/lint/commit.** Could collapse "Step 7: typecheck + lint" and "Step 8: Commit" into a "verify + commit" block — but the current explicit form is fine for an executing agent.
- **Task 5 Step 1 says "Pick one before editing"** for the CHANGELOG version. The default already says v0.5.8. Either remove the indecision (commit to v0.5.8 unless the implementer sees something in the prior 10 commits that argues for v0.5.7.1) or keep as-is. Trivial.

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| `notify(value)` module helper | `src/hooks/useSession.ts:11-13` | Reused in the debounced timeout callback (plan does this correctly). |
| `SESSION_KEY` constant | `src/lib/storage-keys.ts` (re-imported in test setup) | Used in seed-and-assert; plan adds the import in Task 1 Step 1. ✓ |
| `clearSession` + `storeSession` exports | `useSession.ts:67-76` | Used in tests 4 & 5; plan reuses, doesn't reimplement. ✓ |

### Potential duplication risks

- **No new debounce helper.** The plan correctly inlines the `setTimeout` rather than extracting a `useDebouncedEffect` hook — matches the project's "three similar lines is better than a premature abstraction" rule (CLAUDE.md). ✓
- **No new test util.** The plan rewrites the mock plumbing inline in `useSession.test.tsx` rather than adding a shared `convex-react-mock.ts`. Right call — the plumbing is hook-specific and a shared util would be premature.

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|------|------------|-------|
| Task 0 (verify hypothesis) | Good | Correctly placed BEFORE the fix; rollback to a "stop the plan" branch is explicit. |
| Task 1 (hook + first test) | Good | TDD cycle correct: write failing test → confirm fail → implement → confirm pass. |
| Task 2 (remaining 4 tests) | **Needs Test #5 fix** | See Critical #1. Other 3 tests are correct. |
| Task 3 (drop fixture sleep) | Good | Correctly AFTER the hook fix so the workaround removal isn't pre-emptive. |
| Task 4 (un-skip 6 specs) | **Needs refund.spec.ts line numbers** | See Critical #2. Other 5 specs correctly numbered. |
| Task 5 (CHANGELOG + PR ready) | Good | Final wrap with PR conversion. |

**Ordering issues:** None — the dependency chain is hook → fixture → specs, mirroring trust order. Task 0 is correctly insulated as a separate verification PR step.

**Missing phases:** None.

## 7. Specialist Agent Recommendations

| Task | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Task 0 (instrument + verify) | `general-purpose` or main session | Throwaway instrumentation; no specialist needed. |
| Task 1-2 (hook + tests) | `frontend-integrator` or main session | React hook + vitest — frontend-integrator is closest fit, but the scope is small enough for the main session. |
| Task 3-4 (fixture + spec un-skip) | main session | Pure text edits, no specialist value. |
| Task 5 (CHANGELOG + PR) | main session | Documentation + git plumbing. |

No specialist agent is *required* for this plan. If using subagent-driven-development per the plan's header recommendation, one fresh subagent per Task (1, 2, 4) is the natural decomposition.

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ (`worktree-plan-issue-44-usesession-fix`, named in Task 0 Step 2) |
| Branch naming follows convention | ✅ (matches existing `worktree-*` pattern visible in `git worktree list`) |
| Merge strategy documented | ⚠️ Plan doesn't explicitly say "squash-merge" but the project convention is squash-merge (CLAUDE.md + ship-it skill memory) — implementer will follow project default. Acceptable. |

### Commit checkpoints

The plan commits at these natural boundaries (one per task):

1. After Task 0 instrumentation → `chore(temp): instrument useSession transitions for issue #44 verification`
2. After Task 0 strip → `chore(temp): revert #44 instrumentation — hypothesis confirmed`
3. After Task 1 fix + first test → `fix(useSession): debounce dead-session clear (issue #44)`
4. After Task 2 timing tests → `test(useSession): add 4 debounced-clear timing tests (issue #44)`
5. After Task 3 fixture edit → `fix(e2e): drop awaitSignedIn warm-up sleep — superseded by useSession debounce`
6. After Task 4 un-skip → `test(e2e): un-skip 6 PIN-gated specs after useSession fix (issue #44)`
7. After Task 5 CHANGELOG → `docs(changelog): v0.5.8 — useSession transient-null fix (issue #44)`

That's 7 commits on a feature branch, all with conventional-commit prefixes (`fix`, `test`, `chore`, `docs`). Squash-merge at PR time will fold them into one. Natural boundaries — each commit is independently revert-able if needed during execution.

### Pre-push verification

- [x] `npm run typecheck` in plan — yes, Task 1 Step 8, Task 2 Step 6, Task 3 Step 2, Task 4 Step 7, Task 5 Step 3.
- [x] `npm run lint` in plan — yes, Task 4 Step 7 (also covers the CHANGELOG / fixture edits transitively via the same step).
- [x] `npm run test` in plan — implicit (Task 1/2 run `npx vitest run src/hooks/useSession.test.tsx`); Success Criteria explicitly calls `npm run test` for full-suite regression.
- [x] Local testing before push — yes, Task 0 step 2 pushes only the instrumentation; real fix lands across multiple commits before final push in Task 5.

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ documented — explicit Rollback section covering both hypothesis-refuted and fix-lands-but-e2e-still-red branches. |
| Deployment order | ✅ — frontend-only change, no schema, no backend. PR squash-merge → Vercel deploys frontend; no Convex deploy needed. |
| Data backup needed | No — client-only race fix. |
| Migration safety | N/A — no schema change. |

## 9. Documentation Checkpoints

| Task | Docs to update |
|------|----------------|
| Task 5 | `docs/CHANGELOG.md` — one-line v0.5.8 entry citing issue #44. |
| None | `CLAUDE.md` / `docs/SCHEMA.md` / `docs/API_REFERENCE.md` — no public-API / business-rule changes. |

### CHANGELOG draft

The plan's draft (Task 5 Step 2) is correctly shaped — matches the "## v0.5.X — date — kind / ### Fixed" pattern used elsewhere in `docs/CHANGELOG.md`. No edits needed; just fill the date at ship time.

## 10. Testing Plan Assessment

**Verdict:** Adequate after Critical #1 is fixed.

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Unit | `useSession` transient null ignored | `vitest` + RTL + fake timers | Planned ✓ |
| Unit | `useSession` sustained null clears at 1500ms | `vitest` + RTL + fake timers | Planned ✓ |
| Unit | `useSession` real→null transition | `vitest` + RTL + fake timers | Planned ✓ |
| Unit | `clearSession` mid-window | `vitest` + RTL + fake timers | Planned ✓ |
| Unit | `storeSession` mid-window | `vitest` + RTL + fake timers | **Planned but BROKEN — see Critical #1** |
| Unit | Existing 3 (none / storeSession-notify / clearSession-notify) | unchanged | Plan keeps them green ✓ |
| E2E | 6 PIN-gated specs un-skipped | Playwright (CI) | Planned ✓ — acceptance via workflow run. |

### Missing test coverage (must add)

None — the 5 unit tests + 6 e2e specs cover the spec's stated cases comprehensively.

### Test execution checkpoints

1. After Task 0 — CI e2e on the draft PR (verify hypothesis).
2. After Task 1 — `npx vitest run src/hooks/useSession.test.tsx`.
3. After Task 2 — `npx vitest run src/hooks/useSession.test.tsx` (8 tests pass).
4. Final: `npm run test` (full suite) + e2e CI on the ready PR.

### Regression risk

- Other test files mock `useSession` directly (`AppHeader.test.tsx`, `SpokeLayout.test.tsx`) — isolated, no impact.
- `router.test.tsx` — verify it still passes (no `useSession` internal coupling).
- `RootLayout` — manual smoke test mentioned in plan? Looking back, no — but the e2e specs cover this transitively via the post-login `page.goto` path. Acceptable.

## 11. Edge Cases to Address

- [x] Transient null during reconnect — Test #1
- [x] Sustained null (genuine stale session) — Test #2
- [x] Real→null transition (logged out elsewhere) — Test #3
- [x] `clearSession()` mid-pending-timer — Test #4
- [x] `storeSession(newId)` mid-pending-timer — Test #5 (NEEDS FIX per Critical #1)
- [ ] `useSession` test under React 19 StrictMode double-effect — not tested, but StrictMode would simply mount/unmount the hook twice, which fires the effect cleanup → timer cancelled → no leak. Edge case; optional to add a StrictMode-mounted variant.
- [ ] Memory leak if the hook unmounts mid-timer — covered by the `clearTimeout` in the effect's cleanup return. ✓ verified in the implementation snippet.

## 12. Approval Conditions

**To approve the PLAN for execution:**

1. ✅ Fix Critical #1 — rewrite Test #5 to flip the mock to `undefined` during the storeSession `act()`, mirroring the production validation transition. Optionally update the test title and the spec's Risk 3 wording.
2. ✅ Fix Critical #2 — correct `refund.spec.ts` line numbers in the File Structure row, Task 4 Files block, and Task 4 Step 1 prose ("8-line block, lines 4-11, `test.skip` on line 12").

**Strongly recommended before execution:**

3. Improvement 1 — `eslint-disable-next-line no-console` on the Task 0 `console.warn`.
4. Improvement 2 — reword Task 1 Step 5 as "insert above line 7" with only the new content in the snippet.
5. Improvement 3 — one-line note that draft PRs trigger workflows by default.

**Optional polish:** §4 Refinements.

---

*Generated by /staffreview — plan gate*
