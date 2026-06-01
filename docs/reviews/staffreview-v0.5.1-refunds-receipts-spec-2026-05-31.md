# Staff Review: v0.5.1 Refunds + Customer Receipts (design spec)

**Date:** 2026-05-31
**Plan:** `docs/superpowers/specs/2026-05-31-v0.5.1-refunds-receipts-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (spec is design-doc shape, not executable-plan shape — file-changes and phases are present at the right level for a spec; the executable PLAN.md is the next deliverable and will be reviewed separately)

---

## 1. Summary

**Overall Assessment:** **Revise** (3 Critical, 6 Improvements). Spec is comprehensive and the brainstorm work paid off: the 8 Q&A answers + ADR-038/039 + ADR-040 outline give the design real teeth. The Criticals are all small, mechanical fixes that surface from grounding the abstract spec against actual schema and existing helpers. Address them inline; then proceed to writing-plans.

The two highest-leverage findings: **(C1)** `refunded_qty` must be `v.optional` or have a backfill migration before it can land — Convex schemas reject required-field additions on existing rows. **(C2)** receipts module reading refunds[] directly would violate ADR-034 — must route through `refunds/internal._listForTransaction_internal`.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | `refunded_qty: v.number()` schema change will fail validation on existing rows | Schema / migration | Spec §"Data model" + §"Field additions" |
| C2 | Receipts module reading refunds[] is a cross-module read — must go via refunds/internal per ADR-034 | Architecture / module boundary | Spec §"Customer loads `/r/<token>`" + §"Data flow" |
| C3 | Missing test coverage: dedup guard, send-failure retry, `refund.requested` audit, settle-idempotency, recent-list cutoff | Testing | Spec §"Testing strategy" |

### C1: `refunded_qty: v.number()` schema migration

The spec says `pos_transaction_lines.refunded_qty: v.number()` with "default 0". Convex schemas **do not have field defaults**. Adding a required `v.number()` field to an existing table will fail validation on all pre-existing rows (every line shipped by v0.3-v0.5.0.1 lacks this field).

Two acceptable approaches:
1. **`v.optional(v.number())`** in the schema; everywhere we read it, treat `undefined` as 0. Mirrors the `receipt_number`/`receipt_token` pattern already in use. Simplest; no migration step.
2. **Backfill migration first.** Add an internal action that patches every existing `pos_transaction_lines` row with `refunded_qty: 0`, run it, THEN add the required field. Two-step deploy with an inconsistent intermediate state — riskier and operationally heavier.

**Recommendation:** option 1. Update the spec data model to read:
```ts
pos_transaction_lines {
  refunded_qty: v.optional(v.number()),  // undefined treated as 0
}
```
And specify the helper `lineRefundedQty(line: Doc<"pos_transaction_lines">) = line.refunded_qty ?? 0` used everywhere `refunded_qty` is read.

### C2: Cross-module read for refunds[] inside receipts/_renderReceipt_internal

The spec's data-flow for `/r/<token>` says:
> `call _renderReceipt_internal(txn) → reads pos_settings, txn, lines, voucher, refunds[]`

If `_renderReceipt_internal` (owned by `receipts/`) reads `pos_refunds` (owned by `refunds/`) via `ctx.db.query("pos_refunds")` directly, that's an ADR-034 violation — the same class of violation the lint rule `no-cross-module-db-access` is designed to catch. (See `eslint.config.js` OWNERSHIP map — `pos_refunds` will be added there mapped to `refunds`.)

**Recommendation:** add to the spec, explicitly:
- `convex/refunds/internal.ts` exports `_listForTransaction_internal(ctx, { transaction_id })` returning the refund rows for a txn.
- `convex/receipts/internal.ts` `_renderReceipt_internal` calls it via `ctx.runQuery(internal.refunds.internal._listForTransaction_internal, { transaction_id })`.
- Add `pos_refunds: "refunds"` to `eslint.config.js` OWNERSHIP map in PR B.

This is a small spec edit but a load-bearing architectural commitment.

### C3: Missing test coverage in the spec's testing section

The testing section is broadly thorough but misses these specific tests that the design behaviour depends on:

1. **Dedup guard:** test that two back-to-back `requestRefundApproval` calls for the same txn return the same `requestId` and only send one Telegram message. Without this test, a regression that drops the dedup guard silently allows duplicate-card spam.
2. **Send-failure retry:** test that if `sendTemplate` throws, the pending request row is deleted so the next attempt mints fresh. Inherits v0.4 pattern; must be re-tested for the refund kind because the cleanup is in the action layer.
3. **`refund.requested` audit verb:** test that initiating a Telegram-approval refund writes a `refund.requested` audit row. Mirrors v0.4 `manual_payment_override.requested` test pattern.
4. **Settle idempotency:** test that calling `markRefundSettled` on an already-settled refund returns the existing `{settled_by, settled_at}` (idempotent), not double-stamps.
5. **Recent-list cutoff:** test that `/refund/index` `listTodaysRefundable` query only returns txns where `paid_at >= today-since-00:00-WIB` — the Q1=B contract. Without a test, a regression that widens or narrows the window goes unnoticed.

**Recommendation:** add these 5 to the §"PR B refund subsystem tests" file list. Each is ~10 lines of test code.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | Pin down the source schema fields for ADR-040 math (`txn.total`, `txn.subtotal`, `line.line_subtotal`) | M | L |
| I2 | Receipt renderer should require `status ∈ {paid, partial_refund, refunded}` | M | L |
| I3 | Reuse `randomBytes(32).toString("base64url")` helper from `approvals/actions.ts:71` for receipt_token | L | L |
| I4 | Reference `convex/lib/time.ts` WIB helpers explicitly for datetime formatting | L | L |
| I5 | Cache purge: prefer assertion-with-context over silent no-op when token is undefined | L | L |
| I6 | Lazy-mint helper: spec must note callers MUST auth-gate (helper has no internal gate) | M | L |

### I1: Pin down the source schema fields for ADR-040 math

The spec describes the math using generic names (`paid_total`, `subtotal_pre_voucher`, `line_total`). Grounding in actual schema:

| ADR-040 name | Schema field |
|---|---|
| `paid_total` | `pos_transactions.total` |
| `subtotal_pre_voucher` | `pos_transactions.subtotal` |
| `line_total` | `pos_transaction_lines.line_subtotal` |
| `line.qty` | `pos_transaction_lines.qty` |
| `refund_qty` | the `qty` field on `pos_refunds.lines[i]` |

**Recommendation:** add a 2-line table to the spec's "Data model" section pinning these so the math helper signature is unambiguous: `computeRefundAmount(line: Doc<"pos_transaction_lines">, txn: Doc<"pos_transactions">, refundQty: number): number`.

### I2: Receipt renderer should require paid-status

The httpAction loads the txn by `receipt_token` but the spec doesn't say what happens if `txn.status === "draft"` or `"awaiting_payment"` or `"cancelled"`. Shouldn't happen by design (tokens are minted at `_confirmPaid`), but defence-in-depth matters here — a manual DB patch or a future bug could create the inconsistency.

**Recommendation:** spec says httpAction returns 404 if `txn.status ∉ {"paid"}` (note: per ADR-008 the status is "paid" on read; "partial_refund" and "refunded" are computed, not stored). Or: pass through if stored `status == "paid"` and let the renderer project the computed status.

### I3: Reuse existing token-mint pattern

`convex/approvals/actions.ts:71` already does `randomBytes(32).toString("base64url")`. Receipt token minting in `convex/transactions/internal._confirmPaid` should call the same pattern (or import a shared helper from `convex/lib/`).

**Recommendation:** add to spec: "Token minting reuses `randomBytes(32).toString('base64url')` from `node:crypto`; if used in more than 2 places (approvals + transactions), extract to `convex/lib/tokens.ts` `mintUrlSafeToken(bytes = 32)`."

### I4: WIB timezone helpers

The spec says "datetime in WIB regardless of server tz" but doesn't reference the existing `convex/lib/time.ts` (per CLAUDE.md `convex/lib/` map). Tests will fail in mysterious ways if the receipt template hand-rolls WIB offset arithmetic.

**Recommendation:** spec template-render section reads "datetime formatted via `formatWibTime(epochMs)` from `convex/lib/time.ts` (or extend `time.ts` with the formatter if absent)".

### I5: Cache purge assertion vs silent no-op

Spec says `_purgeReceiptCache_internal` no-ops when token undefined. In v0.5.1 this code path should be unreachable (only paid txns have tokens, and only refunds-of-paid-txns invoke the purge). A silent no-op masks bugs; an assertion surfaces them.

**Recommendation:** the helper should throw with context: `throw new Error("PURGE_NO_TOKEN — refund commit on txn ${txnId} without receipt_token; investigate _confirmPaid token-mint")`. Add a unit test that asserts the throw on the malformed input.

### I6: Lazy-mint helper auth-gate

Spec says `_lazyMintReceiptToken_internal` is dormant in v0.5.1, callable from a future v0.5.3 surface. The helper itself doesn't gate (it's an internal function). The spec must explicitly note the caller's responsibility, OR the helper itself takes an `actor` arg that it audits.

**Recommendation:** add to spec: "`_lazyMintReceiptToken_internal({ txnId, actor })` records the actor in an audit row (`receipt.token_minted`) so post-hoc auditing can trace which staff session triggered the mint. v0.5.3 surface caller must pass a `staffId` from a verified session."

## 4. Refinements (Optional)

- **R1:** Document PR-A-revisit rebase strategy for PR B (if PR A needs post-merge fixes mid-flight on PR B, what's the rebase protocol?).
- **R2:** Document rollback caveat for PR A — if reverted post-merge, `/r/<token>` 404s for tokens already minted. Acceptable since tokens have no public meaning without the route; worth a one-line CHANGELOG note.
- **R3:** Consider drafting ADR-040 on main BEFORE PR B starts (rather than as PR B's first commit). Removes the chicken-and-egg of "the unit test references the ADR that lives in the same commit". Marginal benefit since the squash hides the order, but cleaner provenance.
- **R4:** Spec uses `convex/refunds/lib.ts` for the ADR-040 helper. Convention in the rest of the codebase varies (`approvals/lib.ts` exists, `auth/sessions.ts` exists). Lock the location explicitly so the plan-writer doesn't dither.

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| `randomBytes(32).toString("base64url")` | `convex/approvals/actions.ts:71` | Pattern for `receipt_token` mint at `_confirmPaid` |
| `sha256Hex(rawToken)` | (used in approvals — likely `convex/lib/` or inline) | Not needed for receipts (token IS the lookup key, not a hash) |
| `formatIdr` | `convex/lib/telegramHtml.ts` | Telegram refund template `total_refund` formatting |
| `wibDayWindow` / time helpers | `convex/lib/time.ts` | Receipt template datetime; `listTodaysRefundable` cutoff |
| `rp()` | `src/lib/format.ts` | Receipt template + refund form rupiah formatting |
| `_findPendingRequest_internal` | (assumed to exist — verify) `convex/approvals/internal.ts` | Refund dedup guard |
| `denyRequest` (kind-agnostic) | `convex/approvals/actions.ts` | Refund denial — no new code needed |
| `_markNotified_internal`, `_markResolved_internal`, `_markDeniedBySystem_internal`, `_createRequest_internal` | `convex/approvals/internal.ts` | Refund approval lifecycle |
| `NumericKeypad` | `src/components/pos/NumericKeypad.tsx` | Refund qty stepper (Q7=A) |
| `PinSheet` | `src/components/pos/PinSheet.tsx` | Inline mgr-PIN flow |
| `ApprovalPending` | `src/components/pos/ApprovalPending.tsx` | Refund variant |
| `useApproval` hook | `src/hooks/useApproval.ts` | Refund approval status subscription |
| `requireManagerSession` | `convex/auth/sessions.ts` | `markRefundSettled` authCheck (NOT PIN per ADR-038) |
| `withIdempotency`, `authCheck` pattern | per CLAUDE.md §rule 21 | Every public mutation |

### Potential duplication risks

- **Token-mint logic** could duplicate between approvals and transactions if not extracted to `convex/lib/tokens.ts`. See I3.
- **Receipt rendering** is genuinely new; no existing template engine in the codebase to reuse.
- **Refund line composition** (turning `[{line_id, qty}]` into stock-movement deltas) mirrors how `commitCart` writes stock movements — review `convex/transactions/public.commitCart` to see if a helper can be lifted.

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| Pre-work: ADR-040 draft on main | Refinement (R3) — defensible either way | Currently spec'd as first-commit-of-PR-B |
| PR A: receipts | Good | Self-contained; ships standalone deliverable; ~8-10 plan tasks |
| PR B: refunds | Good | Builds on PR A; ~15-20 plan tasks. Largest risk: cross-module coupling in receipts/_renderReceipt_internal (C2 fixes this in spec) |

**Ordering issues:** None at spec level. Plan-level ordering (schema → backend → frontend → tests → docs within each PR) deferred to the plan staffreview.

**Missing phases:** None at spec level.

## 7. Specialist Agent Recommendations

For the executable plan (next step), recommended agents per phase:

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| PR A schema + backend | convex-expert (Convex backend specialist exists in fleet) | Schema design + Convex httpAction + lazy-mint helper |
| PR A frontend | frontend-integrator | Hook + template wiring (light footprint) |
| PR B schema + backend | convex-expert | Refund commit complexity; cross-module via internal |
| PR B frontend | frontend-integrator + ui-component-builder | RefundLineSelector is a new shadcn-style component |
| Reviews | code-reviewer (gsd-code-reviewer or feature-dev:code-reviewer) | Per existing project review patterns |

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branches specified | ✅ `feat/v0.5.1a-receipts`, `feat/v0.5.1b-refunds` |
| Branch naming follows convention | ✅ matches `feat/v0.5.0-foundation`, `feat/v0.5.1-housekeeping` precedent |
| Merge strategy documented | ✅ squash-merge implicit (per project convention, /ship-it default) |

### Commit checkpoints

PR A natural commits (will be expanded in plan):
1. ADR-040 (if drafted ahead per R3) → `docs(adr): add ADR-040 voucher attribution on partial refunds`
2. Schema additions → `feat(schema): add pos_receipt_html_cache + receipt_token field`
3. Receipts module skeleton → `feat(receipts): scaffold module + http route`
4. Token mint on _confirmPaid → `feat(receipts): mint receipt_token at _confirmPaid`
5. Template + render → `feat(receipts): hardcoded receipt template + render`
6. Cache + lazy-mint helper → `feat(receipts): 24h cache + dormant lazy-mint helper`
7. Tests → 3 commits, one per test file
8. Docs → CHANGELOG + SCHEMA + CLAUDE.md updates

PR B natural commits (~25-35 commits planned).

### Pre-push verification

The /ship-it skill (from v0.5.0.1) handles this:
- [x] `npm run lint` in /ship-it Phase 1
- [x] `npm run typecheck` in /ship-it Phase 1
- [x] `npx vitest run` in /ship-it Phase 1

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ⚠️ partial — spec discusses ship cadence but not explicit rollback steps (see R2) |
| Deployment order | ✅ correct — schema added in PR A; PR B builds on it |
| Data backup needed | No (Convex retains history; no destructive migrations) |
| Migration safety | ⚠️ C1 must be fixed — optional fields safe; required fields not |

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| PR A | CHANGELOG (v0.5.1 PR A section), SCHEMA.md (new table + field), CLAUDE.md (new module), API_REFERENCE.md (new receipt functions), ADR/README.md (if ADR-040 in PR A per R3) |
| PR B | CHANGELOG (v0.5.1 PR B section), SCHEMA.md (pos_refunds, refunded_qty, refund.* audit verbs), CLAUDE.md (new module + rule entries for refunds), API_REFERENCE.md (refund + settlement functions), ADR-040 if not done in PR A, PROGRESS.md (task IDs + completion) |

### CHANGELOG draft (skeleton — plan to flesh out)

```markdown
## v0.5.1 — Refunds + customer receipts (unreleased)

### PR A — receipts (ships <date>)
- Every paid sale produces a shareable signed-URL receipt at `/r/<token>` (ADR-021, ADR-022).
- Hardcoded receipt template per ADR-039 §4 (Indonesian, teal, no NPWP yet).
- 24h HTML cache with lazy regenerate; no cron.

### PR B — refunds + settlement (ships <date>)
- Full refund flow: staff initiate, manager approves (inline PIN or Telegram URL+PIN per ADR-035), refund logged as new row (ADR-008).
- Stock re-credited automatically on refund commit (ADR-019). Spoilage flow deferred to v0.5.2.
- Voucher attribution on partial refunds: proportional, floor-rounded (ADR-040).
- Receipt auto-reprojects on refund commit (purge-on-commit per ADR-039); token stays stable.
- Settlement tracked separately (`settlement_status: pending → settled`); manager-session gated, NOT PIN (ADR-038). `/mgr/refunds-pending` is the settlement surface.

### Security
- Refund approval emits `refund.requested` audit on Telegram path; `refund.{committed,denied,settled}` on terminal states.
- All new public mutations: idempotencyKey + withIdempotency + authCheck.
```

## 10. Testing Plan Assessment

**Verdict:** **Insufficient** (3 missing categories per C3). The covered tests are well-specified and the verdict will flip to "Adequate" after the C3 additions land.

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend (PR A) | renderReceipt, http httpAction, cache | convex-test | ✅ planned (3 files) |
| Backend (PR B) | voucher-math, commit, settlement, refund-kind approvals, refund-projection on receipts | convex-test | ✅ planned (5 files) |
| Frontend (PR B) | /refund/index, /refund/[txnId], /mgr/refunds-pending | vitest + RTL | ✅ planned (3 files) |
| Manual | refund flow end-to-end on PWA device | manual | ⚠️ not in spec — should be in plan |

### Missing test coverage (must add)

See C3 — five missing test cases.

### Test execution checkpoints

1. After PR A backend → run `convex/receipts/` tests
2. After PR A docs → full suite + lint + typecheck before /ship-it
3. After PR B backend (per module) → run module's tests
4. After PR B frontend → run `src/routes/refund/` + `src/routes/mgr/` tests
5. Before /ship-it on PR B → full suite + integration (`refund-projection` is the integration headline)

### Regression risk

- v0.5.0.1 558 tests must all still pass. No anticipated breakage; refund + receipts are additive.
- Telegram approval kind tests (v0.4) — adding `refund` to KIND_AUDIT / KIND_TEMPLATE / validateContext shouldn't break existing kind tests, but re-run the full `convex/approvals/__tests__/` suite to confirm.
- Receipt template renders depend on `pos_settings` — re-run any settings tests.

## 11. Edge Cases to Address

- [ ] Receipt token: what if `txn.status` is not `"paid"` when /r/:token is loaded? → I2
- [ ] `refunded_qty` schema migration → C1
- [ ] Cross-module read avoidance → C2
- [ ] Lazy-mint helper auth-gate → I6
- [ ] Cache purge with missing token → I5
- [ ] Multiple partial refunds composing → covered in spec edge cases + test plan ✅
- [ ] Concurrent refund races → covered ✅
- [ ] PR A reverted post-merge → R2

## 12. Approval Conditions

**To approve, address (Critical):**
1. **C1** — change `refunded_qty` to `v.optional(v.number())` in the spec data model; specify the helper `lineRefundedQty()` for `undefined → 0`.
2. **C2** — explicitly state that receipts/`_renderReceipt_internal` reads refunds via `runQuery(internal.refunds.internal._listForTransaction_internal, ...)`; add OWNERSHIP map entry for `pos_refunds`.
3. **C3** — add the 5 missing test cases to the spec's testing section.

**Recommended before plan-writing (Improvements):**
1. **I1** — pin ADR-040 source field names in a small data-model table.
2. **I2** — receipt renderer status guard.
3. **I3** — extract token-mint helper if used in 2+ places.
4. **I4** — reference `convex/lib/time.ts` for WIB formatting.
5. **I5** — purge-cache assertion vs no-op.
6. **I6** — lazy-mint caller auth-gate note.

---

*Generated by /staffreview*
