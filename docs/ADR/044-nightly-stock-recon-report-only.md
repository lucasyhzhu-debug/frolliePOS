# 044. Nightly stock reconciliation: ledger is truth, drift is reported not corrected

**Date:** 2026-06-02
**Status:** Accepted
**Group:** Inventory

## Context

`pos_stock_levels.on_hand` is a denormalized cache; the ledger is `pos_stock_movements` (CLAUDE.md rule #8). The cache is updated incrementally on every sale, refund, recount, and (v0.6+) spoilage. Theoretically a partial-mutation, manual-dashboard edit, or missed audit could drift the cache from the ledger; we need a periodic check that catches drift before it compounds.

## Decision

A nightly cron at 02:00 WIB rebuilds the ledger sum per active SKU and compares against the cached `on_hand`. When they differ, write a `pos_stock_drift_log` row + emit a `stock.recon_drift` audit + Telegram-alert the `inventory` role with a summary. **Do NOT silently overwrite `pos_stock_levels` to match.** A manager investigates the root cause and either (a) patches the cache manually, (b) re-runs the cron after fixing the underlying movement issue, or (c) marks the drift "investigated, accepted as-is" via `stock.recon_drift_resolved`.

## Alternatives considered

- **Silent auto-correct cache to ledger.** Rejected — masks the corruption source. The whole point of the recon is to detect the bug; rewriting the cache hides it.
- **Block sales when drift is detected.** Rejected — drift is internal accounting hygiene, not a customer-facing failure mode (ADR-018 flag-don't-block spirit).
- **Hourly cron instead of nightly.** Rejected — drift accumulates slowly; nightly is enough; hourly costs Telegram noise for a low-signal check.

## Consequences

- *Easier:* drift becomes visible early; root cause stays findable.
- *Harder:* the manager workflow has a new "drift triage" task. Mitigated by the Telegram alert (no polling) + the "Mark resolved" affordance.
- *Schema:* `pos_stock_drift_log` (append-only); `by_unresolved` index for the open-drift list. Indefinite retention (rows are small, ≤ 1 per night per SKU).
- *Related:* CLAUDE.md rule #8 (cache vs ledger separation); ADR-018 (flag-don't-block philosophy applied to recon).

## Affects other ADRs

- **Relates to [ADR-018](./018-negative-stock-allowed-flagged.md):** applies the same flag-don't-block philosophy — drift is detected and surfaced, never silently corrected or used to halt operations.
- **Relates to [ADR-020](./020-stock-movement-source-enum.md):** the recon reads the full movement ledger; no new `source` enum value is introduced (the recon itself never writes a movement).
