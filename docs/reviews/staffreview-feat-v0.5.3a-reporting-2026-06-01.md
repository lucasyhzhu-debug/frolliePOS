# Staffreview: v0.5.3a Reporting Slice
**Branch:** feat/v0.5.3a-reporting
**Reviewed:** 2026-06-01
**Verdict (depth):** **Deeper** — the slice adds substantial behaviour (history list, manager dashboard, share-receipt activation, day-window aggregation) hidden behind four narrow public functions plus three single-purpose `_internal` seams that respect existing module ownership.

## Summary

The slice is structurally aligned with ADR-034 across the board: every cross-module read goes through a named owner-module `_internal` seam (`auth._listStaffNames_internal`, `auth._resolveSessionRole_internal`, `payments._instrumentForTxn_internal`, `refunds._listForTransaction_internal`), and there are zero direct `ctx.db.query(...)` calls into a foreign module's tables in `transactions/`. The `transactions/lib.ts` runtime-neutral pure-aggregator file matches the existing `refunds/lib.ts` and `approvals/lib.ts` precedent — three siblings now, so the convention is established, not invented. `DayTxn`/`DaySummary` are POS-internal types defined in this module; nothing about them locks future FPro integration because `convex/api/v1/` (the external surface) doesn't consume them.

The four new `transactions/public.ts` exports are earned: each has a distinct gate (`listDayTransactions` non-throwing with `[]` on bad session, `dashboardSummary` throws `MANAGER_ONLY`, `getTransactionDetail` returns null on out-of-scope, `shareReceipt` is a mutation with the strict idempotency contract). Collapsing them would force callers to disambiguate at the FE — three queries with different return-shape contracts is the simpler surface. The slice is the first real caller of the v0.5.1 dormant `_lazyMintReceiptToken_internal` seam, validating the dormant-seam pattern.

The principal concern is **reactive subscription load** on the day-window read: each rendered txn triggers two `ctx.runQuery` round-trips (refunds-list and payments-instrument) inside `_fetchDayWindow_internal`, so a 50-txn day = ~101 internal queries per re-fire, and `useQuery(listDayTransactions)` re-fires every time any paid txn is inserted/patched in the window. This is acceptable for v1 booth volumes but worth flagging as the next-likely scaling pinch point. A secondary concern is that the `polling` literal for `confirmed_via` still exists in the schema and is presented to staff via `CONFIRMED_VIA_LABEL`, even though no production writer emits it; this is documentation-debt more than a defect.

## Critical Issues

None block merge. The slice is correct against the plan and against ADR-034.

## Improvements

### I1 — Day-window read is O(N) cross-module hops, re-fires reactively

`_fetchDayWindow_internal` does, per txn in the window:
- 1 × `ctx.db.query(pos_transaction_lines).withIndex("by_transaction", ...)` (in-module, cheap)
- 1 × `ctx.runQuery(internal.refunds.internal._listForTransaction_internal, ...)`
- 1 × `ctx.runQuery(internal.payments.internal._instrumentForTxn_internal, ...)`

For a 50-txn day that's ~101 queries per `_fetchDayWindow_internal` call, and `useQuery(listDayTransactions)` re-runs on **every** mutation that touches `pos_transactions` in the window (which is every sale). Convex caches reactive queries internally, but each cross-module `runQuery` is its own subscription dependency, so the query engine has to revalidate the whole graph on every fire.

For v1 (single booth, ≤100 txn/day) this is fine. But the slice ships two screens that *will* subscribe simultaneously (`/history` open in one tab, `/mgr/dashboard` in another, both calling `_fetchDayWindow_internal` with the same window), and each gets its own dependency graph. Two mitigations to consider:

1. **Batch the refunds + instrument reads.** Add `refunds._listForTransactionsBatch_internal({txnIds}) → Record<txnId, Refund[]>` and `payments._instrumentForTxnsBatch_internal({txnIds}) → Record<txnId, Instrument>`. Reduces the per-call count from `2N+1` to `3`. Pattern is already used in catalog/inventory (`_getProductsByIds_internal`, `_getOnHandBySkus_internal`) so it's consistent. Likely lands when v0.5.3 inflates the dashboard with more drill-downs.

2. **(Don't) denormalize `instrument` onto `pos_transactions`.** Tempting but wrong: it pulls payments-owned data into a transactions-owned row, exactly the ADR-034 coupling to avoid. Skip.

Recommend (1) as a follow-up — not a blocker for v0.5.3a since the day-volume ceiling is bounded.

### I2 — `_listStaffNames_internal` returns ALL staff every call

The helper collects the entire `staff` table (active + inactive) and is called once per `_fetchDayWindow_internal` invocation. For the current 2-3 staff this is a non-issue. But the comment says "Includes inactive staff so historical txns by a now-deactivated staff member still get a name." which is correct — but pulling unbounded inactive rows for a daily-window query is a smell.

The minor fix is to make this read a `Map<Id, name>` once at module init, but Convex queries can't cache across calls. A better fix is to do the lookup *per-txn* with `ctx.db.get(staff_id)` — yes that's N+1 but each `get` is keyed and cheap, and bounds the read to the actual cardinality of `staff_id`s in the window (≤3 in practice). Or accept this as fine for v1 and revisit when staff count crosses ~20.

No action needed for v0.5.3a — flagging the design choice.

### I3 — `confirmed_via: "polling"` is still exposed in FE labels

`CONFIRMED_VIA_LABEL` in `src/routes/history/$txnId.tsx:49` maps `polling → "Otomatis (polling)"`. ADR-036 retired polling for QRIS/FVA, but the schema literal stays for backward-compat. Showing "Otomatis (polling)" to a staff member viewing a v0.3 archived receipt is technically truthful, but the project has otherwise stopped surfacing the literal (see the comment on the validator in `transactions/schema.ts:40` and CLAUDE.md ADR-036 wording).

Minor: either remove `polling` from the FE label dict and fall back to `"Otomatis"` for v0.3 rows that still carry it, or accept the dual-label as honest provenance. Either way is fine — currently a minor inconsistency.

### I4 — `windowForLabel` parses `"YYYY-MM-DD"` without validation

`transactions/public.ts:14-18` does `label.split("-").map(Number)` and trusts the result. A malformed manager-supplied `day` arg (e.g. `"yesterday"`, `"2026-13-01"`) silently produces `NaN`-bearing math → an empty day window. The FE date picker won't emit malformed values, but the public mutation surface accepts `v.string()` and Convex's `v.string()` doesn't enforce shape.

Add a one-line `/^\d{4}-\d{2}-\d{2}$/.test(label)` guard and throw `INVALID_DAY` if it fails. Trivial fix; closes a small input-validation hole.

## Refinements

### R1 — `DayTxn` carries `staff_name` but `getTransactionDetail` doesn't

`listDayTransactions` returns `DayTxn[]` with `staff_name` denormalised, but `getTransactionDetail` returns `{txn, lines, refundStatus, receipt_token}` — no staff name. The FE detail page falls back to ignoring the field (it doesn't render staff). If a future change wants to show "Diproses oleh Sari" on the detail, it'll need a new fetch path. Acceptable for v0.5.3a; flagging for v0.5.3 dashboard expansion.

### R2 — `_resolveSessionRole_internal` is 8 lines duplicating `_resolveSession_internal`

The two functions differ only in whether they include `role` in the return shape. The author's docstring on `_resolveSessionRole_internal` (`auth/internal.ts:329-339`) explicitly chose duplication over widening `_resolveSession_internal`'s return to avoid coupling callers that don't care about role. Per the user's MEMORY (`v0.5.0 triple-review lessons`), the codebase prefers duplication at small body size over speculative abstraction. The choice is consistent with prior reviews. Keep as-is.

### R3 — `_instrumentForTxn_internal` and `_getPaidInvoiceForTxn_internal` overlap

Both fetch invoices for a txn. `_instrumentForTxn_internal` filters non-cancelled + maps method → enum; `_getPaidInvoiceForTxn_internal` keeps cancelled and returns the row. They could share a "list invoices for txn newest-first" helper, but the body is ~6 lines each and the return shapes differ enough that extracting an inner helper would not net out. Leave as-is.

### R4 — `topSkus` is gross-of-refunds; dashboard doesn't surface this

`computeDaySummary` aggregates `qty` (gross units sold) into `topSkus`, intentionally ignoring `refunded_qty`. The doc comment in `lib.ts:24-27` calls this out. The dashboard card "Top SKU" doesn't label this — a manager reading "Dubai 8pcs: 12" doesn't know whether that's gross or net. Add a card subtitle or footnote ("unit terjual hari ini, sebelum refund") when v0.5.3 expands the dashboard.

### R5 — `needsAttention` only counts `NEG_STOCK`

The `flags` bitset has three values (`NEG_STOCK`, `VOUCHER_OVER_REDEEMED`, `PAYMENT_AMOUNT_MISMATCH`); the dashboard counts only `NEG_STOCK`. The inline comment justifies this ("voucher/amount mismatch reconciled elsewhere"), which is correct for now. But the card title "Perlu perhatian" implies all-flags. Either rename the card to "Stok negatif" or expand the aggregate to all-flag-bits with a breakdown. The implementation is correct; the labelling could mislead.

## Architecture notes

### A1 — `lib.ts` is now the official runtime-neutral idiom

Three sibling files (`approvals/lib.ts`, `refunds/lib.ts`, `transactions/lib.ts`) all do the same thing: pure functions + plain types, no Convex types in the imports, V8-safe. This is the right shape and now feels canonical. Worth a one-paragraph mention in CLAUDE.md or ADR-034's "Cross-module patterns" section so the next module that wants the same thing finds the precedent.

### A2 — The slice validated the dormant-seam pattern

`_lazyMintReceiptToken_internal` shipped in v0.5.1 with no caller; v0.5.3a `shareReceipt` is its first real consumer. The seam Just Worked: no schema migration, no audit-verb addition, no widening — the public mutation wraps the seam, threads idempotency, and the audit row was already correct from v0.5.1. This is good evidence the "ship the seam dormant, callers come later" pattern is sound. Document it as a deliberate technique in CLAUDE.md if not already.

### A3 — `DayTxn` shape is POS-internal

The aggregator types (`DayTxn`, `DaySummary`, `Instrument`) live entirely under `convex/transactions/`. They're imported by `transactions/public.ts` (consumed by the React FE via `convex/_generated/api`) but the external `convex/api/v1/` surface — which is the actual graft point for FPro — does not touch them. The `instrument: "qris" | "bca_va" | "unknown"` enum is Xendit-coupled today; when v1.1 brings another payment provider it'll widen to `"qris" | "bca_va" | "<new>" | "unknown"` without breaking POS-internal callers (TypeScript exhaustive checks will surface the dashboard card that needs a new branch). The graft remains free.

### A4 — Cross-module count

Cross-module `_internal` calls from this slice:
- `auth._resolveSessionRole_internal` — new
- `auth._requireManagerSession_internal` — existing
- `auth._listStaffNames_internal` — new
- `payments._instrumentForTxn_internal` — new
- `refunds._listForTransaction_internal` — existing
- `receipts._lazyMintReceiptToken_internal` — existing (first activation)

All six are owner-module-owned, narrow-arg/narrow-return. Zero direct `ctx.db.query(other_table)` calls in the slice. ADR-034 compliance is clean.

### A5 — Plan fidelity

Task-by-task vs shipped:
- T1 refundStatus extract — ✅ shipped, signature matches plan, both call sites delegate
- T2 day-summary aggregators — ✅ shipped, `computeDaySummary` matches plan
- T3 `_resolveSessionRole_internal` — ✅ shipped, sibling of `_resolveSession_internal`, non-throwing
- T4 `_fetchDayWindow_internal` — ✅ shipped, all three internal deps wired
- T5 `listDayTransactions` — ✅ shipped with staff today-collapse
- T6 `dashboardSummary` — ✅ shipped manager-gated
- T7 `getTransactionDetail` — ✅ shipped, **but** returns `null` on out-of-scope instead of throwing `OUT_OF_SCOPE` per plan. This is a deliberate post-plan adjustment (commit `faafbed`, "return null instead of OUT_OF_SCOPE throw + test hygiene") aligned with the graceful-degrade pattern used elsewhere in the project. Captured correctly in CLAUDE.md / SCHEMA.md / CHANGELOG.md.
- T8 `shareReceipt` — ✅ shipped with `withIdempotency` + `authCheck` per rule #21
- T9 FE history list + detail — ✅ shipped
- T10 FE dashboard cards — ✅ shipped (all seven cards)
- T11 register routes — ✅ shipped
- T12 docs — ✅ shipped

No scope creep, no omissions.

### A6 — Out-of-scope graceful-degrade vs throw

The decision to return `null` from `getTransactionDetail` on staff-prior-day rather than throw is the right call for the booth UX: staff tapping an old permalink (e.g. saved as bookmark before lock+resume reset their context) should see the "tidak ditemukan" card, not an ErrorBoundary. The trade-off is observability — a forensic query asking "did any staff try to read out-of-scope txns?" can't find these because there's no audit row. For v0.5.3a this is fine; if abuse is observed later, a one-line `logAudit({source: "booth_inline", action: "txn.out_of_scope_view"})` on the null branch closes the gap without changing the user-facing behaviour.

## Final word

Ship it. The two follow-ups worth filing are I1 (batch the day-window reads when the dashboard expands) and I4 (validate `day` label shape). Neither blocks v0.5.3a.
