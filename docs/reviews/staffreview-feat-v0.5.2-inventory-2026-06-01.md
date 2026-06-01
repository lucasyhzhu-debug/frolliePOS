# Staff review — `feat/v0.5.2-inventory`

**Date:** 2026-06-01
**Reviewer:** staffreview (architectural lens — ADR-034 deep modules)
**Base:** `1e4388f` → **Head:** `4334201` (19 commits)
**Scope:** FPOS-internal inventory slice — stock-check screen, staff recount, reactive low-stock alerting, two new ADRs.

---

## Summary

**Module-depth verdict: this change makes the affected modules measurably deeper.** The `inventory/` module grows ~+201 internal lines (`_applyLevelDelta_internal`, `_checkLowStock_internal`, two dispatch actions) behind a public surface that is mostly thin auth-+-validation wrappers; `catalog/` gains a pair of named cross-module seams (`_getSkusByIds_internal`, `_setLowThreshold_internal`) instead of being read directly from `inventory/`; `telegram/` widens by one role literal and two `sendTemplate` kinds — earned by a real new operational signal, not gratuitous. Plan fidelity is high; the v0.5.2 task-board "You'll be able to" bullets all land. The FPro-driven stock-in path is correctly deferred to v0.5.2b — no FPro coupling sneaks in.

**Verdict: ACCEPTED with minor cleanups.** Nothing blocks merge. Three Important items are worth picking up either in a follow-up commit on this branch or queued as v0.5.2.1 housekeeping. The two new ADRs (041, 042) read as legitimate engineering decisions, not docs-for-the-record.

**Headline observations:**

1. **Deep-module discipline held.** Every cross-module read goes through a named `_internal` seam. No new `ctx.db.query("pos_inventory_skus")` from inside `inventory/` — the catalog seam is honoured even in the new `_checkLowStock_internal`'s hot path.
2. **The architectural seam `_applyLevelDelta_internal` is healthy *because* it deliberately doesn't refactor the existing `upsertStockLevel` callers.** The plan explicitly told the implementer to leave sale/refund paths on the local helper; that constraint is respected and is the right call for a regression-surface-zero phase. The eventual collapse is a v0.6-housekeeping candidate.
3. **`pos_low_stock_alerts` flag-by-existence model is the cleanest dedup encoding I've reviewed in this codebase.** The "re-arm by delete" pattern is named in the ADR, mirrored in the code, and tested in both directions. No status enum to drift, no half-flipped state possible by construction.
4. **Recount cross-path parity is not yet a problem but is one design step from becoming one.** Today recount is booth-only — there is no Telegram-approval equivalent. If/when v0.6 adds an off-booth recount (e.g. founder remote-corrects a count), the `_changePinCommit_internal`-style funnel pattern will need to be applied. Note the absence; don't pre-build it.
5. **One real Important: the inventory low-stock dispatch returns silently on `role_unbound`, but the sibling `foundersSummary` writes `_auditSkip_internal` for exactly the same condition.** Pattern drift across two dispatch paths that should be siblings.

---

## Critical Issues

None.

---

## Important

### I1. `_dispatchLowStockAlert_internal` / `_dispatchRecountNotice_internal` silently return on `role_unbound`; `foundersSummary` audits the skip.

`convex/inventory/internal.ts:387–395` and `:437–445` swallow the exact-message error from `getChatIdByRole` with no audit row. `convex/telegram/foundersSummary.ts:88–99` catches the *same* error string and writes `_auditSkip_internal({ reason: "role_unbound" })`.

This is the **sibling-pattern drift** problem the v0.4 lessons memory warns about (see `v04-triple-review-lessons.md` — "audit-source threading"). The consequences:

- An operator who set up Telegram, bound `managers` and `founders`, but forgot to bind `inventory`, gets *no observability* that low-stock alerts are being silently dropped. Hours or days could pass before someone notices that on-hand crossings aren't producing messages.
- The ADR-042 text explicitly says "if the `inventory` Telegram role is unbound, the dispatch action returns silently (no error)" — but the founders path documents an *audited* silence. Two contradictory conventions in adjacent code.

**Fix scope:** add `_auditSkip_internal({ reason: "role_unbound", kind: "low_stock_alert" | "recount_notice" })` calls in both inventory dispatch actions. `_auditSkip_internal` is already in `convex/telegram/internal.ts`; widening its `reason` enum (currently `founders_summary_*`) by one literal each is the change. Audit cost is one row per dispatched-and-dropped event — bounded.

Severity: **Important** (not Critical because failure is silent-but-non-data-corrupting; the on-hand state is still correct, only the alert is lost).

### I2. `idempotencyKey: "lowstock:${sku_id}:${on_hand}"` makes the same threshold-crossing alert un-resendable if the on-hand bounces.

`convex/inventory/internal.ts:404`. Consider this sequence at threshold = 20:
1. Sale: 21 → 18. Flag inserted, dispatch scheduled with key `lowstock:<sku>:18`. Telegram delivered.
2. Recount lifts it: 18 → 25. Flag deleted (re-arm).
3. Sale: 25 → 18. Flag re-inserted, dispatch scheduled with key `lowstock:<sku>:18`. **`sendTemplate`'s idempotency cache returns the cached response from step 1; Telegram receives nothing.**

The flag was correctly deleted at step 2, so the in-database state says "we're freshly alerted". But the Telegram side gets no message because `sendTemplate` deduplicates at the idempotency layer.

This is the **action-level cache wrapping an idempotent writer** pitfall from `v051b-refunds-triple-review-lessons.md`. The fix is to thread `alerted_at` (or any monotonic value from the flag row) into the idempotency key:

```ts
idempotencyKey: `lowstock:${args.sku_id}:${args.alerted_at}`,
```

where `alerted_at` is the new flag row's timestamp. This makes the key collision-free across re-arm cycles without losing within-cycle dedup.

Severity: **Important.** In practice this would manifest as a latent "we re-flagged, why did Telegram go quiet?" bug, weeks or months after the inventory threshold was first tripped on that SKU.

### I3. `_dispatchLowStockAlert_internal` resolves chatId twice (once locally in the dispatch action, then again inside `sendTemplate` via `chatIdOverride` — no, wait — actually `chatIdOverride` skips the re-resolve; ignore this point).

(Verified by re-reading `convex/telegram/send.ts:101–106` — `chatIdOverride` is honoured and bypasses the role lookup. The dispatch action *does* re-resolve only when `chatIdOverride` is unset. Inventory's dispatches both pass `chatIdOverride`, so they are race-safe. Withdrawing this finding — leaving the trace to show what was checked.)

---

## Refinements

### R1. `_applyLevelDelta_internal` co-existing with `upsertStockLevel` is acceptable transitional debt — but mark it.

`convex/inventory/internal.ts:19–41` (the local `upsertStockLevel`) and `:285–300` (the new `_applyLevelDelta_internal`) do nearly identical work — the differences are:
- `_applyLevelDelta_internal` is an `internalMutation` (callable across module boundaries via `ctx.runMutation`); `upsertStockLevel` is a plain function (callable only in-module).
- `_applyLevelDelta_internal` returns the new `on_hand`; `upsertStockLevel` returns `void`.
- `_applyLevelDelta_internal` snapshots `now` per call; `upsertStockLevel` accepts `now` from the caller (so multiple movements in one mutation share one timestamp).

The plan explicitly said "don't refactor sale/refund callers to use the new seam — keeps regression surface zero." That's right for v0.5.2. But the pair will drift if a future change touches one and not the other. Two cheap mitigations:

- Add an explicit JSDoc cross-reference on `upsertStockLevel`: *"v0.6 housekeeping: collapse into `_applyLevelDelta_internal` once sale/refund test coverage is sufficient to absorb the now-snapshot semantics change."*
- File a v0.6 task: `inventory-housekeeping-collapse-level-upsert`.

Not a blocker; explicitly documented intent prevents the drift from becoming surprise debt.

### R2. `getRecountState` returns `last_recount_at: null` on no-row, but the schema requires `last_recount_at: v.number()`.

`convex/inventory/schema.ts:46–49` defines `pos_recount_state` with `last_recount_at: v.number()` (required). `convex/inventory/public.ts:329` returns `last_recount_at: row?.last_recount_at ?? null`. That is fine for the API shape but reveals a **schema-vs-return-type duality**: the row, if it exists, is guaranteed to have a number. The `?? null` is for the "no row" case only.

The current type elision (TypeScript infers `number | null`) is correct, but a reader skimming the public.ts could be tempted to "narrow" the type to `number` "since the schema says so" — which would crash on first-ever load. A one-line comment would close that read trap:

```ts
// `null` covers the "no row yet" case — the schema's required `last_recount_at`
// is row-local. Don't tighten to `number` here.
```

Pattern matches `v051a-receipts-triple-review-lessons.md` — "schema-literal vs return-type."

### R3. `getSkuDetail` returns `name: sku?.name ?? String(args.skuId)` — fallback to an `Id` string is a customer-facing lie.

`convex/inventory/public.ts:311`. If the SKU has been hard-deleted (which v0.5.2 doesn't permit but isn't enforced), the screen would render the raw Convex Id as the SKU name. The catalog seam returns an empty array (silently dropped) when the SKU is missing; the public API papers over that with a string-cast that produces something like `j578xyz...`.

Better: surface `null` and have the UI render "Unknown SKU" or "(deleted)". The frontend already handles missing data states elsewhere (e.g. `detail === undefined` → "Memuat…"). Pattern matches `v051a-receipts-triple-review-lessons.md` — "hardcoded deferred values become customer-facing lies."

Note this also applies to `recordRecount`'s notice line: `noticeLines.push({ sku_name: sku?.name ?? String(skuId), ... })` (`convex/inventory/public.ts:126`). The Telegram message to managers could render a raw Id in the same hard-delete scenario.

Severity: low (SKUs are not hard-deleted in v0.5.2; the soft-delete `active: false` convention from ADR-034 §"Edge cases" keeps the read intact). Worth fixing in a small follow-up.

### R4. `listInventory` filters via "active SKUs" but the path is two queries — one for ids, one for rows.

`convex/inventory/public.ts:258–265`:
```ts
const activeIds = await ctx.runQuery(internal.catalog.internal._getActiveSkuIds_internal, {});
const skus = await ctx.runQuery(internal.catalog.internal._getSkusByIds_internal, { skuIds: activeIds });
```

Two round-trips into catalog to get `{ skuId, name, low_threshold }` for active SKUs. A single `_getActiveSkus_internal` returning the projected rows directly would halve the catalog touches. Cost vs benefit: the SKU set is ~10 rows in v0.5.2; the round-trips are cheap; the **separation of concerns** (active filter vs row projection) reads cleaner than a combined helper. Acceptable as-is; flag if active-SKU count ever crosses ~50.

### R5. `_checkLowStock_internal`'s catalog read uses `_getSkusByIds_internal` for one row — slightly heavier than needed.

`convex/inventory/internal.ts:322`:
```ts
const [sku] = await ctx.runQuery(internal.catalog.internal._getSkusByIds_internal, { skuIds: [skuId] });
```

Building a one-element array and array-destructuring works but signals to the reader "batch read"; the call site is per-SKU. An additional `_getSkuById_internal` would be a marginal cleanup, but adds a third near-duplicate seam. Stay with the batch helper — the noise is a one-line cost paid for the simpler catalog surface. Not a finding.

### R6. ADR-041 and ADR-042 are legitimate engineering decisions.

Both ADRs follow the established template (Context / Decision / Alternatives / Consequences / Affects), reject the obvious alternatives with reasoning that holds up (manager-PIN-gated recount, cron-based scan, separate-threshold-table), and document the *easier / harder* trade-offs honestly. The cross-reference between the two ("recount accuracy has no consumer without alerts; alerts misfire without recount accuracy") is the architectural insight that justifies shipping them in tandem.

No docs-for-the-record padding. They will read well in 6 months.

### R7. Recount `idempotencyKey` collision potential when the same operator submits two recounts in the same second.

`convex/inventory/internal.ts:451`: `idempotencyKey: recount:${args.recorded_at_iso}`. The `recorded_at_iso` is `new Date(now).toISOString()` from the parent mutation. If two different recounts on different SKUs both finalise within the same millisecond (vanishingly rare on a single device), the second dispatch would be cached against the first. The ADR comment acknowledges "in practice impossible for the same operator to fire two recounts in one ms."

Acceptable. If concurrency ever becomes a concern, append a per-recount random nonce to the key. Trace this thought in the comment for future grep-ability — already done.

### R8. `recordRecount` emits one `_dispatchRecountNotice_internal` per recount even when only the recount-state row was touched (no SKU changes after the loop).

Re-read: `if (touched.length === 0) return { ok: true, changed: 0 };` short-circuits before the dispatch (`convex/inventory/public.ts:134`). So a no-op recount doesn't fire Telegram. **Withdraw R8** — the code is correct. Leaving the trace for transparency.

---

## Plan-fidelity check

The v0.5.2 PROGRESS.md block (`docs/PROGRESS.md:873–909`) enumerates eight task-board items. The branch ships all eight:

| Plan item | Status | Where |
|---|---|---|
| `recordRecount`, `setLowThreshold`, `listInventory`, `getSkuDetail`, `getRecountState` | Shipped | `convex/inventory/public.ts` |
| `_checkLowStock_internal`, `_dispatchLowStockAlert_internal`, `_dispatchRecountNotice_internal` | Shipped | `convex/inventory/internal.ts` |
| `_getSkusByIds_internal`, `_setLowThreshold_internal` cross-module seams | Shipped | `convex/catalog/internal.ts` |
| `/stock` inventory list | Shipped | `src/routes/stock/index.tsx` |
| `/stock/recount` recount flow | Shipped | `src/routes/stock/recount.tsx` |
| `/stock/:skuId` SKU detail + manager threshold edit | Shipped | `src/routes/stock/$skuId.tsx` |
| Home-screen hourly recount nudge | Shipped | `src/hooks/useRecountNudge.ts` + `src/routes/home.tsx:82–89` |
| Schema: `pos_low_stock_alerts`, `pos_recount_state`, `recount` source literal | Shipped | `convex/inventory/schema.ts` |
| ADR-041, ADR-042 | Shipped | `docs/ADR/041-*.md`, `docs/ADR/042-*.md` |
| New `inventory` Telegram role | Shipped | `convex/telegram/config.ts:5` |

The FPro-driven stock-in path is correctly deferred — `docs/PROGRESS.md:913` documents v0.5.2b as backlog, and no FPro coupling appears in this branch.

---

## Architectural-risk audit

| Concern | Verdict |
|---|---|
| Real-time subscription load (low-stock check per sale) | Acceptable. One indexed read of `pos_stock_levels` per touched SKU, dedup'd via `Set`. Counter velocity is ~30 sales/hour worst case. |
| Schema migration | Additive only. `pos_low_stock_alerts` and `pos_recount_state` are empty on first deploy; `pos_stock_movements.source` gains a literal — backfill-free. |
| Idempotency harness bypassed? | No. Both public mutations (`recordRecount`, `setLowThreshold`) use `withIdempotency` with `authCheck`. ESLint rule still passes. |
| Audit harness bypassed? | No. Every state-changing path emits `logAudit`. New audit actions documented in `docs/SCHEMA.md:636–638`. |
| Cross-module table reads? | None. `inventory/` reads catalog only via `_getActiveSkuIds_internal`, `_getSkusByIds_internal`, `_setLowThreshold_internal`. |
| FPro coupling | None. Cross-deployment integration deferred to v0.5.2b per plan. |
| Test coverage | `inventory.test.ts` covers recount happy path, idempotent replay, negative-rejection, first-ever count, low-stock flag insert / re-arm / threshold-0 / no-level-row, dedup, manager-gating. `telegramHtml.test.ts` covers both new renderers including HTML escaping. `confirmPaid.test.ts` updated to drain the new scheduled dispatches. |

---

## Items for the v0.6 backlog

- (R1 follow-up) `_auditSkip_internal` reason-union expansion + thread through inventory dispatch actions.
- (I2 follow-up) Move `lowstock:` idempotency key from `on_hand` to `alerted_at` to handle re-arm cycles cleanly.
- (R1) Collapse `upsertStockLevel` → `_applyLevelDelta_internal` once sale/refund test coverage absorbs the now-snapshot semantics change.
- (R3) Stop falling back to `String(skuId)` in public APIs; render "(deleted)" or return `null` and let the UI handle it.

---

## STAFFREVIEW COMPLETE
