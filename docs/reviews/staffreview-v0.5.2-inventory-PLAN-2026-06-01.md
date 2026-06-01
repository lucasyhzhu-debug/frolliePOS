# Staff Review: v0.5.2 Inventory — IMPLEMENTATION PLAN

**Date:** 2026-06-01
**Plan:** `docs/superpowers/plans/2026-06-01-v0.5.2-inventory.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, File Structure, TDD tasks, Testing, Success Criteria, Rollback all present)

---

## 1. Summary

**Overall Assessment:** Revise (3 Criticals — all are "the plan's code won't run / duplicates existing schema as written"; none are architectural dead-ends)

The plan is well-structured, TDD-disciplined, and correctly bakes in the three Criticals from the spec review (scheduled Telegram dispatch, fail-isolated SKU-deduped sale path, `sessionId`+`authCheck`). But verifying the plan's code against the **real** schema exposed three concrete breakages: (1) a new threshold field that **already exists** on the catalog SKU, (2) test seed helpers with wrong/missing required fields, and (3) the wrong `useSession()` return shape in every frontend task. All are mechanical to fix; the first is a genuine design simplification.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `pos_stock_thresholds.reorder_point` duplicates the existing required `pos_inventory_skus.low_threshold` | Schema/Duplication | Tasks 1, 5, 8, 9 |
| 2 | Test seed helpers use wrong/missing required fields → tests won't run | Testing | Tasks 1, 4, 5, 6, 7 |
| 3 | Frontend destructures a `useSession()` shape that doesn't exist | Logic | Tasks 10, 11, 12 |

### Issue 1: the reorder point already exists on the catalog SKU

`convex/catalog/schema.ts` `pos_inventory_skus` already declares **`low_threshold: v.number()`** — a *required* field, so every SKU already has a low-stock threshold. The plan (and spec §4) invents a parallel `pos_stock_thresholds.reorder_point`, justified by "don't bolt a threshold onto catalog's `pos_inventory_skus`" — but it's **already bolted on**, and required.

Two competing thresholds is a correctness trap: `listInventory`, `_checkLowStock_internal`, and `setReorderPoint` would read/write `reorder_point` while the rest of the system (and any catalog admin in v0.5.3) reads `low_threshold`.

**Recommendation (design simplification):**
- **Reorder point = the existing `low_threshold`.** Read it via a catalog cross-module internal (ADR-034), the same way `_getActiveSkuIds_internal` is consumed. Do **not** create `pos_stock_thresholds`.
- The only genuinely inventory-owned new state is the **dedup flag**. Replace `pos_stock_thresholds` with a minimal **`pos_low_stock_alerts`** table: `{ inventory_sku_id, alerted_at, updated_at }`, index `by_sku`. `_checkLowStock_internal` reads `low_threshold` from catalog + the alert-flag row from inventory.
- `setReorderPoint` becomes **`setLowThreshold`** — a manager-gated mutation that updates the catalog field. Decide its module: cleanest is a catalog public mutation (it edits a catalog-owned field) called from the inventory UI, OR an inventory mutation that writes via a new `catalog/internal._setLowThreshold_internal`. Prefer the catalog public mutation to keep the field's single writer in its owning module.
- This *reduces* code (one fewer table, reuse a populated field) and makes alerting work out-of-the-box for every SKU (no opt-in gap — Improvement 3 from the spec review dissolves).

*Net change:* Task 1 drops `pos_stock_thresholds`, keeps `pos_recount_state`, adds `pos_low_stock_alerts`. Tasks 5/8/9 read `low_threshold` via catalog internal and the alert flag locally.

### Issue 2: test seed helpers don't match the real schema (tests fail at insert)

Verified field names:

- **`pos_inventory_skus`** (`catalog/schema.ts`): `sku: v.string()`, `name`, `unit: v.literal("piece")`, `low_threshold: v.number()` (**required**), `active`, `created_at`. **No** `sku_code`, **no** `updated_at`, `unit` is the literal `"piece"` not `"pcs"`.
  The plan's `seedSku` uses `sku_code`, `unit: "pcs"`, `updated_at`, and omits required `low_threshold` → schema validation throws on every test.
- **`staff_sessions`** (`auth/schema.ts`): requires `ended_at: v.union(v.number(), v.null())` and `end_reason: v.union(...literals, v.null())` — **both required**. The plan's `seedStaffSession` inserts only `staff_id, device_id, started_at` (+ `as any`) → validation throws. Must add `ended_at: null, end_reason: null` (and `requireSession` needs `ended_at: null` to treat the session as live).

**Recommendation:** Fix both seed helpers with the exact fields:
```ts
// SKU
ctx.db.insert("pos_inventory_skus", {
  sku: code, name: "Dubai", unit: "piece", low_threshold: 0, active: true, created_at: Date.now(),
});
// session
ctx.db.insert("staff_sessions", {
  staff_id: staffId, device_id: "dev-1", started_at: Date.now(), ended_at: null, end_reason: null,
});
```
Drop the `as any` casts — they masked these exact errors.

### Issue 3: frontend uses a `useSession()` shape that doesn't exist

`src/hooks/useSession.ts` returns a discriminated `SessionState`: `{ status: "active"; sessionId; staff: { _id; name; role } }` (or `{ status: "none"|"loading"; sessionId: null; staff: null }`). The plan's components do `const { sessionId } = useSession()` and `const { sessionId, role } = useSession()` — `role` is **not** top-level (it's `staff.role`), and `sessionId` is only non-null when `status === "active"`.

**Recommendation:** In every frontend task:
```ts
const session = useSession();
const sessionId = session.status === "active" ? session.sessionId : null;
const role = session.status === "active" ? session.staff.role : null;
const rows = useQuery(api.inventory.public.listInventory, sessionId ? { sessionId } : "skip");
```
Gate manager-only UI on `role === "manager"`.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | `_getSkuNameById_internal` confirmed absent — make its creation an explicit step, not a footnote | M | L |
| 2 | `getRecountState` is consumed (nudge hook) before it's defined — define it in Task 9, not buried in Task 12 | L | L |
| 3 | `.catch(() => null)` on a `ctx.runQuery` to a possibly-missing internal masks a registration error | L | L |

### Improvement 1
Only `_getActiveSkuIds_internal` exists in `catalog/internal.ts`. The low-stock dispatch and recount notice need SKU names. Add `_getSkuNamesByIds_internal({ skuIds }) → Record<string,string>` (batch, not one-at-a-time) to `catalog/internal.ts` as an explicit Task-5 step, and use it for both dispatch actions. Batch form avoids N calls in a multi-SKU recount notice.

### Improvement 2
`useRecountNudge` calls `api.inventory.public.getRecountState`. Define that query in Task 9 (with the other queries) so the frontend task has no forward dependency. Keep it session-gated.

### Improvement 3
If `_getSkuNameById_internal` isn't registered, `ctx.runQuery` rejects with a non-catchable framework error in some Convex versions. Resolve names via the guaranteed-present batch query (Improvement 1) instead of a `.catch` fallback.

## 4. Refinements (Optional)

- `idempotencyKey: \`lowstock:${skuId}:${onHand}\`` — fine, but consider including a coarse time bucket so a re-arm→re-cross same-level alert isn't deduped by the action-level idempotency. Low risk (on_hand usually differs).
- Recount `NumericKeypad` per-row focus is deferred to a plain input (MVP) — acceptable, matches pragmatic-UX preference.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `low_threshold` field | `pos_inventory_skus` (`catalog/schema.ts`) | **Use as the reorder point** (Issue 1) — don't duplicate |
| `_getActiveSkuIds_internal` | `catalog/internal.ts:10` | Pattern for the new `_getSkuNamesByIds_internal` |
| founders unbound-role skip | `telegram/foundersSummary.ts:88-103` | Already mirrored in dispatch actions — good |
| `withIdempotency` + authCheck | `settings/public.ts:24-72` | Plan mirrors correctly — good |

### Potential duplication risks
- `pos_stock_thresholds` vs `low_threshold` (Issue 1) — the headline duplication.

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| Task 1 schema | Needs adjustment | Drop `pos_stock_thresholds`; add `pos_low_stock_alerts` (Issue 1) |
| Tasks 2-3 Telegram | Good | Parallelisable |
| Tasks 4-9 backend | Good after Issue 1/2 fixes | Sequential ordering correct |
| Tasks 10-13 frontend | Needs Issue 3 fix | Otherwise correct |
| Tasks 14-15 docs/ADR | Good | ADR-042 must now describe `low_threshold` reuse, not a new threshold table |

**Ordering issues:** `getRecountState` forward-reference (Improvement 2).
**Missing phases:** none.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Backend (Tasks 4-9) | `convex-expert` | Module-boundary read of `low_threshold`, scheduler, idempotency |
| Frontend (Tasks 10-13) | `frontend-integrator` | `useSession` discriminated-union wiring, Convex hooks |
| Post-impl | project `triple-review` flow | User's standard gate |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ `feat/v0.5.2-inventory` |
| Branch naming follows convention | ✅ matches `feat/v0.5.1b-refunds` |
| Merge strategy | ✅ squash-PR |

### Commit checkpoints — ✅ one per task (15 atomic commits), `/gsd-undo`-friendly.

### Pre-push verification
- [x] `npm run build` (Task 13)
- [x] `npm run typecheck` (multiple tasks)
- [x] `npx vitest run convex/inventory convex/lib` (Success Criteria)

### CI/CD & rollback
| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ additive-only |
| Deployment order | ✅ convex deploy before vercel; bind `inventory` chat before relying on alerts |
| Data backup | No |
| Migration safety | ✅ no backfill |

## 9. Documentation Checkpoints

✅ Task 15 covers SCHEMA, API_REFERENCE, CLAUDE (rule 9 + locations + role table), CHANGELOG, PROGRESS rescope + v0.5.2b, spoilage-comment fix, progress.html regen. **Add:** ADR-042 must document `low_threshold` reuse (not a new threshold table) once Issue 1 is applied.

### CHANGELOG draft — present in spec §9; carry forward.

## 10. Testing Plan Assessment

**Verdict:** Adequate (once Issue 2 seed-field fixes land — otherwise every test fails at insert)

### Planned tests — strong coverage:
| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend | recount delta/zero-skip/negative/idempotency | convex-test | planned |
| Backend | low-stock fire/dedup/re-arm/no-threshold | convex-test | planned |
| Backend | sale-path injection regression | convex-test | planned |
| Backend | setLowThreshold manager-gate | convex-test | planned |
| Backend | listInventory status | convex-test | planned |
| Frontend | screens | manual smoke | planned |

### Missing test coverage (add)
| # | Missing test | Why | Approach |
|---|--------------|-----|----------|
| 1 | low-stock reads `low_threshold` from catalog (post Issue 1) | the field moved | seed SKU with `low_threshold: 20`, assert alert flag table row |
| 2 | recount on SKU with no level row (first count) | insert path | recount entered=10, no prior level → on_hand 10, movement qty +10 |

### Regression risk
- `_recordSaleMovement_internal` existing tests (`inventory.test.ts:28,75`) — must stay green after injection. Plan calls this out. ✅

## 11. Edge Cases to Address

- [x] First-ever count, negative entered, zero-delta skip, unbound role, re-arm — all in plan
- [ ] **`low_threshold === 0`** (the schema default if unseeded): `on_hand < 0` only → alert effectively fires on negative stock only. Confirm that's acceptable, or seed sane defaults (ties to Issue 1 — alerting now works per-SKU off the existing field).
- [ ] Recount of a SKU whose `low_threshold` is high and `entered` is below it → recount itself should trigger the low-stock check (plan does call `_checkLowStock_internal` post-recount ✅).

## 12. Approval Conditions

**To approve, apply:**
1. Issue 1 — reuse `low_threshold`; replace `pos_stock_thresholds` with `pos_low_stock_alerts` (flag only); `setLowThreshold` writes the catalog field.
2. Issue 2 — correct `pos_inventory_skus` + `staff_sessions` seed fields; drop `as any`.
3. Issue 3 — correct `useSession()` discriminated-union access in all frontend tasks.

**Recommended:**
1. `_getSkuNamesByIds_internal` batch name lookup (explicit step).
2. Define `getRecountState` in Task 9.

---

*Generated by /staffreview*
