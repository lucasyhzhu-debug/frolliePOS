# Staff Review: Phase 0 — Modal off-screen (#8)

**Date:** 2026-06-18
**Plan:** `docs/superpowers/specs/2026-06-18-phase0-modal-offscreen.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (spec doubles as lean plan for an S-effort single-file fix; File Changes / Verification / Out-of-scope / Risk all present)

---

## 1. Summary

**Overall Assessment: Approve** (with 2 Improvements folded into the spec).

The root-cause analysis is correct and code-grounded: `DialogContent` (`src/components/ui/dialog.tsx:32-37`) is `fixed` + `translate(-50%,-50%)` with no height ceiling, so tall content clips both edges. The single-line fix (`max-h-[calc(100dvh-2rem)] overflow-y-auto`) on the shared primitive resolves all 11 dialog instances at once. No schema, backend, auth, or deploy-skew surface. Risk is minimal and reversible.

The one substantive gap is the **test strategy**: a className-string assertion in jsdom cannot verify clipping (jsdom has no layout engine), so it must be framed honestly as a regression guard, with the emulated-viewport check as the real gate.

## 2. Critical Issues (Must Fix)

None.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Frame the unit test honestly as a class-presence regression guard, not a behavior test; make the emulated-viewport check the load-bearing verification | M | L |
| 2 | Record the verified `tailwind-merge` propagation fact in the spec (no consumer sets `max-h`/`overflow`) | L | L |

### Improvement 1: Test strategy is jsdom-limited — say so
jsdom does no layout, so no automated test can assert "the dialog does not clip off-screen." The only feasible unit test is asserting `DialogContent` renders with `max-h-[calc(100dvh-2rem)]` + `overflow-y-auto` — a guard that the fix isn't accidentally deleted, not proof it works. The spec already leans this way ("regression guard"); make it explicit that the **emulated-viewport check is the real gate** and the unit test is a cheap deletion-guard. Don't over-invest: one render assertion via a consumer (e.g. a `PinSheet` render test) is enough; a dedicated `dialog.test.tsx` is optional.

**Recommendation:** Keep one minimal class-presence assertion; label it a guard; rely on the chrome-devtools viewport check for behavioral proof. Note the class string is brittle against #2's planned dialog refactor — acceptable, since #2 will re-verify.

### Improvement 2: Bank the propagation proof
Verified during review: all 11 `DialogContent` call sites set only `max-w-*` (+ some `px/pb`); **none set `max-h` or `overflow`**. Since `max-w` and `max-h` are different `tailwind-merge` groups, the base fix survives every consumer override. This is the load-bearing reason the one-line fix is universal — worth one line in the spec so a future editor doesn't second-guess it.

## 4. Refinements (Optional)

- **`dvh` support:** Android/Chrome ≥108 (2022) supports `dvh`; the booth tablet is modern, so no `vh` fallback needed. Note it so it isn't re-litigated.
- **`overscroll-contain`:** consider adding to prevent scroll-chaining to the page behind a scrolled dialog. Pure polish; defer to #2 if not trivial.
- **Sticky close (X):** the absolute `DialogPrimitive.Close` scrolls out of view on a tall, scrolled dialog. Every tall dialog (`PinSheet`, `PrinterSheet`, the `mgr/staff` keypad dialog at line 624) also has an in-flow Cancel/footer button and Esc/overlay-click still close it, so this is non-blocking. Defer sticky-close to #2.

## 5. Duplication Analysis

No duplication. The fix is to the single shared primitive; the spec correctly avoids per-consumer edits. The bottom-sheet idea is correctly deferred (Tailwind 4 has no height variant; would need custom CSS — scope creep for a blocker).

## 6. Phase / Wave Accuracy

Single-file, single-phase. Ordering trivial: edit → guard test → emulated-viewport verify → commit. No dependencies.

## 7. Specialist Agent Recommendations

None required — single-line CSS edit. Implement inline.

## 8. Git Workflow Assessment

- Branch: `fix/v1.2-phase0-modal-offscreen` (off `origin/main`) ✅
- One logical commit: `fix(ui): cap dialog height + scroll so modals don't clip off-screen on tablet (#8)`.
- Pre-push: `npm run typecheck` + `npx vitest run` (touched tests) + the emulated-viewport check.
- Rollback: revert one line. No deploy-skew (frontend-only CSS).

## 9. Documentation Checkpoints

- `docs/CHANGELOG.md` — add Phase 0 entry.
- No `SCHEMA.md` / `CLAUDE.md` / ADR changes (no ADR for #8, confirmed by roadmap).

### CHANGELOG draft
~~~markdown
## 2026-06-18 — v1.2 Phase 0
- fix(ui): dialogs now cap at viewport height and scroll internally, so the PIN sheet / printer sheet / mgr dialogs no longer clip off-screen on the booth tablet (#8).
~~~

## 10. Testing Plan Assessment

**Verdict: Adequate** (after Improvement 1's honest framing).

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Frontend | `DialogContent` renders with max-h + overflow guard | vitest + RTL (class-presence) | planned |
| Manual | PinSheet + PrinterSheet on ~800×600 & ~800×720 viewport | chrome-devtools `emulate`/`resize_page` | planned (HARD gate) |

**Regression risk:** none expected — additive className; dialogs that already fit are visually unchanged (max-h only engages when content exceeds the cap).

## 11. Edge Cases to Address

- [x] Consumer className override stripping the fix — verified none do (Improvement 2).
- [x] Short viewport (on-screen keyboard) — `dvh` + internal scroll handles it; PIN uses in-app `NumericKeypad`, not OS keyboard, so OS keyboard rarely fires for the tallest dialog.
- [x] Bottom-sheet thumb-reach — explicitly deferred, documented.

## 12. Approval Conditions

**To approve:** none blocking.
**Fold into spec before planning:** Improvement 1 (honest test framing) + Improvement 2 (tailwind-merge propagation note). Both are one-line spec edits.

---

*Generated by /staffreview*
