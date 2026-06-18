# Staff Review: POS → Frollie Pro Sales Sync (Producer Side)

**Date:** 2026-06-18
**Plan:** `docs/superpowers/plans/2026-06-18-pos-erp-sales-sync-producer.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ One section auto-added — see §0

---

## 0. Plan Structure Additions

The plan covers Goal, File Structure, ordered Tasks (with `Interfaces:` consume/produce blocks marking dependencies), Testing (per-task TDD + the §8 six-gate summary), and an implied Success Criteria via Task 11 (full suite + `typecheck`/`lint`/`convex dev --once`).

**Missing → added in this review:** a consolidated **Deployment & Rollback** treatment (§8 of this report). The plan has the prereq schema migration as Task 2/3 but no deployment-ordering or rollback narrative, and the migration runs against a **live prod deployment** (booth live since 2026-06-03). This is the single biggest gap and drives Critical #2.

---

## 1. Summary

**Overall Assessment: Revise** (two Critical, both small and mechanical to fix; no architectural rework needed).

The plan is well-structured, TDD throughout, reuses the right existing patterns (SHA-256 indexed-hash auth, `httpAction` + `ctx.runQuery` internals, schema-fragment composition), and the contract reconciliation is sound. Two Critical issues block execution as written: (1) a wrong dependency — `_listStaffNames_internal` doesn't expose `code`, so the transactions feed can't resolve `staffCode`; (2) the required-field schema flip deploys against live prod data with no gated null-code audit. Both are fixable inside the existing task structure. A handful of Improvements (runtime portability of `Response.json`, cursor-codec placement, N-subquery refunds, unbounded log growth, spec↔plan issuance mismatch) are worth folding in before code.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Transactions feed resolves `staffCode` off `_listStaffNames_internal`, which returns `{_id, name}` — no `code` | Logic/Correctness | Task 7 Step 3 |
| 2 | Required-field schema flip deploys against live prod with no pre-deploy null-code audit | Deployment | Tasks 2, 3 |

### Issue 1: `staffCode` resolver depends on a field that isn't returned

Task 7 Step 3 builds `codeByStaffId = new Map(staffNames.map((s) => [String(s._id), s.code]))`, but `auth/internal.ts:469-474`:

```ts
export const _listStaffNames_internal = internalQuery({
  handler: async (ctx): Promise<Array<{ _id: Id<"staff">; name: string }>> => {
    const rows = await ctx.db.query("staff").collect();
    return rows.map((s) => ({ _id: s._id, name: s.name }));   // NO code
  },
});
```

`s.code` is `undefined` → every txn would throw `STAFF_CODE_MISSING_FOR_TXN`. The sibling `_listActiveManagers_internal` (:485) returns `{name, code}` but no `_id` and is manager-only — also unusable.

**Recommendation:** Add a dedicated internal in `convex/auth/internal.ts`:
```ts
export const _listStaffCodes_internal = internalQuery({
  args: {},
  handler: async (ctx): Promise<Array<{ _id: Id<"staff">; code: string }>> => {
    const rows = await ctx.db.query("staff").collect();
    return rows.map((s) => ({ _id: s._id, code: s.code }));  // code is required post-Task 3
  },
});
```
Use it in Task 7 (`codeByStaffId` map). It's ADR-034-clean (transactions reads staff via an auth internal). Cross-reference: this is only safe **after** Task 3 makes `staff.code` required — Task 7 already sequences after Task 3, good.

### Issue 2: required-field flip against live prod data has no audit gate

Tasks 2–3 flip `pos_products.code` and `staff.code` from `v.optional` → `v.string()`. Convex **rejects a deploy** if any existing row violates the stricter schema. The booth has been live since 2026-06-03 (prod `savory-zebra-800`). The plan asserts "live data is already clean (launch catalog seeds real codes)" — true for seeded rows, but the old `createProduct`/`createStaff` paths allowed code-less rows, and there's no verification that none were created via admin in the ~2 weeks of operation. A failed prod deploy mid-rollout is the realistic outcome.

This is "safe" (Convex blocks rather than corrupts) but it will **block the deploy** and strand the migration.

**Recommendation:** Add **Task 0 (pre-migration data audit)** before Task 2, run against **both** dev and prod:
```bash
npx convex run --prod  <a throwaway internal query>   # count pos_products/staff with code == undefined
```
Add a tiny internal `_auditMissingCodes_internal` returning the count + offending ids; if non-zero, backfill (assign conforming codes via a one-off internal mutation) **before** deploying the schema flip. Make "zero null-code rows on prod" an explicit gate in the task. Document the deploy order in §8.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | `Response.json()` static may be unsupported in Convex runtime — use `new Response(JSON.stringify(...))` | H | L |
| 2 | Move cursor codec to `convex/lib/` (avoid domain→api import inversion) | M | L |
| 3 | Refunds feed does N `ctx.runQuery` sub-calls per page; bad refund 500s the whole page | M | M |
| 4 | `api_rate_buckets` + `api_request_log` grow unbounded — retention cron, not "optional" | M | L |
| 5 | Spec §4.2 (manager-PIN issuance + `createdByStaffId`) contradicts plan's ops-CLI issuance | M | L |

### Improvement 1: don't rely on `Response.json()`
Existing handlers (`receipts/http.ts`, `payments/webhook.ts`) all use `new Response(body, { status, headers })`. The static `Response.json()` is newer Web API surface with uneven runtime support. Match the proven pattern:
```ts
return new Response(JSON.stringify(txnEnvelope(rows, nextCursor)), {
  status: 200, headers: { "content-type": "application/json" },
});
```
Apply in Tasks 8, 9, 12. Cheap insurance against a runtime surprise.

### Improvement 2: cursor codec belongs in `convex/lib/`
`transactions/internal.ts` and `refunds/internal.ts` import `encodeCursor` from `api/v1/_cursor.ts`, making domain modules depend on the `api/v1/` layer (dependency inversion — `api` should depend on domains, not vice versa). Move it to `convex/lib/apiCursor.ts` (V8-safe already). Endpoints and internals both import from `lib/`.

### Improvement 3: batch the refund join + don't fail the page on one bad refund
`_listRefundsForApi_internal` calls `_resolveRefundLinesForApi_internal` once per refund row (N sub-queries/page), and a missing txn/line throws → 500s the entire page. Recommend a single batch resolver `_resolveRefundLinesForApiBatch_internal({ items: [{transactionId, lines}] })` returning a parallel array, and skip-and-`console.error` a malformed refund rather than failing the whole page (a single corrupt refund shouldn't stall the ERP's entire refund sync). Volume is low, but correctness of the drain matters.

### Improvement 4: bound the two new append-only tables
`api_rate_buckets` accrues one row per (token, minute) (~1.4k/day/token) and `api_request_log` grows with every request — both unbounded. Promote the Task 11 "optional" cleanup to a real `api-housekeeping` cron: delete rate buckets older than 2 min and request-log rows older than a retention window (e.g. 90 days). Mirrors the TTL-purge-cron pattern already used elsewhere (v0.4 lessons).

### Improvement 5: resolve the issuance-mechanism contradiction
Plan header flags it, but it's live: producer spec §4.2 still says "manager-PIN-gated mutation" with `createdByStaffId: Id<"staff">` on `api_tokens`; the plan's `api_tokens` schema (Task 4) omits `createdByStaffId` and issues via ops-run `internalMutation`. Pick one and make spec + plan agree before code: (a) ops-CLI (simpler, matches `seed:reset`, no booth session in `convex run`) — then update spec §4.2 + drop `createdByStaffId`; or (b) keep the PIN-gated action — then the plan needs a session+PIN path and a different invocation story. Recommend (a). This is a one-edit reconciliation, but leaving both docs divergent invites an implementer to build the wrong one.

---

## 4. Refinements (Optional)

- **Implementation branch:** plan commits per task but doesn't name the branch. Implement on a fresh branch off `main` (not the current `spec/pos-erp-sales-sync` spec branch).
- **api-inference cycle:** the explicit `Promise<...>` return annotations on the internals are load-bearing (queries calling `ctx.runQuery` need them to avoid the TS inference cycle — v0.5.8 lesson). Add a one-line comment so a future contributor doesn't "simplify" them away.
- **Directory-name check:** confirm `internal.api.v1.internal.*` resolves with no collision against the generated `api` registry. Low risk — the `convex/api/v1/` scaffold already ships per ADR-034 — but worth a `convex dev --once` sanity check at Task 4/6.
- **Keyset over-fetch bound:** `_listPaidTxnsForApi_internal` over-fetches `limit*2+1` to handle same-ms tiebreaks. Document the assumption (booth never produces >`limit` sales in one ms); add a comment that a pathological same-ms burst beyond the headroom could stall pagination (not a real risk at booth volume).

---

## 5. Duplication Analysis

### Existing code to leverage (plan already does)
| Code | Location | How used |
|------|----------|----------|
| V8-safe `sha256Hex` | extracted to `convex/lib/sha256.ts` (Task 1) | auth + issuance; migrates approvals' local copy (rule-of-three) ✅ |
| `httpAction` + `ctx.runQuery` internal pattern | `receipts/http.ts`, `payments/webhook.ts` | endpoint shape ✅ |
| `by_status_paid_at` index | `transactions/schema.ts:51` | reused, no new index ✅ |
| Schema-fragment composition | `convex/schema.ts` | `apiTables` spread ✅ |

### Duplication risks
- **Cursor codec placement** (Improvement 2) — keep it in one place (`lib/`), don't let endpoints and internals each grow a copy.
- **`new Response(JSON.stringify(...))`** envelope/error helpers — Task 7's `_shape.ts` already centralizes `envelope`/`errorBody`; good, keep both endpoints routing through them.

---

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|------|------------|-------|
| 1 (sha256 extract) | Good | Independent, de-risks early |
| 2–3 (prereq migration) | **Needs Task 0 prepend** | Live-data audit gate missing (Critical 2) |
| 4 (schema) | Good | — |
| 5 (cursor) | Good | Move file to `lib/` (Imp 2) |
| 6 (auth/issuance) | Good | Resolve issuance mechanism (Imp 5); auth test goes green only after Task 8 (honestly noted) |
| 7 (txn internal) | **Fix staff resolver** | Critical 1 |
| 8–9 (endpoints) | Good | `Response.json` → `new Response` (Imp 1); refund batch (Imp 3) |
| 10 (gates) | Good | Strong boundary test |
| 11 (docs/smoke) | Good | Promote housekeeping cron (Imp 4) |
| 12 (logging) | Good | — |

**Ordering:** Task 0 (audit) → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12. Tasks 1, 4, 5 are independent and could parallelize, but sequential is fine at this size.

---

## 7. Specialist Agent Recommendations

| Tasks | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| 4, 6, 7, 9 | `convex-expert` | Schema, internal-query pagination, cross-module reads, runtime gotchas |
| Post-impl | `code-reviewer` | Diff review before merge (auth surface + live migration warrant it) |

---

## 8. Git Workflow Assessment (incl. auto-added Deployment & Rollback)

### Branch & commits
| Check | Status |
|-------|--------|
| Per-task atomic commits | ✅ (one commit/task with messages) |
| Implementation branch named | ⚠️ Add: fresh branch off `main`, not the spec branch |
| Build/typecheck before push | ✅ Task 11 (`typecheck`/`lint`/`convex dev --once`) |

### Deployment order (auto-added — was missing)
1. **Task 0 audit** on dev **and prod**: zero null-code rows (backfill if any) — **gate**.
2. Deploy backend (schema flip + new tables + endpoints): `npx convex deploy`. Schema must deploy cleanly only because Step 1 guaranteed conformance.
3. Endpoints are read-only + behind bearer auth → no FE deploy coupling.
4. Issue a `frpos_test_` token on dev, run the ERP dev↔dev drain, then issue `frpos_live_` on prod.

### Rollback
| Concern | Status |
|---------|--------|
| Schema flip reversible | ⚠️ Reverting required→optional is a safe widening; safe to roll back. Document it. |
| New tables/endpoints | ✅ Additive — revert by removing routes; tables idle harmlessly. |
| Token compromise | ✅ `revokedAt` is immediate (auth checks every request). |
| Data backup before migration | Backfill (not destructive) — no backup needed, but snapshot prod row counts pre/post. |

---

## 9. Documentation Checkpoints

| Task | Docs |
|------|------|
| 4 | `docs/SCHEMA.md` (3 new tables) ✅ in plan |
| 11 | `docs/PUBLIC_API.md` endpoint table + `docs/CHANGELOG.md` ✅ in plan |
| Post | `CLAUDE.md` — add `convex/api/v1/` to the module map + business-rule note that `code` is now required (closes the "optional until F6" comments) — **add to plan** |

### CHANGELOG draft
```markdown
## 2026-06-18 — Public API v1 (Frollie Pro sales sync, producer)
- GET /api/v1/transactions + /api/v1/refunds (bearer-authed, cursor-paginated, product-level).
- Consumer-identity binding + optional X-Consumer-Account origin check; append-only api_request_log.
- pos_products.code / staff.code now REQUIRED; sku_family snapshot fallback removed.
```

## 10. Testing Plan Assessment

**Verdict: Adequate.** TDD per task (failing test → impl → pass), all six ADR-034 gates present (shape snapshots, auth paths incl. 401/403/429 + CONSUMER_MISMATCH, stable-ID conformance, cursor-boundary same-ms straddle, request-log, schema smoke).

### Gaps to add
| # | Missing test | Why | Approach |
|---|--------------|-----|----------|
| 1 | `_listStaffCodes_internal` returns code for every staff | Critical 1 fix needs its own coverage | unit: seed 2 staff, assert codes |
| 2 | Refund with a missing/unpaid txn doesn't 500 the page | Imp 3 (skip-and-log) | seed a refund whose txn lacks receipt_number; assert page returns others |
| 3 | Prereq deploy gate: audit query returns 0 on clean data, >0 with a planted null | Critical 2 | unit on `_auditMissingCodes_internal` |

### Regression risk
- Tasks 2–3 touch `commitCart` + every raw `pos_products`/`staff` test insert. The plan calls a full `npx vitest run convex` sweep to fix fallout — correct. Watch `confirmPaid`, `refunds/*`, `inventory` suites.

## 11. Edge Cases to Address

- [ ] Same-`paid_at`-ms rows straddling a page boundary (covered, Task 10) ✅
- [ ] Refund referencing a hard-deleted/unpaid txn → skip-and-log, not 500 (Imp 3)
- [ ] Empty feed (no paid txns) → `{ data: [], nextCursor: null }` — add a one-line assert
- [ ] `_creationTime` fractional values round-trip through the cursor (test uses `.4` ✅)
- [ ] Expired token exactly at `expiresAt` boundary (`<=` vs `<`) — current `expiresAt <= now` → expired at boundary; fine, just confirm intent
- [ ] Null-code rows on prod before the flip (Critical 2)

## 12. Approval Conditions

**To approve, address:**
1. **Critical 1** — add `_listStaffCodes_internal`; fix Task 7 map.
2. **Critical 2** — add Task 0 live-data null-code audit + backfill gate; document deploy order (§8).

**Recommended before implementation:**
1. Imp 1 — `new Response(JSON.stringify(...))` over `Response.json()`.
2. Imp 5 — reconcile spec §4.2 vs plan's ops-CLI issuance (pick one).
3. Imp 2/3/4 — cursor codec → `lib/`; batch + tolerate-bad refund resolve; housekeeping cron.

### Evidence-Before-Mitigation Gate (§4.9)
**N/A** — this is a greenfield feature, not a fix for a flake/race/transient bug. No mitigation-vs-fix ambiguity; gate does not apply.

---

*Generated by /staffreview*
