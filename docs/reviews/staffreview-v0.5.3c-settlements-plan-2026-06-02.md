# Staff Review: v0.5.3c — Settlements (implementation plan)

**Date:** 2026-06-02
**Plan:** `docs/superpowers/plans/2026-06-02-v0.5.3c-settlements.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — Goal, File Structure, waves (PARALLEL/SEQUENTIAL marked), TDD steps, Success Criteria, Rollback/Deployment all present.

---

## 1. Summary

**Overall Assessment: Revise (one Critical, then Approve).**

Excellent, executable plan — real signatures throughout, every flagged assumption verified TRUE against `origin/main` (see §5). One genuine **correctness bug** in the reconciliation logic (`getSettlementDetail`'s `pending` bucket is computed against a single settlement row instead of the union of all settlements, so it would mislabel already-settled txns as "pending" — and the pending/unsettled list IS the headline v1.0 risk-closer). Plus two cleanups (a verified-unnecessary hedge note; an ad-hoc date parse). Fix C1 inline and the plan is ready to execute.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | `getSettlementDetail` `pending` computed per-row, not against the settled union → mislabels txns settled on other dates as "pending" | Logic | Task 7 (`getSettlementDetail`) + Task 2 (`reconcileDay`) |

### Issue C1: reconciliation `pending` is computed against the wrong set
Task 7's `getSettlementDetail` calls `reconcileDay(settledRefs, paidTxns)` where `settledRefs` is **only this settlement row's** payload, and `paidTxns` is **every** paid txn in an 8-day window. `reconcileDay` then puts every paid txn not in *this row* into `pending`. But a txn that already **settled on a different date** (and lives in another `pos_settlements` row's payload) is genuinely settled — it must NOT show as "pending" under this date. As written, opening any one day's detail would report nearly every other day's paid txns as unsettled. Since the "paid-but-not-settled" bucket is the load-bearing v1.0 settlement-timing risk surface (spec §4), a wrong classification defeats the feature.

**Recommendation:** compute `pending` against the **union of all settlement payloads** in the window, not one row. Change the pure function to take three inputs:
```typescript
export function reconcileDay(
  thisRowRefs: string[],   // this settlement's payload — drives `settled`
  allSettledRefs: string[],// union across all settlements in window — drives `pending`
  paidTxns: PaidTxnRef[],
): ReconResult {
  const thisRow = new Set(thisRowRefs.map(parseRefToTxnId));
  const settledAnywhere = new Set(allSettledRefs.map(parseRefToTxnId));
  const settled = paidTxns.filter((t) => thisRow.has(t.txnId));      // this payout covered
  const pending = paidTxns.filter((t) => !settledAnywhere.has(t.txnId)); // not settled ANYWHERE
  const paidIds = new Set(paidTxns.map((t) => t.txnId));
  const unmatched = thisRowRefs.filter((r) => !paidIds.has(parseRefToTxnId(r)));
  return { settled, pending, unmatched };
}
```
`getSettlementDetail` reads all settlements over the window (cheap — ≤ ~8 rows), unions their payload refs, and passes both. (Txns settled on *other* dates correctly appear in neither `settled`-for-this-row nor `pending`.) Update the Task 2 test to cover "a txn settled on another date is NOT pending."

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | Remove Task 8's mutation→`runMutation` hedge note (verified valid pattern) | M | L |
| I2 | `getSettlementDetail` window uses ad-hoc `Date.parse("…T17:00:00Z")`; reuse `parseWibDayLabel` | L | L |

### Improvement I1: the hedge note is verified-unnecessary FUD
Task 8 carries: *"A mutation cannot call `ctx.runMutation` on another mutation… If the executing agent hits a runtime restriction, inline the upsert…"* **Verified false:** public mutations calling `ctx.runMutation(internalMutation)` is an established pattern here — `settings/public.ts:212` (`updateReceiptConfig` → `_purgeAllReceiptCache_internal`), `inventory/public.ts:192,254`, `transactions/public.ts:602` (`shareReceipt`). Nested mutations share the transaction (`payments/internal.ts:270`). The note could mislead the executor into needless inlining.

**Recommendation:** replace the note with a one-liner: *"`recordSettlement` (mutation) calls `_upsertSettlement_internal` (internalMutation) via `ctx.runMutation` — same established pattern as `updateReceiptConfig` (`settings/public.ts:212`); nested mutation is transactional."*

### Improvement I2: reuse `parseWibDayLabel` for the lookback window
Task 7 derives the window with `Date.parse(\`${args.settlementDate}T17:00:00Z\`)` — an ad-hoc WIB-end approximation. `convex/lib/time.ts` exports `parseWibDayLabel(label) → { dayStartMs, dayEndMs }` (added v0.5.3a for the date-picker). Reuse it for the day boundary then subtract the lookback — consistent with the clock-invariant discipline and no magic `17:00:00Z`.

**Recommendation:** `const { dayEndMs } = parseWibDayLabel(args.settlementDate); const sinceMs = dayEndMs - 8 * 86_400_000;`

## 4. Refinements (Optional)

- **R1** — Task 8 step 5 says "Add the audit verb to SCHEMA.md," but the SCHEMA verb update is Task 12. Reword step 5 to "run full settlements suite" only; cross-reference Task 12 for the verb doc, to avoid a half-done SCHEMA edit mid-wave.
- **R2** — `syncSettlementsNow` success path returns `{datesUpserted, txnCount}`; consider also auditing an on-demand sync (`settlement.synced` with `source: booth_inline`, actor = manager) for attribution parity with the cron. Optional — the cron path's audit is the primary record.

## 5. Verified Assumptions (the plan's flagged "confirm at impl" items)

| Plan assumption | Verdict | Evidence |
|---|---|---|
| `withIdempotency` import path `../idempotency/internal` + 3-arg `(name, handler, {authCheck})` | ✅ TRUE | `idempotency/internal.ts:52`; used `staff/public.ts:4,77` |
| public mutation may `ctx.runMutation(internalMutation)` | ✅ TRUE | `settings/public.ts:212`, `inventory/public.ts:192/254`, `transactions/public.ts:602` |
| `_listPaidTxnsSince_internal({sinceMs}) → Doc<pos_transactions>[]` with `_id/receipt_number/total/paid_at` | ✅ TRUE | `transactions/internal.ts:545-556` + schema |
| query may `ctx.runQuery(internalQuery)` | ✅ TRUE | `_fetchDayWindow_internal` does it (`transactions/internal.ts:593,609`) |
| `useSession()` → `{status:"active", sessionId, staff:{_id,name,role}}` | ✅ TRUE | `src/hooks/useSession.ts:15-22,60-64` |
| `requireSession`/`requireManagerSession` ctx + return | ✅ TRUE | `auth/sessions.ts:13-31` |
| `getSession` returns `{staff:{role}}` for the action role check | ✅ TRUE | `auth/public.ts:23-37` |
| resilient cron pattern (`cronRetry`, scheduler.runAfter) | ✅ TRUE | `telegram/foundersSummary.ts:158`, `lib/cronRetry.ts` |
| `crons.daily(name,{hourUTC,minuteUTC},fnRef,ctx)` syntax | ✅ TRUE | `crons.ts:10` |

## 6. Phase / Wave Accuracy

| Wave | Assessment | Notes |
|------|------------|-------|
| 1 schema+lib | Good | Run Task 1 first so generated types exist; Task 2 pure-independent |
| 2 adapter+writer | Good | PARALLEL correct (independent files) |
| 3 action+cron | Good | SEQUENTIAL correct (cron refs the action) |
| 4 queries+mutation | Good | C1 lands here; SEQUENTIAL correct (shared file) |
| 5 frontend | Good | After backend; SEQUENTIAL view→detail |
| 6 docs | Good | PARALLEL; ADR-043 + SCHEMA/CHANGELOG/PROGRESS |

No ordering problems. The `"use node"` boundary is correctly handled (actions in `actions.ts`; the internalMutation writer + queries in default-runtime files).

## 7. Specialist Agent Recommendations

| Wave | Agent | Rationale |
|------|-------|-----------|
| 1–4 backend | `convex-expert` | module/action/cron/idempotency patterns |
| 5 frontend | `frontend-integrator` then `ui-component-builder` | wire queries → read-only list + reconciliation detail |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch | ✅ fresh worktree off `main` at execute time |
| Commit-per-task | ✅ every task ends in a `feat(settlements):`/`docs(...)` commit |
| Pre-push verify | ✅ typecheck + build + lint in success criteria |
| Rollback | ✅ additive; revert commits + drop cron |
| Deploy order | ✅ backend before frontend; no new env var |
| Migration safety | ✅ additive optional fields only |

## 9. Documentation Checkpoints

✅ All present in Task 11 (ADR-043 + foundations §7/ADR-012 annotations) and Task 12 (SCHEMA `pos_settlements` + verbs `settlement.recorded`/`settlement.sync_skipped`, CHANGELOG, PROGRESS Task IDs, CLAUDE inventory). No gaps.

## 10. Testing Plan Assessment

**Verdict: Adequate** (becomes fully adequate once the C1 test is added). Pure `lib` units, adapter builder/normalize fixture, writer upsert/supersede, public gate + ADR-012 staff-read + `NET_MISMATCH`, behavioural. No live Xendit in CI (KYB-blocked; correct).

### Must-add (with C1)
| # | Test | Why |
|---|------|-----|
| 1 | `reconcileDay`: a txn settled on **another date** (in `allSettledRefs`, not `thisRowRefs`) is in **neither** `settled` nor `pending` | proves C1 fixed — the core misclassification |

## 11. Edge Cases to Address

- [x] Empty poll window → cron writes nothing (covered by aggregate empty test).
- [x] `EARLY_SETTLED` included (Task 3 builder).
- [x] Manual→cron supersede on same date (Task 4 test).
- [ ] C1: txn settled on another date must not be "pending" (add test).
- [ ] Pagination cursor field names (`after_id`/`has_more`) — asserted-not-verified; Task 3 Step 0 gate must confirm against a real response before relying on multi-page polls.

## 12. Approval Conditions

**To approve:**
1. **C1** — fix `reconcileDay` to compute `pending` against the union of all settlements; add the cross-date test.

**Recommended before execution:**
1. I1 — drop the verified-unnecessary `runMutation` hedge note.
2. I2 — reuse `parseWibDayLabel` for the window.

---

*Generated by /staffreview*
