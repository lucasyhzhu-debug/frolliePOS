# Editing Report — Frollie POS conference deck (peer-CEO rewrite)

> Reviewed: 2026-06-07
> Source artifact: `public/presentation/frolliepos-talk.html`
> Companion script: `docs/presentation-script.md`
> Personas dispatched: 3 — Aarav Mehta (founder/CEO, SEA FMCG), Diane Mathieson (COO, ex-McKinsey partner), Nikita Park (AI builder / row-4 technical skeptic)
> Round: 1

## Executive summary

The rewrite succeeded at its stated goal: the *technical skeptic* (Nikita) confirms the de-jargoning is mostly **honest** — the plain-English claims map to the real mechanisms without lying. But de-teching exposed a deeper gap the jargon was hiding: **there is no money in the deck.** Both operator-class readers (Aarav, Diane) land at the same middling verdict for the same reason — they get test counts and tooling, not rupiah, margin, or AI spend. The single highest-leverage fix is to put one real money number on stage (AI cost is in your own appendix; booth revenue needs your call). Second: slides 5, 6, and 9 are inward-facing — about *your toolchain*, not a CEO's P&L — and all three readers want them compressed.

## Verdict tally

| Persona | Reader-action verdict | One-line reason |
|---------|----------------------|-----------------|
| Aarav Mehta | "I would take the call myself first to vet" | Sharp on integrity + honesty, but would test whether he grasps real-channel complexity before spending CFO time. |
| Diane Mathieson | "I would forward to my Head of Ops without taking the call myself" | Method's sound, but show me the money before I spend an hour. |
| Nikita Park | "I would follow him" | Confessional, dated, real numbers; honest about what broke, not a LinkedIn victory lap. |

**Read of the tally:** All three positive at different commitment levels — but the two operators stall at "middling" for an identical root cause (no money / too much inward tooling), while the technical reader is the most won over (the simplifications are honest). The deck nails *de-jargoning*; it under-delivers on *"lessons a CEO can take away"* because it shows tooling, not P&L.

## Consensus issues (2/3 or 3/3)

### 1. No money anywhere — the biggest miss (3/3)
- **Raised by:** Diane, Nikita, Aarav
- **Evidence:**
  - Diane: "No money anywhere... he shows me token counts, not rupiah. Test count is not a business metric."
  - Nikita: "Slide 1 numbers have no spend context... the dollar/token figure that's RIGHT THERE in your appendix (23M tokens, ~$700-800/mo)... the one number I'd screenshot is missing."
  - Aarav: "No COGS, no unit economics."
- **Edit:** Put at least one money number on stage. Two tiers: (a) **AI spend** — already known (~USD $700–800/mo, ~23M tokens) — add as a Slide 1 chip and/or a Slide 8 cost beat ("12 days, ~$X of AI vs a $Y engineer-quarter"). (b) **Business** — booth revenue/margin since day 9, if you're willing to disclose it (needs your input). At minimum, end on a number, not a metaphor.

### 2. Slides 5–6 are the engineer deck in a CEO jacket (3/3)
- **Raised by:** Diane, Aarav, Nikita
- **Evidence:**
  - Diane: "Slides 5–6 are inward-facing... two slides on his toolchain, zero on whether this changed his P&L. Compress to one slide."
  - Aarav: "agent-orchestration plumbing... the bit my Head of Ops tunes out — about HIS tooling, not a P&L."
  - Nikita: Slide 5 "is Thariq's 6-pattern taxonomy with the source filed off... reads as a universal recipe when your own appendix says it's 3-of-6 for THIS project"; Slide 6 "'swarm' is identity-signal jargon that survived."
- **Edit:** Compress slides 5 + 6 toward one slide whose CEO takeaway is *"I ran it like a team and paid for tooling, not salaries."* On Slide 5, demote to "three moves I lean on, hard" and drop/footnote the other three so it stops reading as a borrowed universal framework. Kill "swarm" on Slide 6.

### 3. Slide 9 (the meta "I built this talk with the method") is a victory lap (2/3, 1 dissent)
- **Raised by:** Aarav, Diane (Nikita dissents — she liked it)
- **Evidence:**
  - Aarav: "a humble-brag detour... a deck about a deck. Cut or shrink."
  - Diane: "clever, but it's a victory lap... content-marketing recursion. Cut to a sentence."
  - Nikita (dissent): "meta-demo of the delegation thesis, with a spend figure... a workflow I could try this weekend."
- **Edit:** Shrink Slide 9 to a 10-second aside or a single line after Slide 4. Note the dissent: it plays well to *technical* attendees, poorly to *operators* — so its fate depends on room mix (see tradeoff below).

## Tradeoff points (split readers)

### A. Slide 10 closer — "...with better typography"
- **Aarav & Nikita:** love it. Aarav "I'd quote it"; Nikita "earns its tricolon. I'd follow for that line alone."
- **Diane:** "Cute, and it's already the takeaway in the prose above it — the pull-quote doubles the punchline. It summarises; it doesn't land."
- **The tension:** the crowd-pleasing line vs. the McKinsey-ear rule "don't deliver the same punch twice, and end on a number."
- **Recommended resolution:** keep the line (2/3 love it), but **remove the redundancy** — the closer currently echoes a prose bullet above it. Cut the duplicate so the line lands once, clean. If you can, follow it with one revenue number (resolves Consensus #1 too). This honours Diane without losing the crowd.

### B. "no engineers hired" — flex or risk?
- **Diane:** rewards it — "concrete, falsifiable, dated. Not 'AI transformed my workflow.'"
- **Aarav:** penalises it — "reads as a RISK signal, not a virtue. Who maintains it when you're on a flight? Where's the runbook? The bus-factor question is the whole question for an operator."
- **The tension:** the same claim reads as proof to an exec and as fragility to a hands-on operator.
- **Recommended resolution:** keep the claim, add one disarming line (Slide 1 or 6) answering the bus-factor — *"the written record is the runbook; any operator can pick it up"* (you already say "the written record is the moat" on Slide 10 — pull it forward). Costs nothing, neutralises Aarav, keeps Diane's falsifiable flex.

### C. Room mix decides Slide 9 and Slide 5's depth
- If the audience skews **technical/builder**, Nikita's vote says keep Slide 9 and the agent-pattern detail — it's the screenshot-worthy "try this weekend" material.
- If it skews **operator/CEO**, Aarav + Diane win — cut to the business lesson.
- **Recommended resolution:** since the deck's stated frame is *peer-CEO*, optimise for the operators; keep a single technical-depth beat (the honest payment-bug story already does this on Slide 8) for the builders in the room.

## Outlier flags (1/3)

### "Lessons that carry over to any CEO" overreaches — one booth, one SKU (Aarav)
- **Severity:** high (for the operator segment)
- **Evidence:** "it's a one-booth, one-SKU build dressed as a universal CEO method... a clever toy presented as a transferable method. The hardest things in my P&L — returns, MOQ, distributor margin, channel reconciliation — don't exist in his system."
- **Why it matters:** the operators in the room will silently discount the transfer claim unless you build the bridge for them.
- **Edit:** add one bridge line on Slide 7, e.g. *"the same reconciliation gap exists between any marketplace payout and your ledger"* — turns a cookie-booth detail into something a $30M founder recognises.

### Honest-simplification precision quibbles (Nikita)
- **Severity:** medium (technical-honesty; cheap to fix)
- **Evidence:** Slide 2 "the bank tells us the instant money lands" — "it's the *payment provider* (Xendit), not the bank; a literal CEO will picture BCA calling them." Slide 3 "bank confirms / we stopped guessing" — "you swapped one fragile guess (polling) for another fragile dependency (a webhook that fails silently if a token's wrong). A CEO can't tell; I can."
- **Edit:** Slide 2 → "the payment provider tells us" (one word). Slide 3 → add one honest clause tying it to Slide 8's bug: *"...and we learned the hard way — get one setting wrong and it fails silently."*

### "What I would NOT let AI touch" is missing (Aarav)
- **Severity:** medium
- **Evidence:** "He says force is free but never says where AI would be reckless in a real supply chain... judgement-under-constraint is asserted, not shown."
- **Edit (optional):** add a beat on Slide 10 naming the call you still make by hand and why — the operator-credible other half of "force is free."

## Prioritised edit list

**P0 — do before next ship:**
- [ ] Slide 1 + Slide 8: add a real **money number** — AI spend (~$700–800/mo / ~23M tokens, already known) as a chip + cost beat. — 3/3 consensus; the deck's biggest gap.
- [ ] Slides 5 + 6: **compress toward one slide**, demote Slide 5 to "three moves I lean on," cut "swarm." — 3/3; the inward-tooling drag.

**P1 — should do this round:**
- [ ] Slide 9: shrink to a one-line aside (keep a trace for technical rooms). — 2/3 consensus.
- [ ] Slide 10: remove the closer's redundancy with the prose bullet above; ideally end on a number. — tradeoff A resolution.
- [ ] Slide 1 or 6: add the one-line bus-factor answer ("the written record is the runbook"). — tradeoff B resolution.
- [ ] Slide 7: add the one bridge line generalising the reconciliation lesson. — high-severity outlier.

**P2 — judgment calls / cheap polish:**
- [ ] Slide 2: "the payment provider tells us," not "the bank." — one-word honesty fix.
- [ ] Slide 3: add the honest "fails silently if a setting's wrong" clause. — ties to Slide 8.
- [ ] Slide 10: optional "what I wouldn't let AI touch" beat.

## Open questions for the author

- **Booth revenue/margin:** are you willing to put a real rupiah figure on stage (revenue since day 9, or margin on a cookie)? Diane and Aarav both want it; I won't invent it.
- **Room mix:** is this audience operator-heavy (optimise away Slide 9 + agent-pattern depth) or builder-heavy (keep them)? Decides tradeoff C.
- **"No engineers" framing:** keep as the headline flex (Diane's read) or soften with the runbook line (Aarav's read)? I recommend the latter — it costs nothing and closes the only real objection.

## Persona calibration notes

- **Aarav:** on-target and distinct — owned the bus-factor + channel-complexity lens no one else raised. No adjustment.
- **Diane:** on-target — the "no money in a room of operators" + doubled-pull-quote catches are exactly her calibration. No adjustment.
- **Nikita:** the row-4-technical-skeptic framing worked as intended — she alone cross-checked the simplifications against the appendix and caught the "bank vs provider" and "honest-but-fragile webhook" precision losses. No adjustment.

(No calibration needed this round — all three returned distinct, on-target feedback.)

## Appendix — Full persona reviews

### Aarav Mehta
> **What landed:** Slide 7 settlement reversal ("no such notification exists; we pull the transaction list and match it ourselves") — "the one slide where he sounds like an operator, not a builder." Slide 3 press-twice-charge-once + frozen receipts. Slide 8 invisible payment bug + "green tests lied" — "the most credible thing he says all talk." Slide 10 closer — "I'd quote it."
> **What didn't land:** One cookie booth, one SKU — no returns/MOQ/COGS/distributor margin/channel conflict/working capital; "lessons that carry over to any CEO" overreaches ("a clever toy, presented as a transferable method"). Slide 1+6 lone-wolf framing reads as risk ("who maintains it when you're on a flight? where's the runbook?"). Slide 9 meta = humble-brag detour, cut/shrink. Slides 5–6 = agent plumbing his Head of Ops tunes out. No "what I would NOT automate."
> **Verdict:** "I would take the call myself first to vet."

### Diane Mathieson
> **What landed:** Slide 7 — five named reversals owned by name ("integrate by sharing the database is the decision you regret first" — a real scar); "best slide in the deck." Slide 8 — the missing-payment-setting bug + "Green does not mean safe." Slide 1 chips "taking real money, day 9 · no engineers hired" — concrete, falsifiable, dated. Slide 4 closer "the solo founder didn't get faster. they got staffed."
> **What didn't land:** Slide 10 pull-quote doubles the punchline already in the prose. No money anywhere — token counts, not rupiah; "test count is not a business metric." Slides 5–6 inward-facing, the engineer deck in a CEO jacket. Slide 9 a victory lap, cut to a sentence. "500+ tests" scattered as hero proof instead of one chosen number.
> **Verdict:** "I would forward to my Head of Ops without taking the call myself."

### Nikita Park
> **What landed:** Slide 8 invisible-bug story (the `api-version` header bug told honestly + true) — "I'd screenshot that." Slide 8 288→733 bars + "the dashboards that lied." Slide 7 five named reversals — "the slide I'd share with my CEO to justify my weekend habit." Slide 9 "4m 40s · a few dollars" meta-demo + topology. Slide 10 closer — "earns its tricolon."
> **What didn't land:** Slide 1 numbers have no spend context (the 23M-tokens / ~$700-800/mo figure is in the appendix but missing on stage — "the one number I'd screenshot is missing"). Slide 5 "six ways" = Thariq's taxonomy presented as universal when it's 3-of-6 (mild over-claim). Slide 3 "bank confirms / we stopped guessing" oversimplifies a webhook that fails silently. Slide 6 "swarm" = surviving identity-jargon. Slide 2 "the bank tells us" — it's the payment provider, not the bank.
> **Verdict:** "I would follow him."
