> **Live deck:** https://frollie-pos.vercel.app/presentation/frolliepos-talk.html
> **Edit the deck:** `public/presentation/frolliepos-talk.html` — single source of truth. Edit it directly, commit, redeploy (then fully relaunch the PWA so the service worker updates).
> **Present it:** full-screen (F11). next → / ↓ / space / PageDown · prev ← / ↑ / PageUp · jump Home / End · touch swipe.
>
> _Talk script + research appendix, preserved from the former `presentation/` authoring folder (removed 2026-06-07; the deck is now served straight from `public/presentation/`)._

# Frollie POS — talk deck content

10-minute talk, 6 slides, speaker-led, low density. By Lucas Zhu (ex-McKinsey, solo agentic engineer). Audience: AI enthusiasts.

Voice: verbs first, short sentences, numbers over adjectives, em dashes, sentence case, first person. No banned words (leverage, synergy, unlock, journey, holistic, game-changer, 10x, transform your business). No emoji.

---

## Slide 1 — I built a real POS from scratch, alone, in 12 days

**Dek:** ex-McKinsey, zero engineering hires, one operator and a swarm of agents.

**Bullets:**
- I spent 7 years at McKinsey learning what good looks like. On Christmas Day 2025 my build stack was pasting ChatGPT code into something the model told me was Python.
- This is Frollie POS — a production point-of-sale for our cookie booth at Pakuwon Mall. Real money, real Xendit payments, on a real Android phone.
- v0.2 to v0.6 in about 12 days. 500-plus tests. Prod cutover on day 9.
- I'm barely writing code. The job is the spec, the review, and the failure modes.
- The promise of this talk: how one person ran a whole org-chart of tooling — and what rewrote itself underneath me.

**Screenshot/visual cue:** POS home/hub screen on the booth phone (the title hero). One clean device shot.

**Speaker notes:** I'm Lucas — seven years at McKinsey, now building solo with agents. Twelve days ago this was a planning doc, today it takes real QRIS payments at our mall booth. I'll show you what I built, how I worked, and the decisions that flipped on me mid-build.

---

## Slide 2 — what is it, and what holds it together?

**Dek:** a single-booth POS where every feature hangs off a few load-bearing chains.

**Bullets (the feature spine):**
- Sell: cart to commit to Xendit charge — QRIS QR or BCA VA rendered in-POS, price and name frozen onto each line at sale.
- Confirm: signature-verified webhook is primary, manager PIN is the only fallback. Polling is gone.
- Prove: every paid sale mints a signed-URL receipt and prints to a 58mm thermal printer over Web Bluetooth, one tap.
- Govern: refunds are new rows, never status edits. Append-only audit log is the system of record.
- Reach off-booth: gated actions post a Telegram card with an approve link — token authorizes view, PIN authorizes the act.

**Structured payload — the sale settlement chain (arrows):**
`commitCart (snapshot price+name+tax)` → `mint Xendit QRIS/VA invoice` → `signature-verified webhook matches qr_id` → `_confirmPaid (allocate receipt no., confirmed_via:webhook)` → `signed stock movement (deduped)` → `audit: payment.confirmed`

**Architectural spines (one line each):**
- Single-writer funnels — one internal mutation owns each table, booth and Telegram paths converge there.
- Snapshot-on-line, integer rupiah — never re-join history, no floats.
- Token-VIEW / PIN-ACT + idempotency at client and webhook.

**Screenshot/visual cue:** three real screens left-to-right — sale cart, charge/QRIS screen, customer receipt. (Optionally a 4th inset: the printed receipt.)

**Speaker notes:** It looks like a normal POS — cart, charge, receipt. The interesting part is underneath: every feature funnels through one writer per table, so the booth path and the off-booth Telegram path can't drift. Money is snapshotted at sale and never re-joined, which is the bug you only learn to fear after it bites you.

---

## Slide 3 — I never review my own code with one pass

**Dek:** one operator, but the tooling reads like an org chart — a PM tool, a review board, a planning department, a swarm.

**Structured payload — the agent patterns I actually run (2-col):**

| Pattern | How I use it on Frollie |
|---|---|
| Fan-out-and-synthesize | 3 reviewers, 3 distinct lenses (ADR / code-quality / architecture) + 4 simplify agents (reuse, simplification, efficiency, altitude). Different files each. The bug 2 of 3 flag wins. |
| Adversarial verification | Double staffreview gate — review the spec, then review the plan, both before any code. Then triple-review the diff against 22 ADR rules. |
| Loop-until-done | Review, fix, re-review until zero Criticals. Verify the actual command is green — no "looks done." |
| Classify-and-act | /progress routes tasks by lane; approval kinds route by validator. Plumbing, not a reasoning agent. |
| Generate-and-filter | Simplify generates every cleanup; filter is brutal — does it change behavior? Findings filter: can I verify it without a live API? |
| Tournament | Not used — my agents collaborate by division of labor, they don't compete on the same task. |

**Structured payload — the tool stack (L1 inside to L5 metal):**
- L1 bespoke: custom /progress kanban, ceo-progress-report renderer, idempotency-required ESLint rule, project-local /triple-review.
- L2 skills: superpowers, staffreview, /simplify, gsd suite, gstack.
- L3 brain: Claude Code Opus + subagent fan-out + MCP servers.
- L4 runtime: Convex, Vercel, Xendit, Telegram Bot API, Web Bluetooth, argon2id.
- L5 plumbing: GitHub, git worktrees, vitest (500+), TypeScript, Tailwind 4 + shadcn.

**Screenshot/visual cue:** the Telegram approval card + the /approve PIN screen side by side — the clearest proof that "off-booth" is a real product surface, and a nice stand-in for the agent-coordination theme.

**Speaker notes:** The cheapest bug to kill is one in the plan, so I review the spec and the plan adversarially before writing a line. Then I fan the diff out to three reviewers with three different jobs — they read different files, and I never let them merge their notes. The solo engineer didn't get faster; they got staffed.

---

## Slide 4 — the rules rewrote themselves

**Dek:** five decisions I wrote down, then tore up mid-build. The ADRs are the diary.

**Structured payload — before to after (2-col):**

| What I planned | What it became |
|---|---|
| Share one Convex project with our other product | Own dev + prod deployments; talk over a versioned HTTP API (ADR-034). "Integrate by sharing the database" is the decision you regret first. |
| QRIS needs status polling + reconcile-on-reload | Webhook confirms, manager PIN is the only fallback, polling gone. The reconcile hook is a no-op shell I left in on purpose (ADR-036). |
| Approvals over WhatsApp share-intent links | Telegram URL buttons carry the auth token in the link — no bot-side state. The wa.me literal sits in the schema like a fossil. |
| Settlement arrives on a webhook | The webhook doesn't exist. Settlement is poll-only — GET the transactions list, match on my own reference_id. |
| Xendit invoice returns a scannable QR at creation | It returns a URL to a hosted page. One wrong sentence meant zero payments could complete — fixed with the dedicated QR Codes + FVA APIs. |

**Screenshot/visual cue:** the charge/QRIS screen (the inline QR that ADR-011 said wouldn't need to exist) — paired with a small "ADR superseded" marker. Manager dashboard works here too if a second visual is wanted.

**Speaker notes:** Half my load-bearing assumptions were wrong, and I'd written some of them twelve days earlier. The fix wasn't being smarter up front — it was making the decisions cheap to reverse, in writing, where a reviewer could catch them. The ADRs are why one person can move this fast without re-deciding everything daily.

---

## Slide 5 — the build was the cheap part

**Dek:** features took an afternoon. The boring load-bearing wiring took the days.

**Bullets — short vs long:**
- Short: whole features in a session. Telegram as the real approval channel — 444 tests, 29 commits. Receipts, reporting, admin CRUD — each a single slice.
- Long: which order auth and the idempotency cache run in. Threading one `source` argument through every call site. Keeping two divergent mutations in parity.
- The worst bug-to-fix ratio in the project was one HTTP header — `api-version: 2022-07-31` on QR creation. Leave it off and the payment webhook never fires. No error. The QR works. The money never confirms. Now asserted by a test.

**Bullets — surprises that lied to me:**
- A green test suite lied — convex-test matched absent rows on `undefined`, not `null`; the payment query would have returned null in prod every time. 288 passing tests. Filter in JS.
- `tsc --noEmit` reported clean while checking zero files. The only real typecheck is `tsc -b`. I now distrust any agent that says "typecheck clean."
- The Vite "Network: 192.168.x.x" line is a lie — Windows Defender silently drops the inbound TCP. One PowerShell rule fixed a day of "why won't my phone load it."

**Screenshot/visual cue:** the manager dashboard (totals, payment mix, top SKUs, hourly curve) — the payoff screen that proves the boring wiring works end to end.

**Speaker notes:** Greenfield code is cheap now. Sixty-five percent of my effort went to making code I already had not break in production. The slow, unglamorous part — call-site threading, cache ordering, cross-path parity — is exactly where the real engineering lives.

---

## Slide 6 — force is free now; direction is the whole job

**Dek:** what I'd tell you if you're about to do this yourself.

**Bullets — learnings as one-liners:**
- Before I write "fix," I finish the sentence: the root cause is X and this removes it because Y. If it's fuzzy, it's a mitigation — and I name it one. (A co-founder caught me calling a 1.5-second debounce "the fix.")
- The same six findings come back every review — wrong audit source, missing idempotency wrap, `??` papering over corruption. I could write the review before running it, which is exactly why I run it.
- The docs are the moat. The previous engineer who left the diary in the code was me, last Tuesday.
- Reviews aren't a gate at the end — they're where the quality gets made. Two of my worst bugs were caught by independent reviewers, not by me.
- The agent will be confidently wrong, fast, if you let it. The discipline of pausing is the new senior contribution. McKinsey trained mine over seven years.

**Closer (say it):**
> Force is free now — so the only question left worth your week is whether you're pointed at the right destination, because a wrong vector at full speed just gets you to the wrong answer faster, with better typography.

**Screenshot/visual cue:** back to the POS home/hub on the booth phone (bookend with slide 1), or a single-line title card with the closer.

**Speaker notes:** If you take one thing: agents give you almost free force, and the moat is direction. My whole job now is calibration — giving the agent enough of what good and bad look like to keep it honest, and pausing before I ship the confidently-wrong answer. Thanks.

---

## Appendix: raw research

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
