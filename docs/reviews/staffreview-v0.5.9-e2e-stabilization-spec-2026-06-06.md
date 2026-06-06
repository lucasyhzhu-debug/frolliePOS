# Staff Review: v0.5.9 e2e Stabilization & Evidence-Before-Mitigation (Spec Gate)

**Date:** 2026-06-06
**Spec:** `docs/superpowers/specs/2026-06-06-v0.5.9-e2e-stabilization-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** Spec, not plan — Step-0 plan structure checklist adapted: spec has Goals/Non-Goals/Scope/File Map/Build Sequence/Risks/Success Criteria/Decisions. **Spec structure validated.** Plan-stage will fill commit-by-commit detail.

---

## 1. Summary

**Overall Assessment:** **Revise** (minor — 2 critical code claims need fixing before the plan is written; the rest is sound)

The spec correctly diagnoses the actual bug (a11y/selector drift, not a Convex client race) on instrumented evidence, and the scope decomposition into 4 slices with explicit gates is tight. **However, two load-bearing source claims in Slice 1 are wrong as written and will produce broken code if the plan inherits them verbatim:**

1. **Slice 1.A spoilage Qty `id="spoilage-qty"` is a duplicate-id bug.** `src/routes/mgr/spoilage.tsx:230-289` renders Qty inputs **inside a `.map((line, i) => …)` loop** (confirmed: `setRow(i, …)` at lines 240, 269, 282). A static `id="spoilage-qty"` violates HTML id-uniqueness for every multi-line spoilage. The fix must scope the id per-row (`id={\`spoilage-qty-${i}\`}` + `htmlFor={\`spoilage-qty-${i}\`}` + e2e `.first()`).
2. **`src/routes/sale/index.tsx:183` is currently `aria-label={\`Add ${p.name}\`}` (pre-PR-#48).** The spec says "PR #48 partially fixed this" and then in §3 Slice 1.A proposes a conditional. That's internally consistent (worktree base is `48615b7`, pre-PR-48; PR #48 is being closed unmerged), but the spec language in §1 is slightly confusing — read carelessly it could imply PR-#48's change is already on `main`. Worth a one-line clarification in the spec or just in the plan.

The remaining concerns (Type-label htmlFor approach on Radix `SelectTrigger`, `aria-label` snapshot test, postmortem dir, personal-skill change blast radius) are all addressable at plan-stage. Slice 3 (personal-global skill) is genuinely project-agnostic and safe.

---

## 2. Critical Issues (Must Fix Before Plan)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | Spoilage `id="spoilage-qty"` is a duplicate-id bug in a multi-row form | Logic / correctness | Spec §3 Slice 1, §5 file map row 1 |
| C2 | Voucher-offline.spec snapshot Q1 conflates two failure modes — `<TBD>` is a real blocker AND there's no proof the un-skipped spec gets reliable seed output | Testing / honesty | Spec §7 Q1 |

### Issue C1: Spoilage `id="spoilage-qty"` static ID is a duplicate-id bug

**The spec proposes:**
> `src/routes/mgr/spoilage.tsx:264` — add `htmlFor="spoilage-qty"` to `<Label>Qty</Label>` and `id="spoilage-qty"` to the sibling `<Input>`.

**Actual code at `src/routes/mgr/spoilage.tsx:230-289`:** The Qty Label+Input pair is rendered inside `lines.map((line, i) => (… setRow(i, …) …))`. There can be multiple Qty inputs simultaneously. Static IDs would:
- Violate the HTML uniqueness invariant.
- Make `getByLabel(/Qty/i).first()` (the spec already uses `.first()` in `spoilage.spec.ts:11`) "work" because Playwright is permissive — but real a11y consumers (screen readers cycling through inputs) will land on the wrong field.
- Trigger a React DevTools console warning in dev.

**Recommendation:**
```tsx
<Label htmlFor={`spoilage-qty-${i}`} className="text-xs">Qty</Label>
<Input id={`spoilage-qty-${i}`} … />
```

Match the same pattern for the Remove button's existing `aria-label={\`Remove line ${i + 1}\`}` at line 284 — index-scoped is the file's existing convention. The e2e spec `.first()` already filters correctly. The snapshot test in Slice 2.C does not need to know about per-row IDs (it tests the catalog card aria-labels, not spoilage).

**Update §5 file map row 1** to reflect "Modify (per-row Qty Label htmlFor + Input id, index-scoped)".

### Issue C2: voucher-offline `<TBD>` Q1 needs a clearer fork-on-evidence decision

**The spec §7 Q1 proposes:** "Attempt the fix; fall back to honest re-skip if not ≤ 5 lines."

I confirmed `voucher-offline.spec.ts:39` does contain literal `<TBD>` tokens inside an `execSync(...)` wrapped in a silent try/catch (lines 37-47), and the final `Promise.race(...)` is also `.catch(() => {})` (line 60). The spec's "false-green" diagnosis is accurate.

**Concern:** The "≤ 5 lines" budget is the wrong heuristic. The real question is "does `npx convex run seed/actions:reset` already return stable IDs for `voucherId` and `sessionId`, or does the seed need to expose them?" That's the binary decision; line count is a proxy. If the seed already returns them, the fix is ~10 lines (parse seed JSON output, inject into the execSync args). If it doesn't, the seed needs a side change to surface a stable manager session — that's the "offline-queue refactor" the spec mentions and rightly defers.

**Recommendation for the plan:** Replace "≤ 5 lines" with a concrete branching test the implementer runs as Task 0 of Slice 1.C:
1. Run `npx convex run seed/actions:reset` once; inspect stdout.
2. If it emits a parseable `{ lucasSessionId, vouchers: { …, id } }` (or similar) → attempt-fix path.
3. If not → honest re-skip + open follow-up issue requiring `seed/actions:reset` to expose stable test IDs.

This also matches the spec's own §1 evidence-before-mitigation discipline — make the path decision evidence-first.

---

## 3. Improvements (Recommended Before Plan)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | Verify Playwright `getByLabel` resolves through Radix `<SelectTrigger>` before locking in the htmlFor approach for Type label | H | L |
| I2 | `aria-label` snapshot test design — pick rendering vs. unit assertion explicitly | M | L |
| I3 | Disambiguate "all 8 e2e specs green" in §8 success criterion 1 | M | L |
| I4 | §3 Slice 1 — `voucher-online.spec.ts:10` does `getByLabel(/Type/i).click()` which depends on label→Radix-Trigger click forwarding; commit to a verified selector strategy | M | L |
| I5 | Slice 3.A — define what "skill regression" means and how it's verified | M | L |
| I6 | Snapshot test scope — pin all 7 products, not just Dubai | L | L |

### Improvement I1: Verify `getByLabel` resolves Radix `SelectTrigger`

The spec proposes `htmlFor="new-voucher-type"` + `id="new-voucher-type"` on `<SelectTrigger>`. I confirmed:
- `src/components/ui/select.tsx:10-26` — `SelectTrigger = React.forwardRef<…SelectPrimitive.Trigger…>` and forwards all props (including `id`).
- Radix Select Trigger renders as `<button role="combobox" aria-haspopup="listbox">`.
- HTML `<label htmlFor>` → `<button id>` IS a valid pairing browsers honour for click-forwarding.
- Playwright's `getByLabel` resolves via accessible-name (`aria-labelledby` implied from htmlFor↔id).

**However**, the existing `voucher-online.spec.ts:10` does `await page.getByLabel(/Type/i).click()`. This clicks the LABEL element, relying on browser click-forwarding to the associated button. Standard browser behavior: clicking a `<label htmlFor="x">` forwards click to `<input id="x">` but is less reliable for non-input controls. Empirically it works for `<button>` in most browsers, but Radix's listening might also need keyboard fallback.

**Recommendation for the plan:** Plan should include a 30-second smoke test as part of Slice 1.A's commit message (or Slice 1.C's first iteration): manually run the un-skipped `voucher-online.spec.ts` against the local dev build, confirm the click forwards. If it doesn't, the e2e change becomes `getByRole("combobox", { name: /Type/i }).click()` (which the spec should pre-authorize as the fallback). Don't ship Slice 1.A → 1.C without that confirmation.

### Improvement I2: `aria-label` snapshot test — design choice now

§3 Slice 2 proposes `src/routes/sale/__tests__/aria-label-format.test.tsx` pinning "the 7 seed products' rendered aria-labels". Two viable shapes:
- **A. React render test (vitest + @testing-library/react)**: mount the catalog grid with stubbed `useCatalogCache`, assert `screen.getAllByRole("button", { name: /Add / })` matches expected names.
- **B. Pure unit test against a label-builder helper**: extract `aria-label={…}` into `buildAddCardLabel(name, packLabel)` in `src/lib/label.ts`, snapshot its output for the 7 seed combinations + edge cases (empty packLabel, missing name).

Option B is preferable: (a) no jsdom mount, (b) cheaper test, (c) the helper is reusable for the catalog audit work in Slice 2.B, (d) edge cases (empty pack_label) get a dedicated unit test instead of being inlined as a `?:` ternary. The spec's conditional `p.pack_label ? \`Add ${p.name} ${p.pack_label}\` : \`Add ${p.name}\`` is exactly the right shape to extract.

**Recommendation:** Plan should specify Option B + name the helper file. If Option A is chosen, name the testing-library setup file (the repo doesn't currently have one for component tests — check `vitest.config.ts` env: jsdom configured?).

### Improvement I3: "All 8 e2e specs green" needs disambiguation

§8 success criterion 1 says "all 8 e2e specs green". Spec files: `auth, refund, sale-bca-va, sale-qris, spoilage, voucher-offline, voucher-online` = 7 files. Tests within: auth has 2 (one is `test.skip` lockout — out of scope), plus 6 single-test files = 8 test bodies, of which 7 will be un-skipped + the auth-lockout one stays skipped.

The spec's §2 non-goal #4 doesn't mention the auth-lockout skip. **Recommendation:** Add a line to §2 non-goals: "`auth.spec.ts`'s 3-strikes-lockout test stays `test.skip` (out of scope; tracked in spec file body)." Then §8.1 reads as "all 7 actively-run e2e tests green; auth-lockout remains skipped per file-internal comment."

### Improvement I4: Selector strategy commitment in Slice 1

`voucher-online.spec.ts` and `voucher-offline.spec.ts` both use `page.getByLabel(/Type/i).click()` to OPEN the Radix Select. If I1's smoke shows label-click-forwarding fails, the spec's recommended selector chain breaks across two specs simultaneously. The plan needs an explicit fallback selector before Slice 1.A ships (so Slice 1.C doesn't get blocked by an unverified assumption).

**Recommendation:** Plan should write both selectors and have the implementer pick at first-run:
```ts
// Primary (label-click forwarding):
await page.getByLabel(/Type/i).click();
// Fallback (combobox role):
await page.getByRole("combobox", { name: /Type/i }).click();
```

### Improvement I5: Define "skill regression" check for Slice 3.A

Slice 3.A modifies `~/.claude/skills/staffreview/SKILL.md` — a personal-global skill used across all projects. The change is project-agnostic in shape (asking for evidence/trace/log citations applies universally), and I read the current 557-line skill — the proposed insertion location (adjacent to "Findings format" or "Spec review" section) is a sensible non-breaking append.

**Concern:** No regression test. If the change inadvertently reorders required-sections, or shifts the report template numbering, a downstream project's parser (if any) breaks silently.

**Recommendation:** Plan should:
1. Make the change **purely additive** — new subsection inserted between existing sections, not rewriting any existing section heading.
2. After the edit, re-read the file end-to-end and confirm section numbering (`§0`/`§1`/…) is unchanged.
3. Document the change rationale in a one-line commit message that the user can audit on the global skill later.

This addresses spec Q5's "blast radius outside Frollie" concern with concrete safeguards rather than just a PR-body callout.

### Improvement I6: Pin all 7 seed products, not just Dubai

Spec §3 Slice 2 says "assertions for the 7 seed products' rendered aria-labels (`Add Dubai 1 pc` through `Add Mixed Box 4 pcs`)". Confirmed against `convex/seed/internal.ts:101-109`: the 7 products are Dubai 1pc, Dubai 3pcs, Dubai 8pcs, Choco 1pc, Matcha 1pc, Lotus 1pc, Mixed Box 4pcs.

The Dubai SKUs are the issue-#44 motivator (all three named "Add Dubai" before the fix), but the snapshot should also pin Mixed Box (`name = "Mixed Box"`, `pack_label = "4 pcs"` → `Add Mixed Box 4 pcs`) because Mixed Box has the longest product name with a space — a future refactor that strips name-whitespace would silently regress it. The spec already implies this; just be explicit in the plan.

---

## 4. Refinements (Optional)

- **R1:** §4 build sequence step 5 (Gate 1) says "All 8 specs must be green before continuing to Slice 2." Consider naming the failure mode that's most likely to bite: Slice 1.A's htmlFor change ships clean, but `getByLabel` still doesn't resolve on Radix Trigger → Slice 1.C is blocked. Gate-1 enforcement is correct; just name this in the plan as the "known-unknown" risk.
- **R2:** §3 Slice 4 postmortem timeline should include the PR-#48 instrumentation commit SHA explicitly (the spec mentions "playwright run ID `27021101339`" — confirm that's the right ID, since the user wrote `<n>` placeholders in two locations).
- **R3:** §3 Slice 1 mentions REFUTED banners cite "PR #<n>" — implementer needs to update the placeholder once the PR exists. Add a checklist item to Slice 1.D: "post-PR-open: grep `PR #<n>` in both REFUTED'd files; replace with actual PR number; one commit."
- **R4:** §3 Slice 3.B (Frollie pattern doc `docs/PATTERNS/skip-comment-template.md`) — cite PR #43 SHA in the cautionary example. Spec already implies this; plan should name the commit SHA so future readers can `git show`.
- **R5:** The plan should explicitly include `docs/CLAUDE.md` update for the `docs/postmortems/` dir reference (the "docs" file-locations section currently lists `SCHEMA.md`, `API_REFERENCE.md`, etc.; postmortems should be added).
- **R6:** `e2e/specs/spoilage.spec.ts:11` already uses `getByLabel(/Qty|Quantity/i).first()` — the `.first()` lets it work even pre-htmlFor (Playwright falls through to placeholder/name resolution, which fails currently, hence the spec re-skip). Plan should verify that **after** the htmlFor fix, `.first()` still resolves to row 0 (it should — `i=0` per-row id means first element).

---

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| `vouchers.tsx` Value label htmlFor pattern | `src/routes/mgr/vouchers.tsx:613-617` | Spec correctly cites this as the working sibling pattern; Slice 1.A mirrors it. |
| Existing `Label htmlFor=` + `<Input id=>` pairs across mgr routes | grep across `src/routes/mgr/*` during Slice 2.A audit | Already canonical; Slice 2.B follows. |
| `useCatalogCache` for snapshot test data | `src/hooks/useCatalogCache.ts` | If Slice 2.C uses Option A (jsdom), mock this; if Option B (pure helper), bypass. |
| Index-scoped aria-label pattern | `spoilage.tsx:284` (`Remove line ${i + 1}`) | Spoilage Qty per-row id should follow this existing per-row convention. |

### Potential duplication risks

- **Snapshot test format-helper** (R3 from Slice 2.B audit) — if `buildAddCardLabel()` is created (I2 Option B) but Slice 2.A audit finds other catalog/list aria-labels that need the same shape, plan should fold them into the helper instead of inlining `?:` per-call site. Lift to `src/lib/label.ts` once 2+ uses exist.
- **`getByLabel` vs `getByRole("combobox")`** — picking one e2e selector strategy and applying consistently across `voucher-online`, `voucher-offline`, and any other Select-using spec.

---

## 6. Slice / Phase Accuracy

| Slice | Assessment | Notes |
|-------|------------|-------|
| Slice 1 (CI-green tactical) | Needs adjustment (C1 + C2) | Spoilage id must be per-row; voucher-offline fork needs evidence-based decision. |
| Slice 2 (a11y sweep #49) | Good | Audit-first → fix-scope-bound. Snapshot test design choice deferred to plan (I2). |
| Slice 3 (discipline #50) | Good | Skill change is project-agnostic; risk-mitigated with I5. |
| Slice 4 (postmortem) | Good | Genre-distinction (review vs postmortem) is real, not invented; new dir justified. |

**Ordering issues:** Build sequence steps 1-15 in §4 are well-ordered. Gate 1 (after Slice 1.D, before Slice 2) is the right hard-gate. Gate 2 (after Slice 2.C) is the right vitest gate. One refinement: step 10 (Slice 3.A skill modification) could happen earlier in parallel with Slice 1 — it has no dependency on the e2e green. Optional; serial is also fine for one-PR coherence.

**Missing phases:** None. The 4 slices cover the 3 GitHub issues + the cleanup + the discipline change.

---

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Slice 1.A (src a11y) | Direct edit (no agent) | 3-file diff; the implementer is faster than dispatching. |
| Slice 1.C (e2e specs) | Direct edit (no agent) | 6 spec files, mechanical pattern; implementer's choice on commits-per-spec. |
| Slice 2.A (audit pass) | `superpowers:dispatching-parallel-agents` is overkill here; a single subagent dispatched with the `src/routes/sale/, history/, refund/, mgr/` grep target is enough | Audit output goes inline in commit message or a PR-comment; not a doc artifact. |
| Slice 4.B (postmortem write-up) | `superpowers:writing-plans` style — outline first, prose second | Author the timeline as a bulleted skeleton; fill in prose after the PR is opened so PR numbers are concrete. |

(All recommended agents/skills exist in the global Claude setup.)

---

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ Worktree `v0.5.9-e2e-stabilization` exists, branch `main` per `git log`. Spec implies new branch for PR. Plan should name it (e.g., `v0.5.9-e2e-stabilization`). |
| Branch naming follows convention | ✅ Matches v0.5.x phase pattern |
| Merge strategy documented | ✅ Squash merge implied by "single ship for slices 1-4 (one PR)" (D2) |
| PR #48 close-out | ✅ Spec §3 Slice 1 + §4 step 15 explicit `gh pr close 48 --comment "..."` |

### Commit checkpoints

Spec §4 enumerates 15 numbered steps as commits. This is appropriate granularity for `/gsd-undo`-friendly atomic commits. Good.

### Pre-push verification

| Check | Status |
|-------|--------|
| `npm run typecheck` in plan | ✅ §4 "Run `npm run typecheck && npm run lint` after each substantive change" |
| `npm run lint` in plan | ✅ Same |
| `npm run build` in plan | ⚠️ Not explicitly mentioned; recommend plan adds `npm run build` before Gate 2 (after Slice 2) since Slice 2.C creates a new test file that affects vitest config / vite plugin resolution. |
| Local e2e run before push | ⚠️ Plan should specify whether implementer runs `npx playwright test` locally before push (it's slow; CI is the gate per §4 step 5, but local at least once on Slice 1's branch saves a CI cycle). |

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ⚠️ Not explicit. Each commit is `/gsd-undo`-able per ADR-034 commit discipline; spec should make this explicit. |
| Deployment order | ✅ No backend changes; Vercel auto-deploys on merge; no schema migration. |
| Data backup needed | No (no schema or data changes) |
| Migration safety | N/A |

**Recommendation:** Plan should add a "Rollback" subsection: "Any slice's commit can be `git revert`'d independently. Slice 1 commits are independent of Slice 2/3/4 — the e2e specs ship green either way once Slice 1 lands. Slice 3 (skill) lives outside the repo and has its own commit; `git revert` on the skill file works the same way."

---

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Slice 1.D | REFUTED banners (2 files, spec already plans this) |
| Slice 3.B | `docs/PATTERNS/skip-comment-template.md` (new, spec plans this) |
| Slice 4.A | `docs/postmortems/README.md` + `docs/postmortems/2026-06-issue-44-misdiagnosis.md` (spec plans this) |
| Slice 5 (combo) | `docs/CHANGELOG.md` v0.5.9 entry (spec plans this) |
| Missing | `CLAUDE.md` doc-section update to list `postmortems/` dir (R5 above) |
| Missing | `docs/PATTERNS/skip-comment-template.md` cross-link from `CLAUDE.md`'s `docs/PATTERNS/` list (currently lists `idempotency-dual-call-authcheck.md`, `telegram-bot-integration.md`) |

### CHANGELOG draft (rough sketch — plan to finalize)

```markdown
## v0.5.9 — 2026-06-?? — bug fix + a11y

**Closes:** #44 (e2e session-on-hard-nav), #49 (a11y aria-label sweep), #50 (selector-drift discipline)

### Fixed
- Catalog "Add" buttons now distinguish pack sizes (`Add Dubai 1 pc`/`3 pcs`/`8 pcs`)
  rather than three buttons named "Add Dubai" (issue #44 root cause; selector drift,
  not a Convex client race — see `docs/postmortems/2026-06-issue-44-misdiagnosis.md`).
- Spoilage form Qty label / Voucher form Type label now have `htmlFor`+`id` pairs
  so screen readers and Playwright `getByLabel` resolve them (#49).
- Charge screen tab selectors corrected to `role="tab"` in e2e specs (Radix Tabs
  renders as `role="tab"`, not `button`; spec adapts to source per ADR-… principle).

### Added
- `docs/PATTERNS/skip-comment-template.md` — required format for `test.skip` blocks
  citing observed-failure-mode + evidence + follow-up issue (#50).
- `docs/postmortems/` directory + `2026-06-issue-44-misdiagnosis.md`.
- Snapshot test pinning catalog aria-label format (regression guard).

### Discipline
- Global staffreview skill gains "Evidence-Before-Mitigation Gate" subsection.
- Two stale planning artifacts (v0.5.7.1 Option B plan + arch-options review) carry
  visible REFUTED banners pointing to PR #<n> and the postmortem.
```

---

## 10. Testing Plan Assessment

**Verdict:** Adequate — given C1+C2 fixes

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Frontend | Catalog aria-label snapshot (7 products) | vitest | Planned (Slice 2.C) |
| Backend | None | N/A | No backend changes |
| Integration / e2e | 7 specs un-skipped + 1 spec honest-skip OR fix | Playwright | Planned (Slice 1.C) |
| Manual | Local smoke: voucher Type label click forwarding through Radix Trigger | manual | **Missing — add per I1** |

### Missing test coverage (must add)

| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| T1 | Label→Radix-Trigger click forwarding smoke | If browsers don't forward `<label>` click to `<button role="combobox">`, the e2e selector still fails after the htmlFor fix; plan needs this verified before Gate 1. | Manual: open `/mgr/vouchers`, click the "Type" label text, assert dropdown opens. 30 seconds. |
| T2 | Multi-row spoilage Qty rendering | If C1 fix uses per-row id, ensure mounting 2+ rows renders 2+ unique IDs and no React duplicate-key warnings. | Plan to add as a 5-line vitest assertion alongside the aria-label snapshot in Slice 2.C, OR verify manually as part of Slice 1.A's commit message. |
| T3 | voucher-offline.spec re-skip OR fix has 1-spec verification | If fork goes to "honest re-skip", the comment must accurately cite the blocker (per `docs/PATTERNS/skip-comment-template.md` Slice 3.B). | Plan should write the skip-comment text as part of Slice 1.C's commit, not as an afterthought. |

### Test execution checkpoints

1. After Slice 1.A: typecheck + lint + manual T1 (Radix Select label click)
2. After Slice 1.C: local `npx playwright test` for the 6 un-skipped specs (or rely on Gate 1 CI run)
3. Gate 1: CI green on all 7 active e2e tests
4. After Slice 2.C: `npx vitest run` full suite green (Gate 2)
5. Before merge: full CI matrix green

### Regression risk

- Existing vitest unit tests: low risk; no backend touched.
- E2e specs not in the 7-test set: only `auth.spec.ts` happy-path; spec explicitly verifies this stays green.
- Snapshot test in Slice 2.C could be brittle to seed-product changes; mitigation: pin seed-product names and pack_labels in a code-comment cross-reference inside the snapshot test file.

---

## 11. Edge Cases to Address

- [ ] **Empty `pack_label`** — defensive conditional handled in Slice 1.A. Confirm no seed product has empty pack_label (verified: 7 products, all non-empty). Plan can keep the conditional anyway (manager-edited products are the threat model).
- [ ] **Multi-row spoilage with same SKU but different qty** — does the form prevent duplicate-SKU rows, or is that a separate bug? Not in scope of v0.5.9; flag for follow-up if observed during Slice 1.A.
- [ ] **Voucher Type select keyboard navigation** — once htmlFor is added, screen readers will announce "Type, combobox" and arrow-key to options. The label-click forwarding (I1) is the e2e concern; keyboard a11y is the a11y concern. Both should work after the same fix.
- [ ] **REFUTED banner markdown rendering** — ensure the `> ` blockquote renders as expected when the file is viewed via GitHub web UI (no nested-code-block escaping issues).
- [ ] **Slice 3.A diff against the live skill** — if the user has locally modified the global skill since 557 lines, the diff target shifts. Plan should `cat` the skill at start-of-execute to confirm baseline.
- [ ] **Postmortem dir creation on Windows** — `mkdir docs/postmortems` is fine; just confirm git-tracking via the README.md as the first file.

---

## 12. Approval Conditions

**To approve, address:**
1. **C1** — Spoilage `id="spoilage-qty"` is a multi-row form; needs per-row scoped IDs. Spec language update + plan reflects this.
2. **C2** — voucher-offline `<TBD>` fork criterion needs to be evidence-based (does `seed/actions:reset` emit stable IDs?) not line-count.

**Recommended before implementation:**
1. **I1** — manual Radix Select label-click smoke before Gate 1 ships.
2. **I2** — pick snapshot-test shape (Option B: pure helper + `src/lib/label.ts`).
3. **I3** — disambiguate "8 specs green" vs auth-lockout skip.
4. **I5** — additive-only constraint on Slice 3.A skill edit.

**At implementer's discretion:**
- R1-R6 refinements.

---

## 13. Verified vs Refuted spec claims (sanity log)

| Spec claim | Verified | Notes |
|---|---|---|
| `src/routes/mgr/spoilage.tsx:264` has bare `<Label>Qty</Label>` no htmlFor | ✅ Confirmed (line 264, no htmlFor; sibling Input lines 265-275 no id) | But the WHOLE block is inside `.map((line, i) => …)` — see C1. |
| `src/routes/mgr/vouchers.tsx:599` has bare `<Label>Type</Label>` no htmlFor | ✅ Confirmed (line 599) | The sibling Value label at line 614 DOES have `htmlFor="new-voucher-value"` paired with Input id (line 618). Spec's "mirror pattern" framing is accurate. |
| `src/routes/sale/charge.tsx:494-497` uses Radix `TabsTrigger` | ✅ Confirmed (lines 494-497, exact `<TabsTrigger value="QRIS">` + `<TabsTrigger value="BCA_VA">`) | Renders as `role="tab"`. Spec selector-fix direction correct. |
| `src/routes/sale/index.tsx:183` is the catalog aria-label line | ✅ Confirmed (line 183) | Currently `aria-label={\`Add ${p.name}\`}` (no pack_label). Spec's "PR #48 partially fixed this" referring to the not-yet-merged PR-48 branch — minor spec-language clarification recommended (see §1 of this review). |
| `voucher-offline.spec.ts` has `<TBD>` placeholders inside `execSync(...)` wrapped in silent catch | ✅ Confirmed (line 39 literal `<TBD>`, lines 37-47 silent try/catch, line 60 `.catch(() => {})`) | "False-green" diagnosis is accurate. |
| `e2e/fixtures.ts:37-41` has 1500ms warm-up | ✅ Confirmed (line 41 `await page.waitForTimeout(1500)`) | The 5-line block (lines 37-41 comment + waitForTimeout). PR #48 drops this; spec proposes to keep that drop. ✅ |
| Personal-global skill is 557 lines | ✅ Confirmed (`wc -l` matches) | Project-agnostic prose confirmed; safe insertion. |
| Seed has 7 products | ✅ Confirmed (`convex/seed/internal.ts:101-109`) | Dubai×3, Choco, Matcha, Lotus, Mixed Box. Snapshot test scope correct. |

---

*Generated by /staffreview*
