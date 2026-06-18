# POS → Frollie Pro sales sync — design

**Date:** 2026-06-17
**Status:** Draft — reconciled 2026-06-17 with the shared contract + ERP consumer spec
**Repos:** `D:\Claude\FrolliePOS` (producer) · `D:\Claude\Product Manager\product_master` (consumer)
**Supersedes/implements:** ADR-034 §"External API surface", `docs/PUBLIC_API.md` (POS); Phase 74.5 channel spine (ERP)
**Contract (source of truth):** `product_master\docs\superpowers\specs\2026-06-17-pos-erp-sales-sync-CONTRACT.md`
**Consumer detail:** `product_master\docs\superpowers\specs\2026-06-17-pos-erp-sales-sync-erp-consumer-design.md`

> **Reconciliation note (2026-06-17).** This spec was cross-checked against the
> ERP codebase. Changes from the original draft:
> 1. **Auth hashing: argon2id → SHA-256.** A 256-bit random token is high-entropy;
>    argon2 (a password KDF) adds a dependency + per-request CPU for no security
>    gain. Constant-time SHA-256 compare is the standard for opaque API tokens.
> 2. **Dropped the `frollie_pro_aggregate_only` scope.** One fully-trusted consumer,
>    one scope. The `scope` field is retained for forward-compat; only
>    `frollie_pro_full` is implemented/issued.
> 3. **Index/cursor (§4.3):** no new index — reuse the existing
>    `by_status_paid_at: ["status","paid_at"]`. The tiebreak is `_creationTime`
>    (Convex's implicit final index field), **not `_id`** (`_id` can't be named
>    in an index). Cursor encodes `(paidAt, _creationTime)`.
> 4. **Refund sign (D3):** POS serves **positive magnitudes**; the ERP carries
>    direction via `transactionType:"return"` (a first-class field) — not a
>    negative `revenueGross`.
> 5. **ERP-side detail (§5/§6)** moved to the consumer spec to avoid two-doc drift;
>    this spec keeps only the producer contract obligations.

---

## 1. Goal

Pull **product-level POS sales** into the Frollie Pro ERP so each booth transaction lands as a revenue record showing *what SKU was sold*. Refunds flow as reversals. POS becomes the ERP's source #9 (`pos`), alongside Shopee/GoFood/K3Mart/etc.

**Non-goals (v1 of this sync):**
- `/api/v1/catalog` and `/api/v1/inventory` endpoints (manual mapping of ~4 SKUs makes them unnecessary now).
- Inventory deduction in the ERP — the `channelDeductionEnabled.pos` flag stays **OFF** until a revenue soak proves mapping; flipping it on later reuses the ERP's standard per-source cutover.
- Frollie Pro → POS direction (POS keeps owning its own stock per ADR-016).

---

## 2. Decisions (settled in brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Grain = product-level line items**, one `externalRevenue` parent per POS transaction, one `externalRevenueItems` row per line. | User wants "each transaction, what was sold (SKU)." Matches the ERP's parent/line model and product-mapping UI. |
| D2 | **Join key = `productCode`** (e.g. `DUBAI_8PC`), a stable string per ADR-034 — never Convex `_id`. | Cross-deployment `Id<>` types don't transfer; ADR-034 mandates stable string IDs. |
| D3 | **Refunds = separate `/api/v1/refunds` endpoint** on its own `created_at` cursor. POS serves **positive magnitudes**; the ERP lands them as `transactionType:"return"` reversals keyed to the original `receiptNumber` (it owns the sign). | Faithful to ADR-008 ("refunds are their own entity"); keeps the transactions endpoint append-only on `paid_at` with no transaction-level `updated_at`. The ERP's `transactionType` is a first-class field — cleaner than a negative-number convention. |
| D4 | **ERP pulls** on an hourly cron; POS is a stateless server. **ERP owns the cursor.** | Matches every existing ERP source (K3Mart/GoBiz/BigSeller all pull). |
| D5 | **Deduction stays OFF** in v1 (`channelDeductionEnabled.pos = false`); revenue-only first. | Smallest correct slice; deduction is a clean flag-flip follow-up after soak. |

---

## 3. Architecture — ERP pulls, POS serves

```
ERP cron (hourly)
  └─ syncPosRevenue
       ├─ GET  https://<pos>.convex.site/api/v1/transactions?cursor=<opaque>&limit=N   (Bearer)
       │        → pages until nextCursor === null
       │        → adapter.normalize() → ChannelSaleEvent[]  (one per line)
       │        → externalRevenue (source:"pos") + externalRevenueItems
       └─ GET  https://<pos>.convex.site/api/v1/refunds?cursor=<opaque>               (Bearer)
                → transactionType:"return" reversal keyed to receiptNumber (ERP owns the sign)

       cursors persisted on posSyncCheckpoint; token on platformCredentials(platformId:"pos")

(deduction path — saveRevenueItems → channelRouting → productInventoryTransactions —
 gated behind channelDeductionEnabled.pos, OFF in v1)
```

POS endpoints are **httpActions on `.convex.site`** (not `.convex.cloud`). The ERP owns all sync state; POS holds none.

---

## 4. POS side (producer) — new code

### 4.1 Auth — `convex/api/v1/_auth.ts` (replace the throwing stub)
Real `verifyBearerToken(request)`:
- Extract `Authorization: Bearer <raw>` (expect the `frpos_live_` / `frpos_test_` prefix).
- **SHA-256-hash compare (constant-time)** against `_tokens` rows. (High-entropy 256-bit token → a fast hash is correct; argon2id is a password KDF and buys nothing here. Reuse the constant-time pattern from the Xendit webhook's `verifyCallbackToken`.)
- **Resolve consumer identity from the matched token row** — `consumer_label` + `consumer_account_hash` are the trustworthy anchor (bound at issuance, see §4.2). Never trust a client-declared identity for authz.
- **Optional origin-binding (recommended):** if the request carries `X-Consumer-Account` (contract §2), compare it constant-time against the token's `consumer_account_hash`; mismatch → `403 CONSUMER_MISMATCH`. This catches a leaked token replayed from an unexpected origin. Absent header → skip the check (header is optional).
- Reject per contract §4: missing/bad → `401 UNAUTHENTICATED`; endpoint not allow-listed → `403 ENDPOINT_NOT_ALLOWED`; consumer hash mismatch → `403 CONSUMER_MISMATCH`; expired or revoked → `401`; RPM bucket exceeded → `429 RATE_LIMITED` + `Retry-After`.
- On success return the token row (single scope `frollie_pro_full` in v1).
- **Log every request** (success AND every rejection path) to `api_request_log` (§4.2) — one row per request. Failed-auth rows have `token_id = null` but still capture endpoint + status + IP for forensics.

### 4.2 `_tokens` table + issuance (per ADR-034)
```ts
api_tokens: {
  hash: string,                 // SHA-256(raw) hex; constant-time compare
  consumer_label: string,       // human id of the caller, e.g. "frollie-pro-prod" / "frollie-pro-dev"
  consumer_account_hash: string,// sha256(<ERP account/org id>) — bound at issuance, constant across rotation
  scope: "frollie_pro_full",    // union retained for forward-compat; one value in v1
  endpointAllowList: string[],  // explicit, no globs
  rateLimitRpm: number,         // default 60
  issuedAt: number,             // server Date.now() (ADR-031)
  expiresAt: number,            // mandatory; ≤365d
  rotatedFrom?: Id<"api_tokens">, // rotation chains here; consumer_label + consumer_account_hash stay constant
  revokedAt?: number,
  createdByStaffId: Id<"staff">,
}
api_rate_buckets: { token_id, window_start, count }  // reset every 60s by scheduled action

// Access trail — ONE row per request (success + every rejection). Reads don't
// belong in the append-only business audit_log (ADR-007 is for state changes);
// this is the separate access log so it can't pollute the ledger refunds/voids write to.
api_request_log: {
  token_id: Id<"api_tokens"> | null,  // null when auth itself failed (still logged)
  consumer_label: string | null,      // denormalized for "every pull from frollie-pro-prod today"
  endpoint: string,                   // "/api/v1/transactions" | "/api/v1/refunds"
  http_status: number,                // 200 / 400 / 401 / 403 / 429 / 500
  error_code?: string,                // contract §4 code on non-2xx
  returned_count?: number,            // rows in the page (2xx only)
  cursor_in?: string,
  cursor_out?: string,                // nextCursor issued (null/absent = caught up)
  ip?: string,                        // x-forwarded-for if present
  at: number,
}  // .index("by_token_at", ["token_id","at"]) + .index("by_consumer_at", ["consumer_label","at"])
```
- Issuance = **manager-PIN-gated** mutation; binds `consumer_label` + `consumer_account_hash` at creation; returns the raw token **once**. CLI for v1 (dashboard UI deferred).
- Rotation = overlapping 7-day windows (old + new both valid); the new row carries the **same** `consumer_label` + `consumer_account_hash` so identity is stable across rotation.
- Audit (`audit_log`, business): token **issued / rotated / revoked** + **auth failures** (401/403) only. Routine pulls go to `api_request_log`, not `audit_log`.

### 4.3 `convex/api/v1/transactions.ts` (httpAction) — `GET /api/v1/transactions`
- Query: `?cursor=<opaque>&limit=N` (limit default **100**, max **500** per contract §3).
- Cursor decodes to `{ paidAtMs, creationTime }`; opaque base64. `BAD_CURSOR` → `400`.
- **Reuse the existing `by_status_paid_at: ["status","paid_at"]` index** — do NOT add a new one. The existing `_listPaidTxnsSince_internal` is `.order("desc")` + unbounded `.collect()`; add a **new paginated *ascending* internal query** (`_listPaidTxnsForApi_internal(cursor, limit)`) instead of bending the desc one.
- Only `status === "paid"`; ordered `(paid_at, _creationTime)` ascending. **The tiebreak is `_creationTime`** — Convex appends it implicitly to every index; `_id` is NOT a nameable index field. Return rows strictly after the cursor.
- `toApiShape()` per row: snake→camel, attach lines, expose `receiptNumber`/`staffCode`/`productCode` (never `_id`).

Response envelope:
```json
{
  "data": [
    {
      "receiptNumber": "R-2026-0042",
      "paidAt": 1718600000000,
      "subtotal": 90000,
      "voucherCode": "OPEN10",
      "voucherDiscount": 9000,
      "total": 81000,
      "staffCode": "S-0001",
      "lines": [
        { "productCode": "DUBAI_8PC", "productName": "Dubai 8pcs",
          "qty": 2, "unitPrice": 45000, "lineSubtotal": 90000, "taxRate": 0 }
      ]
    }
  ],
  "nextCursor": "base64(paidAt|_creationTime)"
}
```
`status` is omitted (only paid rows are returned). `nextCursor === null` when the page is the last. All money = integer rupiah (ADR-015); all `_at` = UTC epoch ms.

### 4.4 `convex/api/v1/refunds.ts` (httpAction) — `GET /api/v1/refunds`
- Cursor over `(created_at, _creationTime)` on `pos_refunds` (same tiebreak rule as §4.3 — not `_id`).
- `totalRefund` / `refundAmount` are served as **positive magnitudes**; the ERP applies the sign via `transactionType:"return"` and forms its own dedup id `"{receiptNumber}|R|{createdAt}"` ((receiptNumber, created_at) is unique for append-only refunds).
- **Two joins the contract shape hides:** `pos_refunds.lines` carry only `{line_id, qty, refund_amount}` (`refunds/schema.ts:11-15`) — no `productCode`, no `receiptNumber`. The handler resolves `transaction_id → pos_transactions.receipt_number` and, per line, `line_id → pos_transaction_lines.product_code_snapshot`. These are **cross-module reads** (refunds vs. transactions ownership), so per ADR-034 they route through a transactions-module internal (e.g. `_resolveRefundLinesForApi_internal`), never direct `ctx.db`.
- Shape:
```json
{
  "data": [
    {
      "receiptNumber": "R-2026-0042",
      "createdAt": 1718700000000,
      "totalRefund": 45000,
      "reason": "damaged",
      "lines": [ { "productCode": "DUBAI_8PC", "qty": 1, "refundAmount": 45000 } ]
    }
  ],
  "nextCursor": "base64(createdAt|_creationTime)"
}
```

### 4.5 `convex/http.ts`
Register both routes (path prefix `/api/v1/`), method `GET`, handlers from 4.3/4.4.

---

## 5. ERP side (consumer) — see the consumer spec

The consumer is fully specced in
`product_master\docs\superpowers\specs\2026-06-17-pos-erp-sales-sync-erp-consumer-design.md`
(verified against the ERP codebase). It is **not** duplicated here — that would
let the two docs drift. Producer-relevant summary only:

- POS becomes ERP source `"pos"` (a `ChannelAdapter`); `normalize()` emits one
  `ChannelSaleEvent` per line, joined on `productCode`.
- The ERP owns all sync state (token + two opaque cursors), pulls hourly, dedups
  on existing indexes, and keeps inventory deduction **OFF** in v1.
- Refunds land as `transactionType:"return"` (positive magnitude) — see §4.4 + D3.

**Producer obligation:** keep the contract shapes (CONTRACT.md §5/§6) stable, and
honor the stable-ID guarantees in §7. Nothing else about the ERP is the POS
repo's concern.

## 6. Idempotency / dedup (producer side only)

- POS endpoints are read-only `GET`s → the POS `Idempotency-Key` convention does
  **not** apply to them.
- All transaction/line/refund dedup is the **consumer's** job and rides existing
  ERP keys (`by_source_txn` for parents, `saveRevenueItems` set-once for items) —
  detailed in the consumer spec §7. The cursor is the primary watermark.

---

## 7. Prerequisite (critical path)

**Flip POS `code` fields `v.optional` → required** with race-safe allocation (ADR-034's deferred v0.3 task):
- `pos_products.code` (`productCode`) — required; line mapping breaks without it.
- `staff.code` (`staffCode`) — required for attribution field.
- Cascades through `createStaff`/`_seedStaffCommit_internal`/`_createStaffCommit_internal` allocation logic + raw test inserts.
- Allocation must be race-safe for `S-NNNN` (sequential, no collisions).
- **Drop the `?? p.sku_family` fallback** at `transactions/public.ts:214` (`product_code: p.code ?? p.sku_family`). It's necessary-not-sufficient to flip `code` to required: the API serves the *frozen* `product_code_snapshot`, so a sale of a code-less product permanently bakes a non-`UPPERCASE_SNAKE` value into the line. Once `code` is required, commit should refuse a code-less product rather than fall back — guaranteeing every future snapshot conforms to the contract §7 `productCode` format. Live data is already clean (launch catalog seeds real codes, `seed/internal.ts:398-417`).

---

## 8. Testing (ADR-034's six gates, scoped to what ships)

1. **Response-shape snapshot tests** — `transactions.snapshot.test.ts`, `refunds.snapshot.test.ts` (fixed input → frozen camelCase envelope).
2. **Auth-path tests** — valid → 200; bad/missing → 401; endpoint not allow-listed → 403; expired/revoked → 401; rate-limit → 429 + `Retry-After`; constant-time-compare regression.
3. **Stable-ID conformance** — `receiptNumber` `R-YYYY-NNNN`, `productCode` `UPPERCASE_SNAKE(+_<N>PC)`, `staffCode` `S-NNNN`.
4. **Cursor-pagination test** — multi-page walk returns each row once, no gaps/dupes across page boundaries, `(paid_at, _creationTime)` tiebreak correct (incl. two rows sharing a `paid_at` ms straddling a page boundary).
5. **ERP `normalize()` unit test** — one API txn → N `ChannelSaleEvent`s with correct refs/dates.
6. **Dedup test** — re-running a sync window inserts zero duplicate revenue rows.

Plus: `npx convex dev --once` schema-composition smoke (both deployments).

---

## 9. Open items deferred to planning

Resolved in reconciliation (no longer open): limit default/max (100/500, contract §3);
cursor encoding (`base64(orderKeyMs|_creationTime)`); auth hashing (SHA-256); scope
(single `frollie_pro_full`); ERP cursor storage (`posSyncCheckpoint`, consumer spec §3).

Still open:
- Exact base64 cursor payload format (JSON vs delimited) — implementer's call; must round-trip `(orderKeyMs, _creationTime)`.
- Whether `staffCode` is exposed at all (attribution-only; the ERP may not store it — but POS still serves it).
- Rate-bucket reset mechanism — scheduled action vs lazy window check at request time.
- Dev↔dev rollout first (POS `helpful-grasshopper-46` ↔ ERP `exciting-fennec-671`), then prod↔prod (POS `savory-zebra-800` ↔ ERP `decisive-wombat-7`).
