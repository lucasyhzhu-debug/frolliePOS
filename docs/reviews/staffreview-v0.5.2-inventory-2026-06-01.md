# Staff Review: v0.5.2 — Inventory view + staff recount + low-stock alerting

**Date:** 2026-06-01
**Plan:** `docs/superpowers/specs/2026-06-01-v0.5.2-inventory-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Execution sections deferred to writing-plans — see §0

---

## 0. Plan Structure Additions

This artifact is a **design spec**, not yet an implementation plan. The following structural sections are absent **by design** — they are produced in the immediately-following `writing-plans` step, not skipped:

- Ordered implementation waves with PARALLEL/SEQUENTIAL markers
- Commit boundaries + branch name (`feat/v0.5.2-inventory` expected)
- Success criteria (`npm run typecheck`, `npm run build`, `npx vitest` green)

Present in the spec: Scope (§3), File Changes (§4–7), Testing (§10), Rollback (§11). **The plan author must carry the §2–§4 findings below into the plan.** Not a blocker for the spec itself.

## 1. Summary

**Overall Assessment:** Revise (small, mechanical fixes — architecture is sound)

The rescope is correct and the FPOS-internal/v0.5.2b split is the right call. The schema is additive and clean, the `recount`-vs-`adjustment` separation is a genuine win, and reuse of existing patterns (idempotency dual-call, cross-module `_internal` reads, existing inventory test harness) is well-targeted. **Two Critical issues are precision errors in how the spec triggers Telegram from mutations** — fixable in the plan with no architecture change. Three Improvements harden the hot sale path and the nudge query.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Mutations cannot send Telegram inline — must schedule an action | Architecture/Logic | spec §5, §7 |
| 2 | Low-stock check on sale path must be fail-isolated + scheduled, or it can break sales | Architecture/Security | spec §5 |
| 3 | `sessionId` missing from both public mutation arg lists | Pattern/Auth | spec §5 |

### Issue 1: `_checkLowStock_internal` (internalMutation) and `recordRecount` (mutation) cannot call `sendTemplate` directly

`sendTemplate` is an `action` (`convex/telegram/send.ts:1` `"use node"`). Mutations have no `ctx.runAction`. The established bridge is `ctx.scheduler.runAfter(0, <internalAction>, args)` — precedent at `convex/auth/internal.ts:221` (lockout mutation schedules `internal.approvals.actions.notifyStaffLockout`, an action that then calls `ctx.runAction(api.telegram.send.sendTemplate, …)`).

The spec says `_checkLowStock_internal` "dispatch[es] low-stock Telegram" and `recordRecount` "dispatch[es] one summary Telegram" — both are mutations. As written this won't compile.

**Recommendation:** Add two thin internal **actions** — `_dispatchLowStockAlert_internal` and `_dispatchRecountNotice_internal` (each calls `ctx.runAction(api.telegram.send.sendTemplate, …)`). The mutations call `ctx.scheduler.runAfter(0, …)` to fire them. Audit rows (`stock.low_stock_alerted`) stay in the mutation (synchronous, before scheduling) so the audit trail is transactional even if the send later fails. Mirror `notifyStaffLockout`'s structure exactly.

### Issue 2: low-stock check is on the hot sale path — it must never break a sale

`_recordSaleMovement_internal` (`convex/inventory/internal.ts:12`) is called from the payment-confirm path (`convex/transactions/internal.ts:222`). Injecting low-stock logic here means: (a) if the `inventory` Telegram role is **unbound**, the send must no-op-with-audit (like the founders-unbound skip in `foundersSummary.ts`), never throw; (b) scheduling (Issue 1) already isolates the send from the sale transaction — keep it that way (`scheduler.runAfter` enqueues; it does not run inline), so a Telegram outage cannot roll back a confirmed sale.

Also: the ADR-026 dedup `continue` at `internal.ts:31` skips already-recorded lines. The low-stock check must run **only for SKUs actually decremented this call**, and **once per SKU** (a transaction can have multiple lines sharing one SKU). Evaluate after the loop against a `Set` of touched SKU ids, not inside the per-line body.

**Recommendation:** Accumulate touched SKU ids in the loop; after the loop, for each unique touched SKU call `_checkLowStock_internal`. Confirm `_checkLowStock_internal` swallows/curries send failures via scheduling + the unbound-role audited-skip path.

### Issue 3: public mutations omit `sessionId`

Spec §5 lists `recordRecount` args as `{ counts, idempotencyKey }` and `setReorderPoint` without a session arg. The project pattern (`convex/settings/public.ts:24-72`) requires `sessionId: v.id("staff_sessions")` in args — it feeds both the `authCheck` slot (runs before cache lookup, rule 21) and the in-handler `requireSession`/`requireManagerSession` re-resolve for audit attribution.

**Recommendation:** `recordRecount` args → `{ idempotencyKey, sessionId, counts }`, `authCheck: requireSession`. `setReorderPoint` args → `{ idempotencyKey, sessionId, skuId, reorderPoint }`, `authCheck: requireManagerSession`. Handler re-calls the same `require*Session` for the typed `staffId`.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Hourly-nudge `lastRecountAt` needs a cheap source — no index supports "latest recount across all SKUs" | M | L |
| 2 | `listInventory` should batch threshold reads into a map (avoid N+1) | M | L |
| 3 | Define default/seed behaviour for SKUs with no `reorder_point` | L | L |

### Improvement 1: nudge timestamp source

`pos_stock_movements` indexes are `by_sku_created` and `by_line_and_sku` (`schema.ts:22-23`). "Most-recent `recount` movement across all SKUs" has no supporting index → full scan. Either add a `last_recount_at` to a singleton (cheap, like `pos_settings`) updated by `recordRecount`, or add a `by_source_created` index, or derive the nudge purely client-side from `src/lib/storage-keys.ts`. Recommend the singleton: server-authoritative, survives reload, one extra patch per recount.

### Improvement 2: `listInventory` N+1

Collect `pos_stock_thresholds` once (`.collect()` → `Map<skuId, reorder_point>`) and join in JS, same as `getStockLevels` does for levels (`public.ts:20`). Don't per-SKU query thresholds.

### Improvement 3: missing-threshold semantics

SKUs without a `pos_stock_thresholds` row never alert. That's acceptable (manager opt-in per SKU) but make it explicit in ADR-042 and consider seeding a sane default for the known SKUs so alerting works out of the box on the booth device.

## 4. Refinements (Optional)

- Consider whether `recount_notice` to managers should batch a quiet hour (e.g., suppress if zero deltas) — but the user explicitly wants always-notify, so default to always.
- `recordRecount` could short-circuit SKUs where `entered === before` (no movement, no audit) to keep the ledger clean.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `withIdempotency` + `authCheck` slot | `convex/settings/public.ts:24-72` | Copy shape verbatim for `recordRecount` / `setReorderPoint` |
| Mutation→action Telegram bridge | `convex/auth/internal.ts:221` + `approvals/actions.ts:90` | Template for low-stock / recount dispatch actions |
| Unbound-role audited skip | `convex/telegram/foundersSummary.ts:73-118` | Pattern for `inventory` role unbound → no-op, not throw |
| On-hand upsert | `convex/inventory/internal.ts:42-52` | Reuse level read/patch/insert idiom in `recordRecount` |
| Cross-module active-SKU read | `convex/catalog/internal._getActiveSkuIds_internal` | `listInventory` active filter |
| Existing inventory test harness | `convex/inventory/__tests__/inventory.test.ts` | Extend — don't create a new harness |

### Potential duplication risks
- `recordRecount`'s level-upsert duplicates the block in `_recordSaleMovement_internal` and `_refundReCredit_internal`. Three copies now — consider a shared `_applyLevelDelta(ctx, skuId, delta, now)` internal helper. (Improvement-grade, not blocking.)

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| Schema (enum + `pos_stock_thresholds`) | Good | Must land first |
| Telegram role + kinds + renderers | Good | Independent of schema; can parallel |
| Backend mutations/queries + dispatch actions | Needs Issue 1–3 fixes | Sequential after schema |
| Frontend routes | Good | After backend queries exist |
| ADR-041/042 + docs | Good | Parallel with implementation |

**Ordering:** schema → backend (+dispatch actions) → frontend; Telegram role/renderers and ADRs parallelisable. The writing-plans step should mark these.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Backend mutations/queries | `convex-expert` | Idempotency + scheduler + module-boundary nuance |
| Frontend routes | `frontend-integrator` / `ui-component-builder` | Wire `listInventory`/`recordRecount` into screens; `NumericKeypad` reuse |
| Final review | `triple-review` (project flow) | User's standard post-implementation gate |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ❌ (add `feat/v0.5.2-inventory` in plan) |
| Branch naming follows convention | ✅ (matches `feat/v0.5.1b-refunds`) |
| Merge strategy | ✅ squash-PR per repo convention |

### Commit checkpoints (for the plan)
1. Schema (enum + threshold table) → `feat(inventory): recount source + pos_stock_thresholds (v0.5.2)`
2. Telegram role + kinds → `feat(telegram): inventory role + low_stock/recount notice templates`
3. Backend recount + dispatch + low-stock → `feat(inventory): recordRecount + reactive low-stock alert`
4. Backend reorder-point config + queries → `feat(inventory): listInventory + setReorderPoint`
5. Frontend → `feat(inventory): stock-check + recount screens`
6. ADRs + docs + spoilage-comment fix → `docs: ADR-041/042 + v0.5.2 roadmap + CHANGELOG`

### Pre-push verification
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npx vitest run convex/inventory`

### CI/CD & rollback
| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ additive-only (spec §11) |
| Deployment order | ✅ schema before code |
| Data backup | No |
| Migration safety | ✅ no backfill |

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Schema | `docs/SCHEMA.md` (`recount` source, `pos_stock_thresholds`, audit strings) |
| Backend | `docs/API_REFERENCE.md` (`recordRecount`, `listInventory`, `setReorderPoint`) |
| Rules | `CLAUDE.md` rule 9 clarification (recount ≠ adjustment for gating), file-locations (new routes, `inventory` role), required-env (no new env, but document `inventory` role binding) |
| Roadmap | `docs/PROGRESS.md` rescope v0.5.2 + insert v0.5.2b; regen `progress.html` |
| Cleanup | Fix stale `convex/inventory/internal.ts:155` "v0.5.2 spoilage" comment → v0.6 (decision D1) |
| Always | `docs/CHANGELOG.md` |

### CHANGELOG draft
~~~markdown
## 2026-06-xx - v0.5.2 Inventory (FPOS-internal)
- Staff recount flow (absolute count, `recount` movement, always-notify managers)
- Reactive low-stock alerting → new `inventory` Telegram group
- Inventory / stock-check screen with neg-stock visibility
- ADR-041 (recount), ADR-042 (low-stock detection)
~~~

## 10. Testing Plan Assessment

**Verdict:** Adequate (with additions below)

### Planned tests — present in spec §10 and on-target. Add:
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | Telegram dispatch is **scheduled**, not inline | Issue 1 is the main risk | Assert `recordRecount` / sale path enqueue the dispatch action (convex-test scheduler inspection) |
| 2 | Sale path with `inventory` role **unbound** still completes | Issue 2 — sale must not break | Run sale with no `inventory` chat bound; assert sale commits + audited skip, no throw |
| 3 | Low-stock dedup across **multiple sales** below threshold | Prevent per-sale spam | Two consecutive sub-threshold sales → one alert scheduled |
| 4 | Multi-line same-SKU transaction → one low-stock eval | Issue 2 SKU-dedup | Sale with 2 lines sharing a SKU; assert single check |
| 5 | `setReorderPoint` non-manager rejection | Auth gate | Staff session → reject |

### Regression risk
- `_recordSaleMovement_internal` existing tests (`inventory.test.ts:28,75`) must still pass after the low-stock injection — they assert movement count + on_hand; the injection must not alter those.

## 11. Edge Cases to Address

- [ ] First-ever count for a SKU with no `pos_stock_levels` row (recount inserts)
- [ ] Recount `entered === before` (no movement / clean ledger — Refinement)
- [ ] `inventory` Telegram role unbound (audited skip, never throw on sale path)
- [ ] SKU with no `reorder_point` (never alerts — documented)
- [ ] Concurrent recount of same SKU (OCC retry / last-write-wins — note in ADR-041)
- [ ] Negative `entered` rejected (count can't be negative; recount-to-negative is not a sale)
- [ ] Re-arm: stock climbs above threshold then crosses again → second alert fires

## 12. Approval Conditions

**To approve, the plan (next step) must address:**
1. Issue 1 — scheduled dispatch actions for both Telegram sends
2. Issue 2 — fail-isolated, SKU-deduped low-stock check on the sale path
3. Issue 3 — `sessionId` in both mutation arg lists + `authCheck`

**Recommended before implementation:**
1. Improvement 1 — nudge timestamp via singleton (not movement scan)
2. Improvement 2 — batch threshold reads in `listInventory`
3. Shared `_applyLevelDelta` helper (de-dup the three level-upsert copies)

---

*Generated by /staffreview*
