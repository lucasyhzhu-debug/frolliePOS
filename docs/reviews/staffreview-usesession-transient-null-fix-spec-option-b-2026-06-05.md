# Staff Review: `useSession` transient-null fix (Option B SPEC) — issue #44

**Date:** 2026-06-05
**Spec:** `docs/superpowers/specs/2026-06-05-useSession-transient-null-fix-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** Reviewed as a SPEC — implementation-plan sections (commit boundaries, wave ordering) are deferred to the writing-plans gate, not dinged here.
**Companion documents:**
- Architectural-options review: `docs/reviews/staffreview-issue-44-architectural-options-2026-06-05.md`
- Superseded Option A spec review: `docs/reviews/staffreview-usesession-transient-null-fix-spec-2026-06-05.md`

---

## 1. Summary

**Overall Assessment:** Revise — one Critical (relogin-without-reload silently breaks the new ref), two Improvements, two Nits. All addressable inline; design is otherwise sound and grounded in real code.

The Option B shape (transition-based null detection via `useRef`) is the right direction and meaningfully better than Option A. The spec correctly identifies that BOTH the destructive effect AND the render-time branch must consult the same evidence — a correction the architectural review missed. The hook-only logic correctness, the `RootLayout` escape-hatch design, and the test plan are all approximately right.

The one Critical: `hasEverBeenReal` persists across `clearSession()` + `storeSession(newId)` cycles WITHIN A SINGLE HOOK INSTANCE (no page reload), causing a same-instance relogin to inherit the previous session's "real-seen" evidence. The first transient-null render of the new sessionId will be treated as a real → null transition and wipe the just-stored localStorage. Fix: gate the ref on `stored` identity (reset when sessionId changes).

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `hasEverBeenReal` doesn't reset on relogin → same-instance Lock+login wipes new session's localStorage | Logic | Decision #1 hook snippet |

### Issue 1: `hasEverBeenReal` ref leaks across relogin

The spec proposes:

```ts
const hasEverBeenReal = useRef(false);
// ...
if (validation !== null && validation !== undefined) {
  hasEverBeenReal.current = true;
}
```

**Refs persist for the lifetime of the hook instance.** That's correct for the cold-mount transient-null case. But it breaks the **lock + relogin without a page reload** case:

1. User A logged in → `validation = realSession_A` → `hasEverBeenReal.current = true`.
2. User A taps Lock → `clearSession()` → `setStored(null)`. Hook re-renders, returns `status: "none"` via the `!stored` branch. **Ref stays `true`** (never reset).
3. User B logs in → `storeSession(newId)` → `setStored(newId)`. Hook re-renders.
4. `useQuery(getSession, { sessionId: newId })` resubscribes with the new arg. For the first render after the arg change, **`validation` may be `undefined` (loading) OR `null` (transient resubscribe)**.
5. The first `validation === null` render: render-time branch reads `hasEverBeenReal.current === true` (leaked from User A) → returns `status: "none"` → `RootLayout` redirects to `/login`. AND the effect fires (gated on the same true ref) → **wipes the just-stored `newId` from `localStorage`**.

That's the exact same redirect-and-wipe bug we're fixing, just triggered by a different code path. The `RootLayout` and `AppHeader` typically mount/unmount around route changes, so this specifically bites when `useSession` is used in a component that survives the lock+relogin cycle — which is **`RootLayout` itself** (it's the layout wrapping every route, so it's instantiated once per app session, not per route).

**Recommendation:** gate the ref on `stored` identity. The precedent in `src/hooks/useCatalogCache.ts:53` (`liveSeenRef`) is the same shape and worth matching. Concretely:

```ts
// Issue #44: track "have we ever validated THIS sessionId at least once."
// Tied to `stored` identity so a same-instance lock+relogin doesn't inherit
// the previous session's evidence.
const realSeenForStored = useRef<{ sessionId: string | null; seen: boolean }>(
  { sessionId: null, seen: false },
);
if (realSeenForStored.current.sessionId !== stored) {
  realSeenForStored.current = { sessionId: stored, seen: false };
}
if (validation !== null && validation !== undefined) {
  realSeenForStored.current.seen = true;
}
const hasEverBeenReal = realSeenForStored.current.seen;
```

Read sites in the effect and render-time branch then use the local `hasEverBeenReal` const instead of `hasEverBeenReal.current`. The reset-on-stored-change runs during render before the assignment — same render-phase invariant as the spec already proposes for the assignment itself.

Add a test for this case: mount with `s_old`, mock real session, assert `status: "active"`; call `clearSession()`; call `storeSession("s_new", ...)`; mock returns `null` (transient resubscribe); rerender; assert `result.current.status === "loading"` (NOT `"none"`) AND `localStorage.getItem(SESSION_KEY) === "s_new"` (NOT wiped).

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Cite existing `liveSeenRef` precedent (`src/hooks/useCatalogCache.ts:53`) as the model | M | L |
| 2 | Specify controllable test mock plumbing for `RootLayout.test.tsx` — escape-hatch test needs varying useSession + useDeviceId + useQuery + clearSession spy | M | L |

### Improvement 1: Cite the existing ref-pattern precedent

`src/hooks/useCatalogCache.ts:53` introduces `liveSeenRef = useRef(false)` and uses it to gate a destructive overwrite (an async IDB read that "doesn't stomp" a fresher value already set by another effect). It's the exact "have we ever observed a fresh value" pattern Option B needs. **Citing it does three things:**

1. Signals to the reviewer that the pattern is already in-house, not novel.
2. Makes the post-Critical-fix shape (`realSeenForStored.current.seen`) feel like a natural extension of an existing convention rather than ad-hoc.
3. Hands the next maintainer a search anchor when this comes up again.

**Recommendation:** add to Decision #1 or §Detailed approach: *"Pattern precedent: `src/hooks/useCatalogCache.ts:53` (`liveSeenRef = useRef(false)`) gates a destructive overwrite with the same 'have we ever observed a real value' shape — Option B mirrors this convention."*

### Improvement 2: Specify controllable test mock plumbing for `RootLayout.test.tsx`

The spec says "follow the existing `AppHeader.test.tsx` pattern" for the new `RootLayout.test.tsx`. That pattern at lines 6-13 is a **static** mock:

```ts
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ status: "active", sessionId: "kn7s0" as any, staff: { ... } }),
}));
```

That works for `AppHeader` because every test wants the same active-session state. But the new escape-hatch tests need **controllable** mocks across renders:

- Test 6 needs `status: "loading"` indefinitely AND `localStorage[SESSION_KEY]` set AND `clearSession` spy-able.
- Test 7 needs same as #6 plus a way to confirm `clearSession` was called when the button is clicked.

The static mock can't be reconfigured per test, and it doesn't expose `clearSession`. The plan needs to spec the `vi.hoisted()` pattern:

```ts
const { mockUseSession, mockClearSession } = vi.hoisted(() => ({
  mockUseSession: vi.fn().mockReturnValue({
    status: "loading", sessionId: null, staff: null,
  }),
  mockClearSession: vi.fn(),
}));
vi.mock("@/hooks/useSession", () => ({
  useSession: mockUseSession,
  clearSession: mockClearSession,
  storeSession: vi.fn(),
}));
```

Plus mocks for `useDeviceId` (return a non-null string) and the `isDeviceRegistered` query (return `true`). The plan needs to list these — without them the test file won't render past the gate.

**Recommendation:** add a "Test plumbing" sub-section to the Test plan that lists every mock the new file needs (useSession + clearSession + useDeviceId + useQuery for isDeviceRegistered + useStartupReconciliation no-op). The plan-gate review will catch this if missed, but spec-level acknowledgement saves a round-trip.

## 4. Refinements (Optional)

- **5s stuck threshold precedent.** `src/components/layout/ConnDot.tsx:46` uses `setInterval(read, 5000)` for connection polling — the only existing 5000ms in production code. Not exactly the same use case (polling cadence vs escape-hatch reveal), but worth referencing as "5s is the existing 'reasonable wait' number in the layout layer." Tightens the choice from "arbitrary" to "matches established cadence." Optional citation.
- **Comparison table at end of spec lists "Hook LOC delta ~10 added" for both A and B.** Post-Critical-fix, B's hook LOC delta will be closer to ~15 added (the wrapped-object ref instead of bare boolean). Adjust the table after addressing #1.
- **Stuck-loading button class string is a copy from the project's own `text-muted-foreground hover:text-foreground` token-style.** Fine, but worth using `cn(...)` from `@/lib/utils` (the project's convention) if any conditional class joining is added later.

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| `liveSeenRef = useRef(false)` pattern | `src/hooks/useCatalogCache.ts:53` | Reuse the "have we ever observed a fresh value" shape; the post-Critical-fix `realSeenForStored` is a direct sibling. |
| `clearSession` export | `src/hooks/useSession.ts:73` | Imported into `RouteFallback` in RootLayout — verified the symbol exists and is exported at module top-level. ✓ |
| `SESSION_KEY` constant | `src/lib/storage-keys.ts` (imported in `useSession.ts:5`) | Imported into `RootLayout.tsx` for the `showSessionStuck` check. Path `@/lib/storage-keys` works — `useSession.ts` uses the same path with a tilde-alias resolved by Vite. ✓ |
| `ConnDot.tsx` connection-polling pattern | `src/components/layout/ConnDot.tsx:24-49` | Not directly reused, but the 5s cadence reference is the same. |

### Potential duplication risks

- **`AppHeader.test.tsx`'s static `vi.mock` pattern** vs the new `RootLayout.test.tsx`'s controllable pattern: two slightly different shapes for mocking the same hook. Acceptable — `AppHeader`'s tests genuinely don't need variance, but worth a one-line note in the new file explaining why it diverges. Not a duplication risk per se.
- **5s threshold magic number** — if it ends up living in `RootLayout.tsx` as a bare `5000`, and a future hook somewhere else needs a similar threshold, they'll diverge. **Recommend** putting it behind a named constant `STUCK_LOADING_REVEAL_MS = 5000` inside `RootLayout.tsx`, with a comment naming the failure mode it addresses (genuinely-stale localStorage UX). Easy to grep, easy to tune.

## 6. Phase / Wave Accuracy

Not applicable for a SPEC review — task decomposition is the plan-author's job. The spec's "Files touched" table provides the right granularity for the plan-gate to slot into ~5 sequential tasks:

1. Task 0 (hypothesis verify, defence-in-depth — keep from the superseded plan).
2. Task 1: hook change + 3 hook tests (updated existing + 2 new + the post-Critical-fix relogin test).
3. Task 2: RootLayout escape hatch + 2 RootLayout tests.
4. Task 3: drop fixture warm-up.
5. Task 4: un-skip 6 specs.
6. Task 5: CHANGELOG.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Task 1 (hook) | `frontend-integrator` or main session | React hook + vitest — small scope. |
| Task 2 (RootLayout) | `ui-component-builder` or main session | New UI affordance + Framer-free CSS — the project's existing component-builder agent fits, but main session works too. |
| Tasks 0, 3-5 | main session | Pure text edits and CI runs. |

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ (`worktree-replan-issue-44-option-b`, named in worktree state) |
| Branch naming follows convention | ✅ |
| Merge strategy documented | ⚠️ Same as the superseded plan — project default (squash-merge) is assumed but not stated in-spec. Acceptable. |

### Commit checkpoints

Natural boundaries (one per task):
1. Task 0 instrumentation (temp).
2. Task 0 revert + verified note.
3. Task 1 hook + tests.
4. Task 2 RootLayout escape hatch + tests.
5. Task 3 fixture cleanup.
6. Task 4 un-skip 6 specs.
7. Task 5 CHANGELOG.

### Pre-push verification

- [x] `npm run typecheck` — implicit in each task.
- [x] `npm run lint` — implicit; the `useRef`-during-render pattern doesn't trip `react-hooks/exhaustive-deps` because refs aren't reactive.
- [x] `npm run test` — full suite at the end of Task 4.

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ inherited from the Option A spec's Rollback section; should be carried over and adjusted for the new shape. Add: if `RootLayout` escape hatch causes a regression, it can be reverted independently of the hook change (separate commits). |
| Deployment order | ✅ frontend-only, no schema, no backend. |
| Data backup needed | No. |
| Migration safety | N/A. |

## 9. Documentation Checkpoints

| Task | Docs to update |
|------|----------------|
| Task 5 | `docs/CHANGELOG.md` — v0.5.7.1 entry. |
| None | `CLAUDE.md` / `docs/SCHEMA.md` / `docs/API_REFERENCE.md` — no API surface change. |

### CHANGELOG draft

The spec's draft is shaped correctly. After addressing Critical #1, expand by one line to mention the relogin-safe ref design:

~~~markdown
## v0.5.7.1 — 2026-06-?? — bug fix

### Fixed
- `useSession`: replaced the always-on "any null means session is dead"
  interpretation with evidence-based detection — a null is only treated as
  authoritative after we've successfully validated this sessionId at least
  once. Stops a transient null from `useQuery(getSession)` during Convex WS
  resubscribe (after hard-nav) from wiping `localStorage` and bouncing the
  user to `/login`. Also: small "Stuck on loading?" escape hatch in
  `RootLayout` covers the rare genuinely-stale localStorage case. Unblocks
  the 6 PIN-gated e2e specs `test.skip`-ed in PR #43 and drops the 1500ms
  fixture-level warm-up. (issue #44)
~~~

## 10. Testing Plan Assessment

**Verdict:** Adequate after Critical #1 and Improvement #2 are addressed.

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Unit (hook) | No stored session → `"none"` | vitest + RTL | ✅ unchanged from existing |
| Unit (hook) | `storeSession` notifies same-tab listeners | vitest + RTL | ✅ unchanged from existing |
| Unit (hook) | `clearSession` notifies same-tab listeners | vitest + RTL | ✅ unchanged from existing |
| Unit (hook) | Cold-mount null → `"loading"`, no wipe | vitest + RTL | Planned ✓ |
| Unit (hook) | Real → null transition → wipe + `"none"` | vitest + RTL | Planned ✓ |
| Unit (hook) | **Same-instance relogin doesn't inherit prev session's "real-seen" evidence** | vitest + RTL | **MISSING — add per Critical #1** |
| Unit (RootLayout) | Escape hatch hidden initially | vitest + RTL + fake timers | Planned ✓ |
| Unit (RootLayout) | Escape hatch visible after 5s + click clears session | vitest + RTL + fake timers | Planned ✓ |
| E2E | 6 specs un-skipped | Playwright (CI) | Planned ✓ |

### Missing test coverage (must add)

| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | Same-instance relogin: mount with s_old, real validation, lock, store s_new, mock null → status `"loading"` (NOT `"none"`) AND `localStorage[SESSION_KEY] === "s_new"` (NOT wiped) | Validates the post-Critical-fix ref-reset behaviour. Without this test the bug introduced by Issue #1 would only be caught by e2e (slow) or never. | Use the same `vi.hoisted()` + controllable mock plumbing already specified for tests 4-5. |
| 2 | Loading-then-real-session does NOT trigger the escape hatch | `RootLayout` test — verify that if `useSession` transitions `"loading"` → `"active"` before the 5s timer fires, the button never appears (timer cleared on unmount or status change). | Mount with loading status; flip mock to active at t=2000ms within an act(); advance timer to t=6000ms; assert button NOT visible. |

### Test execution checkpoints

1. After Task 1 (hook) — `npx vitest run src/hooks/useSession.test.tsx` — 6 PASS (3 existing + 3 new).
2. After Task 2 (RootLayout) — `npx vitest run src/components/layout/__tests__/RootLayout.test.tsx` — 3 PASS.
3. After Tasks 3-4 — `npm run typecheck && npm run lint && npm run test` clean.
4. Final: e2e CI on the ready PR — all 8 specs green.

### Regression risk

- **`useSession.test.tsx` existing 3 tests:** test #3 (`clearSession` notifies) currently asserts `status: "loading"` → `clearSession()` → `status: "none"`. Under Option B with the post-Critical-fix ref, this transition is unchanged because `clearSession()` synchronously wipes `localStorage` → `setStored(null)` → render returns via the `!stored` branch (independent of `hasEverBeenReal`). ✓ should stay green.
- **`AppHeader.test.tsx` + `SpokeLayout.test.tsx`:** mock `useSession` directly with a static return; isolated from the hook internals. ✓ no impact.
- **`router.test.tsx`:** uses a real `ConvexReactClient` with `https://example.convex.cloud`; the queries don't actually run. ✓ no impact.

## 11. Edge Cases to Address

- [x] Transient null on cold-mount reconnect — Decision #1 trace ✓
- [x] Genuine logout-elsewhere (real → null) — Decision #1 trace ✓
- [x] Genuinely-stale localStorage cold mount — Decision #2 escape hatch ✓
- [ ] **Same-instance relogin (lock + new login without page reload)** — Critical #1
- [ ] Loading → active before 5s timer (escape hatch should NOT flash) — Missing test #2 in §10
- [ ] React 19 StrictMode double-mount — `useRef` survives StrictMode's double-effect within a single mount; safe. `hasEverBeenReal.current` initialised to false at mount; the assignment is idempotent (true→true is a no-op). No risk.
- [ ] `useRef`-during-render lint check — refs aren't reactive, so `react-hooks/exhaustive-deps` doesn't flag the in-render assignment or the in-effect read. Lint passes.

## 12. Approval Conditions

**To approve the SPEC for plan-gate:**

1. ✅ Address Critical #1 — gate `hasEverBeenReal` on `stored` identity to prevent the relogin leak. Add the corresponding test.

**Strongly recommended before plan-gate:**

2. Improvement #1 — cite the `liveSeenRef` precedent so the new pattern is recognisably in-house.
3. Improvement #2 — spec the controllable mock plumbing for `RootLayout.test.tsx` (vi.hoisted, the four mocks the file needs, the `clearSession` spy).
4. Add Missing test #2 — confirm the escape hatch doesn't flash on a normal loading→active transition.

**Optional polish:** §4 Refinements (5s constant named, LOC table updated, `cn(...)` if conditional classes appear).

---

*Generated by /staffreview — spec gate (Option B)*
