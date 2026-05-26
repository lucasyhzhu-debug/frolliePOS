# 034. Deep modules with surface APIs as architectural blueprint

**Date:** 2026-05-26
**Status:** Accepted (revised post-staffreview 2026-05-26 — see `docs/reviews/staffreview-adr-034-deep-modules-2026-05-26.md`)
**Group:** Arch (foundational)

## Context

Frollie POS sits inside a larger Frollie ecosystem. Frollie Pro (`product_master`) is the ERP / data aggregator that ultimately owns reporting, accounting, kitchen production, and inventory truth. POS is a **system of record for booth sales** that feeds Frollie Pro.

The two run in **separate Convex deployments**: POS owns `helpful-grasshopper-46` (dev) and `savory-zebra-800` (prod). Frollie Pro owns its own project (`product_master`). This separation is load-bearing — it gives POS independent schema evolution and prevents POS deploys from contaminating Frollie Pro's prod environment. See `CLAUDE.md` §"Convex deployment" for the current URLs and the `.cloud` vs `.site` subdomain split. This decision supersedes the earlier shared-project model documented in [ADR-000 §1](./000-strategic-foundations.md#1-shared-convex-project-with-product_master).

Integration between POS and Frollie Pro is **not optional** — it's a v1.1 commitment that POS sales become Frollie Pro revenue rows. The question is *what shape* that integration takes.

Two failure modes are equally bad:

1. **Schema-coupled integration.** POS tables are designed to mirror Frollie Pro's tables field-for-field, so the sync becomes "copy POS rows into Frollie Pro rows." This makes POS's internal data shape a *de facto* public contract — renaming a field internally breaks Frollie Pro. Refactors become cross-deployment migrations. Cross-deployment `Id<>` types don't work, so the shape mirroring is incomplete anyway.

2. **Undisciplined module boundaries.** Without explicit internal/external surface markers, POS evolves into a tangle where any function might be called by anything. Refactors require global grep. There's no stable contract for Frollie Pro to consume, so integration code is fragile and changes with every POS release.

Both failures are architectural, not coding-discipline issues. They need a design commitment, not a code-review rule.

## Decision

**Frollie POS is architected as a set of deep modules with explicit surface APIs.** This applies at three layers.

### Layer 1 — Internal module boundaries (POS frontend ↔ POS backend)

The `convex/` directory is organised by domain module, not by Convex primitive type. Each module exposes a small, stable public surface and hides its implementation behind it:

```
convex/
  catalog/        # products, components, stock-levels (read side)
    public.ts       # query/mutation — used by POS UI
    internal.ts     # internalQuery/internalMutation — only consumed by other modules
    schema.ts       # local table definitions (re-exported by root schema.ts)
  cart/           # draft transaction building
  checkout/       # payment lifecycle (Xendit, webhooks, polling, manual override)
    webhook.ts      # httpAction — INBOUND from Xendit (not part of external API surface)
  transactions/   # finalised sales + refunds
  inventory/      # stock movements (write side)
  vouchers/       # discount codes + redemption
  auth/           # staff, sessions, devices
  audit/          # append-only log (internal-only — no public.ts)
    internal.ts     # logAudit() — called by every state-changing mutation
  approvals/      # WA approval flow
  api/            # ===== EXTERNAL API SURFACE (Layer 2) =====
    v1/
      transactions.ts   # httpAction — Frollie Pro pulls sales
      catalog.ts        # httpAction — Frollie Pro reads catalog (optional)
      inventory.ts      # httpAction — Frollie Pro reads stock
      _auth.ts          # bearer-token verification middleware
      _tokens.ts        # token storage table + issuance/revocation
  http.ts         # registers httpAction routes (Convex requires central registration)
  schema.ts       # composes module schemas into one defineSchema()
```

**Rules:**
- A module's `public.ts` exports `query` / `mutation` / `action`. Anything called by the POS frontend lives here.
- A module's `internal.ts` exports `internalQuery` / `internalMutation` / `internalAction`. Only consumed by other modules' code. Convex enforces this — `internal*` functions are not exposed to clients.
- Modules talk to other modules only through their `public.ts` or `internal.ts` exports. Direct table access (`ctx.db.query("other_module_table")`) across module boundaries is a CI lint block (see §"Verification").
- Each module owns its tables. Schema fragments live in `<module>/schema.ts`; `convex/schema.ts` composes them. No table is "shared" across modules — if two modules need the same data, one owns it and the other reads through the owner's public/internal API.
- **Reactive subscriptions across modules are expected and supported.** POS frontend subscribes directly to multiple modules' `public.ts` queries; Convex's reactive query engine handles the merge. Aggregator modules are an anti-pattern — they centralize subscription state for no benefit.

### Layer 2 — External API surface (POS ↔ Frollie Pro / future consumers)

Frollie Pro consumes POS via **versioned outbound HTTP actions** under `convex/api/v1/`. No direct Convex client access, no cross-deployment Convex queries, no shared schema package.

**Rules:**
- Path prefix `/api/v1/` on every external endpoint. Breaking changes require `/api/v2/`; deprecation window per §"Implementation notes — Versioning".
- Bearer-token auth via `Authorization: Bearer <token>` header. See §"Implementation notes — API authentication model" for the full spec.
- Response shapes use **stable string identifiers**, never Convex `_id`s. `receiptNumber`, `productCode`, `componentCode`, `staffCode` etc. POS owns the string-id namespace and guarantees stability.
- Field naming in API responses uses `camelCase` (industry-standard HTTP/JSON convention). Internal POS field naming is unconstrained by this — `snake_case` POS tables map to `camelCase` API responses at the boundary via a small `toApiShape()` helper per module.
- Pagination via opaque `cursor` strings (Convex pagination model). Response shape: `{ data: [...], nextCursor: string | null }`.
- Errors return a standard envelope: `{ error: { code: string, message: string, details?: object } }` with appropriate HTTP status codes.
- Every external endpoint has a contract document in `docs/PUBLIC_API.md` with request/response examples. Adding/changing an endpoint requires updating `docs/PUBLIC_API.md` in the same commit (enforced in PR template).

### Layer 3 — Data is private

POS table shapes, field names, and `Id<>` types are **internal implementation detail**. They can evolve freely — rename fields, restructure tables, change types — as long as the public + external API surfaces continue to satisfy their contracts.

`docs/SCHEMA.md` describes the *current* internal schema for POS developers (audience: POS engineers). `docs/PUBLIC_API.md` describes the *stable* external contract for consumers (audience: Frollie Pro engineers + future consumers). These are different documents serving different audiences.

## Cross-module patterns

Three patterns recur across modules. They are non-negotiable.

### 1. Audit logging from any state-changing mutation

Every state-changing mutation calls `audit/internal.logAudit(ctx, {...})`. This is the only sanctioned cross-module call inside a mutation. Mechanics:

- `logAudit` is an `internalMutation` (NOT an `internalAction`). Convex `internalMutation` calls invoked from inside another `mutation` run **in the same transaction**. If the audit write fails for any reason, the entire mutation rolls back — the [ADR-007](./007-audit-log-append-only.md) append-only-and-always-present guarantee is preserved.
- The existing `convex/audit.ts` file moves to `convex/audit/internal.ts` during the restructure. Call sites update import path; behaviour unchanged.
- Direct `ctx.db.insert("audit_log", ...)` from outside the audit module is a lint block — same enforcement as cross-module table access.

### 2. Cross-module state-changing mutations

When a mutation in one module needs to modify state owned by another (canonical example: `transactions/public.checkoutSale` redeeming a voucher), it calls the owning module's `internal.ts` function:

```ts
// convex/transactions/public.ts
export const checkoutSale = mutation({
  args: { /* ... */ },
  handler: async (ctx, args) => {
    // ... finalise sale ...
    if (args.voucherCode) {
      await ctx.runMutation(internal.vouchers.redeem, {
        code: args.voucherCode,
        transactionId,
      });
    }
    await ctx.runMutation(internal.audit.logAudit, { /* ... */ });
  },
});
```

All called `internalMutation`s run in the same transaction — partial-write inconsistency is impossible by construction. This is a Convex guarantee, not a POS invention.

`internalAction` is **not** transactional with the caller. Cross-module actions (e.g., calling Xendit) must be designed to be idempotent and reconciled separately — the existing payment-confirmation pattern ([three-path confirmation, ADR-000 §8](./000-strategic-foundations.md#8-three-path-payment-confirmation-operational-pattern)) is the reference.

### 3. Reactive subscriptions across modules

POS frontend subscribes to whatever `public.ts` queries it needs, across whatever modules. Convex handles the reactive merge. No aggregator modules. No subscription proxies.

Example: the cart screen subscribes to `catalog.listProducts`, `cart.getCurrentCart`, `inventory.getStockLevels`, and `vouchers.getActiveVouchers` — four queries across four modules, all reactive, all merged client-side by React.

## Alternatives considered

- **Schema-first mirroring of Frollie Pro.** Considered and rejected in the architectural review preceding this ADR. Couples POS internals to Frollie Pro's data shape. Cross-deployment `Id<>` types don't work, so the mirroring is incomplete and requires translation anyway. Field renames in either system become cross-deployment migrations. POS loses architectural autonomy.
- **Shared Convex deployment (POS inside `product_master`).** Was the original [ADR-000 §1](./000-strategic-foundations.md#1-shared-convex-project-with-product_master) direction, since superseded. Maximum reuse but shared blast radius (a POS bug breaks Frollie Pro). The separate-deployment fact (now documented in `CLAUDE.md` §"Convex deployment") is load-bearing.
- **Direct Convex-to-Convex sync.** Convex's deployment isolation is intentional; there's no first-class cross-deployment query primitive. Building one via `httpAction` is exactly what the external API surface in this ADR is — just framed as a deliberate contract rather than a leaky pipe.
- **GraphQL or tRPC instead of HTTP actions.** Rejected for v1: extra dependencies, schema-definition tax, runtime surface area. Convex `httpAction` is already a thin HTTP wrapper; bearer-token + JSON is sufficient for the integration patterns POS needs. Reconsider if a third consumer joins.
- **No module structure (flat `convex/` directory like today).** Rejected: scales poorly past ~20 functions. Already at 14 designed Convex files (per [`CLAUDE.md` file locations](../../CLAUDE.md#file-locations)) before transactions, payments, refunds, stock, vouchers, approvals, etc. exist. Module boundaries are cheap to set up now, expensive to retrofit.

## Consequences

### Easier
- **Schema evolution is internal.** Renaming a `pos_transactions` column doesn't ripple into Frollie Pro. Convex's `internalQuery` / `internalMutation` markers make the public/internal split syntactically enforced.
- **Integration is versioned and testable.** Frollie Pro consumes a documented HTTP contract. Both sides can mock the API in tests. Adding `/api/v2/` is a clean cutover, not a coordinated migration.
- **Module ownership is clear.** Each domain has a single owner module. Cross-module reads go through public/internal APIs — CI lints reject violations mechanically.
- **Blast radius isolated.** POS deploys can't break Frollie Pro because there's no shared database. API contract changes are versioned. Worst case is API consumers fall back to `/v1/` while POS internals churn.

### Harder
- **Module boundary discipline.** Easy to slip "just this one cross-module read." Mitigation: hard CI gate (see §"Verification"), not a soft warning.
- **String-id stability is now a commitment.** POS owns `receiptNumber`, `productCode`, `componentCode`, `voucherCode`, `staffCode` as durable identifiers. Renaming them later is a breaking API change. `docs/PUBLIC_API.md` documents which strings are stable IDs.
- **Two surface layers means more files.** Each domain gets `public.ts` + `internal.ts` + `schema.ts` minimum; integration domains add `api/v1/<domain>.ts`. Upfront cost in file count.
- **Translation layer at the API boundary.** POS-internal `snake_case` → API-external `camelCase` requires a mapping function per endpoint. Mitigation: small `toApiShape()` helper per module; tested separately with snapshot tests.
- **`docs/SCHEMA.md` and `docs/PUBLIC_API.md` are both load-bearing and must not drift.** Mitigation: API-changing PRs must update `docs/PUBLIC_API.md` (enforce in PR template); SCHEMA.md updates as part of any schema change (existing convention per CLAUDE.md §"How to add a feature").

### Reversal cost
**Moderate.** Switching back to schema-coupled integration means:
- Tearing out `convex/api/v1/`
- Exposing internal schema directly via some sync mechanism
- Rewriting Frollie Pro's consumer code
- Estimated 2-3 weeks of work plus a backfill of historical data through the new path.

**Switching the internal module structure back to flat is cheaper** (~1 week) but rarely necessary — modules can be flattened by moving files without changing any external behaviour.

### Affects other ADRs / docs

This ADR **supersedes or amends**:
- **[ADR-000 §1](./000-strategic-foundations.md#1-shared-convex-project-with-product_master)**: the shared-Convex-project decision is already obsolete. This ADR makes that separation a load-bearing architectural commitment, not an accident.
- **`CLAUDE.md` "Stack" section**: the directive "Mirror Frollie Pro. No deviation without an ADR." is relaxed for *data shape* — POS internal schema is independent. The directive still holds for *stack choices* (Convex, React 19, Tailwind 4, etc.) where mirroring serves codebase consistency.
- **`docs/SCHEMA.md`** introduction: reframed as "POS-internal schema. For integration contracts see `docs/PUBLIC_API.md`."
- **New artifact required**: `docs/PUBLIC_API.md` defining the external API contract, versioning policy, auth model, and endpoint catalogue. Drafted as part of the follow-up `v0.6-architecture-restructure` planning phase.

This ADR **does not affect**:
- Any ADR about POS-internal behaviour (PIN auth, idempotency, audit log shape, voucher rules, refund modelling, payment flow, etc.) — these all describe internal-module concerns and survive untouched.
- The `staff_sessions`, `registered_devices`, `audit_log` schema decisions — these are POS-internal, never exposed externally.

## Implementation notes

### Module-boundary lint (hard CI gate)

**Mechanism:** Custom ESLint rule (preferred) or `grep` check in CI workflow. Both options will work; ESLint integrates with editor tooling.

**What it checks:** in any file under `convex/<moduleA>/`, any reference to a table name owned by `convex/<moduleB>/schema.ts` is a violation. The ownership map is derived statically from `convex/*/schema.ts` exports.

**Severity:** ERROR. CI fails. PR cannot merge.

**Exceptions:** `audit/` is the only module other modules call cross-boundary (via `internal.logAudit`). The lint rule recognises this single allow-list entry.

**Owner:** the follow-up `v0.6-architecture-restructure` planning phase delivers this lint rule as a hard prerequisite — before any module migration happens. Migration without the lint risks introducing violations that are then invisible.

### API authentication model

Bearer tokens for the external API surface follow these rules:

- **Storage**: tokens stored in `convex/api/v1/_tokens.ts` module's `api_tokens` table. The token value is **hashed at rest with argon2id**, reusing the helper pattern established by [ADR-004](./004-pin-hashing-server-side.md). The raw token is shown once at issuance and never again.
- **Comparison**: validation uses **constant-time comparison** (`crypto.timingSafeEqual` or equivalent in the Convex action runtime). Plain `===` is forbidden.
- **Schema** (`api_tokens` table):
  ```
  hash: string                    // argon2id(raw_token)
  scope: union(
    "frollie_pro_full",           // includes PII fields (customer_phone, etc.)
    "frollie_pro_aggregate_only"  // numeric rollups only, no PII
  )
  endpointAllowList: array(string) // explicit enum of endpoint codes — e.g. ["v1/transactions", "v1/inventory"]
                                  // NOT patterns/globs/regex (typos silently grant access)
  rateLimitRpm: number            // default 60 requests/min; configurable per token
  issuedAt: number                // server-set Date.now() per ADR-031
  expiresAt: number               // mandatory; max 365 days from issuance
  rotatedFrom: optional(id("api_tokens")) // links to previous token during overlap window
  revokedAt: optional(number)
  createdByStaffId: id("staff")   // manager who issued
  ```
- **Rotation**: tokens roll via overlapping validity windows. Manager issues new token → both old + new are valid for 7 days → manager revokes old. No downtime for consumers.
- **Revocation**: setting `revokedAt` is immediate; in-flight requests using the revoked token fail at the next auth check. Auth check runs on every request — no caching.
- **Rate limiting**: per-token request-per-minute counter in a separate `api_rate_buckets` table; reset every 60s by a scheduled action. Exceeding the limit returns `429 Too Many Requests` with `Retry-After` header.
- **PII scope gating**: `scope: "frollie_pro_aggregate_only"` strips PII fields (customer_phone, customer_name, voided_by, reason notes) from API responses before serialization. Implemented as a serializer parameter, not a separate endpoint set.
- **Issuance UX**: manager-PIN-gated Convex mutation in `convex/api/v1/_auth.ts` (logged to `audit_log`). For v1, no dashboard UI — managers run via Convex CLI or a hidden manager-PIN-gated tool. Dashboard UI deferred to a future phase if multiple consumers materialise.
- **Audit**: every external API request logs to `audit_log` with `source: "api_consumer"` (new enum value — add during restructure) and `actor_id: "system"`, `metadata: { tokenId, scope, endpoint }`. Token issuance/rotation/revocation events log with the issuing manager as `actor_id`.

### Stable string identifiers

POS owns and guarantees stability for:

| Identifier | Format | Owner module | Used in API | Notes |
|---|---|---|---|---|
| `receiptNumber` | `R-YYYY-NNNN` (per [ADR-023](./023-receipt-number-format.md)) | transactions | ✅ primary key for sales | Allocated at sale finalisation |
| `productCode` | UPPERCASE_SNAKE (e.g. `DUBAI_8PC`) | catalog | ✅ product lookup | Immutable post-creation |
| `componentCode` | UPPERCASE_SNAKE (e.g. `DUBAI`) | catalog | ✅ atom-level inventory | Immutable post-creation |
| `voucherCode` | UPPERCASE (e.g. `OPEN10`) | vouchers | ✅ voucher redemption echo | Immutable post-creation |
| `staffCode` | `S-NNNN` (e.g. `S-0042`) | auth | ✅ attribution on sales | Opaque, immutable. **NOT `staffName`** — names change |

`staffName` continues to exist as a **mutable display-only field** on API responses (denormalised at sale time for human-readable receipts) but is never the join key. Schema commitment: the `staff` table adds `code: v.string()` with a `by_code` index, populated at row creation and never updated.

Convex `_id` values are **never** part of the API surface.

### Schema composition

`convex/schema.ts` composes per-module table fragments. Each module exports its tables from `<module>/schema.ts`:

```ts
// convex/catalog/schema.ts
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const catalogTables = {
  pos_products: defineTable({ /* ... */ }).index("by_active_sort", ["active", "sort_order"]),
  pos_inventory_skus: defineTable({ /* ... */ }).index("by_sku", ["sku"]),
  pos_product_components: defineTable({ /* ... */ }).index("by_product", ["product_id"]),
};
```

Root composition:

```ts
// convex/schema.ts
import { defineSchema } from "convex/server";
import { catalogTables } from "./catalog/schema";
import { cartTables } from "./cart/schema";
import { transactionsTables } from "./transactions/schema";
// ... etc.

export default defineSchema({
  ...catalogTables,
  ...cartTables,
  ...transactionsTables,
  // ...
});
```

The restructure phase validates this pattern actually compiles + deploys cleanly via `npx convex dev --once` before any module migration happens.

### Versioning policy

- `/api/v1/` is the current contract.
- A new `/api/v2/` is introduced only for breaking changes. Additive changes (new optional fields, new endpoints) ship under the current version.
- **Deprecation window: 14 days minimum, with explicit written agreement from each active consumer** (Slack thread, GitHub issue, or commit message reference is sufficient). The 14-day floor is for one-consumer reality (Frollie Pro); future external consumers will negotiate per-contract windows. The previous draft's 90-day RFC-8594 ceremony was theatrical for an internal API — relax it now, tighten if/when an external consumer requires it.
- During deprecation, `/v1/` responses include `Sunset: <RFC 7231 date>` and `Deprecation: true` HTTP headers per [RFC 8594](https://datatracker.ietf.org/doc/html/rfc8594).

### Inbound vs outbound `httpAction`

Convex `httpAction` is a single primitive but POS uses it in two distinct surface categories:

- **Outbound (external API surface)**: `convex/api/v1/*` — POS publishes data for consumers (Frollie Pro). Versioned (`/v1/`), bearer-token auth, stable string IDs, snapshot-tested. Governed by this ADR.
- **Inbound (provider webhooks)**: lives inside the relevant domain module — e.g., `convex/checkout/webhook.ts` for Xendit, future `convex/approvals/telegram_webhook.ts` for Telegram (if the POC graduates). Authenticated by provider-specific signing keys (Xendit callback token, etc.). NOT versioned at the POS path — Xendit's webhook URL is what Xendit knows about. NOT bearer-token auth.

Both register routes through `convex/http.ts` (Convex requires central registration) but they don't share auth middleware, surface conventions, or stability guarantees.

## Verification

Architecture without verification is aspiration. The following mechanisms are mandatory; they are CI-enforced or scheduled.

### 1. Module-boundary lint (hard CI gate)

Per §"Implementation notes — Module-boundary lint". Custom ESLint rule rejects any cross-module `ctx.db.*` access except the `audit/` allow-list entry. PR cannot merge on violation.

### 2. API response shape snapshot tests

Every endpoint under `convex/api/v1/*` has a Vitest snapshot test that captures the response shape for a fixed input. Accidental field renames, removals, or type changes fail the test. Updating a snapshot requires explicit `--update-snapshot` and review of the diff.

```
convex/api/v1/__tests__/
  transactions.snapshot.test.ts
  catalog.snapshot.test.ts
  inventory.snapshot.test.ts
```

These tests don't validate semantics — they validate **shape stability**. Semantic tests live alongside the underlying module's tests.

### 3. Bearer-token auth path tests

Every authentication branch is covered:

- Valid token + valid scope + valid endpoint → 200
- Valid token + insufficient scope → 403 + correct error envelope
- Valid token + endpoint not in allow-list → 403
- Expired token → 401
- Revoked token → 401
- Wrong-format / malformed token → 401
- Missing `Authorization` header → 401
- Rate-limit exceeded → 429 + `Retry-After` header

Plus: timing-attack regression test (constant-time comparison must take indistinguishable time for valid-prefix vs invalid-prefix tokens).

### 4. Schema composition smoke test

CI runs `npx convex dev --once` after the restructure to verify the composed schema parses, deploys, and indexes build. Catches accidental name collisions across module schemas at PR time.

### 5. Stable-ID format conformance

A unit test for each stable identifier (`receiptNumber`, `productCode`, `componentCode`, `voucherCode`, `staffCode`) verifies the format regex. Catches accidental drift in id allocation logic — e.g., a refactor that starts emitting `R-2026-42` instead of `R-2026-0042`.

### 6. PII scope enforcement test

For each endpoint that returns PII fields, two tests:
- With `scope: "frollie_pro_full"` token → PII fields present.
- With `scope: "frollie_pro_aggregate_only"` token → PII fields absent (not null — *absent*).

These six mechanisms together form the architectural test suite. If any one is removed, this ADR's commitments are no longer enforced — flag as a Critical issue in code review.

## Edge cases addressed

| Edge case | Handling |
|---|---|
| Frollie Pro calls `/api/v1/...` mid-POS-deploy | Convex deploys are atomic per function; in-flight requests complete on the deployed-at-start code version. No request hangs across the deploy boundary. |
| Bearer token revoked mid-request | Auth middleware re-checks token state at the start of every request; in-flight request that was already past auth completes (acceptable — single request, bounded scope). The next request fails with 401. |
| Pagination cursor invalidation | If a row that a cursor points past is deleted, Convex pagination silently skips it. Consumer sees a slightly-different page but no error. Hard-delete is rare in POS (audit-log + snapshots mean soft-delete is the norm). |
| Cross-module mutation fails partway | All `internalMutation` calls run in the caller's transaction (Convex guarantee). Partial-write is impossible. |
| Two modules subscribe to overlapping reactive data | Convex's reactive engine handles this transparently — both subscriptions see consistent snapshots, updated together. No special pattern needed. |
| Stable-ID's underlying record is "deleted" | POS uses soft-delete (`active: false`) for catalog entries; the API returns the record with `active: false` rather than 404. Hard-deletion of catalog entries is forbidden (would break historical receipts that reference the code). |

## Related

- `CLAUDE.md` §"Convex deployment" — the separate-deployment fact this ADR builds on.
- [ADR-000 §1](./000-strategic-foundations.md#1-shared-convex-project-with-product_master) — superseded by this ADR's deployment-isolation commitment.
- [ADR-004](./004-pin-hashing-server-side.md) — argon2id pattern reused for bearer-token hashing.
- [ADR-007](./007-audit-log-append-only.md) — audit log append-only guarantee; preserved by the cross-module audit pattern (audit write is in the same transaction).
- [ADR-013](./013-idempotency-keys.md) — applies inside POS; the external API has its own idempotency model (`Idempotency-Key` header on POST requests; documented in `docs/PUBLIC_API.md`).
- [ADR-023](./023-receipt-number-format.md) — `receiptNumber` format is the canonical stable-id example.
- [ADR-031](./031-convex-server-time-wins.md) — server-time-wins applies to `issuedAt` / `expiresAt` on tokens.

## Acceptance criteria

This ADR moved from Proposed to Accepted on 2026-05-26 after:

1. All Critical issues from `docs/reviews/staffreview-adr-034-deep-modules-2026-05-26.md` resolved in-line (memory cross-ref replaced with inline + CLAUDE.md pointer; verification mechanisms committed in §"Verification"; `staffName` → `staffCode`; bearer-token spec expanded in §"API authentication model"; cross-module audit pattern documented in §"Cross-module patterns").
2. Resolved Questions section (below) decided in-line rather than deferred.
3. `docs/ADR/README.md` index updated with ADR-034 + new "Arch" group.
4. `docs/CHANGELOG.md` entry added.
5. `CLAUDE.md` "Stack" section relaxed per ADR text.

**Not yet done** (post-acceptance follow-ups):
- Create `v0.6-architecture-restructure` planning phase. This is the implementation deliverable that operationalises this ADR. Status: scheduled, not started.
- Draft `docs/PUBLIC_API.md` (lives inside the restructure phase as its primary doc artifact).

## Resolved questions

Decisions made during staffreview revision pass, captured for traceability:

1. **Standalone vs absorbed into ADR-000?** → Standalone. ADR-000 is already long; absorbed too early, the foundation can't show its own implementation detail. Reconsider absorbing after the pattern proves itself in code (~3 months post-restructure).
2. **`docs/API.md` vs `docs/PUBLIC_API.md`?** → `docs/PUBLIC_API.md`. `API.md` collides with the existing `docs/API_REFERENCE.md` (Convex function reference, internal-facing). `PUBLIC_API.md` makes the external-facing scope explicit.
3. **Lint rule hard CI gate vs soft warning?** → Hard CI gate. Soft warnings get ignored within weeks. Trade-off: blocks the restructure phase if the lint isn't ready first — answer: ship the lint first, in the same phase, before any module move.
4. **Token issuance UX (CLI vs dashboard)?** → CLI / hidden manager tool for v1. Single consumer (Frollie Pro) needs exactly one token. Dashboard UI deferred until a second consumer materialises.
5. **Existing code retroactive vs forward-only restructure?** → Retroactive. Current codebase is small (14 designed Convex files, most not yet implemented). Mixed-convention codebase would confuse new engineers and AI agents for marginal speedup.
