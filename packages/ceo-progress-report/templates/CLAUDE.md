# Project context for AI agents

## Build log
This project uses **CEO Progress Report** for its roadmap.
- Source of truth: `PROGRESS.md`
- Rendered HTML: `progress.html` (regenerated from the markdown)
- Build command: `npx ceo-report build`

## Refusal conditions when editing PROGRESS.md
- Do not edit `progress.html` directly — it's regenerated.
- Do not delete a resolved decision — they are institutional memory; keep them in `~~strikethrough~~ — **RESOLVED YYYY-MM-DD**: ...` form.
- Do not surface engineering metrics (task counts, dependency chains) in the phase-level Outcome or "You'll be able to" bullets.
- Do not change a phase status without also updating the `**Target:**` line if applicable.

## Voice discipline
Every phase needs:
- `**Outcome:**` — one sentence in user-action voice, not engineer voice.
- `**Target:** YYYY-MM-DD` (or `TBD`) — date the phase ships.
- `**You'll be able to:**` — 4-8 user-readable bullets, each starting with a verb the reader would say aloud.
- `**Still not yet:**` — 2-6 bullets naming what's deferred to which future version.

See the `buildlog-author` skill for full guidance.
