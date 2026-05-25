# 020. Stock movement source enum

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Stock

## Context

Stock movements happen for several distinct reasons. Without an explicit reason field, reports devolve into heuristics ("if `qty > 0` and no `transaction_ref`, probably a stock-in"). For reconciliation and audit, the source needs to be unambiguous and required on every row.

## Decision

Every `pos_stock_movements` row carries a required `source` field with a fixed enum:

| source | sign | description |
|---|---|---|
| `sale` | negative | decrement on sale; `ref_type = transaction`, `ref_id = transaction_line_id` |
| `stock_in_kitchen` | positive | new units arriving from the kitchen (default Stock In path) |
| `stock_in_adjustment` | positive | manager-PIN reconciliation when the count drifted |
| `stock_in_return` | positive | non-refund return-to-shelf (rare; e.g., damaged box returned by partner) |
| `refund` | positive | re-credit when a sale is refunded ([ADR-019](./019-refund-re-credits-stock.md)); `ref_type = refund`, `ref_id = refund_line_id` |
| `spoilage` | negative | manager-PIN-gated; for binned/damaged items; requires `notes` |

Adjustment rows require a `reason` string. Spoilage rows require manager-PIN.

## Alternatives considered

- **Free-text `source` column.** Rejected: inconsistent values prevent reliable filtering. Enum + lint catches typos at code review.
- **Lump everything into `qty_delta` with no reason field.** Rejected: loses reporting fidelity. "Why did inventory drop?" must be answerable from data.

## Consequences

- *Easier:* "show me all spoilage this month" is a single filtered query. Stock-in source chips ("Kitchen / Adjustment / Return") on the Stock In screen map 1:1 to enum values.
- *Harder:* adding a new source requires schema enum update, mutation argument update, UI chip update, and a CLAUDE.md note. Friction is intentional — sources should not multiply casually.
- *Schema:* `pos_stock_movements { id, inventory_sku_id, qty (signed), source (enum), ref_id?, ref_type?, staff_id, approved_by? (for spoilage/adjustment), notes? (required for adjustment/spoilage), created_at }`.
- *Indexes:* `by_sku_date` on `(inventory_sku_id, created_at)`, `by_source_date` on `(source, created_at)`.
