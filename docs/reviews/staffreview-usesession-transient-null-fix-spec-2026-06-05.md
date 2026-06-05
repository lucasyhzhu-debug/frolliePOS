# Staff Review: `useSession` transient-null fix (SPEC) — issue #44

**Date:** 2026-06-05
**Plan:** `docs/superpowers/specs/2026-06-05-useSession-transient-null-fix-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** Reviewed as a SPEC — implementation-plan sections (commit boundaries, wave ordering, full file diffs) are deferred to the writing-plans gate, not dinged here.

---

## 1. Summary

**Overall Assessment:** Approve with Improvements (no Critical findings).

The spec is architecturally sound and grounded in real code. The suspect block (`src/hooks/useSession.ts:47-55`), the gate logic (`RootLayout:40` loading, `:48` redirect), the fixture workaround (`e2e/fixtures.ts:41`), the test mock surface (`useSession.test.tsx:6-8`), and the `getSession` query (`convex/auth/public.ts:23-37`) all match the spec's description. The chosen fix shape — `setTimeout` inside the effect with cleanup-on-deps-change — is the correct correction of the issue's literal Option A and is the simplest behavioural change that satisfies acceptance. No blocking issues.

Four improvements sharpen the test plan (mock-hoist gotcha, `act()` boundaries, fake-timer cleanup, hypothesis verification) and one small spec/version-target nit. All resolvable inline before the writing-plans gate.

## 2. Critical Issues (Must Fix)

None.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Pin the mock-hoist pattern AND re-render trigger in the test plan | H | L |
| 2 | Specify `act()` wrap around `vi.advanceTimersByTime()` + fake-timer cleanup | M | L |
| 3 | One-pass hypothesis verification before claiming the fix in CI | M | L |
| 4 | Name the CHANGELOG target version (or explicitly defer the choice) | L | L |

### Improvement 1: Lock down the mock plumbing — `vi.hoisted()` + forced re-render

The spec says (line 138):

> Mock plumbing: switch from `vi.mock("convex/react", () => ({ useQuery: () => undefined }))` to a `vi.fn()` whose return value is controllable via a ref.

Two practical landmines aren't called out:

**(a) `vi.mock()` factories are hoisted above imports.** A bare `let mockReturn: any = undefined` declared outside the factory is referenced inside it, which can fail under strict hoisting (or work today and break on a vitest minor bump). The robust idiom is `vi.hoisted()`:

```ts
const { mockUseQuery } = vi.hoisted(() => ({
  mockUseQuery: vi.fn<[], unknown>().mockReturnValue(undefined),
}));
vi.mock("convex/react", () => ({ useQuery: mockUseQuery }));
```

Each test then drives the value via `mockUseQuery.mockReturnValue(realSession)`.

**(b) Changing the mock return value does NOT trigger a re-render.** The real Convex `useQuery` subscribes to a server signal; the mock has no such mechanism. Test #1 ("flip mock to a real session value; assert status ends 'active'") will hang at `status: "none"`-or-`"loading"` unless the test forces React to call the mocked hook again. Use `renderHook`'s `rerender`:

```ts
const { result, rerender } = renderHook(() => useSession());
// ...
mockUseQuery.mockReturnValue(realSession);
act(() => { rerender(); });
```

**Recommendation:** the plan should specify both the `vi.hoisted()` factory and the `rerender()` trigger explicitly, with one-line test skeletons for tests #1 and #3. Without this, a test author will produce flaky or false-passing tests and the e2e gate will be the only real signal — defeating the unit-test layer the spec promises.

### Improvement 2: `act()` wrap around `vi.advanceTimersByTime(...)` + fake-timer hygiene

When the debounced `setTimeout` fires, the callback runs `localStorage.removeItem + notify(null)`, and `notify` calls `setStored(null)` on every mounted hook — a React state update. Outside `act()`, this produces "not wrapped in act(...)" warnings and the assertions can race the rerender. The plan must specify:

```ts
act(() => { vi.advanceTimersByTime(DEAD_SESSION_CONFIRM_MS); });
```

Additionally, the existing `beforeEach` clears `localStorage` + `clearSession()` but not timers. With `vi.useFakeTimers()`, a test that *doesn't* advance the timer leaves a pending `setTimeout` behind, which leaks into the next test (potentially firing during the next test's `renderHook` and clearing storage). Plan must add `vi.clearAllTimers()` and (per test-suite preference) `vi.useRealTimers()` to `afterEach`, or scope fake timers per-test with `vi.useFakeTimers()` at the top of each timing test.

**Recommendation:** plan should include the `afterEach` / per-test timer scoping decision explicitly, plus `act()` around every timer advance.

### Improvement 3: One-pass hypothesis verification before declaring CI green

The spec accepts the issue's hypothesis verbatim: `useQuery` transiently returns **`null`** (not `undefined`) during WS resubscribe after hard-nav. If empirically the transient state is `undefined` end-to-end (i.e., the subscription never yields a stray `null` between the WS handshake and the real row), the debounced effect is a **no-op for the e2e bug** — the fix lands, the 6 specs still fail, and we burn a PR cycle plus a CI run discovering it.

Cheap mitigation: in the same PR, add a one-shot debug pass *before* concluding "the fix is good":

- Option A (in-band, kept after merge): change the render-time short-circuit so when `validation === null && stored != null` we also stash the last 5 validation transitions in a `sessionStorage` debug key. Plain Playwright assertion reads it after the failing `page.goto` and prints. Strip before merge.
- Option B (out-of-band, throwaway): a tiny temporary `console.warn("[useSession]", { stored, validation })` in the hook; run one CI pass on a draft PR; verify the warn log contains `validation: null` post-`page.goto`; then strip the warn and ship.

This is *risk mitigation*, not a redesign. The fix shape is fine for either of the two transient-value scenarios (`null` or `undefined`) because the early return treats `undefined` as a no-op — but if the e2e specs need a *different* mechanism (e.g., the issue is actually the WS-disconnect-during-subscribe leaving `validation` stuck), we want that signal cheaply.

**Recommendation:** plan should include the verification step (Option A or B) as Task 1, before the fix itself. If Task 1 confirms the null hypothesis, proceed with the spec'd fix. If it shows `undefined` only, escalate before writing the fix code.

### Improvement 4: Name the CHANGELOG target version (or explicitly defer)

The spec's Files-touched table says:

> `docs/CHANGELOG.md` — One-line entry under the next patch version (handled at plan/execute time).

Latest shipped is **v0.5.7** (commit 4befe11, in `git log` and CHANGELOG). A bug-only PR like this typically lands as a v0.5.7 patch or v0.5.8. Leaving it open invites the plan-author/implementer to guess. Either:

- Name the target (`v0.5.7.1` / `v0.5.8` / "fast-follow under v0.5.7"); or
- Add one line: "Version target decided at plan time based on what else lands in the window — default v0.5.8 if isolated."

**Recommendation:** add the explicit deferral line; it costs nothing and removes ambiguity.

## 4. Refinements (Optional)

- **Line-reference drift.** Spec says `e2e/fixtures.ts:awaitSignedIn` line "~46"; actual line is **41** (the `await page.waitForTimeout(1500)` after the URL check). Trivial inline tweak.
- **Skip-block size variance across specs.** `refund.spec.ts` has a **9-line** `// SKIPPED:` block (lines 4-12) — the other 5 specs have a 2-line block. The spec's "delete the tracking-note block" applies to both shapes; just be explicit that on `refund.spec.ts` it's the entire multi-line block, not the one-liner the other 5 specs use.
- **`useSession.ts:47-48` comment "Fix V17" gets superseded.** The existing comment ("Fix V17: remove the dead session from storage in an effect, not during render. `validation === null` means the session row no longer exists (expired/deleted).") becomes stale once the effect is debounced — the implementer should replace it with the new docstring naming `DEAD_SESSION_CONFIRM_MS` and the failure mode, not leave both side-by-side.
- **Decision #2 cites PR #41 as the source of the 1500ms warm-up.** Confirmed against `git log --oneline -10` (`1ee39a5 fix(e2e): 1.5s settle window in signedIn fixture for Convex client warm-up (#41)`). No action — sourced correctly.

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| `notify(value)` module-level helper | `src/hooks/useSession.ts:11-13` | Reuse as-is in the debounced clear callback (the spec already does). |
| `SESSION_KEY` constant | `src/lib/storage-keys.ts` (imported on line 5) | Reuse the same key for the timeout callback. |

### Potential duplication risks

- No new timing/debounce helper should be introduced for a 5-line `setTimeout`. The spec correctly inlines the timer rather than adding a `useDebouncedEffect` abstraction; this matches the project's "three similar lines is better than a premature abstraction" rule (CLAUDE.md). ✓

## 6. Phase / Wave Accuracy

Not applicable for a SPEC review — wave-decomposition is the plan-author's job. The spec's "Files touched" table provides the right granularity for the plan-gate to slot into 3-4 sequential tasks (verify-hypothesis → hook + constant → test + mocks → fixture + spec un-skip → CHANGELOG).

## 7. Specialist Agent Recommendations

Not applicable for a SPEC review.

## 8. Git Workflow Assessment

Not applicable for a SPEC review — branch / commit / PR strategy is decided at the plan gate. The spec is small enough (one PR, one logical unit) that the standard single-feature-branch flow applies.

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| At ship | `docs/CHANGELOG.md` — one-line bug-fix entry citing issue #44 |
| At ship | None on `CLAUDE.md` / `SCHEMA.md` / `API_REFERENCE.md` — no schema, no API surface change |

### CHANGELOG draft

~~~markdown
## v0.5.8 (or v0.5.7.1) — 2026-06-?? — bug fix

### Fixed
- `useSession`: debounced the "session-dead" effect so a transient `null` from
  the Convex session-validation query during WS resubscribe (after hard-nav)
  no longer wipes `localStorage` and bounces the user to `/login`. Unblocks
  the 6 PIN-gated e2e specs skipped in PR #43. (issue #44)
~~~

## 10. Testing Plan Assessment

**Verdict:** Insufficient as written — recoverable in the plan-gate.

The 3-test target list is correct in **shape** (transient-null-ignored / sustained-null-clears / real-to-null-honoured). It is **under-specified** in **mechanics**:

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Unit | `useSession` transient null | `vitest` + RTL + fake timers | Listed, missing mock-hoist + rerender plumbing |
| Unit | `useSession` sustained null | same | Listed, missing `act()` + timer cleanup |
| Unit | `useSession` real→null transition | same | Listed, missing rerender |
| E2E | 6 spec-files un-skipped | Playwright (CI) | Listed; acceptance criterion clear |

### Missing test coverage (must add in plan)

| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | Logout-during-pending-timer doesn't race | `clearSession()` after the timer started but before it fires must not produce a duplicate notify or leave the user in `loading` | Test: mount, mock=null, advance 500ms, `clearSession()`, assert localStorage clear, status `"none"`, no pending timer leaked |
| 2 | New `storeSession` mid-pending-timer cancels it | The spec's Risk 3 claims this works "by construction" — should have one direct test, not just inference | Test: mount, mock=null, advance 500ms, `storeSession(newId, ...)`, advance another 1000ms total past original deadline, assert localStorage still has newId (not cleared) |
| 3 | Existing 3 tests still green | Regression check that the mock-plumbing rewrite doesn't break them | Run-only — no new assertions; if `mockUseQuery.mockReturnValue(undefined)` is the default, existing tests are untouched |

### Test execution checkpoints

1. After hook change: `npm run typecheck` + `npx vitest src/hooks/useSession.test.tsx`
2. After fixture/spec un-skip: `npm run typecheck` + full `npx vitest` to catch unrelated breakage
3. Before merge: e2e CI run — primary acceptance signal (all 8 specs green)

### Regression risk

- `useSession.test.tsx` existing 3 tests — mock-plumbing rewrite touches their setup; verify they still pass without modification (or note the minimal modification needed).
- `AppHeader.test.tsx`, `SpokeLayout.test.tsx` — they mock `useSession` directly (don't touch the hook internals), so they're isolated from this change.
- `RootLayout` rendering — no test currently covers the `status: "loading"` path under a sustained-null condition; verify manually in dev that you see `Loading…` for ~1.5s (not a flash to `/login`) when forcing a stale sessionId in localStorage.

## 11. Edge Cases to Address

- [x] Transient null during reconnect (the primary case) — handled by debounce
- [x] Sustained null (genuine stale session) — handled by timer firing
- [x] Real→null transition (logged out elsewhere) — handled by debounce + timer
- [ ] **`clearSession()` mid-pending-timer** (logout pressed during reconnect window) — should cancel pending clear; needs explicit test (see §10 Missing #1)
- [ ] **`storeSession(newId)` mid-pending-timer** (rare: relogin during reconnect window) — should cancel pending clear; needs explicit test (see §10 Missing #2)
- [ ] **HMR-induced reconnect in dev** — not a real production scenario; mentioned in fixture comment but not tested. Acceptable to skip.
- [ ] **WS reconnect window exceeds 1500ms** — already in spec §Risks; mitigation = tune the constant. Acceptable as documented risk.

## 12. Approval Conditions

**To approve the SPEC for plan-gate:** no Critical issues — already approvable.

**Strongly recommended before plan-gate:**
1. **Improvement 1** (mock hoist + rerender) — without this the unit tests will be flaky or false-passing.
2. **Improvement 2** (`act()` + timer cleanup) — without this you get spurious React act-warnings and possible cross-test timer leaks.
3. **Improvement 3** (hypothesis verification step) — risk mitigation against landing a no-op fix.

**Optional polish:**
4. **Improvement 4** (CHANGELOG version naming) — one-line addition.
5. All §4 refinements (line-ref drift, refund-spec block-size note, Fix V17 comment removal).

---

*Generated by /staffreview — spec gate*
