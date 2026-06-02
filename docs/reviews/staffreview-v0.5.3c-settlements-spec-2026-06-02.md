# Staff Review: v0.5.3c — Settlements (design spec)

**Date:** 2026-06-02
**Plan:** `docs/superpowers/specs/2026-06-02-v0.5.3c-settlements-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated *as a design spec* — wave breakdown, per-task Task IDs, and commit checkpoints are correctly deferred to `/superpowers:writing-plans` (the spec says so in Open Items; this is the spec→plan pipeline, not a self-contained plan).

---

## 1. Summary

**Overall Assessment: Approve (with Improvements).**

Strong, well-researched spec. The central risk — that the phase's premise ("Xendit settlement webhook") was a speculative assumption — was caught and corrected with live doc verification, captured durably in `docs/xendit-reference/`, and de-risked with an explicit plan-time verification gate (mirroring the ADR-036 pattern). Every load-bearing helper it names was verified to exist with the cited signature (see §5). **No Critical issues.** The Improvements are about pinning two semantics the poll-model changes (`payload` meaning; the on-demand action's auth/idempotency mechanism), one reuse opportunity (the v0.5.3a windowed reader), and one schema-doc consistency fix.

All grounding checks ran against real code at `origin/main` @ 908549e.

## 2. Critical Issues (Must Fix)

None. The one genuine risk (unverified `GET /transactions` field/param shape) is already explicitly flagged in the spec as asserted-not-verified with a plan-time verification gate + a single normalize choke-point — handled exactly as ADR-036 handles the BCA VA FVA callback shape.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | `payload` field semantics under the poll model | M | L |
| I2 | `syncSettlementsNow` action auth + idempotency mechanism under-specified | M | L |
| I3 | Reconciliation reader should reuse the v0.5.3a windowed paid-txn reader | M | L |
| I4 | `bca_account_destination` optionality vs SCHEMA.md current type | L | L |

### Improvement I1: `payload` semantics change under the poll model
SCHEMA.md:520 defines `pos_settlements.payload` as "Raw Xendit payload JSON" — a notion that assumed a **single settlement-webhook object**. Under the poll model there is no single object; a row is an **aggregate of many settled transactions** for a `settlement_date`. Left as-is, `payload` is either a dead write or an ambiguous field (the v0.5.2 "schema field without a consumer is a dead write" lesson).

**Recommendation:** redefine `payload` as the **contributing-transaction snapshot** for the day — the array of `{ reference_id, amount, fee }` (or the raw normalized subset) that produced the aggregate — so it serves debugging + the reconciliation join and has a real consumer. Document the redefinition in SCHEMA.md. For `source:"manual"` rows, `payload` is absent/empty.

### Improvement I2: the on-demand `syncSettlementsNow` action — auth + idempotency
The spec marks it "manager-session" + "action-level idempotency pre-check (resetStaffPin/refund pattern)" but doesn't pin the mechanism, and the mechanism is **not** the mutation one. Verified in `convex/auth/actions.ts`: actions assert sessions via `ctx.runQuery(api.auth.public.getSession, { sessionId })` + a role check (`actions.ts:74,193,271`) — they **cannot** call `requireManagerSession` (no `ctx.db` in an action ctx), and they **cannot** use `withIdempotency` (a mutation-handler wrapper). Action-level idempotency is a manual `ctx.runQuery(internal.idempotency.internal._lookup_internal, …)` pre-check (`actions.ts:63,185`).

**Recommendation:** specify that `syncSettlementsNow` (a) resolves the session via `getSession` + asserts `role === "manager"` (throwing otherwise), and (b) relies primarily on the **idempotent upsert-by-date writer** for replay safety (a double-tap re-aggregates identical data — no cache strictly required), optionally with the `_lookup_internal` pre-check for parity. Consider **deferring "Sync now" entirely** (Refinement R-defer below) since the nightly cron + manual entry cover the core, and the button adds an auth surface for marginal benefit.

### Improvement I3: reuse the v0.5.3a windowed paid-txn reader
The reconciliation join needs the booth's `paid` `pos_transactions` over a window to classify settled/pending/unmatched. v0.5.3a already shipped `transactions/internal.ts::_fetchDayWindow_internal` (role-neutral windowed read over `by_status_created`, status `paid`). The spec says "cross-module reads via `_internal`" but doesn't name the reuse, risking a fresh near-duplicate reader (the v0.5.3a "collapse two internals running identical SQL" lesson, in reverse).

**Recommendation:** reconciliation should **reuse / extend** `_fetchDayWindow_internal` (or factor a shared `_fetchPaidTxnsInWindow_internal` if the settlement window spans multiple WIB days) rather than write a new foreign-table scan. Name it in the spec so the plan threads it.

### Improvement I4: `bca_account_destination` optionality
The spec makes it `v.optional(v.string())` (cron rows leave it undefined until configured), but SCHEMA.md:519 currently types it non-optional (`string`, "Last 4 digits for verification"). This is a real change to the documented shape.

**Recommendation:** the SCHEMA.md update must change it to `string?` and document the "cron leaves undefined unless a `pos_settings` last-4 is configured; manual rows may set it" behavior — so the schema doc and the implementation agree (the v0.5.3a "schema-literal vs return-type" hygiene).

## 4. Refinements (Optional)

- **R1 — integer-rupiah guard at normalize.** IDR has no cents; `fetchSettledTransactions`' normalize step should assert/round `amount` and `fee` to integer rupiah (rule #14) so a stray decimal from the API never reaches the aggregator.
- **R2 — pin the `settlement_date` label format.** Fix it to ISO `YYYY-MM-DD` in WIB and make it the single dedup key shared by the cron, the upsert, and the view's date display (the v0.5.3a clock-invariant discipline) — so "the day Xendit settled" is unambiguous across producer and reader.
- **R3 — name the skip audit verb.** Replace "or reuse the foundersSummary idiom" with a concrete verb, e.g. `settlement.sync_skipped`, documented in SCHEMA.md alongside `settlement.synced` + the new `settlement.recorded`.
- **R-defer — consider dropping "Sync now"** (see I2): cron + manual entry are the core; the on-demand re-poll is the most droppable surface.

## 5. Duplication Analysis

### Existing code to leverage (all verified present)
| Code | Location | How to use |
|------|----------|------------|
| `requireManagerSession` → `{ staffId }` | `convex/auth/sessions.ts:24` | authCheck for `recordSettlement` (mutation) |
| `getSession` + role check | `convex/auth/public.ts` via `ctx.runQuery` (`auth/actions.ts:74`) | manager assert for `syncSettlementsNow` (action) |
| `withIdempotency<A,R>("ns.fn", handler, authCheck)` | used at `refunds/public.ts:185` | wrap `recordSettlement` exactly like `markRefundSettled` |
| `markRefundSettled` (session, idempotent, audited mutation) | `refunds/public.ts:179` | structural template for `recordSettlement` (Q3 precedent) |
| `sendFoundersSummaryResilient` + `cronRetry` | `telegram/foundersSummary.ts`, `lib/cronRetry.ts` | resilient-cron template for `settlement-recon` |
| `_lookup_internal` (action idempotency) | `idempotency/internal.ts` via `auth/actions.ts:63` | optional action-level pre-check |
| `_fetchDayWindow_internal` (windowed paid read) | `transactions/internal.ts` (v0.5.3a) | reconciliation reader (I3) |
| `authHeader()` (Basic auth, Buffer) | `payments/xendit.ts:34` | reused by `fetchSettledTransactions` |
| `reference_id`/`receipt_id` join keys | `pos_xendit_invoices` (`payments/schema.ts:14`) | settled-txn ↔ pos_transaction match |

### Potential duplication risks
- A fresh windowed paid-txn reader instead of reusing `_fetchDayWindow_internal` (I3).
- A second "settlement" `source` enum colliding conceptually with `pos_refunds.settlement_status` — the spec's Naming Guard already fences this; keep enums unshared.

## 6. Phase / Wave Accuracy

Waves intentionally deferred to `/superpowers:writing-plans` (correct for a spec). The implied natural ordering — (1) schema + `lib.ts` pure aggregators, (2) adapter `fetchSettledTransactions` + internal writer/reader, (3) cron + actions, (4) public queries/mutation, (5) `/settlements` view + reconciliation detail, (6) ADR-043 + docs — is sound and matches the v0.5.3a/b cadence. The plan should mark waves 1–2 PARALLEL-friendly (pure lib has no deps) and the view SEQUENTIAL after the queries.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Backend (module, cron, adapter) | `convex-expert` | Convex action/mutation/cron + deep-module patterns |
| Frontend (`/settlements` view) | `frontend-integrator` / `ui-component-builder` | wire read-only list + reconciliation detail to queries |
| Post-write plan check | `staffreview` (gate 2) | verify the `GET /transactions` shape + flagged assumptions against real responses |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ `worktree-spec+v0.5.3c` (spec/plan artifacts); impl branch cut at execute time |
| Merge strategy | ✅ squash-PR (repo convention) |
| Pre-push verification | ✅ typecheck + build + lint in success criteria |
| Rollback strategy | ✅ additive table/module/cron → revert commits + drop cron; inert dangling table |
| Deployment order | ✅ backend (`convex deploy`) before frontend (Vercel); no new env var (`XENDIT_SECRET_KEY` already set) |
| Migration safety | ✅ additive optional fields, no destructive migration |

Commit checkpoints (for the plan): per-wave atomic commits (`feat(settlements): …`), ADR-043 + SCHEMA/CHANGELOG in the same PR.

## 9. Documentation Checkpoints

| Item | Update |
|------|--------|
| `docs/ADR/043-*.md` | **new** — no-settlement-webhook finding, poll-cron + manual-fallback mechanism, manager-session gate, live-unverified-pending-KYB; supersedes foundations §7 / ADR-012 *mechanism*, preserves ADR-012 visibility |
| `docs/ADR/000-strategic-foundations.md` §7 | annotate "settlement webhook" as superseded by ADR-043 |
| `docs/ADR/012-*.md` | annotate ingress-mechanism superseded (visibility intact) |
| `docs/SCHEMA.md` | `pos_settlements`: `source`, `updated_at`, `created_by`; `bca_account_destination` → optional (I4); `payload` redefinition (I1); synthesised `xendit_settlement_id` note; verbs `settlement.recorded` + `settlement.sync_skipped` |
| `docs/CHANGELOG.md` | v0.5.3c entry |
| `docs/PROGRESS.md` | flip 🗂️ settlement items → done at execute time + `v053c-*` Task IDs |
| `docs/xendit-reference/settlement-reconciliation.md` | ✅ already created this session |

## 10. Testing Plan Assessment

**Verdict: Adequate.** The spec scopes pure-`lib.ts` unit tests (aggregators + `reconcileDay`), adapter query-builder + fixture-normalize tests, integration tests (upsert-by-date no-dup, gate tiers incl. staff-can-read per ADR-012, idempotency), and a behavioural pass — with **no live Xendit dependency in CI** (KYB-blocked + good hygiene). This matches the money/reconciliation-surface bar in "How to add a feature" #7.

### Must-add (fold into the plan)
| # | Missing test | Why | Approach |
|---|--------------|-----|----------|
| 1 | `reconcileDay` **unmatched both directions** | the risk-closer is "collected but not settled" — test a settled Xendit ref with no POS txn AND a POS paid txn Xendit never returned | fixture arrays |
| 2 | integer-rupiah exactness on aggregate (R1) | float drift on money is a rule-#14 violation | known-value fixtures incl. odd `fee` |
| 3 | `listSettlements` returns rows for a **staff** session (ADR-012) | the easy regression is to over-gate it manager-only | convex-test with a staff session |
| 4 | cron upsert + concurrent manual row on same date | supersede policy (Open Item) must be asserted once chosen | integration |

(convex-test config per the project's edge-runtime + `server.deps.inline` setup — already established.)

## 11. Edge Cases to Address

- [ ] Empty poll window (no settled txns) → cron writes nothing, audited as a clean run, no error.
- [ ] `EARLY_SETTLED` transactions — does the cron include them as settled? (Spec filters `SETTLED`; decide whether `EARLY_SETTLED` also counts — it is money in the balance.) **Flag for plan.**
- [ ] A `settlement_date` spanning a partial set early in the day, then more txns settle later → upsert refines the same row (covered by upsert-by-date + lookback).
- [ ] Manual row then cron supersede (or vice-versa) on the same date — policy in Open Items.
- [ ] Pagination not followed to completion → silent under-count (the spec's "follow pagination to completion" must be tested/asserted).
- [ ] `bca_account_destination` absent on cron rows → view renders gracefully (—/blank), no crash.

## 12. Approval Conditions

**To approve:** nothing blocking (no Criticals).

**Recommended before writing the plan (address inline in the spec):**
1. I1 — redefine `payload` as the contributing-txn snapshot.
2. I2 — specify `syncSettlementsNow` auth (`getSession`+role) + idempotent-upsert reliance; decide keep-vs-defer.
3. I3 — name the reuse of `_fetchDayWindow_internal` for reconciliation.
4. I4 — `bca_account_destination` → optional, reconcile with SCHEMA.md.
5. R1–R3 — integer guard, date-label format, concrete skip verb.
6. Add the `EARLY_SETTLED` inclusion question to Open Items.

---

*Generated by /staffreview*
