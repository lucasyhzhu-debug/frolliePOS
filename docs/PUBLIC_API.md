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
Authorization: Bearer frpos_live_xxxxxxxx…    (prod)
Authorization: Bearer frpos_test_xxxxxxxx…    (dev)
```
- Tokens carry an environment prefix: `frpos_live_<base64url>` on **prod**,
  `frpos_test_<base64url>` on **dev**. The prefix is an ops-hygiene discriminator
  to keep dev/prod credentials visually distinct.
- **Treat the token as an opaque secret.** Do NOT validate or branch on the
  prefix — the server identifies the token by hash lookup, not by prefix.
- Tokens are issued by POS ops (see "Getting a token" below) and shown **once**.
- The token identifies you; store it as a secret (we keep it in
  `platformCredentials(platformId:"pos").currentToken`).
- Revocable + rotatable server-side. On rotation you get a new token valid
  alongside the old for 7 days — swap at your leisure within the window.

**Getting a token:** ask a POS operator to run, on the target deployment:
```bash
# prod (frpos_live_)
npx convex run --prod api/v1/internal:_issueApiToken_internal '{"label":"frollie-pro-prod","endpointAllowList":["/api/v1/transactions","/api/v1/refunds"],"rateLimitRpm":120}'
# dev (frpos_test_) — note isTest:true
npx convex run api/v1/internal:_issueApiToken_internal '{"label":"frollie-pro-dev","endpointAllowList":["/api/v1/transactions","/api/v1/refunds"],"rateLimitRpm":120,"isTest":true}'
```
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

## 4a. Date filtering (optional window bounds)

Both endpoints accept two **optional** query params that clamp the result to a
time window, filtering on the same key the cursor orders by (`paidAt` for
transactions, `createdAt` for refunds):

| Param | Meaning |
|-------|---------|
| `from` | **Inclusive** lower bound, epoch ms. Rows with key `>= from`. |
| `to`   | **Exclusive** upper bound, epoch ms. Rows with key `< to`. |

- **Omitting both = the default drain-from-beginning behaviour** (unchanged). The
  steady-state incremental sync (cursor only, no `from`/`to`) is unaffected.
- **Composes with the cursor.** Within a window you still page via `nextCursor`;
  the effective lower bound is `max(cursor watermark, from)`. Pattern: pin the
  window with `from`/`to` on every page of that drain, and page until `null`.
- Use it to **reconcile a specific day** (`?from=<dayStartMs>&to=<dayEndMs>`),
  **re-pull a range** after a bug, or **backfill** without resetting your cursor
  and re-draining all history.
- Bounds are validated: a non-integer/negative bound, or `from > to`, returns
  `400 BAD_RANGE` (see §5). `from === to` is a valid empty window (zero rows).
- Days are POS-local **WIB (UTC+7)**: a calendar day `D` spans
  `[D 00:00 WIB, D+1 00:00 WIB)` = `[D−07:00 UTC, …)`. Compute the ms bounds in
  WIB to align with the POS dashboard's day-summary.

```ts
// reconcile one WIB calendar day
const dayStartMs = Date.UTC(y, m, d, -7, 0, 0); // 00:00 WIB
const dayEndMs   = Date.UTC(y, m, d + 1, -7, 0, 0);
const url = new URL(base + "/api/v1/transactions");
url.searchParams.set("from", String(dayStartMs));
url.searchParams.set("to", String(dayEndMs));
// then page with ?cursor= as usual until nextCursor === null
```

## 5. Errors

`{ "error": { "code": "...", "message": "...", "details"?: {} } }` + HTTP status:

| HTTP | code | Meaning / what to do |
|------|------|----------------------|
| 400 | `BAD_CURSOR` | You sent a malformed cursor. Don't hand-craft cursors. |
| 400 | `BAD_RANGE` | `from`/`to` is non-integer/negative, or `from > to`. Send epoch-ms integers with `from <= to`. |
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

Additive fields and **new optional query params** (e.g. the §4a `from`/`to`
window bounds) are non-breaking — ignore unknown fields (validate with a
`.passthrough()` schema), and absent params preserve prior behaviour. Removals/
renames/ordering changes ⟹ `/api/v2/` with a ≥14-day deprecation window agreed
in writing.
