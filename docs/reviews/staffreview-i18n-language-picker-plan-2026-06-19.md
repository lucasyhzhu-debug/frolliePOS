# Staff Review: EN/ID Language Picker (#1 i18n) — PLAN

**Date:** 2026-06-19
**Plan:** `docs/superpowers/plans/2026-06-19-i18n-language-picker.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, Files, Tasks w/ deps, Testing per-task, Success Criteria, Rollback).

## 1. Summary

**Overall Assessment:** Revise (then approve). Architecture, signatures, and reuse are correct — verified
`withIdempotency`/`requireSession`/`logAudit`/`gridItemVariants`/`useIdempotency`-vs-`crypto.randomUUID`
against real code. Three Critical issues are all in **test seed/setup shapes** that would fail at runtime
the moment the tests run. All cheap to fix.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | convex-test staff seed omits required `code` | Testing | Task 3 & 4 tests |
| 2 | staff_sessions seed omits required `ended_at`/`end_reason` | Testing | Task 3 & 4 tests |
| 3 | `home.test.tsx` throws — `Home` now needs `LocaleProvider` | Testing | Task 5 Step 6 |

### Issue 1: `staff.code` is REQUIRED — seeds will fail validation
`convex/auth/schema.ts:7` defines `code: v.string()` (required since v1.1, ADR-034 sync prereq). The plan's
Task 3 and Task 4 `insert("staff", { name, role, active, pin_hash, created_at })` omit `code`, so
`convexTest` rejects the insert. The canonical seed (`convex/staff/__tests__/_helpers.ts:28`) patches
`code: "S-0001"`.

**Recommendation:** add `code: "S-0001"` (Task 3) / `code: "S-0002"` (Task 4) to every staff insert.

### Issue 2: `staff_sessions` REQUIRES `ended_at` + `end_reason` (both `union(_, null)`)
`convex/auth/schema.ts:26-32` — both fields are required unions, not optional. The plan's session inserts
omit them. The canonical helper passes both as `null` (`_helpers.ts:35-36`, explicitly documented at
`_helpers.ts:14-16`).

**Recommendation:** add `ended_at: null, end_reason: null` to every `staff_sessions` insert.

### Issue 3: `home.test.tsx` will throw "useT must be used within LocaleProvider"
After Task 5, `home.tsx` calls `useT()` and renders `<LocaleToggle/>` (which calls `useT`/`useLocale`).
But `src/routes/__tests__/home.test.tsx:37-43` renders `<Home/>` inside only `<MemoryRouter>` — no
`LocaleProvider`. `useT()`'s context guard throws, failing all 5 existing home tests. The plan's Step 6
mentions updating string assertions but not the provider wrap.

**Recommendation:** Task 5 Step 6 must wrap `renderHome` in `<LocaleProvider>` (inside `MemoryRouter`).
The existing `useSession` mock (`home.test.tsx:8-15`) returns staff without `locale`; that's runtime-safe
(`savedLocale ?? "en"`), but the mock is now type-loose — fine for a `vi.mock` factory. Group labels stay
`"MANAGER"` etc. (en defaults), so the role-tile assertions still pass.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Reuse/extend a shared staff-seed helper | M | L |
| 2 | Note self-only is structural (no cross-staff test needed) | L | L |

### Improvement 1: shared staff-seed helper
`convex/staff/__tests__/_helpers.ts` has `seedManagerSession`. The plan hand-rolls two more seeds. Per
rule-of-three this is borderline; recommend either reusing the helper or adding a sibling
`seedStaffSession(t)` so the required-field shape lives in one place and can't drift again (this exact
drift is Issues 1-2).

### Improvement 2: self-only is structural
`setOwnLocale` takes no `staffId` arg (derives from session), so "staffer A can't set B's locale" is
impossible to express — no negative test is needed. Worth a one-line comment in the test so a future
reader doesn't add a redundant case.

## 4. Refinements (Optional)
- Catalog-summary English plural inflects `count` (products) but not SKUs → "1 SKUs" when skus===1. Rare
  on a real catalog; acceptable. Could add `home.catalogSkus_one/_other` later if it bothers.
- The `t(\`home.group.${group}\`)` template-key access may need `as TranslationKey` (plan already notes).

## 5. Duplication Analysis
**Verified reuse (correct):** `withIdempotency`/`staffIdFromArgs` (matches `staff/public.ts:104-126`),
`requireSession → {staffId,deviceId,role}` (`auth/sessions.ts:13-21`), `logAudit` shape
(`staff/public.ts:85-93`), `gridItemVariants(reduce)` (`home.tsx:68`), inline `crypto.randomUUID()` for
one-shot mutations (`account.tsx:88`), the ESLint `no-restricted-syntax` fence shape (`eslint.config.js:163+`).
No duplication. One reuse gap: the test seed helper (Improvement 1).

## 6. Phase / Wave Accuracy
| Task | Assessment | Notes |
|------|------------|-------|
| 1 core → 2 provider | Good | 2 depends on 1 (dicts) ✅ |
| 3 schema/projection, 4 mutation | Good | independent of FE core; can parallel 1-2 |
| 5 toggle+home | Good | depends on 2,3,4 ✅ |
| 6 fence/ADR/docs | Good | mostly independent |
| 7 extraction Workflow | Good | after 1-6; correctly gated |

**Ordering:** sound. Task 7 correctly runs last (mechanism + fence first).

## 7. Specialist Agent Recommendations
| Phase | Agent | Rationale |
|-------|-------|-----------|
| Tasks 3-4 | `convex-expert` | schema + idempotent self-mutation + convex-test |
| Task 5 | `ui-component-builder` | flag SVG + toggle + token usage |
| Task 7 | Workflow fan-out | parallel per-file extraction (Lucas opted in) |

## 8. Git Workflow
Feature branch `i18n-language-picker` (worktree), squash-PR convention ✅. Commit-per-task ✅.
Pre-merge gate (typecheck+lint+vitest+build) in Success Criteria ✅.

## 9. Documentation
ADR-049, SCHEMA.md (staff.locale), CHANGELOG, CLAUDE.md — all in Task 6 ✅.

## 10. Testing Plan Assessment
**Verdict:** Adequate (after Critical fixes). Covers `t()` units, dictionary parity, provider behavior,
`getSession` projection, `setOwnLocale` happy + auth-reject, `LocaleToggle` interaction, full-gate + manual
bilingual smoke. The 3 Criticals are setup-shape bugs, not coverage gaps.

## 4.9 Evidence-Before-Mitigation Gate
N/A — this is a feature, not a flake/race fix. No timing/debounce/retry mitigations proposed.

## 11. Edge Cases (covered by plan)
- [x] absent `staff.locale` ⇒ English (Task 3 test).
- [x] toggle offline / mutation failure ⇒ optimistic revert + toast (Task 5).
- [x] login-transition seed doesn't clobber optimistic flip (Task 2 design).
- [x] keyset parity guard (Task 1 test).

## 12. Approval Conditions
**To approve, address:** Issues 1, 2, 3 (test seed `code`; session `ended_at`/`end_reason`; home.test
LocaleProvider wrap).
**Recommended:** Improvements 1-2.

---
*Generated by /staffreview*
