# Frollie POS — Public API v1 (consumer guide)

The stable HTTP feed for pulling POS sales + refunds into an external system
(Frollie Pro ERP today). Read this end-to-end before integrating; it's designed
so you never need to read POS source.

> **Response shapes are frozen in the contract:**
> `2026-06-17-pos-erp-sales-sync-CONTRACT.md`. This guide is the *how*; the
> contract is the *what*. A shape change bumps `/api/v2/`.

## 1. Base URLs

| Env | Base URL |
|-----|----------|
| Dev  | `https://helpful-grasshopper-46.convex.site` |
| Prod | `https://savory-zebra-800.convex.site` |

httpActions serve from `.convex.site` (NOT `.convex.cloud`). `GET` only, HTTPS only.

## 2. Authentication

Every request needs a bearer token:
```
Authorization: Bearer frpos_live_xxxxxxxx…    (all deployments — dev and prod alike)
```
- All v1 tokens carry the `frpos_live_<base64url>` prefix on **every** deployment
  (dev and prod alike). A `frpos_test_` variant is **reserved** for a future
  test/live split but is **not issued in v1**.
- **Treat the token as an opaque secret.** Do NOT validate or branch on the
  prefix — the server identifies the token by hash lookup, not by prefix.
- Tokens are issued by POS ops (see "Getting a token" below) and shown **once**.
- The token identifies you; store it as a secret (we keep it in
  `platformCredentials(platformId:"pos").currentToken`).
- Revocable + rotatable server-side. On rotation you get a new token valid
  alongside the old for 7 days — swap at your leisure within the window.

**Getting a token:** ask a POS operator to run
`npx convex run api/v1/internal:_issueApiToken_internal '{"label":"frollie-pro-prod","endpointAllowList":["/api/v1/transactions","/api/v1/refunds"],"rateLimitRpm":120}'`
and hand you the `rawToken` over a secure channel.

## 3. Endpoints

### `GET /api/v1/transactions`
Finalised (paid) sales, ascending by `(paidAt, _creationTime)`. One object per
sale; `lines[]` carries the SKU-level breakdown. → CONTRACT §5 for the field table.

### `GET /api/v1/refunds`
Refund events, ascending by `(createdAt, _creationTime)`. Positive magnitudes —
**you** apply the sign (we model these as `transactionType:"return"`). → CONTRACT §6.

## 4. Pagination — the cursor contract

Both endpoints return `{ "data": [...], "nextCursor": "string | null" }`.

- Call with `?cursor=<opaque>&limit=<N>` (limit default 100, max 500).
- **Treat `nextCursor` as a black box** — persist it verbatim, send it back next call. Never parse it.
- `nextCursor === null` ⟺ you're caught up. Stop and persist the last cursor.
- A non-null cursor ⟹ keep paging **in the same run** until null.
- Omit `cursor` (or send empty) to start from the beginning of time.
- Watermarks are append-only write-once timestamps (`paidAt` / `createdAt`), so a
  caught-up cursor never misses a later row. Safe to re-poll forever.

**Worked loop (TypeScript — drop into your sync action):**
```ts
async function drain(base: string, token: string, path: string, startCursor?: string) {
  const rows: any[] = [];
  let cursor = startCursor;
  for (;;) {
    const url = new URL(base + path);
    if (cursor) url.searchParams.set("cursor", cursor);
    url.searchParams.set("limit", "200");
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {                       // backoff + retry, don't advance
      await sleep((Number(res.headers.get("Retry-After")) || 60) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`POS ${path} ${res.status}: ${(await res.json()).error?.code}`);
    const { data, nextCursor } = await res.json();
    rows.push(...data);
    if (nextCursor === null) return { rows, cursor };  // caught up — persist `cursor` (the last position sent; null/absent stored cursor means "start from beginning of time"; re-polling from this cursor is safe)
    cursor = nextCursor;                                // advance + keep going
  }
}
```
**Cursor discipline:** persist your stored cursor only after a full drain to
`null`. If a page mid-drain throws, leave the stored cursor where it was — the
next run resumes with no gaps (re-pulling a few rows is safe; see §6).

## 5. Errors

`{ "error": { "code": "...", "message": "...", "details"?: {} } }` + HTTP status:

| HTTP | code | Meaning / what to do |
|------|------|----------------------|
| 400 | `BAD_CURSOR` | You sent a malformed cursor. Don't hand-craft cursors. |
| 401 | `UNAUTHENTICATED` | Missing/unknown/expired/revoked token. Re-check the secret. |
| 403 | `ENDPOINT_NOT_ALLOWED` | Token isn't allow-listed for this path. Ask ops to re-issue. |
| 429 | `RATE_LIMITED` | Per-token RPM exceeded. Honor `Retry-After` (seconds), then retry. |
| 500 | `INTERNAL` | Transient POS error. Retry with backoff; cursor unaffected. |

## 6. Idempotency / safe re-pull

The feed is a watermark stream; the cursor is your primary dedup. As a safety
net for overlap/retries, dedup on the stable IDs:
- **Sales:** `receiptNumber` is unique per sale.
- **Refunds:** `(receiptNumber, createdAt)` is unique (a receipt can have several
  partial refunds). We key reversal rows on `"{receiptNumber}|R|{createdAt}"`.

Re-pulling a window you've already ingested is safe as long as you upsert on
those keys.

## 7. Rate limits

Per-token RPM bucket (default 60, configurable at issuance). Hourly batch pulls
sit far under it; a `429` means slow down, not stop — honor `Retry-After`.

## 8. Versioning

Additive fields are non-breaking — ignore unknown fields (validate with a
`.passthrough()` schema). Removals/renames/ordering changes ⟹ `/api/v2/` with a
≥14-day deprecation window agreed in writing.
