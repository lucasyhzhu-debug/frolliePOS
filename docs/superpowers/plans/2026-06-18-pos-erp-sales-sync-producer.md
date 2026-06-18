# POS → Frollie Pro Sales Sync (Producer Side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the POS-side public API (`convex/api/v1/`) that lets the Frollie Pro ERP pull product-level sales and refunds over a bearer-authed, cursor-paginated HTTP feed conforming to the shared CONTRACT.md.

**Architecture:** Two read-only httpActions (`/api/v1/transactions`, `/api/v1/refunds`) on `.convex.site`, authed by an opaque bearer token (SHA-256 hashed, indexed-lookup) with a per-token RPM bucket. Each endpoint calls owning-module internal queries (ADR-034 cross-module discipline) that resolve stable string IDs (`receiptNumber`, `productCode`, `staffCode`) and emit the camelCase `{ data, nextCursor }` envelope. A prerequisite migration makes `code` fields required so every sale snapshots a conforming `productCode`.

**Tech Stack:** Convex 1.31.7 (httpActions + internalQuery), TypeScript, Vitest + convex-test (edge-runtime), Web Crypto SHA-256.

## Global Constraints

- **Contract is source of truth:** `D:\Claude\Product Manager\product_master\docs\superpowers\specs\2026-06-17-pos-erp-sales-sync-CONTRACT.md`. Response shapes (§5/§6), error codes (§4), pagination (§3), auth (§2) are frozen — a shape change is a `/api/v2/` change.
- **Producer spec:** `docs/superpowers/specs/2026-06-17-pos-erp-sales-sync-design.md`.
- **Money:** integer rupiah only, no floats (ADR-015).
- **All `_at` fields:** UTC epoch ms; server-set via `Date.now()` inside the function (ADR-031).
- **Stable IDs only in API responses** — never expose Convex `_id` or `snake_case` (ADR-034).
- **Cross-module reads** route through the owning module's `*_internal` query — never direct `ctx.db` from `api/v1/` (ADR-034, CI-linted).
- **Business rule #1:** never join `pos_transaction_lines → pos_products` for historical data; serve the frozen `product_code_snapshot`.
- **`convex/lib/` must be V8-safe** (no `"use node"`).
- **Limit:** default 100, max 500 (CONTRACT §3). **Order:** ascending `(orderKeyMs, _creationTime)`; `_creationTime` is the implicit index tiebreak (`_id` is not nameable in an index).
- **Token format:** `frpos_live_<base64url 32-byte>` / `frpos_test_<...>` (CONTRACT §2).
- **Error envelope:** `{ "error": { "code", "message", "details"? } }` (CONTRACT §4).

---

## File Structure

**New files:**
- `convex/lib/sha256.ts` — V8-safe async SHA-256 hex (extracted; shared by approvals + api).
- `convex/api/v1/schema.ts` — `api_tokens` + `api_rate_buckets` tables → `apiTables` fragment.
- `convex/api/v1/_auth.ts` — replace throwing stub: `verifyBearerToken` + rate-limit check.
- `convex/api/v1/_cursor.ts` — opaque cursor encode/decode (pure, V8-safe).
- `convex/api/v1/_shape.ts` — `toTxnApiShape` / `toRefundApiShape` pure mappers + error helpers.
- `convex/api/v1/transactions.ts` — `GET /api/v1/transactions` httpAction.
- `convex/api/v1/refunds.ts` — `GET /api/v1/refunds` httpAction.
- `convex/api/v1/internal.ts` — `_issueApiToken_internal` (ops CLI), rate-bucket reset cron entry.
- `convex/api/v1/__tests__/*.test.ts` — auth, transactions, refunds, cursor, shape, conformance.

**Modified files:**
- `convex/schema.ts` — spread `...apiTables`.
- `convex/http.ts` — register two routes.
- `convex/catalog/schema.ts` — `code` optional → required.
- `convex/catalog/actions.ts` + `convex/catalog/internal.ts` — `createProduct` requires + validates `code`.
- `convex/auth/schema.ts` — `staff.code` optional → required.
- `convex/staff/internal.ts` — `_createStaffCommit_internal` allocates race-safe `S-NNNN`.
- `convex/seed/internal.ts` — already allocates codes; update any raw inserts if needed.
- `convex/transactions/public.ts:214` — drop `?? p.sku_family` fallback.
- `convex/transactions/internal.ts` — add `_listPaidTxnsForApi_internal` + `_resolveTxnLinesForApi_internal`.
- `convex/refunds/internal.ts` — add `_listRefundsForApi_internal` (calls transactions internal for joins).
- `convex/approvals/public.ts` — import shared `sha256.ts` (drop local copy).
- `convex/crons.ts` — `api-rate-bucket-reset` (if scheduled-action reset chosen).
- `docs/PUBLIC_API.md` — fill endpoint table from CONTRACT.
- `docs/SCHEMA.md` + `docs/CHANGELOG.md` — new tables + entry.

> **Deviation flagged for staffreview (spec §4.2):** Spec says issuance is a "manager-PIN-gated mutation." A CLI (`npx convex run`) has no booth session, and `verifyManagerPinOrThrow` requires a `sessionId`. This plan issues tokens via an **ops-run `internalMutation`** (`_issueApiToken_internal`, run with `npx convex run`) — matching the `seed:reset` ops pattern and the spec's own "CLI for v1" note. Whoever can `convex run` already holds deployment authority. Confirm at review.

---

## Task 1: Extract V8-safe SHA-256 helper

**Files:**
- Create: `convex/lib/sha256.ts`
- Modify: `convex/approvals/public.ts:15-18` (replace local fn with import)
- Test: `convex/lib/__tests__/sha256.test.ts`

**Interfaces:**
- Produces: `export async function sha256Hex(s: string): Promise<string>` — V8-safe, hex digest.

- [ ] **Step 1: Write the failing test**

```typescript
// convex/lib/__tests__/sha256.test.ts
import { describe, it, expect } from "vitest";
import { sha256Hex } from "../sha256";

describe("sha256Hex", () => {
  it("matches the known SHA-256 of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("is deterministic", async () => {
    expect(await sha256Hex("frpos_live_x")).toBe(await sha256Hex("frpos_live_x"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/__tests__/sha256.test.ts`
Expected: FAIL — cannot find module `../sha256`.

- [ ] **Step 3: Create the helper (copy the proven Web Crypto pattern from `approvals/public.ts:15-18`)**

```typescript
// convex/lib/sha256.ts
// V8-safe async SHA-256 (Web Crypto). Safe in the Convex default runtime AND
// "use node" actions — NOT "use node". For hashing high-entropy tokens
// (32-byte random) where index-lookup-by-hash is the auth mechanism; argon2id
// is reserved for low-entropy PINs (ADR-004). Mirrors approvals' former local copy.
export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/__tests__/sha256.test.ts`
Expected: PASS.

- [ ] **Step 5: Migrate the approvals local copy to the shared helper**

In `convex/approvals/public.ts`: delete the local `async function sha256Hex(...)` (lines ~15-18) and add `import { sha256Hex } from "../lib/sha256";`. Leave the two call sites (`:124`, `:482`) unchanged — same signature.

- [ ] **Step 6: Run the approvals tests to confirm no regression**

Run: `npx vitest run convex/approvals`
Expected: PASS (all existing approval-token tests green).

- [ ] **Step 7: Commit**

```bash
git add convex/lib/sha256.ts convex/lib/__tests__/sha256.test.ts convex/approvals/public.ts
git commit -m "refactor(lib): extract V8-safe sha256Hex; approvals uses shared helper"
```

---

## Task 2: Prerequisite — `pos_products.code` required + drop the snapshot fallback

**Files:**
- Modify: `convex/catalog/schema.ts` (code → required)
- Modify: `convex/catalog/actions.ts` (createProduct adds `code` arg) + `convex/catalog/internal.ts` (`_createProductCommit_internal` writes + validates code)
- Modify: `convex/transactions/public.ts:214` (drop `?? p.sku_family`)
- Test: `convex/catalog/__tests__/products.test.ts`, `convex/transactions/__tests__/commitCart.test.ts`

**Interfaces:**
- Produces: `pos_products.code: v.string()` (required). `createProduct` arg gains `code: string` (validated `^[A-Z][A-Z0-9_]*$`). Commit refuses a product whose `code` is absent.

- [ ] **Step 1: Write the failing test — commit must snapshot the real code, never sku_family**

```typescript
// convex/transactions/__tests__/commitCart.test.ts  (add this case)
it("snapshots product.code (never sku_family) onto the line", async () => {
  const t = convexTest(schema);
  const { sessionId, productId } = await seedProductAndSession(t, {
    code: "DUBAI_8PC", sku_family: "dubai", price_idr: 320000,
  });
  const { transactionId } = await t.action(api.transactions.public.commitCart, {
    idempotencyKey: "k1", sessionId, intent: "checkout",
    lines: [{ productId, qty: 1 }],
  });
  const line = await t.run((ctx) =>
    ctx.db.query("pos_transaction_lines")
      .withIndex("by_transaction", (q) => q.eq("transaction_id", transactionId))
      .first());
  expect(line!.product_code_snapshot).toBe("DUBAI_8PC");
});
```

(If `seedProductAndSession` doesn't exist, add a local helper mirroring the inserts in `convex/transactions/__tests__/commitCart.test.ts`; products must be inserted **with** `code`.)

- [ ] **Step 2: Run to verify it passes already (live behaviour is correct) then make the guarantee structural**

Run: `npx vitest run convex/transactions/__tests__/commitCart.test.ts`
Expected: PASS (seed sets code). This test locks the behaviour before removing the fallback.

- [ ] **Step 3: Flip the schema — `convex/catalog/schema.ts`**

Find `code: v.optional(v.string()),` in the `pos_products` table and change to:

```typescript
    code: v.string(),  // stable productCode, UPPERCASE_SNAKE(+_<N>PC); required since v1.1 (ADR-034, sync prereq)
```

- [ ] **Step 4: Drop the fallback — `convex/transactions/public.ts:214`**

Change:
```typescript
          // code is optional until F6; fall back to sku_family for the frozen ADR-001 snapshot
          product_code: p.code ?? p.sku_family,
```
to:
```typescript
          // code is required (sync prereq) — snapshot it directly. A code-less product
          // cannot reach a sale: createProduct refuses one, and the schema rejects it.
          product_code: p.code,
```

- [ ] **Step 5: Add `code` to `createProduct` + validate — `convex/catalog/actions.ts`**

Add to the `args` of the `createProduct` action: `code: v.string(),`. In the handler, before the commit `runMutation`, validate format and forward it:

```typescript
        const PRODUCT_CODE = /^[A-Z][A-Z0-9_]*$/;  // accepts DUBAI_8PC and component-style codes
        if (!PRODUCT_CODE.test(args.code)) throw new Error("INVALID_PRODUCT_CODE");
```
Then add `code: args.code,` to the `internal.catalog.internal._createProductCommit_internal` call. In `convex/catalog/internal.ts`, add `code: v.string()` to `_createProductCommit_internal` args and include `code: args.code,` in the `ctx.db.insert("pos_products", { ... })`.

- [ ] **Step 6: Fix raw test inserts that omit `code`**

Run `npx vitest run convex` to surface every test inserting a `pos_products` row without `code`. Add a conforming `code:` to each failing insert (e.g. `code: "TEST_1PC"`). The schema change makes these hard type/validation failures — fix until green.

- [ ] **Step 7: Run targeted + full backend tests**

Run: `npx vitest run convex/catalog convex/transactions`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add convex/catalog/schema.ts convex/catalog/actions.ts convex/catalog/internal.ts convex/transactions/public.ts convex/**/__tests__/*.test.ts
git commit -m "feat(catalog): require product code; drop sku_family snapshot fallback (sync prereq)"
```

---

## Task 3: Prerequisite — `staff.code` required + race-safe `S-NNNN` allocation

**Files:**
- Modify: `convex/auth/schema.ts` (`staff.code` → required)
- Modify: `convex/staff/internal.ts` (`_createStaffCommit_internal` allocates code)
- Test: `convex/staff/__tests__/createStaff.test.ts` (create if absent)

**Interfaces:**
- Produces: every `staff` row has `code: string` matching `^S-\d{4}$`. `_createStaffCommit_internal` allocates the next sequential code inside the mutation (Convex OCC = race safety).

- [ ] **Step 1: Write the failing test**

```typescript
// convex/staff/__tests__/createStaff.test.ts
import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";

describe("staff code allocation", () => {
  it("allocates the next sequential S-NNNN", async () => {
    const t = convexTest(schema);
    // Seed an existing S-0007 so the next must be S-0008.
    await t.run((ctx) => ctx.db.insert("staff", {
      name: "Existing", code: "S-0007", role: "staff", active: true,
      pin_hash: "x", created_at: 0,
    }));
    const sessionId = await seedManagerSession(t);  // helper: manager staff + session
    await t.mutation(internal.staff.internal._createStaffCommit_internal, {
      idempotencyKey: "k1", sessionId, name: "New", role: "staff", pin_hash: "h",
    });
    const created = await t.run((ctx) =>
      ctx.db.query("staff").filter((q) => q.eq(q.field("name"), "New")).first());
    expect(created!.code).toBe("S-0008");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/staff/__tests__/createStaff.test.ts`
Expected: FAIL — `created.code` is `undefined` (createStaff doesn't allocate today).

- [ ] **Step 3: Flip the schema — `convex/auth/schema.ts`**

Change `staff`'s `code: v.optional(v.string()),` to:
```typescript
    code: v.string(),  // stable staffCode S-NNNN; required since v1.1 (ADR-034, sync prereq)
```

- [ ] **Step 4: Allocate inside `_createStaffCommit_internal` — `convex/staff/internal.ts`**

Inside the handler, before `ctx.db.insert("staff", {...})`, compute the next code (max existing numeric + 1; OCC retries the mutation on a concurrent insert conflict):

```typescript
      // Allocate next S-NNNN. Reading all staff codes inside the mutation makes
      // the read part of the OCC read-set: a concurrent createStaff that also
      // allocated will conflict and retry, so codes never collide (ADR-031 server-time
      // analogue for sequential IDs).
      const all = await ctx.db.query("staff").collect();
      const maxN = all.reduce((m, s) => {
        const n = s.code?.match(/^S-(\d{4})$/)?.[1];
        return n ? Math.max(m, parseInt(n, 10)) : m;
      }, 0);
      const code = `S-${String(maxN + 1).padStart(4, "0")}`;
```
Then add `code,` to the `ctx.db.insert("staff", { name: args.name, code, pin_hash: ... })`. Add `code` to the returned object if the caller surfaces it.

- [ ] **Step 5: Fix raw test inserts omitting `staff.code`**

Run `npx vitest run convex` and add a conforming `code: "S-XXXX"` to every `staff` insert the schema now rejects. (Many test files already set `code` — only the bare ones fail.)

- [ ] **Step 6: Run tests**

Run: `npx vitest run convex/staff convex/auth`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add convex/auth/schema.ts convex/staff/internal.ts convex/**/__tests__/*.test.ts
git commit -m "feat(staff): require staff code; race-safe S-NNNN allocation in createStaff (sync prereq)"
```

---

## Task 4: `api_tokens` + `api_rate_buckets` schema

**Files:**
- Create: `convex/api/v1/schema.ts`
- Modify: `convex/schema.ts` (spread `...apiTables`)
- Modify: `docs/SCHEMA.md`
- Test: schema-composition smoke (Task covered by `npx convex dev --once`, asserted in Step 4)

**Interfaces:**
- Produces: `export const apiTables` with `api_tokens` (index `by_hash`) + `api_rate_buckets` (index `by_token_window`).

- [ ] **Step 1: Create the schema fragment**

```typescript
// convex/api/v1/schema.ts
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const apiTables = {
  // Opaque bearer tokens for the external API (ADR-034). SHA-256 hashed at rest;
  // auth = hash incoming token → indexed by_hash lookup (no plaintext stored).
  api_tokens: defineTable({
    hash: v.string(),                                  // sha256Hex(rawToken)
    label: v.string(),                                 // human note for ops e.g. "frollie-pro-prod"
    scope: v.literal("frollie_pro_full"),              // union retained for forward-compat; one value in v1
    endpointAllowList: v.array(v.string()),            // e.g. ["/api/v1/transactions","/api/v1/refunds"]
    rateLimitRpm: v.number(),                          // default 60
    issuedAt: v.number(),
    expiresAt: v.number(),                             // mandatory; ≤ 365d
    rotatedFrom: v.optional(v.id("api_tokens")),
    revokedAt: v.optional(v.number()),
  }).index("by_hash", ["hash"]),

  // Per-token RPM counter. One row per (token, minute-window).
  api_rate_buckets: defineTable({
    token_id: v.id("api_tokens"),
    window_start: v.number(),                          // epoch ms floored to the minute
    count: v.number(),
  }).index("by_token_window", ["token_id", "window_start"]),

  // Append-only access log — ONE row per API request (success AND failure,
  // incl. unauthenticated attempts where token_id is null). NOT the business
  // audit_log (ADR-007 is state-changes only; pulls are reads). The token IS
  // the caller (look up api_tokens.label for a human name). Indexed for ops.
  api_request_log: defineTable({
    token_id: v.optional(v.id("api_tokens")),          // null = auth failed before a token resolved
    endpoint: v.string(),                              // "/api/v1/transactions" | "/api/v1/refunds"
    http_status: v.number(),                           // 200/400/401/429/500
    error_code: v.optional(v.string()),                // contract §4 code, when non-200
    returned_count: v.optional(v.number()),            // rows in the response page (200 only)
    cursor_in: v.optional(v.string()),                 // request cursor (opaque), if any
    cursor_out: v.optional(v.string()),                // nextCursor returned, if any
    at: v.number(),                                    // server Date.now()
  })
    .index("by_token_at", ["token_id", "at"])
    .index("by_at", ["at"]),
};
```

- [ ] **Step 2: Compose into the root schema — `convex/schema.ts`**

Add `import { apiTables } from "./api/v1/schema";` and `...apiTables,` in the `defineSchema({...})` spread list.

- [ ] **Step 3: Document — `docs/SCHEMA.md`**

Add an `api_tokens` + `api_rate_buckets` section mirroring the field comments above.

- [ ] **Step 4: Verify schema composes**

Run: `npx convex dev --once`
Expected: deploys; indexes `by_hash`, `by_token_window` build with no error.

- [ ] **Step 5: Commit**

```bash
git add convex/api/v1/schema.ts convex/schema.ts docs/SCHEMA.md
git commit -m "feat(api): add api_tokens + api_rate_buckets schema"
```

---

## Task 5: Opaque cursor codec

**Files:**
- Create: `convex/api/v1/_cursor.ts`
- Test: `convex/api/v1/__tests__/cursor.test.ts`

**Interfaces:**
- Produces: `encodeCursor(orderKeyMs: number, creationTime: number): string` and `decodeCursor(s: string): { orderKeyMs: number; creationTime: number }` (throws `BAD_CURSOR` on malformed input).

- [ ] **Step 1: Write the failing test**

```typescript
// convex/api/v1/__tests__/cursor.test.ts
import { describe, it, expect } from "vitest";
import { encodeCursor, decodeCursor } from "../_cursor";

describe("cursor codec", () => {
  it("round-trips (orderKeyMs, creationTime)", () => {
    const c = encodeCursor(1718600000000, 1718600000123.4);
    expect(decodeCursor(c)).toEqual({ orderKeyMs: 1718600000000, creationTime: 1718600000123.4 });
  });
  it("is opaque base64url (no '+' '/' '=')", () => {
    expect(encodeCursor(1, 2)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it("throws BAD_CURSOR on garbage", () => {
    expect(() => decodeCursor("@@@not-base64@@@")).toThrow("BAD_CURSOR");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/api/v1/__tests__/cursor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (V8-safe; base64url over a JSON payload)**

```typescript
// convex/api/v1/_cursor.ts
// Opaque cursor: base64url(JSON{p:orderKeyMs, c:creationTime}). Consumers treat
// it as a black box (CONTRACT §3). V8-safe — uses btoa/atob, no node:Buffer.
type Decoded = { orderKeyMs: number; creationTime: number };

const b64urlEncode = (s: string) =>
  btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s: string) => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
};

export function encodeCursor(orderKeyMs: number, creationTime: number): string {
  return b64urlEncode(JSON.stringify({ p: orderKeyMs, c: creationTime }));
}

export function decodeCursor(s: string): Decoded {
  try {
    const o = JSON.parse(b64urlDecode(s));
    if (typeof o.p !== "number" || typeof o.c !== "number") throw new Error();
    return { orderKeyMs: o.p, creationTime: o.c };
  } catch {
    throw new Error("BAD_CURSOR");
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run convex/api/v1/__tests__/cursor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/api/v1/_cursor.ts convex/api/v1/__tests__/cursor.test.ts
git commit -m "feat(api): opaque base64url cursor codec"
```

---

## Task 6: Token issuance (ops CLI) + auth verification

**Files:**
- Create: `convex/api/v1/internal.ts` (`_issueApiToken_internal`)
- Rewrite: `convex/api/v1/_auth.ts`
- Test: `convex/api/v1/__tests__/auth.test.ts`

**Interfaces:**
- Consumes: `sha256Hex` (Task 1), `api_tokens`/`api_rate_buckets` (Task 4).
- Produces:
  - `_issueApiToken_internal({ label, endpointAllowList, rateLimitRpm?, ttlDays? }) → { rawToken: string }` — mints `frpos_live_<32-byte base64url>`, stores `sha256Hex(raw)`, returns raw once.
  - `verifyBearerToken(ctx, request, endpointPath) → { tokenId: Id<"api_tokens"> }` — throws `ApiError(401|403|429, code)`; enforces expiry/revocation/allow-list/RPM.
  - `class ApiError extends Error { status: number; code: string }`.

- [ ] **Step 1: Write the failing test**

```typescript
// convex/api/v1/__tests__/auth.test.ts
import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";

async function issue(t: any, over: Partial<{ endpointAllowList: string[]; rateLimitRpm: number }> = {}) {
  return await t.mutation(internal.api.v1.internal._issueApiToken_internal, {
    label: "test",
    endpointAllowList: over.endpointAllowList ?? ["/api/v1/transactions"],
    rateLimitRpm: over.rateLimitRpm ?? 60,
  });
}

describe("verifyBearerToken (via the transactions route)", () => {
  it("401 when Authorization header is missing", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/api/v1/transactions", { method: "GET" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });
  it("200 with a valid token", async () => {
    const t = convexTest(schema);
    const { rawToken } = await issue(t);
    const res = await t.fetch("/api/v1/transactions", {
      method: "GET", headers: { Authorization: `Bearer ${rawToken}` },
    });
    expect(res.status).toBe(200);
  });
  it("403 when the path is not allow-listed", async () => {
    const t = convexTest(schema);
    const { rawToken } = await issue(t, { endpointAllowList: ["/api/v1/refunds"] });
    const res = await t.fetch("/api/v1/transactions", {
      method: "GET", headers: { Authorization: `Bearer ${rawToken}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("ENDPOINT_NOT_ALLOWED");
  });
  it("401 for a revoked token", async () => {
    const t = convexTest(schema);
    const { rawToken } = await issue(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("api_tokens").first();
      await ctx.db.patch(row!._id, { revokedAt: Date.now() });
    });
    const res = await t.fetch("/api/v1/transactions", {
      method: "GET", headers: { Authorization: `Bearer ${rawToken}` },
    });
    expect(res.status).toBe(401);
  });
  it("429 once the RPM bucket is exceeded", async () => {
    const t = convexTest(schema);
    const { rawToken } = await issue(t, { rateLimitRpm: 1 });
    const h = { Authorization: `Bearer ${rawToken}` };
    expect((await t.fetch("/api/v1/transactions", { method: "GET", headers: h })).status).toBe(200);
    const res2 = await t.fetch("/api/v1/transactions", { method: "GET", headers: h });
    expect(res2.status).toBe(429);
    expect(res2.headers.get("Retry-After")).toBeTruthy();
  });
});
```

> This test depends on the route existing (Task 7/8). Order of execution: implement Steps 3–4 here, then Task 7 registers the route; this test goes green at the end of Task 8. If running strictly TDD per-task, stub the route first or run this suite after Task 8. (Noted so the executor doesn't expect green in isolation.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/api/v1/__tests__/auth.test.ts`
Expected: FAIL (route/handlers absent).

- [ ] **Step 3: Implement issuance — `convex/api/v1/internal.ts`**

```typescript
// convex/api/v1/internal.ts
import { internalMutation } from "../../_generated/server";
import { v } from "convex/values";
import { sha256Hex } from "../../lib/sha256";

const DAY_MS = 86_400_000;

// Ops-run (npx convex run). Mints a token, stores only its hash, returns the raw
// token ONCE. See the deviation note in the plan header re: PIN vs ops issuance.
export const _issueApiToken_internal = internalMutation({
  args: {
    label: v.string(),                          // human note for ops, "frollie-pro-prod"
    endpointAllowList: v.array(v.string()),
    rateLimitRpm: v.optional(v.number()),
    ttlDays: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ rawToken: string }> => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const b64url = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const rawToken = `frpos_live_${b64url}`;
    const now = Date.now();
    const ttl = Math.min(args.ttlDays ?? 365, 365);
    await ctx.db.insert("api_tokens", {
      hash: await sha256Hex(rawToken),
      label: args.label,
      scope: "frollie_pro_full",
      endpointAllowList: args.endpointAllowList,
      rateLimitRpm: args.rateLimitRpm ?? 60,
      issuedAt: now,
      expiresAt: now + ttl * DAY_MS,
    });
    return { rawToken };
  },
});

// Append-only access-log writer. Called once per request from each endpoint
// (success and catch paths). Never throws into the response path — a log-write
// failure must not turn a 200 into a 500, so callers wrap it in try/catch.
export const _logApiRequest_internal = internalMutation({
  args: {
    token_id: v.optional(v.id("api_tokens")),
    endpoint: v.string(),
    http_status: v.number(),
    error_code: v.optional(v.string()),
    returned_count: v.optional(v.number()),
    cursor_in: v.optional(v.string()),
    cursor_out: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("api_request_log", { ...args, at: Date.now() });
  },
});
```

- [ ] **Step 4: Rewrite `convex/api/v1/_auth.ts`**

```typescript
// convex/api/v1/_auth.ts
import { GenericActionCtx } from "convex/server";
import { DataModel, Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { sha256Hex } from "../../lib/sha256";

export class ApiError extends Error {
  constructor(public status: number, public code: string, msg?: string) {
    super(msg ?? code);
  }
}

// httpAction ctx. Verifies the bearer token and the per-token RPM bucket.
// Returns the token id on success; throws ApiError otherwise.
export async function verifyBearerToken(
  ctx: GenericActionCtx<DataModel>,
  request: Request,
  endpointPath: string,
): Promise<{ tokenId: Id<"api_tokens"> }> {
  const auth = request.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(\S+)$/);
  if (!m) throw new ApiError(401, "UNAUTHENTICATED");
  const hash = await sha256Hex(m[1]);
  const result = await ctx.runMutation(internal.api.v1.internal._authAndCount_internal, {
    hash, endpointPath,
  });
  if (result.error) throw new ApiError(result.status!, result.code!);
  return { tokenId: result.tokenId! };
}
```

Add the verify+count mutation to `convex/api/v1/internal.ts` (one mutation so the RPM increment is transactional):

```typescript
export const _authAndCount_internal = internalMutation({
  args: { hash: v.string(), endpointPath: v.string() },
  handler: async (ctx, args): Promise<{
    error: boolean; status?: number; code?: string; tokenId?: Id<"api_tokens">;
  }> => {
    const tok = await ctx.db.query("api_tokens")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash)).first();
    const now = Date.now();
    if (!tok || tok.revokedAt || tok.expiresAt <= now)
      return { error: true, status: 401, code: "UNAUTHENTICATED" };
    if (!tok.endpointAllowList.includes(args.endpointPath))
      return { error: true, status: 403, code: "ENDPOINT_NOT_ALLOWED" };
    // RPM bucket: lazy per-minute window (no cron needed for correctness).
    const windowStart = now - (now % 60_000);
    const bucket = await ctx.db.query("api_rate_buckets")
      .withIndex("by_token_window", (q) =>
        q.eq("token_id", tok._id).eq("window_start", windowStart)).first();
    if (bucket && bucket.count >= tok.rateLimitRpm)
      return { error: true, status: 429, code: "RATE_LIMITED" };
    if (bucket) await ctx.db.patch(bucket._id, { count: bucket.count + 1 });
    else await ctx.db.insert("api_rate_buckets", { token_id: tok._id, window_start: windowStart, count: 1 });
    return { error: false, tokenId: tok._id };
  },
});
```

(Lazy per-minute windows mean stale buckets accumulate; a `api-rate-bucket-reset` cron that deletes buckets older than 2 minutes is optional housekeeping — add in Task 11 if desired. Correctness does not depend on it.)

- [ ] **Step 5: Commit (test goes green after Task 8)**

```bash
git add convex/api/v1/internal.ts convex/api/v1/_auth.ts convex/api/v1/__tests__/auth.test.ts
git commit -m "feat(api): bearer-token issuance (ops CLI) + verify + per-token RPM"
```

---

## Task 7: Transactions feed — internal query + pure shape mapper

**Files:**
- Create: `convex/api/v1/_shape.ts`
- Modify: `convex/transactions/internal.ts` (add `_listPaidTxnsForApi_internal`)
- Test: `convex/api/v1/__tests__/shape.test.ts`, `convex/transactions/__tests__/api-list.test.ts`

**Interfaces:**
- Produces:
  - `_listPaidTxnsForApi_internal({ afterPaidAtMs?: number; afterCreationTime?: number; limit: number }) → { rows: ApiTxnRow[]; nextCursor: string | null }` where each `ApiTxnRow` already has resolved `receiptNumber`, `staffCode`, and `lines[]` with `productCode`.
  - `toTxnEnvelope(rows, nextCursor)` in `_shape.ts` (identity passthrough of the already-camelCase rows into `{ data, nextCursor }`).

- [ ] **Step 1: Write the failing internal-query test**

```typescript
// convex/transactions/__tests__/api-list.test.ts
import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";

describe("_listPaidTxnsForApi_internal", () => {
  it("returns paid rows ascending with resolved stable IDs + lines", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const staff = await ctx.db.insert("staff", {
        name: "L", code: "S-0001", role: "staff", active: true, pin_hash: "x", created_at: 0 });
      const prod = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "Eight",
        price_idr: 320000, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 });
      const txn = await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 320000, voucher_discount: 0, total: 320000, flags: 0,
        staff_id: staff, created_at: 100, paid_at: 200, receipt_number: "R-2026-0042" });
      await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txn, product_id: prod, product_code_snapshot: "DUBAI_8PC",
        product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 320000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 320000 });
    });
    const out = await t.query(internal.transactions.internal._listPaidTxnsForApi_internal, { limit: 100 });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      receiptNumber: "R-2026-0042", staffCode: "S-0001", total: 320000, voucherCode: null,
      lines: [{ productCode: "DUBAI_8PC", qty: 1, unitPrice: 320000, lineSubtotal: 320000, taxRate: 0 }],
    });
    expect(out.nextCursor).toBeNull();
  });

  it("excludes non-paid rows", async () => {
    const t = convexTest(schema);
    await t.run((ctx) => ctx.db.insert("pos_transactions", {
      status: "awaiting_payment", subtotal: 1, voucher_discount: 0, total: 1, flags: 0,
      staff_id: "x" as any, created_at: 0 }));
    const out = await t.query(internal.transactions.internal._listPaidTxnsForApi_internal, { limit: 100 });
    expect(out.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/transactions/__tests__/api-list.test.ts`
Expected: FAIL — internal not defined.

- [ ] **Step 3: Implement the internal query — `convex/transactions/internal.ts`**

```typescript
// add near _listPaidTxnsSince_internal
import { encodeCursor } from "../api/v1/_cursor";

export type ApiTxnRow = {
  receiptNumber: string;
  paidAt: number;
  subtotal: number;
  voucherCode: string | null;
  voucherDiscount: number;
  total: number;
  staffCode: string;
  lines: Array<{
    productCode: string; productName: string;
    qty: number; unitPrice: number; lineSubtotal: number; taxRate: number;
  }>;
};

export const _listPaidTxnsForApi_internal = internalQuery({
  args: {
    afterPaidAtMs: v.optional(v.number()),
    afterCreationTime: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, args): Promise<{ rows: ApiTxnRow[]; nextCursor: string | null }> => {
    const limit = Math.min(Math.max(args.limit, 1), 500);
    const after = args.afterPaidAtMs;
    // Ascending scan of paid rows from the watermark. Over-fetch by 1 to detect
    // a next page. _creationTime is the implicit tiebreak; rows at the exact
    // watermark ms are filtered by (paidAt, _creationTime) > cursor below.
    const candidates = await ctx.db
      .query("pos_transactions")
      .withIndex("by_status_paid_at", (q) =>
        after === undefined
          ? q.eq("status", "paid")
          : q.eq("status", "paid").gte("paid_at", after))
      .order("asc")
      .take(limit * 2 + 1);  // headroom for tiebreak filtering at the watermark

    const strictlyAfter = candidates.filter((t) => {
      if (after === undefined) return true;
      if (t.paid_at! > after) return true;
      // equal ms → compare creationTime
      return (t._creationTime) > (args.afterCreationTime ?? -Infinity);
    });
    const page = strictlyAfter.slice(0, limit);

    // Resolve staffCode once (small set) → Map to avoid N+1.
    const staffNames = await ctx.runQuery(internal.auth.internal._listStaffNames_internal, {});
    const codeByStaffId = new Map(staffNames.map((s) => [String(s._id), s.code]));

    const rows: ApiTxnRow[] = [];
    for (const t of page) {
      const lines = await ctx.db.query("pos_transaction_lines")
        .withIndex("by_transaction", (q) => q.eq("transaction_id", t._id)).collect();
      const staffCode = codeByStaffId.get(String(t.staff_id));
      if (!staffCode) throw new Error(`STAFF_CODE_MISSING_FOR_TXN ${t._id}`);
      rows.push({
        receiptNumber: t.receipt_number!,   // paid ⟹ receipt_number set (_confirmPaid invariant)
        paidAt: t.paid_at!,
        subtotal: t.subtotal,
        voucherCode: t.voucher_code_snapshot ?? null,
        voucherDiscount: t.voucher_discount,
        total: t.total,
        staffCode,
        lines: lines.map((l) => ({
          productCode: l.product_code_snapshot,
          productName: l.product_name_snapshot,
          qty: l.qty,
          unitPrice: l.unit_price_snapshot,
          lineSubtotal: l.line_subtotal,
          taxRate: l.tax_rate_snapshot,
        })),
      });
    }
    const last = page[page.length - 1];
    const more = strictlyAfter.length > limit;
    const nextCursor = more && last ? encodeCursor(last.paid_at!, last._creationTime) : null;
    return { rows, nextCursor };
  },
});
```

> Verify `auth.internal._listStaffNames_internal` returns `{ _id, code }` (it returns `{ name, code }` per the extraction — adjust the Map to key on whatever id/code it exposes; if it lacks `_id`, add a sibling `_listStaffCodes_internal` returning `{ _id, code }`). Confirm the exact return shape in `convex/auth/internal.ts` during implementation.

- [ ] **Step 4: Implement the envelope mapper — `convex/api/v1/_shape.ts`**

```typescript
// convex/api/v1/_shape.ts
import type { ApiTxnRow } from "../../transactions/internal";

export function txnEnvelope(rows: ApiTxnRow[], nextCursor: string | null) {
  return { data: rows, nextCursor };
}
export function errorBody(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run convex/transactions/__tests__/api-list.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/transactions/internal.ts convex/api/v1/_shape.ts convex/transactions/__tests__/api-list.test.ts
git commit -m "feat(api): _listPaidTxnsForApi_internal — paginated paid feed with resolved stable IDs"
```

---

## Task 8: `GET /api/v1/transactions` httpAction + route

**Files:**
- Create: `convex/api/v1/transactions.ts`
- Modify: `convex/http.ts`
- Test: `convex/api/v1/__tests__/transactions.test.ts` (+ the Task 6 auth suite now goes green)

**Interfaces:**
- Consumes: `verifyBearerToken` (Task 6), `_listPaidTxnsForApi_internal` (Task 7), `decodeCursor` (Task 5), `txnEnvelope`/`errorBody` (Task 7).
- Produces: `export const handleTransactionsRoute = httpAction(...)`.

- [ ] **Step 1: Write the failing end-to-end test**

```typescript
// convex/api/v1/__tests__/transactions.test.ts
import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";

async function token(t: any) {
  const { rawToken } = await t.mutation(internal.api.v1.internal._issueApiToken_internal, {
    label: "t", endpointAllowList: ["/api/v1/transactions"], rateLimitRpm: 1000 });
  return rawToken;
}

describe("GET /api/v1/transactions", () => {
  it("returns the contract envelope for a paid sale", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "staff", active: true, pin_hash: "x", created_at: 0 });
      const p = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "Eight", price_idr: 320000, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 });
      const x = await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 320000, voucher_discount: 0, total: 320000, flags: 0, staff_id: s, created_at: 1, paid_at: 2, receipt_number: "R-2026-0042" });
      await ctx.db.insert("pos_transaction_lines", { transaction_id: x, product_id: p, product_code_snapshot: "DUBAI_8PC", product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 320000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 320000 });
    });
    const res = await t.fetch("/api/v1/transactions", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].receiptNumber).toBe("R-2026-0042");
    expect(body.data[0].lines[0].productCode).toBe("DUBAI_8PC");
    expect(body).toHaveProperty("nextCursor");
  });

  it("400 BAD_CURSOR on a malformed cursor", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/api/v1/transactions?cursor=@@@", { method: "GET", headers: { Authorization: `Bearer ${await token(t)}` } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("BAD_CURSOR");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/api/v1/__tests__/transactions.test.ts`
Expected: FAIL — route not registered.

- [ ] **Step 3: Implement the httpAction — `convex/api/v1/transactions.ts`**

```typescript
// convex/api/v1/transactions.ts
import { httpAction } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { verifyBearerToken, ApiError } from "./_auth";
import { decodeCursor } from "./_cursor";
import { txnEnvelope, errorBody } from "./_shape";

const PATH = "/api/v1/transactions";

export const handleTransactionsRoute = httpAction(async (ctx, request) => {
  try {
    await verifyBearerToken(ctx, request, PATH);
    const url = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 500);
    const cursorParam = url.searchParams.get("cursor");
    const cur = cursorParam ? decodeCursor(cursorParam) : undefined;  // throws BAD_CURSOR
    const { rows, nextCursor } = await ctx.runQuery(
      internal.transactions.internal._listPaidTxnsForApi_internal,
      { afterPaidAtMs: cur?.orderKeyMs, afterCreationTime: cur?.creationTime, limit },
    );
    return Response.json(txnEnvelope(rows, nextCursor), { status: 200 });
  } catch (e) {
    if (e instanceof ApiError)
      return Response.json(errorBody(e.code, e.message), {
        status: e.status,
        headers: e.code === "RATE_LIMITED" ? { "Retry-After": "60" } : undefined,
      });
    if (e instanceof Error && e.message === "BAD_CURSOR")
      return Response.json(errorBody("BAD_CURSOR", "cursor failed to decode"), { status: 400 });
    console.error("[api/transactions] internal error:", e);
    return Response.json(errorBody("INTERNAL", "unexpected server error"), { status: 500 });
  }
});
```

- [ ] **Step 4: Register the route — `convex/http.ts`**

Add `import { handleTransactionsRoute } from "./api/v1/transactions";` and:

```typescript
http.route({
  path: "/api/v1/transactions",
  method: "GET",
  handler: handleTransactionsRoute,
});
```

- [ ] **Step 5: Run the transactions + auth suites**

Run: `npx vitest run convex/api/v1/__tests__/transactions.test.ts convex/api/v1/__tests__/auth.test.ts`
Expected: PASS (auth suite now green via this live route — the 429/403/401 cases included).

- [ ] **Step 6: Commit**

```bash
git add convex/api/v1/transactions.ts convex/http.ts convex/api/v1/__tests__/transactions.test.ts
git commit -m "feat(api): GET /api/v1/transactions httpAction + route"
```

---

## Task 9: Refunds feed — cross-module internal + endpoint + route

**Files:**
- Modify: `convex/transactions/internal.ts` (add `_resolveRefundLinesForApi_internal`)
- Modify: `convex/refunds/internal.ts` (add `_listRefundsForApi_internal`)
- Create: `convex/api/v1/refunds.ts`
- Modify: `convex/http.ts`
- Test: `convex/refunds/__tests__/api-list.test.ts`, `convex/api/v1/__tests__/refunds.test.ts`

**Interfaces:**
- Produces:
  - `transactions.internal._resolveRefundLinesForApi_internal({ transactionId, lines: {line_id, qty, refund_amount}[] }) → { receiptNumber: string; lines: {productCode, qty, refundAmount}[] }` — does the txn + line joins (transactions owns these tables).
  - `refunds.internal._listRefundsForApi_internal({ afterCreatedAtMs?, afterCreationTime?, limit }) → { rows: ApiRefundRow[]; nextCursor: string | null }`.
  - `handleRefundsRoute = httpAction(...)`.

- [ ] **Step 1: Write the failing internal-query test**

```typescript
// convex/refunds/__tests__/api-list.test.ts
import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";

describe("_listRefundsForApi_internal", () => {
  it("resolves receiptNumber + per-line productCode (positive magnitudes)", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "manager", active: true, pin_hash: "x", created_at: 0 });
      const p = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "Eight", price_idr: 320000, active: true, sort_order: 0, tax_rate: 0, created_at: 0, updated_at: 0 });
      const x = await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 320000, voucher_discount: 0, total: 320000, flags: 0, staff_id: s, created_at: 1, paid_at: 2, receipt_number: "R-2026-0042" });
      const line = await ctx.db.insert("pos_transaction_lines", { transaction_id: x, product_id: p, product_code_snapshot: "DUBAI_8PC", product_name_snapshot: "Dubai 8pcs", unit_price_snapshot: 320000, tax_rate_snapshot: 0, qty: 1, line_subtotal: 320000 });
      await ctx.db.insert("pos_refunds", { transaction_id: x, lines: [{ line_id: line, qty: 1, refund_amount: 320000 }], total_refund: 320000, reason: "damaged", requested_by: s, approver_id: s, approval_source: "booth_inline", settlement_status: "pending", created_at: 500 });
    });
    const out = await t.query(internal.refunds.internal._listRefundsForApi_internal, { limit: 100 });
    expect(out.rows[0]).toMatchObject({
      receiptNumber: "R-2026-0042", createdAt: 500, totalRefund: 320000, reason: "damaged",
      lines: [{ productCode: "DUBAI_8PC", qty: 1, refundAmount: 320000 }],
    });
    expect(out.nextCursor).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/refunds/__tests__/api-list.test.ts`
Expected: FAIL — internals not defined.

- [ ] **Step 3: Add the join resolver — `convex/transactions/internal.ts`**

```typescript
export const _resolveRefundLinesForApi_internal = internalQuery({
  args: {
    transactionId: v.id("pos_transactions"),
    lines: v.array(v.object({ line_id: v.id("pos_transaction_lines"), qty: v.number(), refund_amount: v.number() })),
  },
  handler: async (ctx, args): Promise<{ receiptNumber: string; lines: Array<{ productCode: string; qty: number; refundAmount: number }> }> => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn?.receipt_number) throw new Error(`REFUND_TXN_NOT_PAID ${args.transactionId}`);
    const lines = [];
    for (const l of args.lines) {
      const tl = await ctx.db.get(l.line_id);
      if (!tl) throw new Error(`REFUND_LINE_MISSING ${l.line_id}`);
      lines.push({ productCode: tl.product_code_snapshot, qty: l.qty, refundAmount: l.refund_amount });
    }
    return { receiptNumber: txn.receipt_number, lines };
  },
});
```

- [ ] **Step 4: Add the paginated refund feed — `convex/refunds/internal.ts`**

```typescript
import { encodeCursor } from "../api/v1/_cursor";
import { internal } from "../_generated/api";

export type ApiRefundRow = {
  receiptNumber: string; createdAt: number; totalRefund: number; reason: string;
  lines: Array<{ productCode: string; qty: number; refundAmount: number }>;
};

export const _listRefundsForApi_internal = internalQuery({
  args: { afterCreatedAtMs: v.optional(v.number()), afterCreationTime: v.optional(v.number()), limit: v.number() },
  handler: async (ctx, args): Promise<{ rows: ApiRefundRow[]; nextCursor: string | null }> => {
    const limit = Math.min(Math.max(args.limit, 1), 500);
    const after = args.afterCreatedAtMs;
    // pos_refunds has by_settlement_status (status, created_at) but no plain
    // by_created_at. Add one (Step 5) and scan it ascending.
    const candidates = await ctx.db.query("pos_refunds")
      .withIndex("by_created_at", (q) => after === undefined ? q : q.gte("created_at", after))
      .order("asc").take(limit * 2 + 1);
    const strictlyAfter = candidates.filter((r) =>
      after === undefined ? true :
      r.created_at > after ? true : r._creationTime > (args.afterCreationTime ?? -Infinity));
    const page = strictlyAfter.slice(0, limit);
    const rows: ApiRefundRow[] = [];
    for (const r of page) {
      const resolved = await ctx.runQuery(internal.transactions.internal._resolveRefundLinesForApi_internal, {
        transactionId: r.transaction_id, lines: r.lines });
      rows.push({ receiptNumber: resolved.receiptNumber, createdAt: r.created_at, totalRefund: r.total_refund, reason: r.reason, lines: resolved.lines });
    }
    const last = page[page.length - 1];
    const more = strictlyAfter.length > limit;
    const nextCursor = more && last ? encodeCursor(last.created_at, last._creationTime) : null;
    return { rows, nextCursor };
  },
});
```

- [ ] **Step 5: Add the `by_created_at` index — `convex/refunds/schema.ts`**

Add to the `pos_refunds` table chain: `.index("by_created_at", ["created_at"])`. Run `npx convex dev --once` to build it.

- [ ] **Step 6: Run to verify the internal test passes**

Run: `npx vitest run convex/refunds/__tests__/api-list.test.ts`
Expected: PASS.

- [ ] **Step 7: Write the endpoint test + implement `convex/api/v1/refunds.ts`**

```typescript
// convex/api/v1/__tests__/refunds.test.ts — mirror transactions.test.ts with
// endpointAllowList: ["/api/v1/refunds"], seeding a refund, asserting body.data[0].lines[0].productCode.
```
```typescript
// convex/api/v1/refunds.ts — copy transactions.ts, swap:
//   PATH = "/api/v1/refunds"
//   internal.refunds.internal._listRefundsForApi_internal
//   args: { afterCreatedAtMs: cur?.orderKeyMs, afterCreationTime: cur?.creationTime, limit }
//   envelope: { data: rows, nextCursor }  (use a refundEnvelope or reuse txnEnvelope — shape-agnostic { data, nextCursor })
```
Generalize `txnEnvelope` in `_shape.ts` to `envelope(rows, nextCursor)` (it's shape-agnostic) and use it from both endpoints.

- [ ] **Step 8: Register the route — `convex/http.ts`**

```typescript
http.route({ path: "/api/v1/refunds", method: "GET", handler: handleRefundsRoute });
```

- [ ] **Step 9: Run the refund suites**

Run: `npx vitest run convex/api/v1/__tests__/refunds.test.ts convex/refunds`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add convex/transactions/internal.ts convex/refunds/internal.ts convex/refunds/schema.ts convex/api/v1/refunds.ts convex/api/v1/_shape.ts convex/http.ts convex/**/__tests__/api-list.test.ts convex/api/v1/__tests__/refunds.test.ts
git commit -m "feat(api): GET /api/v1/refunds — cross-module join feed + route"
```

---

## Task 10: Cursor-pagination + stable-ID conformance gates

**Files:**
- Test: `convex/api/v1/__tests__/pagination.test.ts`, `convex/api/v1/__tests__/conformance.test.ts`

**Interfaces:** consumes everything above; adds the two ADR-034 verification gates not yet covered.

- [ ] **Step 1: Write the pagination boundary test (the load-bearing tiebreak case)**

```typescript
// convex/api/v1/__tests__/pagination.test.ts
// Seed 3 paid txns where TWO share the exact same paid_at ms, straddling a
// page boundary at limit=2. Walk pages via nextCursor until null. Assert:
//   - every receiptNumber appears exactly once (no dupes, no gaps)
//   - the two same-ms rows are split correctly across the boundary by _creationTime
import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";

describe("cursor pagination", () => {
  it("walks all rows once across a same-millisecond page boundary", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const s = await ctx.db.insert("staff", { name: "L", code: "S-0001", role: "staff", active: true, pin_hash: "x", created_at: 0 });
      const mk = async (rn: string, paidAt: number) => {
        await ctx.db.insert("pos_transactions", { status: "paid", subtotal: 1, voucher_discount: 0, total: 1, flags: 0, staff_id: s, created_at: 0, paid_at: paidAt, receipt_number: rn });
      };
      await mk("R-2026-0001", 100);
      await mk("R-2026-0002", 200);   // same ms as next
      await mk("R-2026-0003", 200);
    });
    const seen: string[] = [];
    let cursor: { orderKeyMs: number; creationTime: number } | undefined;
    for (let i = 0; i < 10; i++) {
      const out = await t.query(internal.transactions.internal._listPaidTxnsForApi_internal, {
        afterPaidAtMs: cursor?.orderKeyMs, afterCreationTime: cursor?.creationTime, limit: 2 });
      out.rows.forEach((r: any) => seen.push(r.receiptNumber));
      if (!out.nextCursor) break;
      const { decodeCursor } = await import("../_cursor");
      cursor = decodeCursor(out.nextCursor);
    }
    expect(seen.sort()).toEqual(["R-2026-0001", "R-2026-0002", "R-2026-0003"]);
    expect(new Set(seen).size).toBe(3);  // no duplicates
  });
});
```

- [ ] **Step 2: Run — fix the internal if the boundary leaks/dupes**

Run: `npx vitest run convex/api/v1/__tests__/pagination.test.ts`
Expected: PASS. If it dupes the same-ms row, the `strictlyAfter` filter in Task 7 Step 3 is wrong — the `> afterCreationTime` comparison must exclude the already-returned row.

- [ ] **Step 3: Write the stable-ID conformance test**

```typescript
// convex/api/v1/__tests__/conformance.test.ts
import { describe, it, expect } from "vitest";
const RECEIPT = /^R-\d{4}-\d{4}$/, STAFF = /^S-\d{4}$/, PRODUCT = /^[A-Z][A-Z0-9_]*$/;
// Hit both endpoints with seeded data (reuse the transactions/refunds test seeds)
// and assert every receiptNumber/staffCode/productCode in the response matches.
it("all emitted stable IDs match their contract format", async () => {
  // ...seed + fetch as in transactions.test.ts...
  // for each body.data[i]: expect(RECEIPT.test(...)).toBe(true); etc.
  expect(true).toBe(true); // replace with real assertions against fetched bodies
});
```

Fill in the seed+fetch (copy from `transactions.test.ts`) and assert the regexes against the live response bodies.

- [ ] **Step 4: Run both gates**

Run: `npx vitest run convex/api/v1/__tests__/pagination.test.ts convex/api/v1/__tests__/conformance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/api/v1/__tests__/pagination.test.ts convex/api/v1/__tests__/conformance.test.ts
git commit -m "test(api): cursor-boundary + stable-ID conformance gates"
```

---

## Task 11: Docs + full-suite green + schema smoke

**Files:**
- Modify: `docs/PUBLIC_API.md`, `docs/CHANGELOG.md`
- Optional: `convex/crons.ts` (rate-bucket housekeeping)

- [ ] **Step 1: Fill the endpoint table in `docs/PUBLIC_API.md`**

Mirror CONTRACT §5/§6: two `GET` rows (`/api/v1/transactions`, `/api/v1/refunds`), scope `frollie_pro_full`, cursor pagination, link to CONTRACT.md as the shape source of truth.

- [ ] **Step 2: (Optional) rate-bucket housekeeping cron — `convex/crons.ts`**

If keeping `api_rate_buckets` tidy, add a cron that deletes buckets with `window_start < now - 120_000`. Correctness doesn't require it (lazy windows self-expire logically); this is only storage hygiene. Skip if undesired.

- [ ] **Step 3: CHANGELOG entry — `docs/CHANGELOG.md`**

One entry: "v1.1 — Public API v1: `GET /api/v1/transactions` + `/api/v1/refunds` (bearer-authed, cursor-paginated) for Frollie Pro sales sync. `code` fields now required."

- [ ] **Step 4: Full backend test suite**

Run: `npx vitest run convex`
Expected: ALL PASS (including the prereq-migration test fixes from Tasks 2–3).

- [ ] **Step 5: Typecheck + lint + schema smoke**

Run: `npm run typecheck && npm run lint && npx convex dev --once`
Expected: clean; schema deploys; all indexes build.

- [ ] **Step 6: Commit**

```bash
git add docs/PUBLIC_API.md docs/CHANGELOG.md convex/crons.ts
git commit -m "docs(api): publish v1 endpoint table + changelog; rate-bucket housekeeping"
```

---

## Task 12: Per-request access logging + consumer identity wiring

**Files:**
- Modify: `convex/api/v1/transactions.ts` + `convex/api/v1/refunds.ts` (log once per request)
- Test: `convex/api/v1/__tests__/request-log.test.ts`

**Interfaces:**
- Consumes: `_logApiRequest_internal` (Task 6), `verifyBearerToken` returns `{ tokenId }`.

- [ ] **Step 1: Write the failing test**

```typescript
// convex/api/v1/__tests__/request-log.test.ts
import { convexTest } from "convex-test";
import schema from "../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../_generated/api";

describe("api_request_log", () => {
  it("writes one row per request, incl. unauthenticated attempts", async () => {
    const t = convexTest(schema);
    // unauthenticated → still logged with null token_id
    await t.fetch("/api/v1/transactions", { method: "GET" });
    // authenticated success
    const { rawToken } = await t.mutation(internal.api.v1.internal._issueApiToken_internal, {
      label: "frollie-pro-prod", endpointAllowList: ["/api/v1/transactions"], rateLimitRpm: 1000 });
    await t.fetch("/api/v1/transactions", { method: "GET", headers: { Authorization: `Bearer ${rawToken}` } });

    const rows = await t.run((ctx) => ctx.db.query("api_request_log").collect());
    expect(rows).toHaveLength(2);
    const unauth = rows.find((r: any) => r.http_status === 401);
    expect(unauth!.token_id).toBeUndefined();
    expect(unauth!.endpoint).toBe("/api/v1/transactions");
    const ok = rows.find((r: any) => r.http_status === 200);
    expect(ok!.token_id).toBeDefined();
    expect(typeof ok!.returned_count).toBe("number");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/api/v1/__tests__/request-log.test.ts`
Expected: FAIL — `api_request_log` is empty (endpoints don't log yet).

- [ ] **Step 3: Wire logging into both endpoints**

Refactor each httpAction so every exit path logs exactly once. Pattern for `transactions.ts` (mirror in `refunds.ts`):

```typescript
export const handleTransactionsRoute = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const cursorParam = url.searchParams.get("cursor");
  let tokenId: Id<"api_tokens"> | undefined;
  const log = async (http_status: number, extra: Record<string, unknown> = {}) => {
    try {
      await ctx.runMutation(internal.api.v1.internal._logApiRequest_internal, {
        token_id: tokenId,
        endpoint: PATH, http_status, cursor_in: cursorParam ?? undefined, ...extra,
      });
    } catch (e) { console.error("[api/transactions] log write failed (non-fatal):", e); }
  };
  try {
    const auth = await verifyBearerToken(ctx, request, PATH);
    tokenId = auth.tokenId;
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "100", 10) || 100, 1), 500);
    const cur = cursorParam ? decodeCursor(cursorParam) : undefined;  // throws BAD_CURSOR
    const { rows, nextCursor } = await ctx.runQuery(
      internal.transactions.internal._listPaidTxnsForApi_internal,
      { afterPaidAtMs: cur?.orderKeyMs, afterCreationTime: cur?.creationTime, limit });
    await log(200, { returned_count: rows.length, cursor_out: nextCursor ?? undefined });
    return Response.json(txnEnvelope(rows, nextCursor), { status: 200 });
  } catch (e) {
    if (e instanceof ApiError) {
      await log(e.status, { error_code: e.code });
      return Response.json(errorBody(e.code, e.message), {
        status: e.status, headers: e.code === "RATE_LIMITED" ? { "Retry-After": "60" } : undefined });
    }
    if (e instanceof Error && e.message === "BAD_CURSOR") {
      await log(400, { error_code: "BAD_CURSOR" });
      return Response.json(errorBody("BAD_CURSOR", "cursor failed to decode"), { status: 400 });
    }
    await log(500, { error_code: "INTERNAL" });
    console.error("[api/transactions] internal error:", e);
    return Response.json(errorBody("INTERNAL", "unexpected server error"), { status: 500 });
  }
});
```

Apply the identical structure to `refunds.ts` (swap `PATH`, the internal query, and the cursor arg names).

- [ ] **Step 4: Run the log test + re-run the endpoint suites**

Run: `npx vitest run convex/api/v1`
Expected: PASS (request-log test green; transactions/refunds/auth still green — logging is additive).

- [ ] **Step 5: Commit**

```bash
git add convex/api/v1/transactions.ts convex/api/v1/refunds.ts convex/api/v1/__tests__/request-log.test.ts
git commit -m "feat(api): per-request access log + consumer-identity attribution"
```

---

## Self-Review

**Spec coverage (producer spec §1–§8 + CONTRACT §1–§9):**
- Auth (CONTRACT §2, spec §4.1/§4.2) → Tasks 1, 4, 6. ✅
- Access log → `api_request_log` table (Task 4), `_logApiRequest_internal` (Task 6), per-request wiring + test (Task 12). Token-keyed (the token is the caller; `api_tokens.label` is the human name). No consumer-identity binding / `X-Consumer-Account` in v1. ✅
- Pagination (CONTRACT §3) → Tasks 5, 7, 9, 10. ✅
- Error envelope (CONTRACT §4) → `errorBody` + try/catch in Tasks 8, 9. ✅
- `/transactions` shape (CONTRACT §5) → Tasks 7, 8. ✅
- `/refunds` shape + joins (CONTRACT §6, spec §4.4) → Task 9. ✅
- Stable-ID guarantees (CONTRACT §7, spec §7 prereq) → Tasks 2, 3, 10. ✅
- Testing gates (spec §8): snapshot/shape (7,8,9), auth (6), stable-ID (10), cursor (10), dedup-is-consumer-side (n/a producer), schema smoke (4,9,11). ✅ (Producer has no dedup gate — that's the ERP's; noted in spec §6.)
- Versioning (CONTRACT §8) → `/api/v1/` path prefix throughout; doc note in Task 11. ✅

**Open deviations carried to staffreview:**
1. Issuance via ops-run `internalMutation` instead of session+manager-PIN (plan header). 
2. Auth uses indexed-hash-lookup rather than a manual constant-time compare (equivalent; matches the repo's approval-token pattern).
3. `_listStaffNames_internal` return shape must be confirmed to expose `{ _id, code }` (Task 7 Step 3 note) — add `_listStaffCodes_internal` if not.

**Placeholder scan:** conformance test (Task 10 Step 3) ships with a `expect(true).toBe(true)` stub to be replaced with real assertions in the same step — flagged inline, not a silent gap. Refund endpoint code (Task 9 Step 7) is specified as a delta from `transactions.ts` rather than re-quoted in full — the delta lists every changed line.

**Type consistency:** `ApiTxnRow` (transactions/internal) and `ApiRefundRow` (refunds/internal) are the two row types; `envelope(rows, nextCursor)` is shape-agnostic. `encodeCursor/decodeCursor` signatures match across Tasks 5/7/9/10.
