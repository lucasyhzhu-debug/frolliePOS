# SKIP-comment template for test.skip blocks

Use this format for every `test.skip(...)` or `it.skip(...)` block in `e2e/specs/*.ts` and `src/**/*.test.tsx`. A SKIP without these three fields is a future misdiagnosis trail; reviewers must reject it.

## Required fields

1. **Observed failure mode** — the literal output. NOT a hypothesis. Example: `Playwright getByLabel(/Qty/i) resolves to 0 matches`, not `the label probably isn't wired correctly`.
2. **Evidence path** — a verifiable artifact location. PR number + Playwright run ID, commit SHA + line range, screenshot in `/docs/screenshots/`, or repro steps with exact commands. NOT a paraphrase.
3. **Follow-up issue** — the GitHub issue number tracking the actual fix. If no issue exists, open one BEFORE writing the SKIP.

## Example (good)

```ts
// SKIPPED: Playwright getByRole("button", { name: /QRIS/i }) finds 0 matches
// because charge.tsx:495 uses Radix TabsTrigger which renders as role=tab.
// Evidence: PR #48 trace `27021101339` step "open QRIS tab" → DOM dump shows
// <button role="tab"> at expected location.
// Follow-up: #44 (e2e session-on-hard-nav superseded by selector-drift fix).
test.skip("…", async () => { … });
```

## Example (bad — what PR #43 looked like)

```ts
// SKIPPED: session-loss-on-hard-nav. The signedInAsLucas fixture passes
// (heading + tile + URL all confirm signed-in), but page.goto("/sale") inside
// the spec lands on /login — reproducible on every signedInAs*-fixture spec.
// Likely a Convex client transient null on the session-validation query during
// WS reconnect → useSession.isDead effect clears localStorage.
test.skip("…", async () => { … });
```

Why bad:
- "Likely a Convex client transient null" is a hypothesis, not observed output.
- No PR / run ID / commit SHA cited.
- No follow-up issue number.
- The hypothesis was empirically refuted four planning cycles later (see `docs/postmortems/2026-06-issue-44-misdiagnosis.md`).

**Cautionary anecdote:** PR #43 (`4aa4119` — "fix(e2e): skip 6 PIN-gated specs with tracking notes for hard-nav session loss") shipped six SKIPs of the bad form. The "hard-nav session loss" mechanism was inferred without instrumentation; it was empirically refuted on PR #48 ten weeks later. The actual bug was a11y/selector drift — a 5-line aria-label change would have un-skipped all six. The cost of the misdiagnosis: 4 planning cycles, 4 PRs, ~30k tokens of architectural review on the wrong hypothesis.

## Why this matters

A SKIP without evidence becomes a misdiagnosis seed. Future readers (human or AI) treat the inferred mechanism as fact and plan against it. The cost compounds: each misdiagnosed-mechanism plan generates a staffreview, a refactor proposal, and a code-review cycle — all building on the wrong foundation.

## Enforcement

- Pre-merge: reviewers reject any SKIP that doesn't have all three fields.
- Optional future: ESLint custom rule that fails CI on `test.skip(` without a preceding triple-field comment block. Defer until pattern is ignored in practice.

## Related

- Global staffreview skill §4.9 "Evidence-Before-Mitigation Gate" (cross-project).
- `docs/postmortems/2026-06-issue-44-misdiagnosis.md` (the precedent).
- ADR-034 deep-module surface (where most "transient" bugs actually live: at the e2e selector layer, not in the module internals).
