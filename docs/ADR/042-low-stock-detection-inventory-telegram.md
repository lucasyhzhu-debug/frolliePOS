# 042. Reactive low-stock detection via `low_threshold` + `inventory` Telegram role

**Date:** 2026-06-01
**Status:** Accepted
**Group:** Inventory

## Context

v0.5.2 is the first slice of the inventory feature. Two questions need decisions:

1. **When** does the system notice stock is running low?
2. **Who** gets told?

The catalog already defines `pos_inventory_skus.low_threshold: v.number()` as a required field — populated for every SKU since the schema's inception. The reorder-point data *exists*; what has been missing is the **detection logic** that consumes it, and the **routing** for the resulting alerts.

Two detection strategies were considered: a **periodic cron** that scans all SKUs every N minutes, vs. a **reactive check** that fires inside the sale path on every decrement. Counter velocity at the booth is high (a Dubai 8pc can sell through 20+ pcs in a busy hour), so any lag between "stock crossed threshold" and "managers know" matters operationally.

Routing — who receives the alert — is its own choice. The existing `managers` Telegram role is for approval/governance flows ([ADR-035](./035-telegram-as-internal-comms.md), [ADR-041](./041-recount-staff-absolute-stock-update.md)). Low-stock is an *operations* signal (kitchen / restock crew), not a governance one; mixing them into the managers chat creates noise.

## Decision

**Reactive in-sale-path detection, dedup-flag table, routed to a new `inventory` Telegram role.**

### 1. Reorder point reuses the existing catalog `low_threshold`

`pos_inventory_skus.low_threshold` is the single source of truth. No new `pos_stock_thresholds` table. Manager updates the threshold via a new `inventory.setLowThreshold` public mutation (manager-PIN gate inherited from the manager-only session check; audited as `stock.low_threshold_set` with before/after values).

### 2. Reactive check on every decrementing movement

`_checkLowStock_internal` is called once per **uniquely-decremented** SKU immediately after `_recordSaleMovement_internal` writes its movements (and after refund re-credits, and after recount commits per [ADR-041](./041-recount-staff-absolute-stock-update.md)). Two transaction lines on the same SKU trigger one check (SKU-deduped via a `Set` before dispatch). The check reads the SKU + its current `on_hand` from `pos_stock_levels`, compares to `low_threshold`, and writes the flag row + schedules the Telegram dispatch if the threshold is crossed and no flag exists.

### 3. Dedup-flag table only, re-arm by delete

`pos_low_stock_alerts` carries `{ inventory_sku_id, alerted_at, updated_at }` — **the row's existence IS the "we already alerted on this SKU" flag.** No status enum. Re-arm happens by *deleting* the row when `on_hand` climbs back to or above the threshold (e.g. after stock-in or a recount that raises the number). Deletion (rather than patching `alerted_at: undefined`) makes the re-arm path obvious in code and impossible to leave half-flipped.

### 4. New `inventory` Telegram role

Low-stock alerts route to the `inventory` chat (operations / kitchen / restock). Recount notices ([ADR-041](./041-recount-staff-absolute-stock-update.md)) route to the `managers` chat. Sibling roles, distinct dispatch paths, both populated via the existing `/mgr/telegram-chats` admin UI ([ADR-037](./037-telegram-self-registration-role-indirection.md)). `KNOWN_TELEGRAM_ROLES` gains `"inventory"`.

### 5. Fail-isolated Telegram dispatch

The Telegram send happens in a scheduled internal action (`ctx.scheduler.runAfter(0, ...)`) so a Telegram outage cannot roll back the sale. The flag write and audit row **are** in the sale transaction — those are local DB operations that should succeed-or-fail together with the sale itself. Idempotency key for the scheduled send is `lowstock:${sku_id}:${on_hand}` (collision-proof across SKUs with the same display name; re-firing the same alert at the same on-hand level is a no-op).

## Alternatives considered

- **Separate `pos_stock_thresholds` table.** Pros: explicit table for the operational concern. Cons: `low_threshold` already exists on every SKU and is a required field; adding a second table that duplicates one number per row creates a synchronisation risk (two sources of truth) for zero benefit. The manager edit UI is the same shape either way. **Rejected.**
- **Cron-based scan (e.g. every 15 minutes).** Pros: simpler dispatch (one scheduled job, no in-mutation logic); independent of sale-path latency. Cons: counter velocity at the booth is fast enough that a 15-minute lag turns "near-real-time" into a misnomer; a SKU can go from healthy to critically low inside one cron window. The reactive check adds a single indexed read per touched SKU in the sale mutation — negligible cost (the SKU was already in scope for the decrement). **Rejected.**
- **Threshold-per-store table for v1.0 multi-stall.** Pros: clean multi-tenant data model. Cons: v0.5.2 is single-stall; over-modelling now hurts. When v1.0 introduces multi-stall, that schema migration is orthogonal to the *detection logic* — the migration moves the threshold field, not the algorithm. **Deferred.**
- **Re-route low-stock to the `managers` chat (no new role).** Pros: fewer Telegram bindings to manage. Cons: low-stock is an *operations* signal, not a governance one — kitchen/restock crew need it, managers don't necessarily. Mixing them into the managers chat creates approval-vs-operations noise that hurts both flows. **Rejected.**

## Consequences

- *Easier:* manager UI for threshold edits is one form per SKU; no new table model.
- *Easier:* detection is near-real-time at booth velocity — a SKU crosses threshold inside the sale that crossed it, and the alert is on its way before the customer leaves the counter.
- *Easier:* flag dedup is one row's existence — `pos_low_stock_alerts` rows in the table are exactly the set of currently-flagged SKUs; no scan-and-filter needed for the manager view.
- *Harder:* every decrementing path (sale commit, refund re-credit, recount commit) must call `_checkLowStock_internal` on each touched SKU. Forgetting the call in a new write path leaves alerts un-armed — code review catches it; the seam is one named internal helper, called from exactly three places.
- *Default behaviour:* `low_threshold` defaults to `0` on existing SKUs (catalog schema). At threshold `0`, the only condition that fires an alert is `on_hand < 0` — so unseeded SKUs silently never alert until a manager sets a real threshold. **This is the right default:** don't spam alerts for SKUs the operator hasn't decided what "low" means for yet.
- *Unbound role:* if the `inventory` Telegram role is unbound, the dispatch action returns silently (no error). The flag + audit are committed regardless. Once an operator binds `inventory` via `/mgr/telegram-chats`, subsequent crossings will alert; the *already-flagged* SKU stays flagged (no retroactive replay) and will only alert again after it re-arms.
- *Audit:* `stock.low_stock_alerted` is written **only on flag insert** (the trigger event). Re-arm (flag delete) is silent — there is nothing operationally interesting about a SKU climbing back above threshold, and an audit row per re-arm would noise the log without informing anything.
- *Breaks if wrong:* if `low_threshold` accuracy drifts (e.g. manager forgets to bump it as the catalog evolves), alerts misfire — but this is bounded by the always-edit-via-mutation audit trail (`stock.low_threshold_set` records every change, manager and timestamp).

## Affects other ADRs

- **Extends [ADR-018](./018-negative-stock-allowed-flagged.md):** the NEG_STOCK flag and the low-stock flag are independent — a SKU can be flagged low without being negative, and vice versa. Both flags coexist in the same `pos_stock_levels` row's downstream surface.
- **Relates to [ADR-031](./031-convex-server-time-wins.md):** `alerted_at` is set via `Date.now()` inside the Convex internal mutation, never client-supplied.
- **Relates to [ADR-034](./034-deep-modules-surface-apis.md):** the catalog seam (`_getSkusByIds_internal`, `_getStockLevelsByIds_internal`) is the read surface; `_checkLowStock_internal` lives in the inventory module and reads through it. No cross-module direct table access.
- **Relates to [ADR-035](./035-telegram-as-internal-comms.md):** the new `inventory` role follows the same role-indirection pattern as `managers` and `founders`. `KNOWN_TELEGRAM_ROLES` is the registry.
- **Upstream dependency on [ADR-041](./041-recount-staff-absolute-stock-update.md):** detection accuracy depends on `on_hand` correctness, which depends on periodic recounts. Without recounts, low-stock alerts misfire (phantom stock masks true lows); without low-stock alerts, recount accuracy has no consumer. The two ADRs are designed in tandem.
