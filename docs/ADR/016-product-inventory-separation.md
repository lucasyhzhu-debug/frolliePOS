# 016. Product ↔ Inventory separation

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Stock

## Context

Frollie sells the same physical cookie at different pack sizes with non-linear pricing — Dubai cookies sell as 1 pc (Rp 45k), 3 pcs (Rp 125k, a Rp 10k bundle saving), and 8 pcs (Rp 340k, a Rp 20k saving). The Mixed Box bundles four different cookies into one product. Stock-in happens at the singles level (kitchen produces individual cookies); selling decrements the right number of singles per sale line.

A flat `products` table (price × on-hand) can't represent this — selling "Dubai 3pcs" needs to decrement 3 from a single `dubai` stock count, and "Mixed Box" needs to decrement 1 each from 4 different counts.

## Decision

Three tables:

- **`pos_inventory_skus`** = atoms. Singles only. What the kitchen produces, what staff stock-in adds to. `{ id, name, unit ("piece"), on_hand, low_threshold, last_movement_at }`.
- **`pos_products`** = sellable units. Pack-size pricing. `{ id, sku_family ("dubai"), pack_label ("3 pcs"), price_idr, active, sort_order }`.
- **`pos_product_components`** = join. `{ product_id, inventory_sku_id, qty }`. "Dubai 8pcs" = 1 row `(dubai_sku, 8)`. "Mixed Box" = 4 rows `(choco_sku, 1)`, `(matcha_sku, 1)`, `(lotus_sku, 1)`, `(brownie_sku, 1)`.

**Stock-in only happens at the SKU level.** Products are never restocked directly.

## Alternatives considered

- **One `products` table with on-hand per product.** Rejected: selling Dubai 1pc would have to also decrement Dubai 3pcs and 8pcs availability — leaves the model fighting reality.
- **Compute SKU on-hand from a "starting count + sales history" sum every read.** Rejected: too expensive on the catalog query that runs frequently. Denormalised `on_hand` with [reconciliation](./026-reconciliation-on-reload.md) is the standard pattern.
- **No bundles — model Mixed Box as a fourth atomic SKU.** Rejected: doesn't extend if/when more bundles are added; the join table is the right abstraction.

## Consequences

- *Easier:* selling and stock-in are different operations on different tables. UI surfaces both ("which product can I sell?" → query products + computed availability; "what do I have on the shelf?" → query inventory_skus).
- *Sale-time decrement:* one `pos_stock_movement` per (product_line, component) tuple, qty signed negative. Refund mirrors with positive qty.
- *Computed `available_qty(product)`:* see [ADR-017](./017-available-qty-computed-clientside.md).
- *Manager UI:* `ProductsManager` screen (laptop-first) edits both panes side-by-side with the components join visualised.
