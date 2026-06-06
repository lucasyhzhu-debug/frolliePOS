# Postmortems

Post-incident retrospectives for shipped misdiagnoses or near-misses. These live longer than `docs/CHANGELOG.md` entries because the lesson outlasts the version that triggered it.

## Genre vs. `docs/reviews/`

- `docs/reviews/` = **pre-merge** artifacts. Staffreviews, design reviews, plan reviews. Catch issues BEFORE code ships.
- `docs/postmortems/` = **post-incident** retrospectives. What we shipped wrong, what we learned, what systemic change we made. Catch issues AFTER and prevent recurrence.

A staffreview that *should* have caught a misdiagnosis but didn't is cited in the postmortem (here), not deleted from `docs/reviews/`.

## Index

| Date | Title | Trigger |
|---|---|---|
| 2026-06 | [issue #44 misdiagnosis — selector drift mistaken for Convex race](./2026-06-issue-44-misdiagnosis.md) | 4 planning cycles before PR #48 instrumentation revealed the actual bug |

## Template

When writing a new postmortem, use this skeleton:

1. **Timeline** — PRs, plans, commits in chronological order with one-line summaries.
2. **What we thought was happening** — per planning artifact.
3. **What was actually happening** — with the verified evidence path.
4. **How we caught it** — the instrumentation / step that revealed truth.
5. **Lessons** — 2-4 numbered takeaways, generalizable beyond this incident.
6. **Systemic change** — the pattern doc, skill update, CI gate, or process change that ships in the same PR as the postmortem to prevent recurrence.
7. **References** — PR numbers, instrumentation commit SHAs, run IDs.
