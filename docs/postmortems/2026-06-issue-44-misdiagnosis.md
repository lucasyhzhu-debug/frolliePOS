# Postmortem: issue #44 — selector drift mistaken for Convex client race

**Date:** 2026-06-06
**Triggered by:** PR #48 instrumentation refuting the v0.5.7.1 Option B trust-null hypothesis.
**Shipped fix:** PR #52 (v0.5.9 e2e stabilization).

## Timeline

| When | What | Outcome |
|---|---|---|
| (pre-v0.5.7) | PR #41 — add 1500ms `await page.waitForTimeout(1500)` in `e2e/fixtures.ts:37-41` as Convex client warm-up | Shipped; specs still flaked |
| (v0.5.7) | PR #43 (`4aa4119`) — `fix(e2e): skip 6 PIN-gated specs with tracking notes for hard-nav session loss` | Shipped; 6 specs marked `test.skip` citing inferred "session loss on hard-nav" mechanism |
| (v0.5.7.1 plan A) | PR #45 (`ccb2d65`) — plan: useSession transient-null fix Option A (1500ms debounce in `useSession`) | Replanned as Option B before execute |
| (v0.5.7.1 plan B) | PR #47 (`8fb97cb`) — replan as Option B (evidence-based null trust via `useRef`) | Plan approved; execution paused for PR #48 evidence pivot |
| (PR #48) | Instrumentation: `console.warn` + `sessionStorage` ring buffer + Playwright `page.on("console")` bridge in `auth.spec.ts` + `sale-qris.spec.ts`, 3 retries, 17+ captured renders. Playwright run `27021101339`. | **Refuted Option B:** `validation === null` with `stored=Y` never appears post-login. `validation === undefined` (the transient on hard-nav) already maps to `loading`, not the `isDead` branch. |
| (PR #48 partial fix) | Catalog button aria-label widened to `Add ${p.name} ${p.pack_label}` | Partial; 6 specs still red because the spec selectors hadn't been updated AND the Radix Tabs role mismatch + Label htmlFor gaps were not yet diagnosed |
| (2026-06-06) | PR #48 closed unmerged in favor of v0.5.9 ship | Whole-scope fix lands as PR #<n> |

## What we thought was happening

Across PRs #41, #43, #45, #47:

- **PR #41:** "Convex client cold-start makes the next `page.goto` see a transient null on the session-validation query → `isDead` effect → localStorage wipe → /login redirect." Fix: 1500ms warm-up.
- **PR #43:** Same hypothesis, escalated. "It's still flaking, so skip the specs while we investigate." Fix: `test.skip` on 6 PIN-gated specs.
- **v0.5.7.1 Option A:** Hypothesis preserved. "Debounce the null in `useSession` so transient nulls don't trigger `isDead`."
- **v0.5.7.1 Option B:** Hypothesis preserved. "Trust localStorage harder; only treat `validation === null` as dead after a `useRef`-tracked second observation."

All four cycles assumed `validation === null` was being observed and was load-bearing on the redirect. **None of the four ever instrumented the post-login render sequence to confirm.**

## What was actually happening

Three independent a11y / selector mismatches:

1. **Catalog "Add" buttons** (`src/routes/sale/index.tsx:183`) used `aria-label={\`Add ${p.name}\`}` — three Dubai products (1 pc / 3 pcs / 8 pcs) rendered three buttons all named "Add Dubai". Playwright `/Dubai 1pc/i` matched none of them.
2. **Charge screen payment method picker** (`src/routes/sale/charge.tsx:494-497`) uses Radix `<TabsTrigger>`, which renders as `role="tab"`. E2e specs used `getByRole("button", { name: /QRIS|BCA/i })` — wrong role.
3. **Bare `<Label>` siblings** (`src/routes/mgr/spoilage.tsx:264`, `src/routes/mgr/vouchers.tsx:599`) lacked `htmlFor`/`id` pairs, so `getByLabel(/Qty|Type/i)` resolved 0 matches.

Once specs hit the redirect (because `Add Dubai` clicked the wrong button or because they timed out waiting for a 0-match label), Playwright reported "lands on /login" — which was technically true (the spec navigated away after a timeout cascade), but the cause was 3 selector misses, not a session-validation race.

## How we caught it

**PR #48 Task 0 — cheap-insurance instrumentation.** The author added `console.warn` + a sessionStorage ring buffer + a Playwright console bridge BEFORE writing any fix code, exactly because two architectural reviews had compared four shapes of fix without anyone observing the mechanism. The instrumentation cost ~30 minutes and ran for 3 retries × 17+ captured renders.

Result: zero `validation === null` post-login. The hypothesis dropped.

From there, manual repro on dev showed the catalog button label bug in under 2 minutes (right-click → Inspect → three identical aria-labels). Radix Tabs role + bare-Label gaps surfaced from grepping the e2e specs' selectors against the DOM the components actually produce.

## Lessons

1. **Evidence before mitigation.** A "fix" is a change that addresses a verified mechanism. A "mitigation" is a change that hides a symptom without isolating cause. A 1500ms warm-up (PR #41) that "fixes" a flake without anyone observing the underlying race is a mitigation. Mitigations need an open follow-up issue tracking the real fix.

2. **A `test.skip` without evidence is a misdiagnosis seed.** PR #43's six SKIPs cited an inferred mechanism. Future readers (human or AI) treated the inferred mechanism as fact and built four planning cycles on top. The cost of a missing three-field SKIP comment was ~30k tokens of architectural review on the wrong hypothesis.

3. **Selector-drift-as-symptom.** When a `test.skip` author can't prove the mechanism, the most common reality is stale selectors. The Frollie POS catalog UI shipped 7 buttons named `Add Dubai` (3) + `Add Choco` (1) + `Add Matcha` (1) + `Add Lotus` (1) + `Add Mixed Box` (1); Playwright `/Dubai 1pc/i` failing on the first one cascaded into 6 spec failures, all attributed to a different layer.

4. **Architectural reviews need a verified-mechanism gate.** The v0.5.7.1 Option A → Option B replan compared four ways to fix a bug nobody had observed. Both reviews followed the staffreview skill template, but the template didn't require evidence citation. Skill §4.9 (added in this PR) closes that gap.

## Systemic change

Shipped in the same PR as this postmortem:

1. **`~/.claude/skills/staffreview/SKILL.md` §4.9 "Evidence-Before-Mitigation Gate"** — additive subsection requiring spec/plan authors to cite a concrete artefact (trace / log / SHA / run ID) before any invasive change is reviewable. If absent + change is invasive → downgrade to "mitigation" + require Task 0 instrumentation. (Note: at execute time, the staffreview skill lives as a file on disk, not a git repo on this machine — the §4.9 edit persists, no commit was made.)
2. **`docs/PATTERNS/skip-comment-template.md`** — Frollie-local enforcement of the three-field SKIP format (observed failure mode + evidence path + follow-up issue). Cross-linked from `CLAUDE.md` "How to add a feature" §10.
3. **REFUTED banners** on `docs/superpowers/plans/2026-06-05-issue-44-usesession-transient-null-fix.md` and `docs/reviews/staffreview-issue-44-architectural-options-2026-06-05.md` pointing to PR #<n> and this postmortem.

## References

- PR #41 — Convex warm-up (`e2e/fixtures.ts:37-41`).
- PR #43 (`4aa4119`) — `fix(e2e): skip 6 PIN-gated specs with tracking notes for hard-nav session loss`.
- PR #45 (`ccb2d65`) — `plan: issue #44 useSession transient-null fix (v0.5.7.1)`.
- PR #47 (`8fb97cb`) — `plan: replan issue #44 as Option B — evidence-based null trust`.
- PR #48 — instrumentation + partial catalog fix (closed unmerged).
- Playwright run `27021101339` — the refuting run.
- PR #<n> — v0.5.9 e2e stabilization (this PR).
- `convex/seed/internal.ts:101-109` — the 7 seed products that exposed the disambiguation gap.
- `src/routes/sale/index.tsx:183` — the original aria-label line.
- `src/routes/sale/charge.tsx:494-497` — the Radix TabsTrigger source-of-truth.
- `src/routes/mgr/spoilage.tsx:264` and `src/routes/mgr/vouchers.tsx:599` — the bare-Label sources-of-truth.
