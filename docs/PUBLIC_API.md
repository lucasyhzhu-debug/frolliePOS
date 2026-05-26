# Frollie POS — Public API contract

External API surface for consumers (Frollie Pro and future). Versioned, bearer-token authenticated, stable string identifiers only. Per [ADR-034](./ADR/034-deep-modules-surface-apis.md).

> **Audience:** Frollie Pro engineers + future external API consumers.
> **For POS-internal schema, see [`SCHEMA.md`](./SCHEMA.md).**

## Status

**v0.2.1: scaffold only. No endpoints yet.** First endpoint lands in v0.3 alongside the `pos_transactions` table.

## Conventions

| Concern | Convention |
|---|---|
| Path prefix | `/api/v1/` |
| Versioning | Breaking changes → `/api/v2/`. Deprecation window: 14 days minimum, agreed with consumer in writing |
| Authentication | `Authorization: Bearer <token>` (per ADR-034 §"API authentication model") |
| Pagination | Opaque `cursor` query parameter. Response: `{ data: [...], nextCursor: string | null }` |
| Errors | `{ error: { code: string, message: string, details?: object } }` + appropriate HTTP status |
| Field naming | `camelCase` in API responses (mapped from POS internal `snake_case`) |
| Identifiers | Stable string IDs only — `receiptNumber`, `productCode`, `componentCode`, `staffCode`, `voucherCode`. **Never** Convex `_id` |
| Idempotency | POST requests accept `Idempotency-Key` header (24h retention) |
| Time | All `_at` fields are UTC epoch ms |

## Authentication summary

Bearer tokens are issued by a manager via the manager-PIN-gated mutation in `convex/api/v1/_auth.ts` (logged to `audit_log` with `source: "api_consumer"`). Tokens are argon2id-hashed at rest, compared in constant time, scoped per consumer, and revocable. Rotation via overlapping 7-day window. See [ADR-034 §"API authentication model"](./ADR/034-deep-modules-surface-apis.md#api-authentication-model) for the full spec.

## Stable identifiers

| Identifier | Format | Owner module | Notes |
|---|---|---|---|
| `receiptNumber` | `R-YYYY-NNNN` | transactions | Allocated at sale finalisation (v0.3) |
| `productCode` | UPPERCASE_SNAKE + `_<N>PC` (e.g. `DUBAI_8PC`) | catalog | Immutable post-creation |
| `componentCode` | UPPERCASE_SNAKE (e.g. `DUBAI`) | catalog | Immutable post-creation |
| `voucherCode` | UPPERCASE (e.g. `OPEN10`) | vouchers | v0.6 |
| `staffCode` | `S-NNNN` (e.g. `S-0042`) | auth | Allocated at staff creation, immutable. `staffName` is mutable display-only |

## Endpoints

*None in v0.2.1.* Table populated as endpoints land:

| Method | Path | Scope | Pagination | Spec |
|---|---|---|---|---|
| _none yet_ | | | | |
