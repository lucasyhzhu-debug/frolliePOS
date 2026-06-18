# Staff Review: v1.2 Phase 1 — Phthalo-dark design system (#2 + #4 + #5)

**Date:** 2026-06-18
**Plan:** `docs/superpowers/specs/2026-06-18-v1.2-phase1-design-system.md` (design spec — feeds the plan)
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ It's a spec, not a plan — testing/rollback present as Verification/Risk; plan-level test enumeration still owed (see §0).

---

## 0. Plan Structure Additions

This is the design spec (pre-plan). It has Scope, Files, Verification (HARD gates), Out-of-scope, Risk. **Owed to the plan** (not the spec): per-task ordering, the explicit list of *existing* tests the redesign breaks, and commit boundaries. Flagged below as plan obligations, not spec defects.

## 1. Summary

**Overall Assessment:** Approve (spec) with 2 fixes folded in.

Strong, code-grounded spec. The decisive facts (no theme mounted, ~27 dead tokens referenced only by never-rendered badge variants, framer-motion present/unused) were re-verified true against the worktree. Two items must land in the spec before planning: the **Tailwind-4 `dark:` variant strategy** (the `.dark` class does NOT drive `dark:` utilities by default) and a **named list of existing tests the redesign will break**. Everything else is Improvement/Refinement.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Existing tests the redesign breaks are not enumerated | Testing | spec §Verification |

### Issue 1: Existing tests the redesign breaks aren't named
`home.test.tsx` (`src/routes/__tests__/home.test.tsx`) almost certainly asserts the current behavior #4 changes — the greyed mgr tiles + "mgr only" badge for staff. Hiding those (and dropping empty groups) **will break those assertions**. `sale/index.test.tsx` and `charge-success.test.tsx` exist and could break on markup changes. The spec lists *new* home render tests but doesn't acknowledge the *existing* ones that must be updated.

**Recommendation:** Add to the spec's Verification/Testing: "the plan must enumerate and update existing tests touched by the redesign — at minimum `src/routes/__tests__/home.test.tsx` (mgr-tile hide/show), and re-green `sale/index.test.tsx` + `charge-success.test.tsx`." (Done inline.)

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Declare the Tailwind-4 `dark:` variant strategy | H | L |
| 2 | Pin home test path; reuse-vs-bespoke app-bar note | M | L |
| 3 | Add a contrast (WCAG-AA) check to the mock/glare gate | M | L |

### Improvement 1: Tailwind-4 `dark:` variant strategy (the real gotcha)
Verified: `src/index.css` has **no `@custom-variant dark`**. In Tailwind v4, `dark:` utilities default to `@media (prefers-color-scheme: dark)` — they do **not** key off a `.dark` class. So with a permanent `class="dark"`, the lone `dark:bg-amber-950` (`sale/voucher-reject-banner.tsx`) keys off the OS, not our theme. The spec already sweeps that one usage, so nothing breaks *today* — but because we keep `:root` as a genuine light fallback and `.dark` as the default, the app IS a two-theme setup and `dark:` *should* follow the class. **Recommendation:** add `@custom-variant dark (&:where(.dark, .dark *));` to `index.css` so the class-based strategy is correct and the glare-fallback (flip the class) flips `dark:` utilities coherently. (Folded into spec §B.)

### Improvement 2: Pin test path + deliberate app-bar decision
Spec said home test is "in `__tests__` or co-located" — resolved: `src/routes/__tests__/home.test.tsx`. Also note deliberately: the home keeps a **bespoke top app-bar** (not the spoke `AppHeader`) because it's the hub; it *reuses* `PrinterSheet` + `ConnDot`. (Folded in.)

### Improvement 3: Contrast check in the mock gate
Warm ink `#F1E9D8` on `#102821` paper is very high contrast (good), but `--muted-foreground` `#8E8878` on paper needs a WCAG-AA check for small text. **Recommendation:** the design-mock approval gate should include an explicit AA contrast pass on body + muted text, not just "looks good." (Folded into §G.)

## 4. Refinements (Optional)

- Token mapping fidelity: don't over-invest converting DS hex → oklch. shadcn vars accept hex directly; readability (the glare gate) matters more than exact-oklch parity. Use hex or a quick conversion.
- Pick ONE reduced-motion mechanism (Framer `useReducedMotion`) rather than mixing CSS media + JS.
- Hero New Sale + grouped tiles may exceed viewport height — confirm the hero lives inside the scrollable `main` so it doesn't push tiles off a short tablet.

## 5. Duplication Analysis

| Code | Location | How to use |
|------|----------|------------|
| `PrinterSheet` | `src/components/pos/PrinterSheet.tsx` | Reuse in home app-bar (already planned) |
| `ConnDot` | `src/components/layout/ConnDot.tsx` | Reuse in home app-bar (already planned) |
| Motion tokens | `src/index.css` (`--ease-*`,`--dur-*`) | Framer + tw-animate-css consume them — don't redefine |

**Risk:** none — spec reuses existing components, doesn't reinvent.

## 6. Phase / Wave Accuracy

Spec defers ordering to the plan (correct). The mock-first gate (Task 1, hard STOP) is the right shape. Caution flagged for the plan: sequence tokens → primitives → mock-gate → surfaces → raw-sweep → tests, so the mock reflects real tokens.

## 7. Specialist Agent Recommendations

| Work | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Surface redesign / primitives | `ui-component-builder` | shadcn + Tailwind + Framer Motion specialist |
| Token/CSS port | `claude` (general) | CSS var work, no special agent needed |

## 8. Git Workflow Assessment

Single squash-PR (repo convention) ✓. Commit boundaries owed to the plan: ADR → tokens+index.html → primitives → mock-gate → each surface → raw-sweep → docs. Pre-push: `npm run typecheck` + `npx vitest run src/` (spec §Verification) ✓.

## 9. Documentation Checkpoints

ADR-047 (new), CHANGELOG, PROGRESS (#4/#5 folded), CLAUDE.md token note. All in spec §Files. ✓

## 10. Testing Plan Assessment

**Verdict:** Insufficient → fixed to Adequate via Critical #1. New home render tests + re-green existing `home`/`sale/index`/`charge-success` tests. jsdom can't verify dark readability — the **glare gate + mock screenshots** are the load-bearing visual check (correctly identified as HARD gates).

## 11. Edge Cases to Address

- [ ] Short-tablet viewport: hero + tiles must not clip (scrollable main).
- [ ] `prefers-reduced-motion`: all Framer interactions must no-op.
- [ ] Manager vs staff home render (both paths tested).
- [ ] Glare fallback path actually works (remove `class="dark"` → coherent light theme).

## 12. Approval Conditions

**To approve (folded into spec):**
1. Critical #1 — name the existing tests the redesign breaks.
2. Improvement #1 — declare the `dark:` variant strategy (`@custom-variant`).

**Recommended (folded):** pin test path, contrast check in the gate.

---

*Generated by /staffreview — Pass 1*
