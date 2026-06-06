# Staff Review: v0.5.9 — e2e Stabilization Implementation Plan

**Date:** 2026-06-06
**Plan:** `docs/superpowers/plans/2026-06-06-v0.5.9-e2e-stabilization.md` (commit `55ff197`)
**Spec:** `docs/superpowers/specs/2026-06-06-v0.5.9-e2e-stabilization-design.md` (commit `504d675`, already passed staffreview gate)
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** Validated — all required sections present (Goal, File Map, Phases, Tests, Success Criteria, Rollback).

---

## 0. Plan Structure Additions

None — plan has a "Self-review", "File map", task-numbered phases, gates, rollback section, and a "Top 3 risks" appendix. Structurally complete.

## 1. Summary

**Overall Assessment:** Revise (1 Critical, 4 Improvements, 5 Refinements)

The plan is unusually thorough — line-numbered edits, copy-paste-ready code blocks, named gates with attribution rules, and conditional Task-0 fork-handling that anticipates a Radix unknown. Spec coverage is near-complete and the load-bearing claims about real code (line numbers in `spoilage.tsx:234-291`, `vouchers.tsx:585-611`, `sale/index.tsx:183`, the 7 seed products in `seed/internal.ts:101-109`, `seed/actions.ts:21-55` return signature, charge.tsx Tabs at `:494-497`, SKILL.md baseline 557 lines and §4.8/Step 5 boundaries) all hold up against the worktree code.

**However, one load-bearing claim is wrong:** the plan's File Map asserts `e2e/fixtures.ts:37-41 — Keep PR #48's warm-up drop`, but the worktree branched off `main` (commit `48615b7`) *before* PR #48's commits landed. `fixtures.ts:37-41` in the worktree still contains the 1500ms `page.waitForTimeout(1500)` warm-up — it has NOT been dropped. The plan has no task to drop it, which means at execute-time either (a) the warm-up stays and the spec's "mitigation cleanup" goal silently slips, or (b) the executor improvises a drop without a planned commit boundary. This is the only Critical-severity gap.

The plan's three structural strengths worth preserving in any revision: Task 0's smoke design (clean YES/NO recording), Task 10's static-analysis-backed honest re-skip with a documented re-verify fork, and the Gate-1 attribution rule ("new selector class failing is a Slice 2 finding, not a Slice 1 bug").

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Plan asserts `fixtures.ts:37-41` warm-up has been dropped; worktree still has it; no task exists to drop it | Spec coverage / Load-bearing claim wrong | File map row "Task: keep PR #48's warm-up drop" + spec §3 Slice 1 "Fixtures" |

### Issue 1: `e2e/fixtures.ts:37-41` 1500ms warm-up is still present in worktree; plan has no task to drop it

**What the plan claims** (File map summary row at top + recap line under Task 11): *"keep PR #48's drop of the 1500ms warm-up (5-line block)"*. Spec §3 Slice 1 "Fixtures" matches: *"`e2e/fixtures.ts:37-41` — keep PR #48's drop of the 1500ms warm-up (5-line block)."*

**What is actually in the worktree** (`fixtures.ts:36-42`, verified):

```ts
  await expect(page).not.toHaveURL(/\/login/, { timeout: 2_000 });
  // Convex client warm-up window. Without this, the next page.goto in the test
  // can trigger a transient null on the session-validation query during WS
  // reconnect → useSession.isDead effect clears localStorage → next render
  // redirects to /login. Empirically reproduced on every signedIn fixture spec.
  await page.waitForTimeout(1500);
}
```

The 1500ms sleep is still there. Verifying against `git log --all --oneline`: the worktree base is `48615b7` (above `b644d6a "fix(e2e): drop awaitSignedIn warm-up sleep"` in the timeline). The "drop" lives on a parallel branch that PR #48 produced; it has not been merged or cherry-picked into this worktree.

**Why this is Critical, not Refinement:**
1. The spec explicitly enumerates the warm-up drop as a Slice 1 deliverable (it is mentioned as a discrete file in §3 Slice 1).
2. The postmortem (Task 17, Lesson 1) cites the 1500ms warm-up as the canonical mitigation example — leaving it on `main` while the postmortem calls it out for removal is internally inconsistent.
3. Tasks 1-11 plus Gates leave no commit boundary that touches `fixtures.ts`. An executor following the plan task-by-task will ship without removing it.
4. The plan's "Self-review > Spec coverage" line claims "All 10 success criteria in §8 of the spec map to specific tasks" — the fixtures.ts warm-up is in spec §3 Slice 1; this claim is wrong as written.

**Recommendation:** Add an explicit task (e.g., **Task 2.5: Drop fixture warm-up**) between Task 2 and Task 3, with its own commit:

```bash
# Edit e2e/fixtures.ts: delete the 6-line comment + waitForTimeout(1500) block at lines 36-41.
git add e2e/fixtures.ts
git commit -m "fix(e2e): drop 1500ms warm-up in awaitSignedIn — was a mitigation, now refuted

PR #48 instrumentation refuted the transient-null hypothesis (run 27021101339).
The warm-up was a mitigation for a misdiagnosed Convex client race. The real
bug was a11y/selector drift — see docs/postmortems/2026-06-issue-44-misdiagnosis.md.
With the real fix in this PR (Tasks 1-9), the warm-up is dead weight."
```

Update the file-map row to list this as a real task; update the Self-review spec-coverage line accordingly.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Task 0 PASS/FAIL still has a small ambiguity (label-click vs centred-trigger-click on shared bbox) | M | L |
| 2 | Task 14 SKILL.md commit lands outside the Frollie PR — easy to silently miss at gate-2 push | M | L |
| 3 | Snapshot test promised in spec §3 Slice 2 / spec §4 step 8 isn't actually in the plan (replaced by vitest unit test) | M | L |
| 4 | Task 10 "re-verify fork" at execute-time silently downgrades the static-analysis decision; better to commit to one path | L | L |

### Improvement 1: Task 0 PASS/FAIL is concrete but has one residual ambiguity

The smoke check ("click the literal text 'Type' of the label (not the trigger button)") is well-designed — it isolates label-forwarding from trigger-click. However, in shadcn's typical `<div className="space-y-1.5"><Label>…</Label><SelectTrigger>…</SelectTrigger></div>` layout, the Label and SelectTrigger have non-overlapping bounding boxes, so the click target is unambiguous. **But** if the dev panel is narrow and the Label text wraps onto the same visual row as the trigger, a manual click on the literal text could miss in a way that's hard to attribute. Two clarifications would lock the gate:

1. Add an explicit "if uncertain, run Playwright's own `page.getByLabel(/Type/i).click()` against `/mgr/vouchers` once (after Task 4's local edits) — the result of that call is the canonical PASS/FAIL signal, since Playwright is the consumer in the downstream specs."
2. Note that Step 4's `git restore` only reverts the file change; if the dev server is still running, browser state may need a hard reload. Cheap addition; saves a 10-minute confused-debug at execute time.

**Recommendation:** Reword Task 0 Step 2 to include: *"Canonical signal: run `npx playwright test --headed --grep 'voucher (online)'` once after a local Task-4 edit; observe whether the Type Select dropdown opens. That's the gate."* This skips the human-visual-judgment step entirely.

### Improvement 2: Task 14 SKILL.md commit lands in a different git tree than the Frollie PR — easy to forget

Task 14 Step 6 commits in `~/.claude/skills/staffreview` (its own git tree). The plan's "Top 3 risks" #3 acknowledges this, but the workflow has no enforcement: if the executor forgets to push the skill change, the Frollie PR merges and `gstack-upgrade` later silently overwrites the local skill edit. The CHANGELOG entry (Task 18) and PR body (Task 19) both reference §4.9 as if it exists.

**Recommendation:** Add a Gate-3 step before Task 18 (CHANGELOG):

```bash
# Verify the skill commit landed
cd ~/.claude/skills/staffreview && git log --oneline -1 | grep -q "4.9 Evidence-Before-Mitigation" || { echo "SKILL.md commit missing — go back to Task 14"; exit 1; }
```

Alternative: have Task 14 also write a tiny marker file (e.g., `~/.claude/skills/staffreview/.last-edit`) so a check from any cwd works.

### Improvement 3: The spec promised a snapshot test (§4 step 8 + §5 file map); the plan replaced it with a vitest unit test — fine, but make that explicit

Spec §4 build sequence step 8: *"Slice 2.C — snapshot test (one commit): `src/routes/sale/__tests__/aria-label-format.test.tsx`."* Spec §5 file map: *"`src/routes/sale/__tests__/aria-label-format.test.tsx` — Slice 2 — Create (snapshot pin)."*

The plan's Task 1 + Task 2 ship a vitest unit test at `src/lib/__tests__/label.test.ts` covering all 7 seed products + edge cases. **This is strictly better** than the proposed DOM snapshot (cheaper, no jsdom, no DOM lifecycle), and the spec §3 Slice 2 actually says *"helper is reusable if other parts of the UI need the same label later"* — so the spirit was always extract-helper, not DOM snapshot. But the plan never explicitly notes that it is replacing spec §4 step 8 / §5's `aria-label-format.test.tsx` row with the vitest helper. A future spec-vs-plan diff reviewer will flag this as a coverage gap.

**Recommendation:** Add one sentence to the plan's "Self-review > Spec coverage" line: *"Spec §4 step 8 / §5 row `aria-label-format.test.tsx` (snapshot test) is fulfilled by Task 1's vitest at `src/lib/__tests__/label.test.ts` — extract-helper-first is consistent with spec §3 Slice 2 prose, and cheaper than the DOM snapshot."*

### Improvement 4: Task 10's "re-verify fork" at execute-time gives the executor a choice that requires backend judgment

Task 10 Step 1 (optional re-verify) reads stdout of `npx convex run seed/actions:reset` and forks to either Step 2 (honest re-skip) or Step 2-ALT (attempt-fix). The static-analysis decision (Step 2) is already correct based on the action's declared return type `Promise<{wiped: number; inserted: number}>` (verified in worktree at `convex/seed/actions.ts:23`). The chance that runtime stdout contains side-channel IDs is near-zero (the action doesn't `console.log` IDs). The "optional re-verify" path mostly creates an opportunity for the executor to wander into Step 2-ALT and start backend work that's explicitly out of spec scope.

**Recommendation:** Either delete Step 1 entirely (commit to the static-analysis decision; cite `seed/actions.ts:23` as the load-bearing line) or rewrite Step 1 as: *"Re-verify only to confirm — if Step 1 surfaces anything other than `{wiped, inserted}`, DO NOT branch to Step 2-ALT in this PR; instead, open a follow-up issue and proceed with Step 2 (honest re-skip) here."* The latter preserves the safety net without giving permission to widen scope.

## 4. Refinements (Optional)

- **Task 5's amount fix** (`5_000 → 45_000`) is correct against `seed/internal.ts:102`. Same for Task 6 (`10_000 → 90_000`, 2×Dubai 1pc), Task 7 (`25_000 → 125_000`, Dubai 3 pcs from seed:103), Task 9 (`4_500 → 40_500`, Dubai 1pc – 10%). All verified.
- **Task 11's `head -5` verification** uses POSIX `head`; on Windows shell this requires Git Bash or WSL. The plan's environment is PowerShell per the env block. Use `Get-Content … -TotalCount 5` or just open in the editor — cosmetic.
- **Task 15's pattern doc** has good content but the CLAUDE.md cross-link instruction (Step 2) says *"Also add to the `docs/PATTERNS/` line in the 'File locations' subsection if there's an existing inventory of pattern docs"*. Verified: CLAUDE.md has `docs/PATTERNS/` listed under the docs/ inventory line, but does NOT enumerate individual pattern docs — only references `idempotency-dual-call-authcheck.md` inline in business rule #20. So Task 15 Step 2's "Also add to the `docs/PATTERNS/` line" is a no-op as written. Plan should either drop that instruction or be explicit ("no current inline enumeration to update").
- **Task 16 cites CLAUDE.md "around line 122"** — verified, the `**\`docs/\`:**` line is at the docs inventory paragraph in CLAUDE.md. Line number is approximate; that's fine.
- **Task 3's verification step** mentions "no duplicate-id warning in React DevTools console." React DevTools doesn't warn about duplicate `id` attributes; React itself does for duplicate `key` props. Wording is slightly off; the actual signal is the browser's HTML5 validator console message. Cosmetic.

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| Sibling Label pattern with htmlFor | `src/routes/mgr/vouchers.tsx:587 (Code), :614-618 (Value), :633 (Min cart)` | Task 4 explicitly mirrors `new-voucher-value` at lines 614-617 — correct |
| Per-row aria-label pattern | `src/routes/mgr/spoilage.tsx:284 ("Remove line ${i+1}")` | Task 3 explicitly uses the same `${i}` index convention — correct |
| `pack_label` from useCatalogCache | `convex/catalog/schema.ts` + `convex/catalog/public.ts::listActiveProducts` | Task 2 Step 3 grep-verifies (good safety check) |
| `_getSettings_internal` default-returning shape | `convex/settings/internal.ts` | Not relevant; plan doesn't touch settings |

### Potential duplication risks

- **None identified.** The plan extracts a new helper (`buildAddCardLabel`) for ≥3 prospective call sites (sale/index, plus Task 13 if found, plus possible Slice 2 disambiguator widening) — passes the rule-of-three.
- The plan correctly avoids extracting a second helper for the bare-Label htmlFor pattern; that pattern is 3 lines of JSX, not a function.

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| Task 0 (smoke) | Good | Pre-Task-1 placement is correct; smoke is read-only and reversible |
| Tasks 1-2 (helper + wire-up) | Good | TDD ordering (test before impl) followed; commit boundaries clean |
| Tasks 3-4 (src a11y) | Good | Independent files; could run in any order; sequential commits are fine for bisect |
| Tasks 5-10 (e2e specs) | Good | Independent files; Task 10's fork is well-scoped |
| Task 11 (REFUTED banners) | Good | Pure markdown; safe |
| Gate 1 → Tasks 12-13 | Good | Audit-then-fix; scope-capped at 10 files; attribution rule (Gate-1-failure-routes-to-audit) is excellent |
| Task 14 (skill edit) | Good with caveat | Insertion point between line 277 (end §4.8) and `---` at line 279 is correct (verified); §4.9 numbering doesn't collide with existing sections; commit lands in skill's own git tree (see Improvement 2) |
| Tasks 15-17 (docs) | Good | Independent files; commit-per-doc is appropriate |
| Tasks 18-19 (CHANGELOG + PR) | Good | Standard close-out; backfill step for `PR #<n>` is correctly deferred |

**Ordering issues:** None.

**Missing phases:** One — the fixtures.ts warm-up drop (see Critical Issue 1). Should slot between Task 2 and Task 3 as Task 2.5 (or rename the chain).

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Tasks 1-11 (Slice 1 mechanical) | superpowers:subagent-driven-development | Multiple independent file edits with clean commit boundaries — well-suited for subagent fan-out |
| Task 14 (skill edit) | Direct (main agent) | Cross-project edit; single file; needs the diff verification step run interactively |
| Tasks 12-13 (audit + fix) | Direct (main agent) | Decision-heavy; the audit findings determine Task 13 scope; not suitable for fan-out |
| Tasks 15-17 (docs) | superpowers:subagent-driven-development | Independent markdown files |

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branch specified | Yes — `v0.5.9-e2e-stabilization` worktree (already on this branch) |
| Branch naming follows convention | Yes — matches `v0.5.X-<slug>` from prior PRs |
| Merge strategy documented | Implicit (squash via /ship-it convention) |

### Commit checkpoints

The plan commits at these natural boundaries (verified per task):

1. Task 1 → `feat(lib): add buildAddCardLabel helper with vitest`
2. Task 2 → `fix(sale): catalog Add cards aria-label includes pack_label`
3. **MISSING: Task 2.5 → drop fixtures.ts warm-up** (Critical Issue 1)
4. Task 3 → `fix(spoilage): per-row htmlFor/id on Qty Label/Input`
5. Task 4 → `fix(vouchers): Type Label gains htmlFor + SelectTrigger id`
6. Tasks 5-9 → one commit per spec (5 commits)
7. Task 10 → `test(e2e): voucher-offline honest re-skip`
8. Task 11 → `docs: REFUTED banners on stale issue-#44 planning artifacts`
9. (Gate 1: push + draft PR)
10. Task 12 (optional commit if findings) → `docs(plan): record Slice 2 audit inventory inline`
11. Task 13 → one commit per file (≤10)
12. (Gate 2: push)
13. Task 14 → skill commit (DIFFERENT git tree — see Improvement 2)
14. Task 15 → `docs(pattern): add SKIP-comment three-field template`
15. Task 16 → `docs(postmortems): add index + README`
16. Task 17 → `docs(postmortems): add issue #44 misdiagnosis trail`
17. Task 18 → `docs(changelog): v0.5.9 entry`
18. Task 19 → PR open + backfill commit + close #48

Commit hygiene is excellent: atomic, bisectable, conventional-commit-style messages, all multi-line with proper body.

### Pre-push verification

- [x] `npm run typecheck` after each src change (Tasks 1, 2, 3, 4)
- [x] `npm run lint` after Tasks 1, 2, 3
- [x] `npx vitest run` after Task 1 (test impl) and Task 2 (regression)
- [x] Local manual smoke (optional) called out as cheap insurance
- [x] CI watch at Gate 1 + Gate 2

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | Documented (Rollback section — 5 conditional paths) |
| Deployment order | Source before specs (correct — specs depend on src htmlFor) |
| Data backup needed | No (no schema/data changes) |
| Migration safety | N/A (no migrations) |

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Task 11 | REFUTED banners on 2 stale planning artifacts |
| Task 14 | `~/.claude/skills/staffreview/SKILL.md` §4.9 (cross-project) |
| Task 15 | `docs/PATTERNS/skip-comment-template.md` + CLAUDE.md cross-link |
| Task 16 | `docs/postmortems/README.md` + CLAUDE.md docs/ inventory |
| Task 17 | `docs/postmortems/2026-06-issue-44-misdiagnosis.md` |
| Task 18 | `docs/CHANGELOG.md` v0.5.9 entry |

### CHANGELOG draft

Plan's Task 18 already includes a fully-drafted v0.5.9 entry. Content is well-structured (Fixed / Added / Tests / Discipline / Backend sections). One nit: under "Tests" the entry says *"5 PIN-gated e2e specs un-skipped"* but the previously-skipped set is 6 (refund, sale-qris, sale-bca-va, spoilage, voucher-online, voucher-offline). The 5/6 count is correct *after* re-skipping voucher-offline, but the entry should clarify: *"5 of the 6 PIN-gated e2e specs un-skipped (`voucher-offline` honestly re-skipped — see Task 10)."*

## 10. Testing Plan Assessment

**Verdict:** Adequate

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend | None (no convex changes) | — | N/A |
| Frontend unit | `buildAddCardLabel` (7 seed products + edge cases) | vitest | planned (Task 1) |
| Frontend manual | spoilage Qty htmlFor smoke | manual DevTools | planned (Task 3 Step 3) |
| Frontend manual | vouchers Type label-click smoke | manual | planned (Task 0) |
| E2E | 5 PIN-gated specs un-skipped + 1 re-skipped honestly | Playwright | planned (Tasks 5-10) |
| CI | Gate 1 + Gate 2 | gh run watch | planned |

### Missing test coverage (must add)

None at Critical severity. The vitest helper test covers the regression that originally triggered #44 (`Add Dubai` ambiguity), and the e2e suite covers the user-visible flow.

### Test execution checkpoints

1. After Task 1 (vitest unit test, in isolation)
2. After Task 2 (vitest full suite + typecheck + lint)
3. At Gate 1 (push + CI e2e run)
4. At Gate 2 (vitest full + e2e after Slice 2)

### Regression risk

- **Low.** The src changes are additive (`htmlFor`/`id` attribute adds; aria-label widening). No prop-removal, no event-handler changes, no state-shape changes. The vitest pin for all 7 seed products catches any future name/pack rename that would silently break a Playwright selector.
- The fixtures.ts warm-up drop (Critical Issue 1, if added as Task 2.5) is the only change with a non-zero regression chance — if the underlying transient-null hypothesis is somehow correct for a CI environment we haven't observed (e.g., a slow Convex cold-start in GitHub Actions), Gate 1 will surface it and Slice 2's audit gives a clean attribution path.

## 11. Edge Cases to Address

- [x] Empty `pack_label` — Task 1's helper trims and falls back to `Add ${name}` only
- [x] Whitespace-only `pack_label` — same trim handles it
- [x] `Mixed Box` (space-containing name) — Task 1 vitest pins `Add Mixed Box 4 pcs`
- [x] Duplicate-id risk in multi-row spoilage form — Task 3 uses `spoilage-qty-${i}` per-row
- [x] Radix label-click forwarding unknown — Task 0 gates Tasks 4 + 9
- [ ] **What if `pack_label` field is stripped by a projection in `useCatalogCache`?** — Task 2 Step 3 has a grep-verify step but doesn't enumerate the failure response. Recommendation: add one line *"if `pack_label` is missing, the typecheck at Step 4 will catch it — `p.pack_label` access on a stripped type is a TS error; fix the projection in the same commit if so."*
- [x] Fixture warm-up removal regression — covered in Critical Issue 1 recommendation
- [x] Slice 1 failure attribution at Gate 1 — Gate 1's red-failure routing rule is well-defined (route to Task 12 audit)
- [x] Slice 3 skill commit landing in wrong git tree — Top 3 risks #3 covers it (but see Improvement 2 for enforcement)

## 12. Approval Conditions

**To approve, address:**
1. **Critical Issue 1** — add a task (e.g., Task 2.5) to drop the 1500ms warm-up at `e2e/fixtures.ts:36-41`, with its own commit and the canonical "mitigation-removed-because-real-fix-shipped" framing. Update the Self-review > Spec coverage line accordingly.

**Recommended before implementation:**
1. **Improvement 1** — tighten Task 0's PASS/FAIL signal to "run Playwright once with a local Task-4 edit; observe."
2. **Improvement 2** — add a Gate-3 step that verifies the SKILL.md commit landed in `~/.claude/skills/staffreview/`'s tree before opening the PR.
3. **Improvement 3** — note explicitly in Self-review that Task 1's vitest fulfills spec §4 step 8 + §5's `aria-label-format.test.tsx` row.
4. **Improvement 4** — commit Task 10 to the static-analysis decision (or constrain Step 1 to "verify-only, no Step-2-ALT branch in this PR").

**Optional refinements** (5 items in §4) can be folded in or deferred at implementer's discretion.

---

*Generated by /staffreview*
