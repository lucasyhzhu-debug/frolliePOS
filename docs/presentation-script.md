> **Live deck:** https://frollie-pos.vercel.app/presentation/frolliepos-talk.html
> **Edit the deck:** `public/presentation/frolliepos-talk.html` — single source of truth. Edit it directly, commit, redeploy (then fully relaunch the PWA so the service worker updates).
> **Present it:** full-screen (F11). next → / ↓ / space / PageDown · prev ← / ↑ / PageUp · jump Home / End · touch swipe.
>
> _Talk script + research appendix, preserved from the former `presentation/` authoring folder (removed 2026-06-07; the deck is now served straight from `public/presentation/`)._

# Frollie POS — talk deck content

~10-minute talk, 8 slides + 2 appendix pages, speaker-led, low density. By Lucas Zhu (ex-McKinsey, non-technical founder). **Audience: peer CEOs / founders.** The frame: how a non-technical CEO built a real, money-taking product with AI, and the lessons a CEO can take away.

> **Rewrite note (2026-06-10):** restructured from the author's pinned-comment review (11 comments, `review-comments--frolliepos-talk--2026-06-10.json`). Headline is now 15 days; "what holds it together" moved to appendix A and slide 2 became a 7-layer value-chain diagram; the decisions table moved to appendix B and its slot became a click-through "five mistakes" slide; the cost slide is now an off-site-approval case study; footers carry Ikigai AI Ventures.

Voice: verbs first, short sentences, numbers over adjectives, sentence case, first person. No jargon, no engineering vocabulary on the slides — every mechanism is named by the business risk it kills. No banned words (leverage, synergy, unlock, journey, holistic, game-changer, 10x, transform your business). No emoji.

> **Rewrite note (2026-06-07):** the slides were de-jargoned for a CEO audience. The original engineer-facing language and the full technical research live in the appendix below, unchanged — that's the backing detail if a peer asks "but how does it actually work?"

---

## Slide 1 — I built a working product from scratch in 15 days

**Dek:** ex-McKinsey. no engineering team. a non-technical founder, and a swarm of AI agents.

**On the slide:** the title hero + a real device shot. Chips: idea → live in 12 days · 500+ automated tests · taking real money, day 9 · no engineers hired. Footer carries **Ikigai AI Ventures** (every slide does).

**Speaker notes:** I'm Lucas — seven years at McKinsey, no engineering background. Fifteen days ago this was a planning doc. Today it takes real money at our cookie booth in Jakarta, and I hired no engineers to get there. I'll show you what I built, how I ran AI agents like a team, and the lessons that carry over to any CEO.

---

## Slide 2 — what is it? (the value chain)

**Dek:** a real cash register for our cookie booth in Block M — every layer a sale flows through, on one phone.

**On the slide (a 7-layer value-flow diagram, top to bottom, features in mono under each layer):**
1. **shift management** — staff PINs · registered devices · lockouts · sessions
2. **inventory** — stock-in by SKU · recounts · low-stock alerts · spoilage
3. **transactions** — cart → sale · prices frozen on the receipt · refunds are new rows
4. **payments** (highlighted) — QR + bank transfer · provider confirms the instant money lands
5. **receipts & invoices** — private receipt links · one-tap pocket thermal print
6. **governance** — append-only audit log · manager-PIN gates · nothing deleted, ever
7. **communications** — Telegram approvals · daily founders summary · alerts that find you

Two device shots on the right: the cart, a live payment.

**Speaker notes:** It looks like a normal cash register. What it actually is: one value chain, top to bottom — from opening a shift to the message that wakes a manager at home. Walk the layers: staff sign in, stock comes in, a sale freezes its own prices, the payment provider confirms the moment money lands, the receipt prints, everything lands on a permanent log, and anything unusual finds a manager on Telegram. (The money-path rules behind layer 4 live in appendix A if anyone asks.)

---

## Slide 3 — I never let my own work ship on one pass

**Dek:** the cheapest mistake to fix is thinking QA is the agents' job. I build my own evaluation workflows — qualitative and deterministic.

**On the slide:** idea + spec → review the spec → plan → review the plan → build → hand it to 3 reviewers (does it follow our rules? · is it well-made? · will it hold as we grow?) → agree + tidy up → ship. Closer: *you can't outsource taste and quality. you build evaluation systems you trust — and that takes time and millions of tokens of iteration.*

**Speaker notes:** The cheapest mistake to fix is believing QA happens by itself because the agents are smart. It doesn't. I built my own evaluation workflows — some qualitative, judging taste and consistency; some deterministic, checks that pass or fail. The plan gets reviewed before anything is built, and finished work goes to three reviewers with three different jobs who never compare notes. You can't outsource taste. You build evaluation systems you trust, and that took me time and millions of tokens of iteration.

---

## Slide 4 — one person. a whole org chart.

**Dek:** I ran a swarm of AI agents like a company — split the work, make them check each other, loop until it's right. the team I didn't hire saved the coordination, not just the salary.

**On the slide:** the org chart, run by one person — L1 tools I built for this job · L2 my reusable playbooks · L3 the brain + the helpers · L4 the product's plumbing · L5 the workshop floor. Right column: a browser shot of **the Build Log** (the CEO progress report) captioned "the progress tracker my non-engineer brain reads every morning", and a **QR code → github.com/lucasyhzhu-debug/shipshape** — "the QA checklist I run daily — a primary driver of quality on this build".

**Speaker notes:** I didn't write much code — I ran AI agents like a company, split the work, made them check each other against my written rules, and looped until right. Two of the tools on screen are real and public: the Build Log — the progress report I actually read every morning, written for a non-engineer — and shipshape, the QA checklist I run daily. Scan the code; it's on my GitHub. The team I didn't hire saved me the coordination, not just the salary.

---

## Slide 5 — five mistakes I learnt from (click-through)

**Dek:** beliefs I held on day one. each broke somewhere on the way to day fifteen.

**On the slide (each line appears on a click — talk to each one before revealing the next):**
1. "agentic development is easy"
2. "building alone is hard"
3. "consuming is the same as building"
4. "a better model fixes the quality gaps"
5. "build something you can sell"

**Speaker notes (one beat per click):** Each of these felt true on day one. *(click)* Agentic development is easy — until the demo works and production doesn't. *(click)* Building alone is hard — wrong kind of hard; the loneliness is in the deciding, not the typing. *(click)* Consuming AI is the same as building with it — using ChatGPT daily taught me almost nothing about running agents on a real codebase. *(click)* A better model will fix the quality gaps — it won't; my evaluation workflows did. *(click)* Build something you can sell — I built something I could *run*, and the booth taught me more than a pitch deck ever would.

---

## Slide 6 — the build was the cheap part

**Dek:** features took an afternoon. the boring wiring that keeps them from breaking took the days.

**On the slide:** CASE STUDY · the off-site approval system, in three boxes — **THE BUILD** (pillar by pillar: approvals in one pillar, transactions in another; each clean alone, but they talked past each other in time — async seams no demo ever showed) → **THE LEAK** (transactions falling through without proper logging; no error, no alert; found only while building the refund flow on top) → **THE SAVE** (two fixes, not one: end-to-end testing instructions the testing agents follow on every change, and deeper modules behind simpler interfaces so the seams get tested without touching internals). Right: the chart — tests 288 → 733 (bars) with a second line: public surfaces (domain APIs) 9 → 12, plateauing. Plus the dashboards that lied.

**Speaker notes:** Here's the one that taught me the most. I built the off-site approval system pillar by pillar — each pillar clean on its own, but they talked past each other in time, and some transactions fell through without proper logging. No error. I only found it while building refunds on top. The save was two-fold: better end-to-end testing instructions for my testing agents, and deeper modules behind simpler interfaces — John Ousterhout's "deep modules" idea from *A Philosophy of Software Design* (I first heard it via Matt Pocock) — so the seams are testable without knowing the internals. You can see that in the chart: the tests more than doubled, but the number of public surfaces flatlined at twelve — depth grew, the interfaces didn't.

---

## Slide 7 — this deck built itself

> _(Shrunk from a full workflow-diagram slide to a fast aside — the elaborate 5-agent diagram was a victory lap; the wow-metrics stay.)_

**Head:** this deck built itself.

**Dek:** same method I used on the product — pointed at my own notes and the live app.

**On the slide:** just the headline + dek + three chips: 6 agents · a few dollars · 4m 40s to a first draft. No diagram.

**Speaker notes:** This deck built itself the same way I build features — the same method, pointed at my own notes and the live app. Six agents, a few dollars, a first draft in under five minutes. The pitch about delegation was produced by delegation.

---

## Slide 8 — force is free now; direction is the whole job

**Dek (the takeaway):**
- AI gives you almost free force. it will also be confidently wrong, fast, if you let it. the discipline of pausing is the new senior job.
- the written record is the moat — it's why nothing ever has to be decided twice. the last person who left me notes to follow was me, last Tuesday.
- reviews are not a gate at the end. they are where the quality gets made.

**Closer (say it):**
> a wrong vector at full speed just gets you to the wrong answer faster, with better typography.

**Speaker notes:** If you take one thing: AI gives you almost free force, and the moat is direction. It will be confidently wrong, at full speed, if you let it. My whole job now is pointing it at the right thing, and pausing before the confident-wrong answer ships. Thanks.

---

## Appendix A (in-deck) — what holds it together?

The former slide 3, kept verbatim after the close for Q&A: the money path (lock the sale → request payment → provider confirms → mark paid → stock + log) plus the three rules (one rulebook · frozen receipts · press twice, charge once). Pull it up if a peer asks "but how do you know the money is right?"

## Appendix B (in-deck) — the rules rewrote themselves

The former slide 6, kept verbatim after appendix A: the five planned → became decision reversals (own system vs shared database · webhook vs polling · Telegram vs WhatsApp · settlement has no notification · the QR that wasn't). Pull it up if asked "what did you get wrong on architecture?"

---

## Appendix: technical reference (original, unchanged)

> The research below is the engineering-level backing for the talk — the detail behind each slide, in the original builder-facing language. Kept verbatim as the source material; not the CEO script.

### Deliverable: features + linkage

Internal POS for one Android booth selling Dubai-chocolate cookies. Digital-only payments (Xendit QRIS + BCA VA). Convex backend, React PWA. Each feature cites the controlling ADR.

**Key feature clusters:**
1. PIN auth + device registration + sessions — 4-digit argon2id PINs, 3-fail/60s lockout, ephemeral shared-device sessions, devices activated by a one-time 6-digit setup code (ADR-001/002/003/004; foundations §6).
2. Catalog + finished-goods inventory separation — pack-size products draw from singles-only SKUs via a components join; "Dubai 8pcs" decrements 8 from the `dubai` SKU (ADR-016).
3. Cart → commit → Xendit charge (QRIS + BCA VA) — commit snapshots price/name/tax onto each line; inline QR/VA rendered in-POS, single active invoice per txn with explicit supersede on retry (ADR-014/036). Drafts saveable/resumable, offline-queued (ADR-025/032).
4. Webhook-confirmed payment + manager-PIN manual override — signature-verified webhook primary, PIN fallback, polling retired, frozen on `confirmed_via` (ADR-036; foundations §8).
5. Signed-URL customer receipts + Bluetooth thermal printing — 32-byte token → `/r/<token>` HTML (24h cache); prints to 58mm EPPOS over Web Bluetooth ESC/POS, printed QR links to booth Instagram (ADR-021/022/039/043).
6. Refunds as new rows — staff initiate, manager approves; `pos_refunds` row appended, stock re-credited, voucher attribution proportional/floor-rounded; settlement is a separate manual flip (ADR-008/019/040/038).
7. Vouchers (static, no stacking) — manager-minted, one per txn, cached offline with server re-validation; shared pure validator keeps FE-offline and BE in lockstep (ADR-009/010).
8. Reporting: history + manager dashboard — staff see same-day, managers any WIB day + a 7-card dashboard; pure function of (WIB date, role), zero schema (ADR-031).
9. Telegram off-booth approvals — gated actions post a card with `/approve/:token`; self-registering chat registry routes by role (ADR-035/037/029).
10. Append-only audit log — every state-changing mutation writes one immutable server-timestamped row; the only system-of-record; `/mgr/audit` viewer (ADR-007/030).
11. Inventory ops: recount, low-stock alerts, nightly drift recon — staff absolute recounts, reactive low-stock Telegram alerts, nightly cron reports drift (never auto-corrects) (ADR-041/042/044).
12. Spoilage write-off (v0.6) — manager-PIN (booth) or Telegram-approved (off-booth) decrement with reason, grouped by event id; same single writer both paths.

**Linkage map (load-bearing chains):**
1. Sale settlement chain: commitCart (snapshot price+name+tax, status→awaiting_payment) → payments mints Xendit QRIS/FVA invoice (X-IDEMPOTENCY-KEY) → signature-verified webhook matches qr_id/callback_virtual_account_id → _confirmPaid_internal allocates R-YYYY-NNNN, mints receipt_token, confirmed_via:webhook, captures RRN → _recordSaleMovement_internal writes signed-negative movement (deduped by by_line_and_sku) → audit payment.confirmed + stock.sale_movement.
2. Off-booth gate parity: booth = inline manager PIN; off-booth → _createRequest_internal (kind validated by APPROVAL_KINDS.validateContext) → Telegram card to managers with URL button → /approve/:token (token = VIEW, single-use 60-min) → manager PIN (PIN = ACT, per-token 5-attempt cap) → resolves the same pos_approval_requests row → same single-writer commit as booth, source: telegram_approval threaded everywhere.
3. Refund chain: staff /refund/:txnId → manager PIN inline or Telegram approval → _commitRefund_internal (single writer) inserts pos_refunds + re-credits stock + purges receipt cache → refund.committed audit; later markRefundSettled (manager-session, NOT PIN) flips pending→settled on FIFO /mgr/refunds-pending.
4. Receipt chain: _confirmPaid mints receipt_token via mintUrlSafeToken() → /r/<token> httpAction renders + caches HTML (24h) → shareReceipt lazy-mints for older paid txns via _ensureReceiptTokenForPaidTxn_internal → getReceiptForPrint returns view-model + status label (never a token) → escpos.encodeReceipt → Web Bluetooth print.
5. Low-stock chain: every sale/recount → _checkLowStock_internal compares on_hand vs low_threshold → inserts pos_low_stock_alerts (SKU-deduped) → fail-isolated scheduled Telegram dispatch to inventory; re-arms when stock climbs back.
6. Nightly recon chain: 02:00 WIB cron sendStockReconResilient replays movements per SKU → compares to pos_stock_levels.on_hand → on mismatch writes pos_stock_drift_log + audit stock.recon_drift + Telegram stock_drift_alert to inventory → report-only, manager triages at /mgr/stock, resolveDrift patches in place.
7. Device activation chain (two issuers, one writer): issueDeviceSetupCode called by booth generateDeviceSetupCode (manager-session) OR Telegram /activatepos (chat-role gated) → pending_device_setups row discriminated by issued_via → /activate consumes 6-digit code → registered_devices row → audit device.setup_code_issued (Telegram path = system source, NOT telegram_approval) + device.activated.

**Architectural spines:**
1. Single-writer funnels — one internal mutation owns each table regardless of entry path (_commitRefund_internal, _recordSpoilage_internal, _changePinCommit_internal, issueDeviceSetupCode, _confirmPaid_internal).
2. Append-only, server-timestamped audit — _at fields via Date.now() inside the function; source enum records routing path.
3. Snapshot-on-line + integer-rupiah money — price/name/tax frozen on lines, never re-joined; all money integer rupiah.
4. Token-VIEW / PIN-ACT + idempotency harness — 32-byte single-use 60-min tokens for view; every public mutation requires idempotencyKey + withIdempotency + authCheck (ESLint-enforced); webhook dedupes on xendit_invoice_id.
5. Deep modules / surface APIs — convex/<module>/{public,internal,schema}.ts; cross-module reads only via _internal; POS schema private, Frollie Pro integration HTTP-contract only.

### Deliverable: workflow agent patterns (Thariq's 6-pattern taxonomy)

1. Fan-out-and-synthesize — USED HEAVILY (backbone). /triple-review = 3 parallel reviewers, distinct lenses (R1 ADR/invariant, R2 code-quality, R3 deep-module architecture), kept separate + severity-graded, 2+ consensus bubbles up. /simplify xhigh = 4 parallel cleanup agents (reuse, simplification, efficiency, altitude) merged. Wave-based phase execution + subagent-driven implementation (v0.6 Waves 1-4; v0.5.5 = 4 grouped implementers).
2. Adversarial verification — USED, signature move. Double staffreview gate (staffreview spec + fix, writing-plans, staffreview plan + fix — before code). Triple-review against 22 ADR rules. triple-persona-review for prose. Root-cause adversarial self-check (issue #44 debounce challenge codified as a rubric).
3. Classify-and-act — USED (lightweight plumbing). /progress --ready routes tasks by lane/agent. Approval KIND routing (validateContext switch). Telegram role routing. Deterministic routers, not LLM classifiers.
4. Generate-and-filter — USED. /simplify generates cleanups, filter = strict behavior-preservation. Review fix-scope: filter is "can I verify without a live API?". brainstorming → writing-plans filters to one design.
5. Tournament — NOT USED. Parallel agents always complementary (different lenses/file-sets), never competing on identical work. Closest tool design-shotgun not run here. Triple-review consensus is a faint echo (scores findings, not solutions).
6. Loop-until-done — USED (convergence loop). review → fix → re-review until no HIGH findings. gsd-plan-review-convergence is the named version. Page-bounded self-rescheduling purge crons (scheduler.runAfter(0, self)). verification-before-completion enforces terminal stop (run actual verify command, confirm green).

One-line summary: 3 of 6 hard — fan-out-and-synthesize, adversarial verification, loop-until-done. classify-and-act + generate-and-filter as supporting plumbing. No tournaments — agents collaborate by division of labor.

### Deliverable: tool layers (L1 inside to L5 metal)

L1 — bespoke project automation (built for THIS repo): /progress + /progress-update (custom kanban over docs/PROGRESS.md, stable <phase>-<lane>-<slug> IDs, refusal rules); ceo-progress-report (PROGRESS.md → progress.html renderer, extracted to standalone npm package + Claude Code plugin); spec-plan-pipeline (own spec→staffreview→plan→staffreview→land→handoff skill); idempotency-required ESLint rule (tools/eslint-rules/idempotency-required.js, fails build if a convex/*/public.ts mutation skips idempotencyKey + withIdempotency + authCheck); dev seed (seed:reset pre-registers dev-booth-device); /triple-review (project-local at .claude/commands/triple-review.md).

L2 — reusable agentic workflow skills: superpowers (brainstorming, writing-plans, executing-plans, TDD, dispatching-parallel-agents, systematic-debugging, verification-before-completion); staffreview; triple-persona-review; /simplify + /code-review; gsd-* suite; gstack (/ship, /review, /qa, /browse, /investigate).

L3 — the coding agent + fan-out: Claude Code (Opus) driver; Task/subagent fan-out; dynamic Workflows (orchestration scripts); MCP servers (Figma, Linear, Notion, etc.).

L4 — runtime / product infra: Convex (own dev helpful-grasshopper-46 + prod savory-zebra-800, reactive DB, httpActions, crons); Vercel (PWA hosting); Xendit (QRIS QR Codes API + BCA VA FVA API + signature-verified webhook); Telegram Bot API (/approve/:token, role-routed chats); Web Bluetooth (58mm ESC/POS to EPPOS EP5811AI); argon2id (server-side PIN hashing in a Convex action).

L5 — dev plumbing: GitHub (PRs, squash-merge, gh CLI); git worktrees (.claude/worktrees/exec-v0.5.3b/...); vitest (500+ tests via convex-test, 514 at v0.5.3a, 658 at v0.5.1c); TypeScript (tsc -b gate); Tailwind 4 + shadcn/ui (new-york/stone, Frollie teal); IDB (offline queue + idempotency-key persistence).

The point: one founder, zero employees, but the tooling reads like an org chart. A custom PM tool, a review board, a planning department, a swarm of agents, and a full production stack — operated by a single person. The solo engineer didn't get faster; they got staffed.

### Deliverable: learnings + ADR evolution

Solo agentic engineer, POS from scratch, v0.2-baseline (2026-05-25) → v0.6 (2026-06-05): ~12 days, 500+ tests, prod cutover day 9.

ADR evolution — headline reversals (Lucas's voice):
- Shipped the whole app planning to share one Convex project. ADR-034 tore it up — POS owns its own dev and prod deployments now, two products talk over a versioned HTTP API, not a shared schema. "Integrate by sharing the database" is the decision you regret first.
- Was sure QRIS needed status polling plus reconcile-on-reload. Wrong on both. ADR-036: webhook confirms, manager PIN is the only fallback, polling gone. Reconciliation hook is a no-op shell left in on purpose.
- Designed the approval flow around WhatsApp share-intent links (ADR-027). By v0.4 ripped it out for Telegram. URL buttons carry the auth token in the link — no bot-side state. wa.me literal still sits in the schema for old rows.
- Foundations doc said settlement arrives on a webhook. The webhook doesn't exist. Settlement is poll-only — GET the transactions list, match on own reference_id.
- ADR-011 said the Xendit invoice returns a scannable QR at creation. It returns a URL to a hosted page. One wrong sentence meant zero payments could complete; charge screen showed a dash. Fixed by switching to dedicated QR Codes + FVA APIs (synchronous instrument).

Raw supporting facts: ADR-034 supersedes foundations §1, moved pos_stock_movements/_stock_levels from catalog/ to inventory/. ADR-036 supersedes ADR-011, adjusts ADR-014, amends foundations §8 + ADR-026; three-path confirmation collapsed to two. bcrypt cost-12 → argon2id ~200ms before any prod hashes. Receipt URL: HMAC-signed txn number (?sig=) → 32-byte capability token (/r/<token>). Per-kind audit verbs cutover at v0.5.0 (dashboard reads both shapes). v0.5.0.1 renumbered from a mislabeled squash commit.

Surprises:
- Green test suite lied — convex-test filtering an optional field on undefined matched absent rows; null didn't; neither matches prod reliably. 288 passing tests, payment query would have returned null in prod. Filter in JS.
- tsc --noEmit reported fine while checking zero files (root tsconfig files: [] + project references). Only real typecheck is tsc -b.
- node:crypto in a shared helper broke codegen, not runtime — Convex bundles every module under V8 first. Web Crypto everywhere.
- Vite "Network: http://192.168.1.6:port" is a lie — Windows Defender silently drops inbound TCP (timeout, not refused = firewall-drop signature). One PowerShell rule fixed it.
- Xendit callback token isn't chosen — account-wide, different per test/live mode. Wrong = every webhook 401s silently: QR scans, money moves, POS never flips to paid.
- Group-privacy-mode in Telegram swallows the bare /activatepos command.
- ?? default on invariant-guaranteed fields = silent corruption (flagged v0.5.1a, v0.5.2, v0.5.3a). Fix is throw, not coerce.
- telegram_approval audit source reserved for PIN-gated flows; using it for no-PIN /activatepos pollutes the "manager approvals this week" query. Correct source = system.
- .cloud (WS/client) vs .site (httpAction) URL split — window.open('/r/token') hit the SPA stub.
- A query/mutation referencing internal.*/api.* needs explicit return-type annotation or TS infers a circular type, widens api to any.
- canvas@2.11.2 (transitive of the ESC/POS encoder) has no prebuilt for Node 22/24 → broke install locally + on Vercel. Resolved with npm override to a no-op stub.
- Vercel CLI clobbers .env.local, wiping CONVEX_DEPLOYMENT.

Long vs short:
- Short (whole slices in a session): v0.4 Telegram (444 tests, 29 commits), v0.5.1 receipts+refunds, v0.5.3a reporting (24 commits, 733 tests green at merge), v0.5.3b admin CRUD. Design system scaffolded in the baseline commit.
- Long (boring load-bearing): withIdempotency cache lookup runs BEFORE the handler, so requireManagerSession inside is bypassed on replay — needs authCheck option (caught repeatedly v0.4/v0.5.0). Single-writer funnels where a refactor must sweep every writer (a third un-migrated writer hid in seed/). paid_at vs created_at for date-range indexes (cross-midnight late confirmations bucket wrong).
- Worst bug-to-fix ratio: api-version: 2022-07-31 header on QR creation — leave it off, payment webhook never fires, no error, QR works, money never confirms. Now asserted by a test.
- Test count cadence: 288 → 444 → 514 → 658 → 733.

Meta-lessons:
- Planned a 1.5-second debounce, called it "the fix" through spec/plan/CEO summary. Co-founder: isn't that just hiding the symptom? Now the rule: before writing "fix," finish "the root cause is X and this removes it because Y." Fuzzy = mitigation, name it one.
- Same six findings every review: wrong audit source, missing idempotency wrap, ?? papering over corruption, string validators where a literal union belongs, cross-module reads dodging the boundary, a facade nobody calls.
- The docs are the moat — ADRs, CLAUDE.md, lessons file. The previous engineer left the diary in the code, and the previous engineer was me last Tuesday.
- Reviews are where quality gets made, not a gate at the end. Two of the worst bugs caught by independent reviewers.
- Different reviewer lenses grade the same bug differently (by_status_created bug: Critical to ADR-lens, Minor to code-craft). Keep severity-graded across sources; 2+ consensus bubbles up.
- Fix-scope: take maximal scope (everything except live-API-verification items), not criticals only.
- Rule-of-three drives every extraction. Silent stubs throw, not return. POC-tradeoff comments inline.

### Deliverable: voice + philosophy

Voice fingerprint (8 rules):
1. Verbs first, short sentences, no warm-up. "Two months. One operator. Twenty-three million tokens of Claude Code in production."
2. Specific over impressive — always a number, name, date, or dollar in reach. "~USD $700-800 of agentic spend per month."
3. Em dashes are the house punctuation in analytical pieces; short declaratives in confessional ones. "AI replaces this. Not augments — replaces."
4. Confession before instruction — admit the embarrassing baseline. "open ChatGPT in a browser tab... paste it into something the model had told me was Python."
5. Three-beat close, last clause shortest. "Name the constraint. Solve the constraint. Move."
6. Sentence case everywhere, first-person singular, "we" only for the company.
7. Honest about what's NOT proven — names the limit. "I will not call that battle-tested until it has been."
8. Lands the point with a contrast, not a summary. "A wrong vector at full force just gets you to the wrong answer faster — and now with better typography."

Reusable phrasings: staccato number opener; "It took six weeks. (It would have taken a year in 2022.)"; "AI doesn't disrupt X. It disrupts the Y."; "Not how. What."; the anaphora-of-the-absent; the dry-twist closer; category-change number drop; "The first three rounds will be embarrassing. By round ten the model will be doing the work."

Philosophy nuggets: A. Force is free now; direction is the whole job. B. The build is the cheap part — 65% of tokens went to making code not break. C. Senior judgement is the last moat — the discipline of pausing is the new senior contribution (McKinsey trained mine over seven years). D. Mechanic → Driver → Dad → Builder arc. E. "I'm not really writing any code." F. The team you don't hire saves coordination overhead, not just salary.

Banned words: leverage, synergy, unlock, journey, holistic, game-changer, 10x, "transform your business".

Draft opener: "I spent seven years at McKinsey learning what a great business looks like, and on Christmas Day 2025 my entire build stack was pasting ChatGPT code into something the model told me was Python. Sixty days later, one operator and twenty-three million tokens of Claude Code ran my whole company — three brands, six channels, no engineering hire."

Draft closer: "Force is free now — so the only question left worth your week is whether you're pointed at the right destination, because a wrong vector at full speed just gets you to the wrong answer faster, with better typography."
