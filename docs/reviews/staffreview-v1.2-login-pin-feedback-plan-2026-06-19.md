# Staff Review: Login PIN Feedback (#7 + #11) — PLAN

**Date:** 2026-06-19
**Plan:** `docs/superpowers/plans/2026-06-19-v1.2-login-pin-feedback.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, Global Constraints, 6 TDD tasks with file paths + interfaces, per-task tests, final verification, verify-first list, rollback in Global Constraints)

---

## 1. Summary

**Overall Assessment:** Approve (fold 3 Improvements before execution)

Strong, grounded plan — every task carries real code verified against the actual files, exact `npx vitest run <path>` commands with expected pass/fail, and clean commit boundaries. The test-infra traps are pre-empted (IDB-hook mocking, `vi.clearAllMocks` for the sonner spy, args-based query discrimination to survive re-renders). The #11 denial fix correctly satisfies the **Evidence-Before-Mitigation gate**: Task 5 Step 2 observes the regression RED on current code before Step 3's fix, and the mechanism is deterministic (a `useRef` reset on remount), so a unit test is a sufficient artefact. No Criticals. Three Improvements: a missing success-path test (spec §9 lists it), locking input during the success tick, and registering `login.tsx` in the #12 lint fence now that its sync toast is converted.

## 2. Critical Issues (Must Fix)

None.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Add the success-path test (green "Welcome" → `navigate("/")` after 200ms) — spec §9 requires it; plan tests only the two error paths | H | M |
| 2 | Lock keypad input during the success tick (`disabled` on `pending \|\| phase==="success"`) | M | L |
| 3 | Append `src/routes/login.tsx` to the ESLint #12 fence registry (now a converted file) | M | L |

### Improvement 1: Missing success-path test
Task 4 tests `INVALID_PIN` and `LOCKED_OUT` but not the happy path the spec lists in §9 ("Success path shows green, then `navigate("/")`"). The success branch has the most moving parts (`setPhase("success")` → `storeSession` → 200ms `setTimeout` → navigate), so it's the most valuable to cover.

**Recommendation:** add a Task 4 test that mocks `react-router`'s `useNavigate` to a spy (the `login.tsx` import is `from "react-router"`; mirror `charge.test.tsx`'s `vi.hoisted` + partial-module mock), resolves the `login` action to `{ sessionId }`, types the PIN, asserts the green `role="status"` "Welcome" appears, then `await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith("/", { replace: true }))` (a real 200ms timer resolves well inside waitFor's 1s budget — no fake timers needed).

### Improvement 2: Lock input during the success tick
`PinEntry` disables the keypad only when `pending`. On `success` (pending=false) the keypad is live for the 200ms before navigate. The buffer is full (4) so digits are ignored, but **Clear/backspace would empty the green dots** and flicker before the route swaps.

**Recommendation:** pass `disabled={pending}` → `disabled` should also cover success. Simplest: in `login.tsx` the parent already knows; but since `PinEntry` owns the keypad, change its `NumericKeypad` line to `disabled={pending || phase === "success"}`. Add one assertion to the Task 3 success test that the digit button is disabled.

### Improvement 3: Register `login.tsx` in the #12 lint fence
`eslint.config.js:169` is the #12 inline-messaging migration registry; its comment says "Append files here as later #12 slices convert them." This phase converts `login.tsx`'s sync `INVALID_PIN`/device-not-ready toasts to inline `FieldMessage` — exactly such a slice. After conversion the only remaining `toast.error` is the denial (a template literal **with** expressions), which the fence selectors do not match, so adding `login.tsx` is **safe** and locks in the conversion against regressions.

**Recommendation:** add `"src/routes/login.tsx"` to the `files` array at `eslint.config.js:169` as a step in Task 4 (after the toast removal), and add `npm run lint` to that task's verification.

## 4. Refinements (Optional)

- The CHANGELOG step says "match the existing format" — fine, but the implementer should drop the three bullets under the current unreleased v1.2 heading rather than minting a new dated section if one already exists.
- Consider asserting `localStorage.getItem(SESSION_KEY)` is set in the success test (proves `storeSession` ran) — optional, the navigate assertion already implies the happy path.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How used |
|------|----------|----------|
| `Button` base active-scale / disabled styling | `src/components/ui/button.tsx:7` | Task 1 reuses (only adds `active:bg-accent`) ✓ |
| `FieldMessage` | `src/components/ui/field-message.tsx` | Tasks 3/4 ✓ |
| `PinSheet` pending/error pattern | `src/components/pos/PinSheet.tsx` | pattern source for `PinEntry` ✓ |
| `useLastStaff` helper shape | `src/hooks/useLastStaff.ts` | Task 2 mirrors ✓ |
| `charge.test.tsx` `useNavigate` mock | `src/routes/sale/charge.test.tsx:33` | Improvement 1's navigate spy |

### Potential duplication risks
- None. No re-implementation; `NumericKeypad.disabled` is shared, not duplicated.

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|------|------------|-------|
| 1 NumericKeypad | Good | no deps |
| 2 denial helper | Good | no deps; needed by 5 |
| 3 PinEntry | Good | consumes 1 |
| 4 login machine | Good | consumes 3 |
| 5 denial fix | Good | consumes 2; evidence-first ordering correct |
| 6 StaffListItem + CHANGELOG | Good | independent |

**Ordering issues:** none — `1→3→4` and `2→5` dependencies are satisfied by the 1..6 sequence. All SEQUENTIAL (each ends in a commit).

## 7. Specialist Agent Recommendations

| Work | Agent | Rationale |
|------|-------|-----------|
| Execution (per-task subagents) | the pipeline's executing-session subagent | plan is TDD-structured for `subagent-driven-development` |
| Post-impl QA | `/triple-review` → `/simplify xhigh` | repo close-out (baked into the handoff) |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch | ✅ `spec/v1.2-login-pin-feedback` worktree |
| Commit per task | ✅ 6 commits, one per task, `<type>(v1.2):` |
| Typecheck before commit | ✅ each task |
| Lint before push | ⚠️ add to Task 4 (Improvement 3) |
| Rollback | ✅ revert PR, FE-only |

## 9. Documentation Checkpoints

| Task | Docs |
|------|------|
| 6 | `docs/CHANGELOG.md` ✅ |

No `SCHEMA.md`/`API_REFERENCE.md`/ADR change (correct — ADR-048 already governs).

## 10. Testing Plan Assessment

**Verdict:** Adequate (with Improvement 1 added).

| Layer | What | Type | Status |
|-------|------|------|--------|
| Component | NumericKeypad disabled/keydown/pressed | vitest+RTL | planned (5) |
| Lib | pinResetDenials | vitest | planned (4) |
| Component | PinEntry pending/error/persist/success | vitest+RTL | planned (5, +1 for Improvement 2) |
| Route | login INVALID_PIN / LOCKED_OUT inline | vitest+RTL | planned (2) |
| Route | login **success → navigate** | vitest+RTL | **MISSING — Improvement 1** |
| Route | denial once-across-remount (evidence-first) | vitest+RTL | planned (1) |
| Component | StaffListItem pressed | vitest | planned (1) |

### Regression risk
- Existing `PinEntry.test.tsx` (2) and `login.test.tsx` (4) — preserved; new IDB-hook mocks make them faster, not different. Verified the new `vi.mock`s only touch `useDeviceId`/`useIdempotency` (login imports only those).

## 11. Edge Cases to Address

- [x] Held hardware key during pending — Task 1 keydown guard + test
- [x] Re-render feeding wrong query value — Task 5 args-discrimination
- [x] Sonner spy leak across tests — `vi.clearAllMocks` in beforeEach
- [ ] Input live during success tick — Improvement 2
- [x] setTimeout cleanup on unmount — Task 4 cleanup effect

## 12. Approval Conditions

**To approve:** no Criticals — approved.
**Before execution (fold inline):** Improvements 1–3.

---

*Generated by /staffreview*
