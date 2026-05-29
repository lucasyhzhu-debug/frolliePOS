---
name: buildlog-review
description: Use when reviewing a PROGRESS.md for CEO-readability before sharing it with founders/board/non-technical stakeholders. Triggers on "review my PROGRESS.md as a CEO would", "is this ready to share with the founders", "what's missing for a CEO check-in", "audit my build log".
---

# Buildlog Review — CEO-eye audit of PROGRESS.md

Read PROGRESS.md as if you were the CEO/founder. Spend 30 seconds skimming; report what you couldn't answer.

## Per-phase questions

For each phase, ask:
- Can I tell what unlocks? → `**You'll be able to:**` exists and bullets are user-readable
- Can I tell what's deferred? → `**Still not yet:**` exists and names which version unlocks each item
- Can I tell when? → `**Target:** YYYY-MM-DD` (or "TBD" only if genuinely unknown)
- Can I tell the cost of cutting it? → Outcome is concrete enough to imagine the world without it

## Whole-document questions

- What's the % to the v1 target? (count shipped phases / total phases — the renderer computes this)
- What's blocked on the CEO's decision? (count of active items in `## Decisions awaiting the CTO`)
- What's at risk? (`## Risks under watch` section freshness — anything older than 60 days probably stale)
- When did anything last ship? (most recent `Merged YYYY-MM-DD` line)
- Does any backlog phase still have `**Target:** TBD` when it shouldn't? (i.e., the team has an estimate but hasn't written it down)

## Output format

Punch-list, severity-marked:

- `❌ BLOCKER` — phase X has no Outcome / no You'll-be-able-to / no Target. The CEO literally can't read this phase.
- `⚠ FIX` — phase Y's Target is TBD but the plan is written (i.e., team knows but hasn't said). Decision tagged "Resolved" but not in the `~~strikethrough~~ — **RESOLVED**` format. Bullet over 18 words.
- `→ POLISH` — Outcome could be tighter. Risk body is 3 sentences (target: 1). Decision title could be sharper.

If everything passes:
- `✓ Ready to share with founders.`

Don't pad with praise. Don't include positive findings — just gaps and fixes. Output 5-15 bullets max; if more, the document needs more work than a review can fix.
