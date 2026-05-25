# 017. `available_qty` computed client-side

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Stock

## Context

The phone already caches the full set of inventory SKUs + product components for offline operation ([ADR-009](./009-voucher-cache-offline.md), [ADR-025](./025-service-worker-cache.md)). Recomputing `available_qty` per product on every cart-tile render via a Convex query would be a network round-trip for data the client already has.

## Decision

`available_qty(product) = min(floor(sku.on_hand / component.qty))` across all components. **Computed in a JS selector on the client.** Never stored on the product row. The server validates the same formula on sale to catch races where on-hand changed between client cache read and server commit.

## Alternatives considered

- **Denormalise `available_qty` on `pos_products`.** Rejected: invalidates on every stock-in and every sale; cache invalidation is the hard problem. Computing fresh is cheap.
- **Server-side query that returns `{ product, available }` tuples.** Rejected: doesn't work offline. Cart-build is a primary offline use case.

## Consequences

- *Easier:* no extra storage. No cache invalidation. Works offline. Reflects "what can I sell right now" using the latest cached inventory.
- *Server still validates:* sale mutation re-reads SKU on-hand server-side and re-runs the formula. If the sale would push below zero (per [ADR-018](./018-negative-stock-allowed-flagged.md)) the row is written with the `NEG_STOCK` flag.
- *Cart-tile usage:* the cart shows product cards with their current availability badge. Tapping a product whose `available_qty < 1` shows a "low — confirm?" prompt rather than hard-blocking.
- *Stock Check screen:* shows both inventory SKUs (raw on-hand) and products (computed availability) side-by-side, demonstrating the relationship.
