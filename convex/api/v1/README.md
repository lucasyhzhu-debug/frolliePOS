# Frollie POS External API — v1

Versioned outbound HTTP surface for external consumers (Frollie Pro and future).
Per ADR-034 §"Layer 2 — External API surface".

## Status: scaffold only (v0.2.1)

No endpoints implemented yet. First endpoint (`GET /api/v1/transactions`) lands
in v0.3 alongside the `pos_transactions` table.

## Conventions (when endpoints land)

- Path prefix: `/api/v1/`
- Auth: `Authorization: Bearer <token>` (see `_auth.ts` + ADR-034 §"API authentication model")
- Response shape: `{ data: [...], nextCursor: string | null }`
- Errors: `{ error: { code: string, message: string, details?: object } }`
- Field naming: camelCase (mapped from POS internal snake_case via `toApiShape()` helpers)
- IDs: stable string identifiers only (`receiptNumber`, `productCode`, `componentCode`, `staffCode`, `voucherCode`) — never Convex `_id`

## Full contract spec

See [`docs/PUBLIC_API.md`](../../../docs/PUBLIC_API.md).
