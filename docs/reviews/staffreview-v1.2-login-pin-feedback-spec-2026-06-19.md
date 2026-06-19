# Staff Review: Login PIN Feedback (#7 + #11) — SPEC

**Date:** 2026-06-19
**Plan:** `docs/superpowers/specs/2026-06-19-v1.2-login-pin-feedback-design.md` (spec gate, pre-plan)
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Spec — reviewed for architecture correctness before planning (pipeline gate 1)

---

## 1. Summary

**Overall Assessment:** Approve (fold 5 Improvements inline before writing the plan)

The spec is well-grounded — every code claim verified against the real files (`login.tsx`, `PinEntry.tsx`, `NumericKeypad.tsx`, `PinSheet.tsx`, `FieldMessage`, `login.test.tsx`). The #11 "random toast" fix correctly satisfies the **Evidence-Before-Mitigation gate** (repro-first mandated per the #44 postmortem). No Critical issues. Five Improvements close ambiguities that would otherwise be resolved arbitrarily during implementation — chiefly the **error-clear mechanism** (how `PinEntry` distinguishes a transient wrong-PIN message from a persistent lockout banner) and the **storage-helper shape** for the denial dedup.

## 2. Critical Issues (Must Fix)

None.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Specify the transient-vs-persistent error-clear mechanism in `PinEntry` | H | L |
| 2 | Pin down LOCKED_OUT countdown: static text vs live `useCountdown` | M | L |
| 3 | Concrete denial-dedup storage shape (key in `storage-keys.ts` + helper module, not `storeSession`) | M | L |
| 4 | Add the no-deploy-skew / revert-the-PR rollback note (FE-only) | L | L |
| 5 | Ground the denial regression test in the real `login.test.tsx` mock harness | M | L |

### Improvement 1: Error-clear mechanism (transient vs persistent)
§2's phase machine carries `sticky` on the `error` variant, but §3B's `PinEntry` props (`pending`, `phase`, `message`) **don't thread it down**. The spec specifies the *behavior* (INVALID_PIN "clears on the next digit"; LOCKED_OUT "persists until the next successful transition") but not the *mechanism* — and `PinEntry` owns the buffer while the parent owns the phase, so without a rule the implementer will guess.

**Recommendation:** thread a `persist: boolean` into `PinEntry`. Rule: a **non-persistent** message auto-hides once `buffer.length > 0` (the staffer resumed typing) — no new parent callback needed, since `PinEntry` already knows its buffer. A **persistent** message (lockout) stays regardless of buffer until the parent clears `message`/phase on the next transition. This keeps the leaf presentational and needs zero new wiring.

### Improvement 2: LOCKED_OUT countdown — static vs live
§4 says the banner "shows the wait-seconds," but doesn't say whether it **ticks down live**. `useCountdown` already exists (`src/hooks/useCountdown.ts`, per CLAUDE.md). 

**Recommendation:** default to **static text** ("Terkunci — tunggu 60 dtk, manajer sudah diberi tahu") — matches current behavior and is simplest. Optionally reuse `useCountdown` for a live tick if QA finds the static number confusing. Disabling the keypad during the window is optional (the server enforces lockout regardless) — leave the keypad live unless QA asks.

### Improvement 3: Denial-dedup storage shape
§5/§8 say "via the `storage-keys.ts` namespace — `storeSession`-style helper." `storeSession` is **session-id** storage living in `useSession`; the correct analog is **`useLastStaff.ts`** (a tiny module: a declared key constant + get/add functions over `localStorage`). `storage-keys.ts` is a **constants-only** file (`SESSION_KEY`, `LAST_STAFF_KEY`, `DEVICE_ID_KEY`).

**Recommendation:** declare `SHOWN_PIN_RESET_DENIALS_KEY = "frollie-shown-pin-reset-denials"` in `storage-keys.ts`, and add a small helper (mirror `useLastStaff`) exposing `hasShownDenial(requestId)` / `markDenialShown(requestId)` backed by a JSON string-array in `localStorage`. The effect calls `hasShownDenial` instead of the in-memory `useRef` Set.

### Improvement 4: Rollback / deploy-skew note
The spec is FE-only with **no function-signature change** (no mutation↔action rename, no schema), so it's immune to the deploy-skew hazard that gates this repo's atomic builds.

**Recommendation:** add one line to §7/§8: "Rollback = revert the PR; FE-only, no backend signature or schema change, so no deploy-skew / atomic-build concern."

### Improvement 5: Ground the regression test
§9's "denial toast fires once across a remount" test should name **how** it slots into the existing harness: `login.test.tsx` wires `useQuery` call-slot 0 = `getActiveStaff`, slot 1 = `getRecentPinResetForStaff`. The test sets `LAST_STAFF_KEY` (to enter the PIN stage via pre-stage), makes slot 1 return `{ status: "denied", requestId, denied_by_manager_name, ... }`, then `unmount()` + re-`render()` **within one test** (no `localStorage.clear()` between) and asserts `toast.error` fired **once** (red on current code, green after the dedup).

## 4. Refinements (Optional)

- **Success-tick cleanup:** clear the 200ms `setTimeout` on unmount to avoid a state-set-after-unmount warning if the tree unmounts mid-tick.
- **Spinner a11y:** the pending state should expose an accessible "Memverifikasi…" label (e.g. `role="status"` / `aria-live="polite"`), as §6 already notes — make it explicit in the plan.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `FieldMessage` | `src/components/ui/field-message.tsx` | error/success inline message (ADR-048) — already the spec's choice |
| `PinSheet` pending/error pattern | `src/components/pos/PinSheet.tsx:94-105` | pattern source for the spinner + inline error lift |
| `useLastStaff` helper shape | `src/hooks/useLastStaff.ts` | template for the denial-dedup localStorage helper |
| `useCountdown` | `src/hooks/useCountdown.ts` | optional live lockout countdown (Improvement 2) |
| `pinReset`→fresh-idempotencyKey | `src/routes/login.tsx:46-54` | preserve as-is; spec already flags it |

### Potential duplication risks
- None — the spec lifts the `PinSheet` pattern into `PinEntry` rather than re-implementing; `NumericKeypad`'s new `disabled` prop is shared, not duplicated.

## 6. Phase / Wave Accuracy

Spec-level — phases are the plan's job. The §8 file list is correctly scoped (5 source files + 2 test files) and matches the mega-spec's #7+#11 "one coordinated unit" coupling. No PinSheet rewrite (correctly out of scope).

## 7. Specialist Agent Recommendations

| Work | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Implementation | `frontend-integrator` / `ui-component-builder` | React + prop-driven component rewrite |
| Post-impl QA | `/triple-review` then `/simplify xhigh` | repo standard close-out (handoff bakes this in) |

## 8. Git Workflow Assessment

One PR (#7+#11 coupled). FE-only. Commit boundaries: NumericKeypad `disabled` → PinEntry rewrite → login.tsx phase machine → denial-dedup fix (+ its repro test first) → StaffListItem. `npm run typecheck` + `npx vitest` before push. Rollback = revert PR (Improvement 4).

## 9. Documentation Checkpoints

`docs/CHANGELOG.md` only (spec correctly says no schema/ADR — ADR-048 already governs the inline policy). No `SCHEMA.md`/`API_REFERENCE.md` change.

## 10. Testing Plan Assessment

**Verdict:** Adequate (for a spec). §9 covers pending-disable, INVALID_PIN-inline-no-toast, LOCKED_OUT-banner, success-green-then-navigate, and the denial-once-across-remount regression. Improvement 5 grounds the regression in the real harness. The plan must add the explicit vitest assertions.

## 11. Edge Cases to Address

- [x] Held hardware key during pending (spec: keydown guard) — covered
- [ ] Transient vs persistent message clear (Improvement 1)
- [ ] Lockout countdown live vs static (Improvement 2)
- [ ] Success `setTimeout` cleanup on unmount (Refinement)
- [x] Reduced-motion (spec: `motion-safe:`) — covered

## 12. Approval Conditions

**To approve:** no Criticals — approved.
**Before writing the plan (fold inline):** Improvements 1–5.

---

*Generated by /staffreview*
