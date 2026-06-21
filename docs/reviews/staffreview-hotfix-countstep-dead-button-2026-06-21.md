# Staff Review: Hotfix — CountStep dead-button during handover-in

**Date:** 2026-06-21
**Artifact:** working diff on `hotfix/handover-countstep-dead-button` (vs `origin/main`)
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Note:** This is a review of *implemented code* (a diff), not a pre-implementation plan, at the user's explicit request. Structure adapted accordingly.

---

## 1. Summary

**Overall Assessment: Approve** (with 2 recommended test-coverage improvements; no blocking issues).

The fix correctly identifies and addresses a real root cause: `CountStep` re-derived its session via `useSession()` instead of receiving the authoritative session the route already held, and its `disabled` guard was looser than `submit()`'s early-return — producing an enabled-but-inert button during the post-`storeSession` lag on handover-in. The change threads an authoritative `sessionId` prop and tightens the `disabled` guard. It is FE-only, typechecks, lints clean, and the full src suite (477 tests) passes. Two new regression tests went RED→GREEN. The one notable scoping question (does start-of-day share the bug?) checks out: `start.tsx` and `end.tsx` early-return until the session is active, so only `handover.tsx` was vulnerable — and that's the path that got the prop.

## 2. Critical Issues (Must Fix)

**None.** The Evidence-Before-Mitigation gate (§4.9) passes cleanly — this is a verified-mechanism fix, not a timing band-aid (see below).

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | The "submits via prop" test doesn't prove the empty-list root cause is fixed | M | L |
| 2 | No route-level assertion that handover passes `stage.sessionId` | L | L |

### Improvement 1: Test the actual root-cause symptom (empty inventory list)

The reported failure has two halves: (a) the inventory list rendered **empty** (`listInventory` skipped because `sessionId` was null), and (b) Save silently no-op'd. The new test `submits using the sessionId prop…` only proves (b) — and it does so while `useQuery` is mocked to return `FAKE_SKUS` **regardless of args** (`CountStep.test.tsx:50`). So it can't catch a regression where the query is still called with `"skip"`.

**Recommendation:** add an assertion that `useQuery` is invoked with the prop session, not `"skip"`:
```ts
expect(vi.mocked(useQuery)).toHaveBeenCalledWith(
  expect.anything(),
  { sessionId: "session-prop-1" },
);
```
This pins the half of the fix (the query wiring) that the current tests leave unguarded.

### Improvement 2: Route-level wiring assertion (optional)

`handover.test.tsx` passes but doesn't assert `CountStep` receives `stage.sessionId`. The unit tests prove the *mechanism*; typecheck proves the *wiring* compiles. A small route-level test (count stage renders the SKU list during a `loading` `useSession`) would lock the integration. Low priority given typecheck + unit coverage.

## 4. Refinements (Optional)

- **`start.tsx` consistency:** `start.tsx:107` renders `ShiftWizard` without `sessionId`. It's **not vulnerable** (the route early-returns `null` until `session.status === "active"` at `start.tsx:92-93`, so the wizard never mounts mid-lag). Passing `sessionId={sessionId ?? undefined}` there too would make the three wizard call-sites uniform and remove the "why does end.tsx pass it but start.tsx doesn't?" reader question. Cosmetic.
- **Comment parity:** `handover.tsx:130` now passes `stage.sessionId` — a one-line `// authoritative session; useSession lags post-storeSession (see CountStep)` would mirror the excellent prop-doc already added in `CountStep.tsx` and explain the "why" at the call site.

## 5. Duplication Analysis

### Existing code leveraged correctly
| Code | Location | How used |
|------|----------|----------|
| `useSession` fallback pattern | `CountStep.tsx:32` | Kept as fallback; prop layered on top (prop-wins) — no duplication |
| Authoritative `stage.sessionId` | `handover.tsx:32,109` | Already used by `completeHandoverIn`; now also feeds `CountStep` — consistent single source |

### Duplication risks
- None introduced. The prop-over-hook pattern is the standard React fix for "component re-derives state that the parent already owns." No new abstraction created.

## 6. Phase / Wave Accuracy

Single atomic change; no phases. Ordering within the diff is coherent: prop added to `CountStep` → threaded through `ShiftWizard` → supplied by all three call-sites.

## 7. Specialist Agent Recommendations

| Scope | Agent | Rationale |
|-------|-------|-----------|
| Post-merge sanity | `code-reviewer` | Optional second pass; the diff is small enough that this review suffices |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ `hotfix/handover-countstep-dead-button` off `origin/main` (clean, not the messaging worktree) |
| Branch naming convention | ✅ `hotfix/<slug>` |
| Atomic commit | ⚠️ Not yet committed — should be a single `fix(shifts): …` commit (6 files: 4 src + test + CHANGELOG) |
| Pre-push verification | ✅ `npm run typecheck` (`tsc -b && tsc -p convex`) + eslint + full src vitest all green |
| Deploy skew risk | ✅ None — FE-only, no mutation↔action rename, no schema/signature change |
| Rollback | ✅ Trivial — revert the single commit; no data/migration involved |

Suggested commit message:
```
fix(shifts): pass authoritative session to CountStep so handover-in Save works

CountStep re-derived the session via useSession(), which lags a render
behind storeSession during handover-in → empty SKU list + enabled-but-inert
Save (submit() bailed on !sessionId with no feedback). Thread the route's
sessionId as a prop (prop wins; useSession is the recount-route fallback) and
include !sessionId in the button's disabled guard so it can never be inert.
```

## 9. Documentation Checkpoints

| Item | Status |
|------|--------|
| `CHANGELOG.md` | ✅ Entry added (2026-06-21 hotfix block) |
| `SCHEMA.md` | N/A — no schema change |
| `CLAUDE.md` | N/A — no new business rule or file location |
| `API_REFERENCE.md` | N/A — no function signature change |

## 10. Testing Plan Assessment

**Verdict: Adequate** (tightened by Improvement 1).

| Layer | What | Type | Status |
|-------|------|------|--------|
| Component | Submit via prop while `useSession` mid-lag | vitest/RTL | ✅ added (RED→GREEN) |
| Component | Button disabled when no usable session | vitest/RTL | ✅ added (RED→GREEN) |
| Component | Existing 7 CountStep tests (active session) | vitest/RTL | ✅ pass (regression-covered) |
| Integration | ShiftWizard / end / handover render | vitest/RTL | ✅ 41 pass across the 4 files |
| Full suite | All src | vitest | ✅ 83 files / 477 tests |

### Missing coverage (recommended)
| # | Test | Why | Approach |
|---|------|-----|----------|
| 1 | `listInventory` fires with prop session (not `"skip"`) | Guards the empty-list half of the bug | assert `useQuery` call args |

### Regression risk
- Low. `disabled` gains `!sessionId`; no prior path relied on an enabled button with a null session (submit always bailed on it). Recount route + gated wizards always have an active session → unchanged behavior.

## 11. Edge Cases

- [x] Handover-in post-login lag — fixed (prop)
- [x] Start-of-day post-login lag — not vulnerable (early-return guard), verified
- [x] Close / handover-out — not vulnerable (active-session guard), threaded anyway (defensive)
- [x] Recount route (no prop) — falls back to `useSession`; button disabled until active (improvement over prior inert state)
- [x] `sessionId ?? undefined` in `end.tsx` — non-null after the guard; satisfies the `Id | undefined` prop type
- [ ] (Improvement 1) empty-list query wiring not directly asserted in tests

## 4.9 Evidence-Before-Mitigation Gate — **PASS**

- [x] Concrete artefact cited: the RED test (`submits using the sessionId prop…` → `recordRecount` called 0 times under the lagging-session condition) reproduces the mechanism; user-confirmed symptom ("taps, nothing happens") + code trace (`CountStep.tsx:33` derive, `:46` `!sessionId` bail, `:118` looser disabled).
- [x] Verifiable: failing→passing test in-repo; `file:line` cited throughout.
- [x] Not a timing/debounce/warm-up mitigation — it removes the race by making the component *receive* the session instead of re-deriving it. No follow-up "real fix" issue needed; this **is** the real fix.

## 12. Approval Conditions

**To approve:** nothing blocking. ✅

**Recommended before merge:**
1. Add the `useQuery`-called-with-prop-session assertion (Improvement 1) — ~5 lines.
2. Commit as a single atomic `fix(shifts): …`.

**Optional:** thread `sessionId` into `start.tsx`'s wizard + add the `handover.tsx` call-site comment for uniformity.

---

*Generated by /staffreview*
