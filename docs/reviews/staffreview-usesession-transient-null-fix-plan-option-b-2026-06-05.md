# Staff Review: `useSession` transient-null fix (Option B PLAN) — issue #44

**Date:** 2026-06-05
**Plan:** `docs/superpowers/plans/2026-06-05-issue-44-usesession-transient-null-fix.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — Goal, Architecture, File Structure, Tasks with TDD steps, Success Criteria, Rollback all present.
**Companion documents:**
- Architectural-options review: `docs/reviews/staffreview-issue-44-architectural-options-2026-06-05.md`
- Spec review (Option B): `docs/reviews/staffreview-usesession-transient-null-fix-spec-option-b-2026-06-05.md`
- Superseded Option A plan review: `docs/reviews/staffreview-usesession-transient-null-fix-plan-2026-06-05.md`

---

## 1. Summary

**Overall Assessment:** Revise — one Critical (vitest 2.x generic-signature mismatch), three Improvements, two Nits. All surgical edits. After addressing Critical #1, the plan is approvable for execution.

The plan correctly mirrors the Option B spec, sequences sensibly (verify → hook → RootLayout → fixture → un-skip → CHANGELOG+follow-ups), and uses commit boundaries that make each task independently revertable. File-paths, line numbers, and import shapes verified against current code — they match. The Critical is a single line in two tasks that would fail at typecheck under the project's actual vitest version.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `vi.fn<[], unknown>()` is vitest 1.x syntax; project uses vitest 2.1.8 where the generic is a function type, not args+return | Testing | Task 1 Step 1; plan's "Tech Stack" line |

### Issue 1: `vi.fn<[], unknown>()` won't typecheck under vitest 2.1.8

The plan's `package.json` declares **vitest 2.1.8** (verified: `"vitest": "^2.1.8"`). In vitest 2.x, the `fn` signature at `@vitest/spy/dist/index.d.ts` is:

```ts
declare function fn<T extends Procedure = Procedure>(implementation?: T): Mock<T>;
```

— the generic parameter is a **function type** (`Procedure = (...args: any[]) => any`), not a tuple-args + return-type pair like in vitest 1.x. The plan's snippet:

```ts
mockUseQuery: vi.fn<[], unknown>().mockReturnValue(undefined),
```

passes `[]` (a tuple type) as the function-type generic, which TypeScript will reject as "Type '[]' does not satisfy the constraint '(...args: any[]) => any'." This blocks Task 1 Step 1 at `npm run typecheck`.

**Recommendation:** drop the generic entirely — `vi.fn()` is sufficient because the mock's return value will be coerced to `unknown` by the consumer anyway (the real `useQuery` type comes from `convex/react`'s declaration, not from this mock). Or, if explicit typing is wanted: `vi.fn<() => unknown>()`. Both work in vitest 2.x.

Same fix in **two places**:
- Task 1 Step 1 (`useSession.test.tsx` rewrite).
- Plan's Tech Stack line: "vitest 1.x" → "vitest 2.1.8".

Apply once and the issue is gone. No code in Task 2 needs changing — its `vi.fn()` calls are already untyped.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | ESLint-disable comment style doesn't match the project's existing convention | M | L |
| 2 | Note that the `PrinterProvider` mock is defensive-only — the gate path doesn't render it | L | L |
| 3 | Note that `mockUseQuery.mockReturnValue(true)` is a global mock — flag for future maintenance | L | L |

### Improvement 1: Match the existing eslint-disable comment style

The plan's Task 0 instrumentation uses:

```ts
// eslint-disable-next-line no-console -- TEMP issue #44 instrumentation, stripped in Step 5
console.warn(tag);
```

The `--` separator after the rule name is an ESLint 8.0+ feature for inline rationale, but **the project doesn't use it anywhere**. The single existing eslint-disable in `src/` is `src/lib/escpos.ts:9`:

```ts
// eslint-disable-next-line no-control-regex
return s.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "").trim();
```

— bare rule name, no rationale, rationale (if needed) goes on a separate comment above. Match the convention:

```ts
// TEMP issue #44 instrumentation, stripped in Step 5
// eslint-disable-next-line no-console
console.warn(tag);
```

Same shape, same enforcement, matches house style.

### Improvement 2: `PrinterProvider` mock is defensive-only

The plan's Task 2 Step 1 mocks `@/components/pos/PrinterProvider`:

```ts
vi.mock("@/components/pos/PrinterProvider", () => ({
  PrinterProvider: ({ children }: { children: React.ReactNode }) => children,
}));
```

with a comment that "an accidental render past the gate doesn't crash." Verified the real `PrinterProvider` (`src/components/pos/PrinterProvider.tsx:1-31`):
- Imports `useThermalPrinter` (which is pure module-level constants + a hook — no DOM side effects on import).
- Exports a named `PrinterProvider` function.

In every test scenario the plan exercises, `session.status` is `"loading"` or `"active"` — the gate at `RootLayout.tsx:40` returns `<RouteFallback />` for `"loading"` (tests 6, 7, 8 starting state), and the `Navigate` redirect for `"none"` (test 7's post-click follow-up). **`PrinterProvider` is never instantiated in any test path.** The mock is harmless but unnecessary.

**Recommendation:** either drop the mock (cleaner) OR keep it with a comment explicitly naming the defence ("defensive — gate path doesn't render PrinterProvider, but if a future test exercises the active-session render path this prevents accidentally hitting the real BLE-coupled hook"). Either choice is fine; just remove the implication that it's load-bearing today.

### Improvement 3: `mockUseQuery.mockReturnValue(true)` is global

The plan's Task 2 Step 1 mocks `useQuery` globally to return `true`. Verified that `RootLayout.tsx` calls `useQuery` exactly **once** (line 26-29, for `isDeviceRegistered`), so returning `true` correctly satisfies the gate's "device registered" branch.

But this is a global mock — every `useQuery` call in the rendered tree returns `true`. If a future RootLayout edit adds a second `useQuery` (say, for a notifications query, or an `isOnline` ping), the global `true` would also satisfy it, possibly hiding a real bug in that consumer. **Recommendation:** add a one-line comment in the mock setup making the assumption explicit:

```ts
// useQuery → true satisfies RootLayout's single isDeviceRegistered query.
// If RootLayout grows a second useQuery call, this mock will return `true`
// for it too — tighten via mockImplementation((q) => q === ... ? true : ...).
mockUseQuery: vi.fn().mockReturnValue(true),
```

Costs nothing; saves a future "why is this test passing when it shouldn't?" debug session.

## 4. Refinements (Optional)

- **Task 0 Step 4 "If `auth.spec.ts` alone is insufficient."** Worth a quick grep before assuming. `e2e/specs/auth.spec.ts` may already have a `page.goto` after login (e.g., the lockout test); if so, the "temporarily un-skip a spec" caveat is unnecessary. Minor — the fallback path is still safe.
- **Plan's "Tech Stack" line.** Currently reads "vitest 1.x" — fix per Critical #1 to "vitest 2.1.8."
- **Test 6 trace: `Navigate` short-circuit at gate.** Worth noting in the test description that `<MemoryRouter initialEntries={["/sale"]}>` + `status: "loading"` lands on `RouteFallback` (line 41 short-circuits), never reaching the `Navigate to="/login"` at line 49. The trace is implicit in the test design but stating it makes the test's correctness more reviewable.

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| `liveSeenRef = useRef(false)` pattern | `src/hooks/useCatalogCache.ts:53` | Plan correctly cites this as precedent in Task 1 Step 5(b)'s comment. ✓ |
| `clearSession` named export | `src/hooks/useSession.ts:73` | Verified — imported into RootLayout in Task 2 Step 5(a). ✓ |
| `SESSION_KEY` constant | `src/lib/storage-keys.ts` | Verified — `@/lib/storage-keys` alias works (current `useSession.ts:5` uses same path). ✓ |
| `PrinterProvider` named export | `src/components/pos/PrinterProvider.tsx:31` | Mock path matches; named export confirmed. ✓ |
| AppHeader.test.tsx static-mock pattern | `src/components/layout/__tests__/AppHeader.test.tsx:6-13` | Intentionally diverged from — RootLayout tests need controllable mocks. Plan documents the divergence. ✓ |
| Existing eslint-disable convention | `src/lib/escpos.ts:9` | See Improvement #1 — plan should match. |

### Potential duplication risks

- **Two mock patterns in same dir.** `AppHeader.test.tsx` static vs. `RootLayout.test.tsx` controllable. Acceptable per spec review §5; the new file's `vi.hoisted()` block self-documents.
- **Heredoc commit messages.** Plan uses `git commit -m "$(cat <<'EOF' ... EOF)"` consistently — matches the project's commit style (per CLAUDE.md heredoc example). ✓

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|------|------------|-------|
| Task 0 (verify hypothesis) | Good | Defence-in-depth; correctly placed before the fix. |
| Task 1 (hook + 3 tests) | **Needs Critical #1 fix** | Otherwise sound. TDD cycle correct. |
| Task 2 (RootLayout + 3 tests) | Good | New file, controllable mocks, cleanup-path test 8 is the right addition. |
| Task 3 (drop fixture sleep) | Good | Correctly placed after Tasks 1-2 so the workaround removal isn't pre-emptive. |
| Task 4 (un-skip 6 specs) | Good | Line numbers verified against current code (refund 8-line block at 4-11 + test.skip at line 12; other 5 are 2-line blocks). |
| Task 5 (CHANGELOG + PR ready + follow-ups) | Good | Includes the two follow-up `gh issue create` commands per spec Decision #6. |

**Ordering issues:** none. Each task's output is consumable by the next.

**Missing phases:** none.

## 7. Specialist Agent Recommendations

| Task | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Task 0 (instrumentation) | main session | Throwaway; no specialist needed. |
| Task 1 (hook) | `frontend-integrator` or main session | React hook + vitest — small scope. |
| Task 2 (RootLayout) | `ui-component-builder` or main session | New UI affordance + a new test file; either fits. |
| Tasks 3-5 | main session | Text edits, CI runs, gh CLI commands. |

No specialist required. Plan is small enough for the main session per-task.

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ (`worktree-replan-issue-44-option-b`, visible in worktree state) |
| Branch naming follows convention | ✅ |
| Merge strategy documented | ⚠️ Project default (squash-merge) assumed but not stated in-plan. Acceptable. |

### Commit checkpoints

Natural boundaries (one per task, 7 commits total before squash):
1. Task 0 instrumentation (temp) → `chore(temp): instrument useSession transitions…`
2. Task 0 strip → `chore(temp): revert #44 instrumentation`
3. Task 1 hook + 3 hook tests → `fix(useSession): evidence-based null trust (issue #44, Option B)`
4. Task 2 RootLayout + 3 RootLayout tests → `feat(RootLayout): 'Stuck on loading?' escape hatch (issue #44)`
5. Task 3 fixture cleanup → `fix(e2e): drop awaitSignedIn warm-up sleep`
6. Task 4 un-skip 6 specs → `test(e2e): un-skip 6 PIN-gated specs after useSession Option B`
7. Task 5 CHANGELOG → `docs(changelog): v0.5.7.1 — useSession transient-null fix Option B`

Squash-merge at PR time folds them into one. Each commit is independently `git revert`-able if Rollback section's conditional rollback paths trigger.

### Pre-push verification

- [x] `npm run typecheck` — in Tasks 1, 2, 3, 5.
- [x] `npm run lint` — in Tasks 1, 2, 4. (Task 5 doesn't run it; harmless — CHANGELOG is markdown.)
- [x] `npm run test` — implicit via per-task `npx vitest run` + Success Criteria final.
- [x] Local testing before push — Yes, every task runs tests before commit.

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ documented — 4 conditional paths (hypothesis-refuted, fix-lands-but-e2e-red, RootLayout-causes-regression, unrelated-e2e-flake) |
| Deployment order | ✅ frontend-only, no schema, no backend |
| Data backup needed | No |
| Migration safety | N/A |

## 9. Documentation Checkpoints

| Task | Docs to update |
|------|----------------|
| Task 5 | `docs/CHANGELOG.md` — v0.5.7.1 entry. |
| Task 5 (also) | Two GitHub issues created — Option D migration + null-handling audit. |
| None | `CLAUDE.md` / `docs/SCHEMA.md` / `docs/API_REFERENCE.md` — no public-API or schema change. |

### CHANGELOG draft

Plan's draft (Task 5 Step 2) is shaped correctly; matches the existing CHANGELOG format. Date placeholder explicitly noted to fill at ship time. ✓

## 10. Testing Plan Assessment

**Verdict:** Adequate after Critical #1 is fixed.

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Unit (hook) | No stored session → `"none"` | vitest + RTL | ✅ unchanged from existing |
| Unit (hook) | `storeSession` notifies same-tab listeners | vitest + RTL | ✅ unchanged |
| Unit (hook) | `clearSession` notifies same-tab listeners | vitest + RTL | ✅ unchanged |
| Unit (hook) | Cold-mount null → `"loading"`, no wipe | vitest + RTL | Planned ✓ |
| Unit (hook) | Real → null → wipe + `"none"` | vitest + RTL | Planned ✓ |
| Unit (hook) | Same-instance relogin doesn't inherit prev session's evidence | vitest + RTL | Planned ✓ (covers spec staffreview Critical #1) |
| Unit (RootLayout) | Escape hatch hidden initially | vitest + RTL + fake timers | Planned ✓ |
| Unit (RootLayout) | Escape hatch visible after 5s + click → clearSession | vitest + RTL + fake timers | Planned ✓ |
| Unit (RootLayout) | Loading → active before 5s does NOT flash | vitest + RTL + fake timers | Planned ✓ |
| E2E | 6 specs un-skipped | Playwright (CI) | Planned ✓ |

### Missing test coverage (must add)

None — the 6 hook tests + 3 RootLayout tests + 6 e2e specs cover the spec's stated cases comprehensively.

### Test execution checkpoints

1. After Task 1 — `npx vitest run src/hooks/useSession.test.tsx` (6 PASS).
2. After Task 2 — `npx vitest run src/components/layout/__tests__/RootLayout.test.tsx` (3 PASS).
3. After Task 3/4 — `npm run test` (full suite green).
4. Final — e2e CI on the ready PR (all 8 specs green).

### Regression risk

- **`AppHeader.test.tsx` + `SpokeLayout.test.tsx`** mock `useSession` statically; isolated from internals. ✓ No impact.
- **`router.test.tsx`** uses a real `ConvexReactClient` with `example.convex.cloud` — queries don't actually run. ✓ No impact.
- **`useSession.test.tsx` existing 3 tests** stay green because the default `mockUseQuery.mockReturnValue(undefined)` reproduces the current "no real session observed yet" state, which the new render-time branch maps to `"loading"` exactly as the existing test 3 already asserts. ✓ No assertion update needed.

## 11. Edge Cases to Address

- [x] Transient null on cold-mount reconnect — hook test 4
- [x] Genuine logout-elsewhere (real → null) — hook test 5
- [x] Same-instance relogin without page reload — hook test 6
- [x] Genuinely-stale localStorage cold mount — RootLayout test 7 (escape hatch click → clearSession)
- [x] Normal loading → active before 5s should NOT flash escape hatch — RootLayout test 8
- [x] React 19 StrictMode double-mount — `useRef` survives StrictMode's double-effect; idempotent assignments. No risk noted in spec; no test needed.
- [x] React `useRef`-during-render lint — refs aren't reactive; `react-hooks/exhaustive-deps` (warn-level in `eslint.config.js:125`) doesn't track ref reads. Plan's hook snippet passes lint. ✓ Verified against config.

## 12. Approval Conditions

**To approve the PLAN for execution:**

1. ✅ Fix Critical #1 — change `vi.fn<[], unknown>().mockReturnValue(undefined)` → `vi.fn().mockReturnValue(undefined)` (or `vi.fn<() => unknown>().mockReturnValue(undefined)`) in Task 1 Step 1. Update the plan's Tech Stack line from "vitest 1.x" to "vitest 2.1.8".

**Strongly recommended before execution:**

2. Improvement #1 — match the existing `// eslint-disable-next-line <rule>` style (no `--` separator; rationale on a comment line above).
3. Improvement #2 — note that the PrinterProvider mock is defensive-only.
4. Improvement #3 — flag the global `useQuery` mock as a footgun for future maintenance.

**Optional polish:** §4 Refinements (auth.spec.ts page.goto verification, MemoryRouter trace note).

---

*Generated by /staffreview — plan gate (Option B)*
