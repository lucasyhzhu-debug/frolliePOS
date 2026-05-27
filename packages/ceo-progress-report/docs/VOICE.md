# Voice — why this format is opinionated

This document is the reason the package exists. The renderer is commodity HTML; the discipline is the IP. Read it before you write your first phase, and re-read it before you ship one.

---

## The problem with engineer-voice build logs

Engineers default to listing what they built. "Implemented Xendit webhook handler with HMAC signature verification, polling fallback, and idempotency dedupe by invoice id." The sentence is true, dense, and useless to the person paying for it. The reader — the CEO, the cofounder, the investor doing diligence between meetings — has no surface to grip. They don't know what changed in the world. They know the team did something, and the something has tokens they vaguely recognize, and they nod and close the tab.

The CEO doesn't need to know what you built. They need to know what unlocks. "Customers can now pay by scanning a QR code, and if the network drops the staff member won't accidentally charge them twice." Same code, same week, same diff — different sentence. The translation from one to the other is the work, and it's the work engineers most often skip. This package is the scaffolding that makes you do it anyway.

---

## The CEO question hierarchy

The `buildlog-review` skill audits every phase against four questions and the whole document against four more. Each question screens for a specific failure mode.

### Per-phase questions

**Can I tell what unlocks?** The CEO is allocating attention across a portfolio — yours is one of several balls in the air. The `**You'll be able to:**` block answers "what new thing can I describe to the next investor I meet?" If the bullets read like a changelog ("added X service, refactored Y module"), the phase has no surface for the reader. Failure mode being screened: engineer-voice masquerading as outcomes.

**Can I tell what's deferred?** Every shipped phase reframes scope cuts as roadmap. Without `**Still not yet:**`, the reader either assumes everything works (and is surprised later) or assumes nothing works (and discounts the win). The list calibrates expectation. Failure mode being screened: silent scope drift the team has internalized but the CEO hasn't.

**Can I tell when?** A `**Target:**` date — even one that has slipped twice — beats "soon." Targets are commitments of intent; their absence reads as "we don't know and we'd rather not say." The CEO can absorb a slip; they can't absorb invisibility. Failure mode being screened: estimate-shyness disguised as caution.

**Can I tell the cost of cutting it?** The Outcome must be concrete enough that the reader can imagine the world without it. "Improve payment reliability" doesn't cut — every phase improves something. "Customers can pay by QRIS without staff manually checking the bank app" does cut, because the absence is now visible. Failure mode being screened: abstract outcomes that hide their own optionality.

### Whole-document questions

**What's the % to the v1 target?** The renderer computes this for you (see "How roadmap % is computed" below). The number's job is to anchor the reader before they read anything else — a CEO opening the page wants a single integer before deciding how deep to dive.

**What's blocked on the CEO's decision?** `## Decisions awaiting the CTO` is the action list. If the count is zero, the team is fully unblocked. If it's nonzero, those are the items the CEO must move first. Failure mode being screened: decisions that sit in Slack, forgotten, while the team waits.

**What's at risk?** `## Risks under watch` is the calibration list. If anything in it is older than 60 days and unchanged, the risk has either resolved (and should be removed) or solidified (and should be re-described). Failure mode being screened: risk theater — risks listed once for cover, never updated.

**When did anything last ship?** The most recent `Merged YYYY-MM-DD` is the velocity tell. If the gap is wider than the team's cadence, the build log is overdue for an honest conversation, not a polish pass. Failure mode being screened: the doc looks active because phases are listed; the diff history says otherwise.

---

## Outcome statements — before / after

### Payment feature
**Engineer voice:** Implement Xendit Invoice API integration with webhook + polling fallback + idempotency wrapper.
**CEO voice:** Staff take a sale and accept QRIS or BCA VA payment, with retries that don't double-charge.

The first sentence names three engineering decisions. The second names the customer's experience and the staff's confidence — the two things the CEO actually owns.

### UI feature
**Engineer voice:** Build cart drawer component with line-item add/remove, quantity stepper, and live totals via Zustand store.
**CEO voice:** Staff build a sale on screen and see the total update as they add items — no calculator, no double-entry.

The first sentence is for a UX designer reviewing implementation. The second is for the cofounder deciding whether the team is solving the right problem.

### Infrastructure
**Engineer voice:** Set up Convex deployment with auth schema, idempotency table, and seeded staff records.
**CEO voice:** The system is ready to receive its first real sale — staff can log in, the database knows who they are, and no test data is in the way.

The first sentence is a checkpoint inside the engineering plan. The second is the threshold at which the project becomes real to a non-engineer.

---

## The unlocks/deferred framing — why both lists matter

The `**You'll be able to:**` list is the promise. The `**Still not yet:**` list is the calibration. Skip the second list and every phase reads like a complete launch — the reader pattern-matches each phase to a finished product and gets disappointed when the next phase reveals a missing piece. Include the second list and scope cuts feel like roadmap, not omission; the reader updates their internal model in real time, and the team buys credibility for the cut they're about to make later.

---

## When to mark a decision resolved

A decision is "resolved" the moment downstream work starts assuming the outcome — not the moment consensus is reached. Consensus is a meeting artifact; assumption is a code artifact. By the time someone has written a function that depends on choosing option A over option B, the decision has been made whether or not anyone said so out loud. Mark it resolved then.

The format is exact and intentional:
```
- ~~**Original question?**~~ — **RESOLVED 2026-05-15**: chose option A because [one-sentence reason].
```

Strikethrough makes the original question visible-but-past. The date stamps it. The single reason sentence is the institutional memory — six months from now, when someone asks "wait, why did we go with A?", the answer is in the file. Don't delete a resolved decision; the resolved list is the only record of how the project actually thought.

---

## Targets vs deadlines

A target is a commitment of intent: "we're aiming for this date because we said we would." A deadline is enforced by something external — a launch, a contract, a court. Most product builds don't have real deadlines; they have targets that drift. The build log's job isn't to pretend the target is a deadline; it's to make the drift legible. When a target slips, change the date and add one line to risks or decisions explaining why. The pattern of slips is the signal — a single slipped target is normal, three slips on the same phase is a re-plan.

---

## Why the renderer is opinionated

The newspaper aesthetic isn't decoration — it's a coding choice. Cormorant Garamond, the editorial column structure, the seal stamps for shipped phases, the calm grayscale for resolved decisions — they all signal "this is documentation that respects your attention." The reader opens the page and their posture changes. They don't skim because the document doesn't look skimmable; they read because it looks read. A markdown-default GitHub render looks like a status update from someone too busy to format it; the editorial render looks like a memo someone wrote because they wanted you to understand. That's the whole product.

---

## How roadmap % is computed

The renderer computes "% to v1.0" as `shipped phases / total phases`. Unweighted — a one-task phase counts the same as a fifty-task phase. This is intentional: weighted-by-scope would require effort estimates the build log doesn't currently capture, and the resulting number would be more authoritative than the underlying estimate deserves. The unweighted number is honest about its own imprecision; it tells the reader "we're 4 of 7 phases through" and trusts them to look at the phase list for nuance. The weighted-by-tasks variant ships as an opt-in: set `roadmapPercent: "tasks"` in `buildlog.config.mjs` to count by addressable tasks instead of phases. Default remains unweighted because most projects don't yet capture per-task effort estimates, and weighting by raw task count amplifies the "many small tasks beat one big one" bias — better to know than to assume.
