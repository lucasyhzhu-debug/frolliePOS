# Staff Review: v0.5 Decomposition Proposal

**Date:** 2026-05-30
**Plan:** Verbal proposal (no PLAN.md yet) — split v0.5 into 4 sub-phases
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ N/A — this review evaluates the *decomposition itself*, not a written plan. Per-slice plans will be written after the cut is agreed.

---

## 0. Plan Structure Additions

Not applicable. The artifact under review is a 4-bucket decomposition, not a structured PLAN.md. The output of this review is a **recommended cut** + the criteria each per-slice plan must satisfy when written.

---

## 1. Summary

**Overall Assessment:** **Revise** (the decomposition is directionally right but has 3 misplacements that will cause rework if shipped as-is)

The user's instinct — split v0.5 into 4 sub-phases rather than monolith — is correct and matches the repo's proven v0.2→v0.2.1→v0.3→v0.4 cadence. However the proposed cut has three issues: **(1) lock/handoff is in the wrong bucket** (it's a session/shell concern, not a sale-loop concern); **(2) receipt-config UI is in the wrong bucket** (it's a manager admin tool, not a sale-loop concern); **(3) settlements is buried in "manager ops"** despite being load-bearing for v1.0 launch confidence per the project's own Risks-under-watch register.

With those three fixes, the 4-slice cut is optimal — 5 slices would be ceremony, 3 would force re-monolith. Recommended order: **v0.5.0 → v0.5.1 → v0.5.2 → v0.5.3** (foundation → refunds+receipts → stock → manager ops + settlements).

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Lock/handoff miscategorized in v0.5.1 | Architecture fit | proposed v0.5.1 |
| 2 | Receipt-refund data contract must be locked before either ships | Schema/coupling | proposed v0.5.1 |
| 3 | Receipt-config UI conflated with public receipt page | Scope boundary | proposed v0.5.1 |

### Issue 1: Lock/handoff belongs in v0.5.0 foundation, not v0.5.1 sale-loop closure

The proposed v0.5.1 bundles `routes/lock.tsx` + "Lock → resume UX (resume-on-prev-staff)" with refunds, receipts, and history. These have **zero technical overlap**:

- Lock/handoff touches: `useSession` hook, `staff_sessions` table, `/login` route's pin-stage pre-fill, last-staff persistence at lock time
- Refunds/receipts/history touch: `pos_refunds`, `pos_receipt_counters`, `transactions/public.ts` query expansions, public `/r/:n` route

Lock/handoff is an **auth/shell concern surfaced by v0.3 UAT** (PROGRESS.md:809). It belongs alongside the nav shell in foundation because both are app-chrome work that every screen depends on. Shipping it inside the sale-loop slice forces refund/receipt PRs to touch unrelated session code.

**Recommendation:** Move lock/handoff into v0.5.0 foundation. Foundation's identity becomes "app shell + session ergonomics + v0.4 stabilizers" — coherent.

### Issue 2: Receipt ↔ refund data contract must be designed before either is implemented

ADR-008 says refunds are a new row (`pos_refunds`), never a mutation of the paid transaction. The public receipt `/r/:n` is a customer-facing URL that the *customer might re-open after a partial or full refund*. The contract must answer, **before either feature lands**:

- Does the receipt URL render the original sale + refund block appended? Or does it render the *current effective state* (computed from `pos_transactions` + `pos_refunds`)?
- Does a refund **invalidate the receipt cache** (24h TTL per WORKFLOW.md:79) or augment it?
- Does the receipt token from the original sale **stay valid after refund**, or does refund mint a new token?
- Does the receipt show *which lines* were refunded if partial?

These are spec-level decisions — getting them wrong means the receipt template + cache layer + refund mutation all need rework after v0.5.1 ships. The proposal correctly bundles refunds + receipts in one slice (good!), but the **spec must answer the four questions above explicitly** before code starts.

**Recommendation:** v0.5.1 spec MUST include a "Receipt-after-refund display contract" section with explicit answers. Don't start implementation until it's locked.

### Issue 3: Receipt config UI is a manager admin tool, not a sale-loop feature

PROGRESS.md:812 lists `routes/mgr/receipt.tsx` (ReceiptConfig) in the v0.5 grab bag. If it lands in v0.5.1 alongside the public receipt page, v0.5.1's UI surface doubles and its threat model spans both customer-facing AND manager-gated routes — different quality bars, different reviewers.

**Recommendation:** Ship a **hardcoded receipt template** in v0.5.1 (good enough for v1 launch). Defer `routes/mgr/receipt.tsx` ReceiptConfig to v0.5.3 manager ops alongside other admin CRUD. This keeps v0.5.1 single-purpose (close the sale loop) and prevents the customer-facing receipt route from being held hostage to a manager admin form.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Call out settlements as an explicit named deliverable, not buried in "manager ops" | H | L |
| 2 | Document that `pos_stock_movements` schema already exists (v0.3) — stock slice is smaller than it looks | M | L |
| 3 | Commit to a sequencing recommendation: 0 → 1 → 2 → 3 (risk-front-loaded after foundation) | M | L |
| 4 | Per-slice PR size cap, calibrated to v0.4 baseline | M | L |

### Improvement 1: Settlements deserves a name, not burial

PROGRESS.md:898 says:
> **Xendit settlement timing** — payout latency vs cashflow visibility. v0.5 settlements module is the canary; if it ships clean, settlement risk is closed.

This is **load-bearing for v1.0 launch confidence** by the project's own Risks-under-watch register. Bundling settlements unlabeled inside "manager ops" creates the risk that if dashboard or in-app staff/products mgmt overflows the slice, settlements gets silently dropped to v0.6 — leaving v1.0 with an open risk that the v0.5 cycle was supposed to close.

**Recommendation:** Either (a) rename v0.5.3 to **"Manager ops + Settlements"** so it's explicit in the changelog and impossible to drop unnoticed, or (b) consider whether settlements deserves its own v0.5.4 slice. Recommend (a) for ceremony reasons — 4 slices is right.

### Improvement 2: Stock slice is smaller than the proposal implies

`pos_stock_movements` and `pos_stock_levels` tables **already exist** as of v0.3 (`convex/inventory/schema.ts:5,25` confirms). v0.3's PROGRESS note: *"stock_movements/vouchers/approvals tables added."* The v0.5 stock slice is therefore:

- Mutations on existing tables (stock-in, stock adjust), not new schema
- Two new routes (`routes/stock.tsx`, `routes/stock/in.tsx`)
- Reconciliation tools for ADR-018 neg-stock

This is **substantially smaller than refunds+receipts** (which need new tables, new approval kind, public route, cache layer). v0.5.2 stock is the natural "warm-up" slice between v0.5.0 foundation and v0.5.1's higher-risk customer-facing work — except sequencing pushes refunds-first for user value (see Improvement 3).

### Improvement 3: Sequencing — recommend 0 → 1 → 2 → 3

Two defensible orderings:

| Order | Rationale | Trade-off |
|-------|-----------|-----------|
| **0 → 1 → 2 → 3** (recommended) | Highest-value (refunds+receipts close the v0.3 sale loop) ships earliest after foundation lands; manager ops depends on history queries from v0.5.2 + settlements infra | Highest-risk slice ships second; if it slips, stock & manager ops both slip |
| 0 → 2 → 1 → 3 | Stock is the low-risk warm-up after foundation; pattern-discovery happens on a smaller blast radius before refunds | Refunds (highest user value, longest-pending request) waits behind stock |

The first order matches how the team shipped v0.3 (highest-risk Xendit work first, not last). Recommend it.

### Improvement 4: Per-slice size budget

v0.4 baseline: 386-line spec, 1699-line plan, ~15 backend tasks + ~5 frontend tasks. Cap each v0.5 sub-phase at this size. If a per-slice plan starts pushing past ~2000-line plan / ~20 tasks, split it further before starting implementation.

---

## 4. Refinements (Optional)

- Consider whether v0.5.0 foundation should be split into v0.5.0a (nav + lock/handoff — visible plumbing) and v0.5.0b (security hardening + hygiene — invisible cleanup). Lean against — adds ceremony, and bundling them lets the foundation PR ship one cohesive "app shell hardening" narrative.
- In-app staff/products mgmt (in v0.5.3) has no hard deps on dashboard or settlements. If v0.5.3 overflows, this is the natural extractable to a v0.5.4. Keep an eye on it during planning.
- The "per-token failed-PIN cap on /approve actions" item (PROGRESS.md:795) is a security finding — when it lands in v0.5.0, make sure the PR description flags it as security so it gets a security-grade review pass.

---

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How v0.5 uses it |
|------|----------|------------------|
| `pos_stock_movements` table | `convex/inventory/schema.ts:5` | v0.5.2 stock mutations write into it (don't re-define) |
| `pos_stock_levels` table | `convex/inventory/schema.ts:25` | v0.5.2 reconciliation reads from it |
| `pos_approval_requests` + `APPROVAL_KINDS` registry | `convex/approvals/` | v0.5.1 refund flow adds a new `kind` (refund / refund_approval), following the 4-touchpoint pattern documented in CLAUDE.md §how-to-add-a-feature #8 |
| `sendTemplate` + URL-button approval | `convex/telegram/send.ts` | v0.5.1 refund Telegram message reuses this — don't roll a parallel sender |
| `NumericKeypad` + `PinSheet` | `src/components/pos/` | v0.5.2 stock-in qty input + v0.5.3 manager admin PIN gates |
| `useApproval` hook + `ApprovalPending` overlay | v0.4 surface | v0.5.1 refund flow's "waiting for manager" UI reuses these |
| `effectiveStatus(row)` helper (to be built in v0.5.0) | `convex/approvals/lib.ts` (proposed) | Every refund/approval read path in v0.5.1 + v0.5.3 dashboard |
| `RootLayout` + nav shell (v0.5.0) | `src/components/layout/` | Every new route in v0.5.1–v0.5.3 plugs into it (this is the prereq) |

### Potential duplication risks

- v0.5.3 manager dashboard will be tempted to write its own transaction-list query rather than reusing v0.5.2 history queries. Plan must require: dashboard reuses `transactions.public.list*` queries from history, with manager-scope filter as an arg.
- Receipt-config UI in v0.5.3 will be tempted to duplicate `pos_settings` access patterns from v0.4. Plan must require: extend existing `settings/public.ts`, don't create a parallel module.

---

## 6. Phase / Wave Accuracy

### Recommended cut (revised from proposal)

| Slice | Identity | Backend | Frontend | Cross-cutting |
|-------|----------|---------|----------|---------------|
| **v0.5.0 Foundation** | App shell + session ergonomics + v0.4 stabilizers | All ~10 carry-over items (PROGRESS.md:790–799,822,823) + per-token PIN cap + ESLint idempotency rule + effectiveStatus helper | Nav shell (cohesive nav strategy) + Lock route + Lock-resume-on-prev-staff UX | RouteError shared component (moved up from v1.0 because nav shell needs it) — optional |
| **v0.5.1 Refunds + Receipts** | Close the v0.3 sale loop, customer-facing | `pos_refunds` schema + `refunds.ts` + new approval kind `refund` (4-touchpoint pattern) + `pos_receipt_counters` + receipt token gen + public receipt query | `routes/refund/[txnId].tsx` + `routes/receipt/[receiptNumber].tsx` + `lib/receipt-template.ts` (hardcoded template) | ADR-008 honored + receipt-after-refund display contract documented in spec + `rp()` negative-amount handling |
| **v0.5.2 Stock** | Inventory ops on top of existing v0.3 schema | `stock.ts` mutations (stock-in / adjust against existing `pos_stock_movements`) + neg-stock reconciliation queries | `routes/stock.tsx` + `routes/stock/in.tsx` (NumericKeypad qty) | ADR-018 reconciliation tools |
| **v0.5.3 Manager Ops + Settlements** | Replace Convex dashboard reliance + close settlement risk | `dashboard.ts` (queries reuse history) + `staff.ts` updates (resetPin, deactivate, update, strip pin_hash) + products CRUD + `settings.ts` extensions for receipt config + `settlements.ts` (Xendit settlement webhook + nightly recon) | `routes/mgr/dashboard.tsx` + `routes/mgr/products.tsx` + `routes/mgr/receipt.tsx` (ReceiptConfig) + `routes/mgr/staff.tsx` + `routes/settlements.tsx` | History queries reused by dashboard (no duplication) |

### Ordering issues

- **Foundation MUST ship first.** Nav shell is a stated prerequisite (PROGRESS.md:814: *"Define the shell here BEFORE building the v0.5 screen set so screens aren't each retrofitted"*).
- **Refunds+receipts MUST ship before manager dashboard** (dashboard surfaces refunds; building dashboard against missing refund data invites placeholder cruft).
- **Stock and Refunds+receipts have no hard dep on each other.** Could swap 1↔2 if business priorities shift.

### Missing phases

None at this cut. Settlements is now explicit, lock/handoff is relocated, receipt config is deferred to admin.

---

## 7. Specialist Agent Recommendations

(Per-slice plans will assign agents per task; this is the slice-level recommendation.)

| Slice | Primary agent | Why |
|-------|---------------|-----|
| v0.5.0 Foundation | `frontend-integrator` (nav + lock) + `convex-expert` (stabilizers + ESLint rule) | Split work cleanly between FE shell and BE hygiene; can parallelize |
| v0.5.1 Refunds + Receipts | `convex-expert` lead, `ui-component-builder` for receipt template + refund route | New schema + approval kind = backend-led; receipt template is design-grade FE |
| v0.5.2 Stock | `convex-expert` for mutations, `frontend-integrator` for routes | Schema exists, mostly business logic + form UIs |
| v0.5.3 Manager Ops + Settlements | `convex-expert` (settlements webhook + dashboard queries), `ui-component-builder` (dashboard UI is laptop-first → different breakpoints) | Settlements is Xendit-integration-grade; dashboard is layout-grade |

`code-reviewer` should run on every slice before merge. `feature-dev:code-architect` not needed at this stage — per-slice scope is small enough.

---

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Per-slice feature branch (e.g., `feat/v0.5.0-foundation`) | ⚠️ to be defined in per-slice plans — follow v0.4 pattern (`feat/v0.4-telegram-approval`) |
| Branch naming follows v0.3/v0.4 convention | ✅ pattern is established |
| Merge strategy | ✅ squash-merge per PR (matches v0.2→v0.4 history) |

### Commit checkpoints

Each slice's per-task plan should commit at natural boundaries (matches v0.4's commit cadence — see git log `883be7f`, `db125d3`, `86942fa`, etc., one commit per backend task ID). v0.5 should keep this.

### Pre-push verification

Per CLAUDE.md the standard commands are:
- `npm run typecheck`
- `npm run build`
- `npx vitest` (test suite — currently 288 tests post-v0.3, growing in v0.4)

Each per-slice plan must require all three before push. The v0.4 plan does this; v0.5 plans must inherit.

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ atomic commits per task → `/gsd-undo`-friendly (project pattern) |
| Deployment order | ⚠️ each slice's plan must explicitly sequence: schema → backend → frontend (per WORKFLOW.md) |
| Data backup needed | ⚠️ v0.5.1 adds `pos_refunds` (additive, safe), v0.5.3 adds `settlements` (additive, safe). No destructive migrations expected. |
| Migration safety | ✅ all v0.5 schema changes are additive |

**Note:** Per the v0.3 PROGRESS update, **prod cutover is deferred to v1.0**. All v0.5 slices ship to dev (`helpful-grasshopper-46`) only. Confirm this in every per-slice plan to prevent accidental `npx convex deploy --prod` during v0.5.

---

## 9. Documentation Checkpoints

| Slice | Docs to update |
|-------|----------------|
| v0.5.0 | CLAUDE.md (file locations: nav shell, lock route, `lib/effectiveStatus`); SCHEMA.md (no new tables but mention effectiveStatus virtual); CHANGELOG.md; v0.4 stabilizer audits in audit-source docs |
| v0.5.1 | CLAUDE.md (refund flow → new business rule; receipt URL contract); SCHEMA.md (`pos_refunds`, `pos_receipt_counters`); ADR-008 honored (reference, not new); new ADR for receipt-after-refund display contract if a non-obvious choice is made; CHANGELOG.md |
| v0.5.2 | CLAUDE.md (file locations: `stock.ts`); SCHEMA.md audit enum (`stock.*`); CHANGELOG.md |
| v0.5.3 | CLAUDE.md (manager portal routes, settlements module); SCHEMA.md (`pos_settlements` table); SCHEMA.md audit enum (`settings.*`, `settlement.*`); CHANGELOG.md; possibly new ADR for settlement webhook integration |

### CHANGELOG draft (top-level v0.5 entry, written when last slice ships)

```markdown
## v0.5 — Operational completeness (multi-PR cycle)

Shipped as four sub-phases:
- **v0.5.0** App shell + session ergonomics + v0.4 stabilizers — nav shell, lock+handoff, per-token PIN cap, ESLint idempotency rule, effectiveStatus helper
- **v0.5.1** Refunds + customer-facing receipts — ADR-008 honored, new `refund` approval kind, public `/r/:n` route
- **v0.5.2** Stock-in + stock-check + neg-stock reconciliation — built on v0.3's pos_stock_movements
- **v0.5.3** Manager dashboard + in-app staff/products admin + Xendit settlements reconciliation — closes the v1.0 settlement-risk register item
```

---

## 10. Testing Plan Assessment

**Verdict:** **Insufficient at decomposition level — must be Adequate at per-slice spec level**

The decomposition itself has no test plan because it's structural. The per-slice plans must each include:

### Per-slice testing requirements (mandatory in spec)

| Slice | Required test coverage |
|-------|------------------------|
| v0.5.0 | Nav shell smoke (every route navigable); Lock-and-resume round-trip; each carry-over bug has a regression test; ESLint rule has fixture-based tests (positive + negative); effectiveStatus helper has unit tests covering all status × time combos |
| v0.5.1 | Refund-as-new-row (paid txn status NEVER mutated — assertion test); refund Telegram approval round-trip; receipt URL pre-refund + post-refund; receipt cache invalidation on refund; signed URL forgery rejection; receipt counter monotonic + no gaps under concurrent commits |
| v0.5.2 | Stock-in increments level + writes movement; stock-out on sale writes signed-negative movement; neg-stock reconciliation surfaces flagged txns; reconciliation idempotent |
| v0.5.3 | Dashboard query reuses history queries (don't allow duplication — a test that asserts the query handler is shared); settlement webhook signature verification; nightly recon idempotent; staff CRUD strips pin_hash from response |

### Regression risk

- v0.5.0 nav shell changes touch every route — must run full E2E smoke (v0.4 has manual smoke; v0.6 adds Playwright per PROGRESS.md:97).
- v0.5.1 changes `transactions/public.ts` (history queries) — verify v0.3 sale flow still passes.
- v0.5.3 settlements is a NEW Xendit webhook endpoint — verify v0.3 QRIS/FVA webhooks still verify signatures correctly (no auth-header collision).

---

## 11. Edge Cases to Address (per slice spec must enumerate)

- [ ] **v0.5.0:** lock-then-power-cycle → resume should still pre-select last staff
- [ ] **v0.5.0:** nav shell on `/r/:n` public receipt route — should NOT render staff nav (different layout shell)
- [ ] **v0.5.1:** partial refund (subset of lines) — receipt display contract
- [ ] **v0.5.1:** double-refund attempt (refund already exists for txn) — block with clear error
- [ ] **v0.5.1:** refund Telegram approval denied — staff UI returns to refund form, no half-state
- [ ] **v0.5.1:** receipt token brute-force — token must be long enough + signed
- [ ] **v0.5.2:** stock-in for archived SKU — block or allow?
- [ ] **v0.5.2:** negative stock-in (correction) — allowed with reason?
- [ ] **v0.5.3:** settlement webhook for unknown invoice id — log + 200 (don't 500-retry-storm Xendit)
- [ ] **v0.5.3:** manager dashboard timezone — must use WIB (Asia/Jakarta) consistently per `convex/lib/time.ts`

---

## 12. Approval Conditions

**To approve the cut and start writing per-slice plans:**

1. **Accept Critical 1:** move lock/handoff into v0.5.0 foundation
2. **Accept Critical 2:** v0.5.1 spec will lock the receipt-after-refund display contract before code
3. **Accept Critical 3:** receipt-config UI moves to v0.5.3, v0.5.1 ships hardcoded template

**Recommended before writing per-slice specs:**

1. Accept Improvement 1: rename v0.5.3 to "Manager Ops + Settlements"
2. Accept Improvement 3: commit to sequence 0 → 1 → 2 → 3
3. Accept Improvement 4: per-slice plan size cap at ~v0.4 baseline (~2000-line plan, ~20 tasks)

---

## 13. Recommended Cut — TL;DR

```
v0.5.0  Foundation
        ├─ Nav shell (PREREQ — stated in PROGRESS.md)
        ├─ Lock + resume-on-prev-staff UX            [moved from v0.5.1]
        ├─ All ~10 v0.4 stabilization carry-overs
        ├─ Per-token failed-PIN cap (security)
        ├─ ESLint rule: public mutations need idempotencyKey
        └─ effectiveStatus(row) helper

v0.5.1  Refunds + Receipts (sale-loop closure, customer-facing)
        ├─ pos_refunds + refunds.ts + new "refund" approval kind
        ├─ Public /r/:n receipt route + signed URL + counter
        ├─ Hardcoded receipt template                [config UI deferred to v0.5.3]
        └─ Receipt-after-refund display contract     [must lock in spec]

v0.5.2  Stock
        ├─ Stock-in / stock-adjust mutations (on existing pos_stock_movements)
        ├─ /stock + /stock/in routes
        └─ ADR-018 neg-stock reconciliation tools

v0.5.3  Manager Ops + Settlements
        ├─ Manager dashboard (laptop-first)
        ├─ In-app staff CRUD + listStaff pin_hash strip
        ├─ In-app products CRUD
        ├─ Receipt config UI                         [moved from v0.5.1]
        └─ Xendit settlements reconciliation         [load-bearing for v1.0]
```

**Sequence:** 0 → 1 → 2 → 3
**Per-slice plan budget:** ~v0.4 baseline (~2000-line plan, ~15–20 tasks)
**Per-slice branch:** `feat/v0.5.X-<slice-slug>`

---

*Generated by /staffreview*
