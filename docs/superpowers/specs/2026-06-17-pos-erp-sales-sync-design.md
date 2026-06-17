# POS → Frollie Pro sales sync — design

**Date:** 2026-06-17
**Status:** Draft (awaiting final review)
**Repos:** `D:\Claude\FrolliePOS` (producer) · `D:\Claude\Product Manager\product_master` (consumer)
**Supersedes/implements:** ADR-034 §"External API surface", `docs/PUBLIC_API.md` (POS); Phase 74.5 channel spine (ERP)

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
| D3 | **Refunds = separate `/api/v1/refunds` endpoint** on its own `created_at` cursor; ERP lands them as **negative reversal** `externalRevenue` keyed to the original `receiptNumber`. | Faithful to ADR-008 ("refunds are their own entity"); keeps the transactions endpoint append-only on `paid_at` with no transaction-level `updated_at`. |
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
                → negative reversal externalRevenue/items keyed to receiptNumber

       cursor persisted on platformCredentials(platformId:"pos")

(deduction path — saveRevenueItems → channelRouting → productInventoryTransactions —
 gated behind channelDeductionEnabled.pos, OFF in v1)
```

POS endpoints are **httpActions on `.convex.site`** (not `.convex.cloud`). The ERP owns all sync state; POS holds none.

---

## 4. POS side (producer) — new code

### 4.1 Auth — `convex/api/v1/_auth.ts` (replace the throwing stub)
Real `verifyBearerToken(request)`:
- Extract `Authorization: Bearer <raw>`.
- argon2id-hash compare (constant-time) against `_tokens` rows.
- Reject: missing/bad → `401`; scope/endpoint not allowed → `403`; expired or revoked → `401`; RPM bucket exceeded → `429` + `Retry-After`.
- On success return the token's scope so handlers can gate PII (`frollie_pro_full` vs `frollie_pro_aggregate_only`).

### 4.2 `_tokens` table + issuance (per ADR-034)
```ts
api_tokens: {
  hash: string,                 // argon2id(raw)
  scope: "frollie_pro_full" | "frollie_pro_aggregate_only",
  endpointAllowList: string[],  // explicit, no globs
  rateLimitRpm: number,         // default 60
  issuedAt: number,             // server Date.now() (ADR-031)
  expiresAt: number,            // mandatory; ≤365d
  rotatedFrom?: Id<"api_tokens">,
  revokedAt?: number,
  createdByStaffId: Id<"staff">,
}
api_rate_buckets: { token_id, window_start, count }  // reset every 60s by scheduled action
```
- Issuance = **manager-PIN-gated** mutation; returns the raw token **once**. CLI for v1 (dashboard UI deferred).
- Rotation = overlapping 7-day windows (old + new both valid).
- Audit: new `audit_log.source = "api_consumer"`.

### 4.3 `convex/api/v1/transactions.ts` (httpAction) — `GET /api/v1/transactions`
- Query: `?cursor=<opaque>&limit=N` (default/max limit TBD, e.g. 100).
- Cursor decodes to `{ sinceMs, lastId }`; opaque base64.
- Reads `_listPaidTxnsSince_internal(sinceMs, lastId, limit)` over a **`by_paid_at` index `[paid_at, _id]`** — **add this index if absent** (verify against `convex/transactions/schema.ts`).
- Only `status === "paid"` rows; ordered `(paid_at, _id)` ascending; `_id` is the tiebreak for equal `paid_at`.
- `toApiShape()` per row: snake→camel, attach lines, expose `receiptNumber` (never `_id`).

Response envelope:
```json
{
  "data": [
    {
      "receiptNumber": "R-2026-0042",
      "paidAt": 1718600000000,
      "status": "paid",
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
  "nextCursor": "base64(paidAt|_id)"
}
```
`nextCursor === null` when the page is the last. All money = integer rupiah (ADR-015); all `_at` = UTC epoch ms.

### 4.4 `convex/api/v1/refunds.ts` (httpAction) — `GET /api/v1/refunds`
- Cursor over `[created_at, _id]` on `pos_refunds`.
- **Dedup key without a new schema field:** `externalRef = ${receiptNumber}|refund|${createdAt}` ((receiptNumber, created_at) is unique for append-only refunds).
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
  "nextCursor": "base64(createdAt|_id)"
}
```

### 4.5 `convex/http.ts`
Register both routes (path prefix `/api/v1/`), method `GET`, handlers from 4.3/4.4.

---

## 5. ERP side (consumer) — new code

### 5.1 Register the source
- Add `"pos"` to `EXTERNAL_SOURCES` union in `convex/lib/externalSource.ts` (cascades exhaustive switches).
- Add `channelDeductionEnabled.pos` to `productInventorySettings` (default **false**).

### 5.2 `convex/integrations/pos/adapter.ts` — `ChannelAdapter<PosTxnPayload>`
- `source: "pos"`.
- `fetch`: GET the POS endpoint with stored cursor + Bearer (paged).
- `normalize(payload)`: one `ChannelSaleEvent` per line:
  - `externalTransactionId = receiptNumber`
  - `externalItemId = ${receiptNumber}|${productCode}`
  - `externalProductCode = productCode`
  - `externalProductName = productName`
  - `quantity`, `unitPrice` (= `unitPrice`), `transactionDate = paidAt`

### 5.3 `convex/integrations/pos/sync.ts` + cron `syncPosRevenue` (hourly)
- **Phase A (sales):** page `/api/v1/transactions` until `nextCursor === null`; create `externalRevenue` (`source:"pos"`, `dataOrigin:"api_revenue"`, `confidence:"exact"`, `externalTransactionId = receiptNumber`) + `externalRevenueItems`.
- **Phase B (refunds):** page `/api/v1/refunds`; create **negative** `externalRevenue`/items keyed to `receiptNumber`, `externalRef = ${receiptNumber}|refund|${createdAt}`.
- **Cursor persistence:** store sales-cursor and refunds-cursor on the `platformCredentials(platformId:"pos")` row. *(Swap to a dedicated sync-checkpoint table if the ERP already has that idiom — implementer's call.)*
- Token stored in `platformCredentials(platformId:"pos", currentToken)`.

### 5.4 Product mapping
Manual via the existing `/admin/unlinked-products` UI: `productCode` → `menuProductId` in `externalProductMappings(source:"pos", externalProductCode)`. ~4 SKUs, one-time.

---

## 6. Idempotency / dedup

- POS endpoints are read-only GETs → POS-side `Idempotency-Key` convention does **not** apply.
- Sales dedup: ERP `externalRef = ${receiptNumber}|${productCode}` + set-once `inventoryDeductedAt` (when deduction later enabled). Re-pulling a page is a no-op.
- Refunds dedup: `externalRef = ${receiptNumber}|refund|${createdAt}`.
- Cursor is the primary watermark; dedup keys are the safety net against overlap/replay.

---

## 7. Prerequisite (critical path)

**Flip POS `code` fields `v.optional` → required** with race-safe allocation (ADR-034's deferred v0.3 task):
- `pos_products.code` (`productCode`) — required; line mapping breaks without it.
- `staff.code` (`staffCode`) — required for attribution field.
- Cascades through `createStaff`/`_seedStaffCommit_internal`/`_createStaffCommit_internal` allocation logic + raw test inserts.
- Allocation must be race-safe for `S-NNNN` (sequential, no collisions).

---

## 8. Testing (ADR-034's six gates, scoped to what ships)

1. **Response-shape snapshot tests** — `transactions.snapshot.test.ts`, `refunds.snapshot.test.ts` (fixed input → frozen camelCase envelope).
2. **Auth-path tests** — valid → 200; bad/missing → 401; scope/endpoint denied → 403; expired/revoked → 401; rate-limit → 429; constant-time-compare regression.
3. **Stable-ID conformance** — `receiptNumber` `R-YYYY-NNNN`, `productCode` `UPPERCASE_SNAKE(+_<N>PC)`, `staffCode` `S-NNNN`.
4. **Cursor-pagination test** — multi-page walk returns each row once, no gaps/dupes across page boundaries, `(paid_at, _id)` tiebreak correct.
5. **ERP `normalize()` unit test** — one API txn → N `ChannelSaleEvent`s with correct refs/dates.
6. **Dedup test** — re-running a sync window inserts zero duplicate revenue rows.

Plus: `npx convex dev --once` schema-composition smoke (both deployments).

---

## 9. Open items deferred to planning

- Exact `limit` default/max and cursor encoding format.
- Whether `staffCode` is sent under `frollie_pro_aggregate_only` scope (PII gating).
- ERP cursor-storage location (platformCredentials vs dedicated checkpoint table).
- Dev↔dev rollout first (POS `helpful-grasshopper-46` ↔ ERP `exciting-fennec-671`), then prod↔prod.
