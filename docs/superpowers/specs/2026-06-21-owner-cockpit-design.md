# Owner cockpit — a business owner manages all their outlets from one same-backend route tree

**Date:** 2026-06-21
**Phase:** v2 (multi-tenancy program, Phase 1.5)
**Branch (target):** feat/v2-owner-cockpit
**Decomposition rationale:** brainstorm 2026-06-21 (multi-tenancy / SaaS program); staffreview at `/spec-plan-pipeline`
**Status:** Brainstorm

> **No new ADR.** This spec implements decisions already recorded in the multi-tenancy program. It **depends on** and references:
> - **Spec 1 — outlet data plane** (`docs/superpowers/specs/2026-06-21-multi-tenancy-foundation-design.md`): the `outlets` table, the `outlet_id` column threaded through every operational table, `staff_outlet_access`, session-derived outlet scoping, the `withOutletScope` helper, per-outlet singletons, the `R-<outletcode>-YYYY-NNNN` receipt counter.
> - **Spec 2 — owner session / Telegram-OTP auth** (`docs/superpowers/specs/2026-06-21-owner-auth-plane-design.md`): the `owner` role, `staff_sessions.kind` discriminator (`"booth" | "cockpit"`), `staff.telegram_user_id`, OTP-to-DM binding, `requireOwnerSession(...)`, durable cockpit session, the new auth principle **"OTP authorizes MANAGE"** (extends ADR-029).
> - **Spec 4 — Telegram per-outlet routing** (`docs/superpowers/specs/2026-06-21-per-outlet-telegram-routing-design.md`): `telegramChats.outlet_id`, the `by_role_outlet` index, `getChatIdByRoleAndOutlet`, owners chat = business-wide / managers chat = per-outlet, optional managers-chat provisioning from the wizard.
>
> This spec OWNS: the cockpit route tree + owner-scoped query/mutation layer, the **new-outlet wizard** (primary flow) and its underlying **clone mutation**, the **outlet switcher / context** for owners, and the **dashboard feature roadmap**.

---

## Identity

The **owner cockpit** is a new, durable-session product surface for a business **owner** — distinct from the device-bound booth app and the Phase-2 platform console. It runs on the **same Convex deployment** as that business's outlets (mandatory: its whole job is cross-outlet reads inside the silo), under a **separate route tree** (`src/routes/cockpit/*`) gated by an owner session (Spec 2), served by **owner-scoped, outlet-UNSCOPED** Convex queries/mutations.

This slice ships concretely:

1. **The cockpit shell + owner session gate** — a `CockpitLayout` route subtree that mounts only for `session.kind === "cockpit"` + `role === "owner"`, with an **outlet switcher** that sets a client-side outlet-context (the owner is the one principal NOT outlet-locked).
2. **The guided new-outlet wizard** — the *primary* owner flow: clone-from-existing OR blank → name → address → timezone → bank/receipt config → staff access → (optional) provision managers Telegram chat → review/create.
3. **The owner clone mutation** — single-writer, idempotent, audited; copies/remaps/skips exactly the tables in the locked clone decision.
4. **Owner-scoped query layer scaffolding** — the `requireOwnerSession`-gated read surface (`cockpit/*` Convex modules) that the dashboard roadmap builds on, with **one** dashboard landing page (`cockpit/index`) shipped to prove the cross-outlet read path.

**Out of scope for this slice (roadmap, named below):** consolidated + per-outlet financial dashboards, cross-outlet transactions browser, product management, promotions management, staff-access management UI. Each is specced incrementally; this doc names their data sources and owner-scoped queries so the route tree and access layer don't get redesigned later. Also out of scope: the Phase-2 control plane (registry/billing/provisioning) and any cross-deployment behavior.

---

## Architecture overview

| # | Stream | Owner module(s) | Risk |
|---|---|---|---|
| A | Cockpit route tree + owner session gate + `CockpitLayout` | `src/routes/cockpit/*`, `src/components/layout/CockpitLayout` | Med — must not leak into booth `RootLayout`; depends on Spec 2 session kind |
| B | Owner outlet context + switcher | `src/contexts/OutletContext`, `convex/cockpit/outlets` | Low |
| C | Owner-scoped query layer (`requireOwnerSession`-gated, outlet-unscoped) | `convex/cockpit/*` | Med — outlet-UNSCOPED reads are the inverse of the Spec-1 fence; needs its own ESLint carve-out |
| D | New-outlet wizard (FE) | `src/routes/cockpit/outlets/new/*` | Med — multi-step, blank vs clone fork |
| E | Owner clone mutation (BE) | `convex/cockpit/outlets` (action + internal mutations) | **High** — multi-table copy + id remap; must be idempotent + audited |
| F | Dashboard roadmap (named only; one landing page shipped) | `convex/cockpit/dashboard`, `src/routes/cockpit/index` | Low (this slice) |

---

## Workstream A — Cockpit route tree + owner session gate

**Goal:** a `cockpit/*` route subtree that mounts only under a valid **cockpit-kind owner** session, with its own layout shell — never reachable from the booth picker.

### Routing

React Router v7 (library mode). The cockpit is a **sibling subtree** to the booth routes, not nested under `RootLayout`. A separate top-level branch:

```
/cockpit                       → CockpitLayout (owner session gate)
  /cockpit                     → cockpit/index        (dashboard landing — Stream F)
  /cockpit/outlets             → cockpit/outlets/index (outlet list + "New outlet" CTA)
  /cockpit/outlets/new         → cockpit/outlets/new/index (wizard host — Stream D)
  /cockpit/settings            → cockpit/settings (owner profile / logout) — stub this slice
```

**New routes (files under `src/routes/cockpit/`):**

| Route file | Renders |
|---|---|
| `cockpit/index.tsx` | Dashboard landing (Stream F): outlet count + consolidated headline numbers + per-outlet cards |
| `cockpit/outlets/index.tsx` | Outlet list (name, code, address, active, today's sales chip) + "New outlet" button |
| `cockpit/outlets/new/index.tsx` | Wizard host + step machine (Stream D) |
| `cockpit/settings.tsx` | Stub: owner name, signed-in-via-Telegram badge, "Log out" |

`/cockpit/login` is **owned by Spec 2** (the Telegram-OTP surface). This spec assumes `requireOwnerSession` resolves and the FE has a cockpit-kind session id in storage.

### `CockpitLayout` (new — `src/components/layout/CockpitLayout.tsx`)

Mirrors `RootLayout`'s session-gate shape but reads a **cockpit** session:

- Reads cockpit session id from a **separate storage key** (`COCKPIT_SESSION_KEY` in `src/lib/storage-keys.ts`) so a booth session and a cockpit session can coexist on the same browser without clobbering each other.
- Queries `api.cockpit.session.getOwnerSession({ sessionId })` (Spec 2 query; outlet-unscoped, projects `{ staff: { _id, name, role }, kind, startedAt }`).
- Gate: `null` / not `kind: "cockpit"` / `role !== "owner"` → redirect to `/cockpit/login`.
- Renders an `AppHeader`-style cockpit bar with the **OutletSwitcher** (Stream B) and an outlet/business label.

**FE hook:** `useOwnerSession()` (`src/hooks/useOwnerSession.ts`), modeled on `useSession()` but keyed on `COCKPIT_SESSION_KEY`; returns `{ status: "loading" | "none" | "active"; staff; sessionId }`. Same module-listener + cross-tab `storage` sync pattern.

### Tests
- Route-gate unit: cockpit subtree redirects to `/cockpit/login` when session absent / wrong kind / non-owner role.
- `useOwnerSession` storage-key isolation: a booth `storeSession` does not surface in `useOwnerSession`.

---

## Workstream B — Owner outlet context + switcher

**Goal:** the owner picks a "current outlet" to scope **per-outlet views**, while consolidated views stay outlet-unscoped. The owner is the only principal NOT bound to a device outlet (per locked decision), so context is **client-state**, not session-stamped.

### `OutletContext` (new — `src/contexts/OutletContext.tsx`)
- Provides `{ outlets: OutletSummary[]; currentOutletId: Id<"outlets"> | "all"; setCurrentOutlet(id) }`.
- `"all"` is the default (consolidated view). Per-outlet pages read `currentOutletId`; if `"all"`, they show a "pick an outlet" affordance or aggregate.
- Persists `currentOutletId` to localStorage (`COCKPIT_CURRENT_OUTLET_KEY`) so the choice is sticky per browser.
- Source query: `api.cockpit.outlets.listOutlets` (below).

### `OutletSwitcher` (new — `src/components/cockpit/OutletSwitcher.tsx`)
- Dropdown in the cockpit header: "All outlets" + one row per outlet (`name` — `code`). Selecting sets context.

### Convex — `convex/cockpit/outlets.ts`

```ts
// listOutlets — owner-scoped, outlet-UNSCOPED (returns ALL outlets in the deployment)
export const listOutlets = query({
  args: { sessionId: v.id("staff_sessions") },
  // requireOwnerSession(ctx, sessionId)  → throws NO_OWNER_SESSION if not cockpit+owner
  // returns: { _id, name, code, address?, timezone, active, created_at }[]
});
```

Returns the full `outlets` list (Spec 1 table). No `outlet_id` arg — the owner sees the business, not one outlet. This is the canonical example of an **owner-scoped, outlet-unscoped read** (Stream C invariant).

### Tests
- `listOutlets` returns all outlets for an owner session; throws `NO_OWNER_SESSION` for a booth/staff/manager session.

---

## Workstream C — Owner-scoped (outlet-unscoped) query layer

**Goal:** a dedicated `convex/cockpit/*` module namespace where queries deliberately read **across all outlets** — the structural inverse of Spec 1's `withOutletScope` fence.

### Invariant
Spec 1 makes session-derived `outlet_id` mandatory on operational reads (booth/manager). The cockpit is the **sanctioned exception**: an owner reads the whole silo. To keep this auditable and prevent accidental cross-outlet leaks elsewhere:

- **All** owner-unscoped reads live under `convex/cockpit/` and gate on `requireOwnerSession(ctx, sessionId)` (Spec 2) as their **first line**.
- **ESLint carve-out:** Spec 1 adds a rule (mirroring `tools/eslint-rules/no-cross-module-db-access.js`) that flags operational-table reads lacking an `outlet_id` index prefix. `convex/cockpit/**` is **allowlisted** for that rule (the only directory permitted outlet-unscoped reads) — documented inline + in `eslint.config.js`. The carve-out is *narrow*: cockpit modules still obey `no-cross-module-db-access` for table ownership; they read via the owning module's `internal.ts` cross-outlet reader, not raw `ctx.db` on another module's table.

> **Pattern note for plan:** prefer adding `_listAllOutlets_internal` / `_dashboardAcrossOutlets_internal` readers in each *owning* module (transactions, settlements, refunds, catalog) and have `convex/cockpit/*` call them via `ctx.runQuery(internal.<module>...)`. That keeps table ownership intact and the cockpit module a thin aggregator. Where an owning module already has a single-outlet reader (`_fetchDayWindow_internal`), add an outlet-unscoped sibling rather than overloading it with an optional arg (rule-of-three: extract only when the third caller appears).

### Module layout
```
convex/cockpit/
  session.ts    # getOwnerSession (Spec 2 surface re-exported here OR imported)
  outlets.ts    # listOutlets, createOutlet (action), cloneOutlet wiring, internal commit mutations
  dashboard.ts  # consolidatedSummary, perOutletSummary (Stream F — landing page only this slice)
  __tests__/
```

---

## Workstream D — New-outlet wizard (FE)

**Goal:** the *primary* owner flow. A guided, multi-step wizard that lets an owner stand up a new outlet — blank or cloned from an existing one — in one journey. Only owners reach it (locked decision: only owners create outlets).

### Route + host
`src/routes/cockpit/outlets/new/index.tsx` hosts a step machine (`useReducer` or a small `step` state). No router sub-routes per step (keeps wizard state in one component; back/next is in-component). Steps:

| # | Step | Collects | Notes |
|---|---|---|---|
| 0 | **Mode** | `mode: "blank" \| "clone"`; if clone → `source_outlet_id` | Clone picker lists existing outlets (`listOutlets`) |
| 1 | **Name** | `name` (required), `code` (required, short, unique — validated) | `code` becomes the receipt prefix `R-<code>-...` (Spec 1). Inline-validate uniqueness against `listOutlets` codes client-side; server re-checks. |
| 2 | **Address** | `address` (optional), `geo?` (optional lat/lng) | Free text + optional map-pin later |
| 3 | **Timezone** | `timezone` (default `"Asia/Jakarta"` / WIB) | Default pre-filled; v1 single-tz business stays WIB |
| 4 | **Bank / receipt config** | `manual_bca_*`, `receipt_*` fields | **Clone mode:** pre-filled from source `pos_settings` (editable). **Blank mode:** empty + sane defaults. |
| 5 | **Staff access** | `staff_ids: Id<"staff">[]` | Multi-select from business-wide staff (`api.cockpit.outlets.listAssignableStaff`). Grants `staff_outlet_access` rows (Spec 1). Owner implicitly has access — not shown. |
| 6 | **Telegram (optional)** | `provision_managers_chat: boolean` | If on, surfaces the per-outlet managers-chat provisioning hint (Spec 4). v1 = generates a `/register` deep-link instruction card, not auto-create (bots can't create chats). |
| 7 | **Review / Create** | — | Summary of all steps + "Create outlet" CTA → calls `createOutlet` action |

Each step: validate-on-next; "Back" preserves entered state. Inline errors via `FieldMessage` (ADR-048), not toasts. Brand strings as `{"…"}` JSX expressions (ADR-049 fence).

### FE → BE call
"Create outlet" calls **one** action: `api.cockpit.outlets.createOutlet` (below), passing the full wizard payload + a client `idempotencyKey` (so a double-tap / retry / SW re-fire doesn't create two outlets — rule #20). On success, set `OutletContext.currentOutletId` to the new outlet and navigate to `/cockpit/outlets`.

### Supporting query
```ts
// listAssignableStaff — owner-scoped: all active staff in the business (for the access step)
export const listAssignableStaff = query({
  args: { sessionId: v.id("staff_sessions") },
  // requireOwnerSession; returns { _id, name, code, role }[] (NO pin_hash)
});
```

### Tests
- Wizard step-machine: blank vs clone fork renders the right step-4 prefill; back/next preserves state.
- Code-uniqueness inline validation blocks "Next" on a dup code.

---

## Workstream E — Owner clone mutation (BE)

**Goal:** the single-writer, idempotent, audited engine behind the wizard's "Create outlet". Handles **both** blank and clone modes. This is the highest-risk stream (multi-table copy + id remap).

### Entry point — `createOutlet` action
`convex/cockpit/outlets.ts`:

```ts
export const createOutlet = action({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    mode: v.union(v.literal("blank"), v.literal("clone")),
    source_outlet_id: v.optional(v.id("outlets")), // required iff mode === "clone"
    name: v.string(),
    code: v.string(),
    address: v.optional(v.string()),
    geo: v.optional(v.object({ lat: v.number(), lng: v.number() })),
    timezone: v.string(),
    settings: v.object({ /* manual_bca_*, receipt_* (logo_storage_id reused, see below) */ }),
    staff_ids: v.array(v.id("staff")),
    provision_managers_chat: v.boolean(),
  },
  // → { outlet_id: Id<"outlets"> }
});
```

**Why an action (not a mutation):** the clone copies potentially many rows across modules; the orchestration runs as the action, and each table-copy step is its own `internalMutation` so writes stay transactional per step and the action can sequence them. (If row counts stay small — Frollie's catalog is tiny — a single internalMutation is acceptable; the plan picks based on Spec-1 row-count reality. Default: action orchestrator + per-module commit internals, mirroring `createProduct`/`createStaff` action→internal pattern.)

**authCheck:** `requireOwnerSession` runs **before** the idempotency cache lookup (ADR-013 dual-call; action-level cache carries the same invariant per ADR-046). The handler re-resolves the owner session inside.

### Commit sequence (clone mode)
The action orchestrates, in order, calling per-owning-module internal mutations so table ownership (ADR-034) is respected — `cockpit` never raw-writes another module's table:

1. **Create the outlet row** — `internal.cockpit.outlets._createOutletRow_internal` inserts `outlets` (`name, code, address?, geo?, timezone, active: true, created_at: Date.now()`). Server time wins. Throw `OUTLET_CODE_TAKEN` if `code` exists (re-check the index).
2. **Copy catalog** (clone only) — `internal.catalog._cloneCatalogToOutlet_internal({ source_outlet_id, target_outlet_id })`:
   - Copy `pos_inventory_skus` rows → new rows stamped `outlet_id = target`. Build an `sku_id_map: Map<oldSkuId, newSkuId>`.
   - Copy `pos_products` rows → new rows stamped `outlet_id = target`. Build `product_id_map`.
   - Copy `pos_product_components` rows → **remap** `product_id` via `product_id_map` and `inventory_sku_id` via `sku_id_map`; stamp `outlet_id = target`.
   - **Photos: reuse the same `_storage` ids** (`photo_storage_id` copied by value — same deployment, cheap; rows diverge on later edit). No file re-upload.
3. **Copy settings** (clone only) — `internal.settings._cloneSettingsToOutlet_internal({ source_outlet_id, target_outlet_id })`: copy the source `pos_settings` row (bank details `manual_bca_*`, receipt branding `receipt_*` incl. `receipt_logo_storage_id` reused by value, `founders_summary_enabled`, `txn_ticker_enabled`) into a new per-outlet `pos_settings` row stamped `outlet_id = target`. **Override** with any wizard edits from step 4 (the action passes the merged `settings` object). Blank mode: insert a `pos_settings` row from the wizard step-4 values + read-time defaults.
4. **Grant staff access** — `internal.staff._grantOutletAccess_internal({ target_outlet_id, staff_ids })`: insert one `staff_outlet_access` row per `(staff_id, target_outlet_id)` (Spec 1 join table). Skip the owner (implicit access). Dedup: skip if a row already exists (idempotent re-run).
5. **(Optional) Telegram** — if `provision_managers_chat`, the action does NOT auto-create a chat (bots can't). It records intent + the action's return surfaces the `/register` deep-link instruction for the FE review screen (Spec 4 owns the actual `telegramChats.outlet_id` binding once a manager runs `/register` in the new outlet's group).
6. **Audit** — `logAudit(ctx, { action: "outlet.created", entity_type: "outlets", entity_id: outlet_id, actor_id: ownerStaffId, source: "cockpit", metadata: JSON.stringify({ mode, source_outlet_id?, code, cloned_counts: { skus, products, components }, staff_granted }) })`. New audit verb: **`outlet.created`** (documented in `docs/SCHEMA.md`). `source: "cockpit"` is a **new audit source** (extend the source set in SCHEMA.md + Spec 2's audit-threading note).

### Tables: copied / remapped / skipped (locked clone decision)

| Table | Clone action | Notes |
|---|---|---|
| `outlets` | **CREATE** (the new row) | server time, unique `code` |
| `pos_inventory_skus` | **COPY** (ids remapped) | new outlet_id; `sku_id_map` |
| `pos_products` | **COPY** (ids remapped) | new outlet_id; `product_id_map`; `photo_storage_id` reused by value |
| `pos_product_components` | **COPY + REMAP** | `product_id` + `inventory_sku_id` via maps; new outlet_id |
| `pos_settings` | **COPY** (then override w/ wizard edits) | new outlet_id; `receipt_logo_storage_id` reused by value |
| `staff_outlet_access` | **GRANT** (new rows) | one per selected staff; owner skipped |
| `staff` | **SKIP** | shared business-wide identities (Spec 1) — never copied |
| `pos_stock_levels` / `pos_stock_movements` / `pos_low_stock_alerts` / `pos_recount_state` / `pos_stock_drift_log` | **SKIP** | new outlet starts with **empty stock** (locked decision) |
| `pos_transactions` / `_lines` / `pos_xendit_invoices` / `pos_receipt_*` | **SKIP** | new outlet starts empty |
| `pos_refunds` / `pos_settlements` / `pos_shift_events` | **SKIP** | new outlet starts empty |
| `pos_vouchers` / `_redemptions` | **SKIP** (v1) | not in locked copy set; revisit if owners ask |

### Idempotency
- Action wrapped with action-cache keyed on `idempotencyKey` (ADR-046; authCheck-before-lookup). A retry with the same key returns the same `{ outlet_id }` — **no second outlet, no duplicate copies**.
- Each internal commit mutation is individually idempotent-safe on re-run: `_grantOutletAccess_internal` dedups existing rows; the copy steps run once because the action short-circuits on cache hit (the outlet already exists). If a partial failure occurs mid-sequence (action crashes after step 2), the **re-run with the same key** must resume safely — recommended: the orchestrator checks "does `code` already have an outlet row?" and, if so, treats the create as done and re-runs only the not-yet-applied copy steps guarded by per-step existence checks. **Open question OQ-2** flags the partial-failure-resume rigor for review.

### Tests
- Clone copies skus/products/components with remapped FKs; component `product_id`/`inventory_sku_id` point at the NEW rows.
- Clone reuses `photo_storage_id` (same id value on source + target product).
- Clone SKIPS stock + transactions (target outlet has zero of each).
- Blank mode creates outlet + settings + access, no catalog copy.
- Idempotent re-run with same key returns same `outlet_id`, creates no duplicates.
- `staff_outlet_access` granted for selected staff, owner skipped.
- Non-owner session → `NO_OWNER_SESSION` (no writes).
- Duplicate `code` → `OUTLET_CODE_TAKEN` (no partial outlet left behind — runs in step 1 before any copy).
- Audit row `outlet.created` with `source: "cockpit"` + `cloned_counts` metadata.

---

## Workstream F — Dashboard feature roadmap (named; one landing page shipped this slice)

**Goal:** ship a single cross-outlet landing page to prove the owner-scoped read path; name the rest as roadmap with concrete data sources so the route tree + query layer aren't redesigned later.

### Shipped this slice — `cockpit/index.tsx`
- **Consolidated headline** (all outlets, today WIB): gross sales, txn count, refund total.
- **Per-outlet cards**: name, code, today's sales, active/closed booth state.
- Data: `api.cockpit.dashboard.consolidatedSummary` + `api.cockpit.dashboard.perOutletSummary` (both `requireOwnerSession`, outlet-unscoped, aggregating per-module internal readers).

```ts
// dashboard.ts (this slice)
export const consolidatedSummary = query({
  args: { sessionId: v.id("staff_sessions"), dayMs: v.optional(v.number()) },
  // fans out to internal.transactions._dashboardAcrossOutlets_internal etc.
});
export const perOutletSummary = query({
  args: { sessionId: v.id("staff_sessions"), dayMs: v.optional(v.number()) },
});
```

### Roadmap (spec incrementally — NOT built this slice)

| Roadmap feature | Route (planned) | Owner-scoped query (planned) | Data source(s) |
|---|---|---|---|
| Consolidated + per-outlet **financials** (sales, settlements, refunds, fees) | `cockpit/financials` | `cockpit.financials.consolidated` / `byOutlet` | `pos_transactions` (`by_status_paid_at` per outlet), `pos_settlements` (`listSettlements` outlet-unscoped), `pos_refunds` (`by_settlement_status`) — fan-out via per-module `_acrossOutlets_internal` readers |
| Cross-outlet **transactions browser** | `cockpit/transactions` + `cockpit/transactions/$txnId` | `cockpit.transactions.listAcrossOutlets` / `getDetail` | `transactions._fetchDayWindow_internal` outlet-unscoped sibling; reuses `getTransactionDetail` projection |
| **Product management** (cross-outlet view, per-outlet edit) | `cockpit/products` | `cockpit.products.listByOutlet` + reuse `catalog` admin actions scoped to a chosen outlet | `pos_products`/`pos_inventory_skus`/`pos_product_components` per outlet; writes reuse `createProduct`/`updateProductPricing` (manager-PIN tier still applies — owner is a manager+) |
| **Promotions management** (vouchers) | `cockpit/promotions` | `cockpit.vouchers.listByOutlet` | `pos_vouchers`/`_redemptions` per outlet; `createVoucher` (manager-PIN) |
| **Staff-access management** across outlets | `cockpit/staff` | `cockpit.staff.listAccessMatrix` + `grantAccess`/`revokeAccess` mutations | `staff` (business-wide) × `staff_outlet_access` (Spec 1) — a staff×outlet grid; mutations idempotency+authCheck+audit |

Each roadmap row gets its own design doc + Task ID when it enters planning (do not retrofit Task IDs now per the PROGRESS workflow).

---

## Schema changes

This spec adds **no new tables** (it consumes Spec 1's `outlets` + `staff_outlet_access` and Spec 2's session-kind / owner-role changes). It adds:

| Change | Where | Detail |
|---|---|---|
| New audit verb `outlet.created` | `docs/SCHEMA.md` (verb list) | emitted by `createOutlet` |
| New audit source `cockpit` | `docs/SCHEMA.md` (source set) + Spec 2 audit note | for owner-initiated cockpit writes (no device, no booth) |
| (FE) storage keys `COCKPIT_SESSION_KEY`, `COCKPIT_CURRENT_OUTLET_KEY` | `src/lib/storage-keys.ts` | isolate cockpit session/context from booth |

> All schema *table* changes (`outlets`, `staff_outlet_access`, `outlet_id` columns, `staff_sessions.kind`, `owner` role, `staff.telegram_user_id`) are defined in **Spec 1** and **Spec 2** — this spec depends on them, does not redefine them.

### Owner clone — field-level copy contract (returned per assignment)

`outlets` (Spec 1 — fields this spec writes on create):
- `name: v.string()`
- `code: v.string()` (unique; receipt prefix `R-<code>-YYYY-NNNN`)
- `address: v.optional(v.string())`
- `geo: v.optional(v.object({ lat: v.number(), lng: v.number() }))`
- `timezone: v.string()` (default `"Asia/Jakarta"`)
- `active: v.boolean()` (true on create)
- `created_at: v.number()` (server `Date.now()`)
- index: `by_code` (`["code"]`) for the uniqueness re-check

`staff_outlet_access` (Spec 1 — rows this spec grants):
- `staff_id: v.id("staff")`
- `outlet_id: v.id("outlets")`
- `granted_at: v.number()` (server time)
- `granted_by: v.optional(v.id("staff"))` (the owner)
- index: `by_staff` (`["staff_id"]`), `by_outlet` (`["outlet_id"]`), `by_staff_outlet` (`["staff_id", "outlet_id"]`) for the dedup check

---

## Migration / backfill plan

No standalone migration in *this* spec — the outlet backfill (existing prod rows → default outlet "Frollie · Pakuwon") is **Spec 1's** Phase-1 migration. This spec's only data effect is **forward** (creating new outlets via the wizard). Once Spec 1's backfill has stamped the default outlet:

1. The default outlet appears in `listOutlets` and the switcher with no extra work.
2. The owner can clone it to stand up "Frollie · <second location>" — the first real exercise of the clone path.
3. Receipt counters: each new outlet gets its own `[outlet_id, year]` counter row lazily on first sale (Spec 1) — clone does NOT seed a counter (skip, per the "new outlet starts empty" rule).

---

## Implementation notes

- **Cockpit session never clobbers booth session.** Separate storage key + separate `useOwnerSession` hook. A device used as both a booth POS and an owner's cockpit browser keeps both sessions live.
- **Owner is outlet-unscoped by design.** Every `convex/cockpit/*` read gates on `requireOwnerSession` first; the ESLint outlet-scope fence (Spec 1) allowlists `convex/cockpit/**`. Audit any new cockpit read against this — a cockpit query that forgets the owner gate is a cross-outlet data leak.
- **Clone is the riskiest write in the program.** Keep id-remap maps explicit (`Map<oldId,newId>`); never reuse a source row's `_id`. Photos + receipt-logo reuse `_storage` ids **by value** (cheap, same deployment) — this is intentional, annotated inline.
- **Partial-failure resume.** The action is the orchestrator; a crash mid-sequence must be safe to re-run under the same idempotency key. See OQ-2.
- **Manager-PIN tiers still apply inside the cockpit.** The owner has elevated *read* scope, but identity/money writes that are manager-PIN-gated at the booth (`createProduct`, `createVoucher`, refunds) stay PIN-gated when surfaced in cockpit roadmap pages — "OTP authorizes MANAGE" (Spec 2) gates *access to the cockpit*, not individual money writes. Outlet **creation** itself is owner-session-gated (no extra PIN) because only owners can do it and it moves no money.
- **Rollback.** If the cockpit needs to be disabled, the route subtree is independent — pulling `/cockpit/*` and the `cockpit/*` Convex modules leaves the booth untouched. Created outlets persist (they're real data) but become invisible until the cockpit is re-enabled; booth devices bound to a real outlet keep working regardless.

---

## Cross-references

- **Spec 1** `docs/superpowers/specs/2026-06-21-multi-tenancy-foundation-design.md` — `outlets`, `staff_outlet_access`, `outlet_id` threading, `withOutletScope`, per-outlet singletons, receipt-counter prefix, the outlet-scope ESLint fence (allowlists `convex/cockpit/**`).
- **Spec 2** `docs/superpowers/specs/2026-06-21-owner-auth-plane-design.md` — `owner` role, `staff_sessions.kind`, `requireOwnerSession`, Telegram-OTP cockpit login (`/cockpit/login`), `getOwnerSession`, "OTP authorizes MANAGE" (extends **ADR-029**).
- **Spec 4** `docs/superpowers/specs/2026-06-21-per-outlet-telegram-routing-design.md` — `telegramChats.outlet_id`, owners chat (business-wide) vs managers chat (per-outlet), wizard's optional managers-chat provisioning hint.
- **ADR-034** deep-modules/surface-APIs — cockpit reads other modules via their `internal.ts`, never raw `ctx.db`.
- **ADR-013 / ADR-046** idempotency + action-cache auth-before-lookup — `createOutlet` action contract.
- **ADR-007** audit append-only — `outlet.created` verb, `cockpit` source.
- **ADR-048 / ADR-049** inline messaging + i18n fences — wizard FieldMessage + brand-string idiom.

---

## Open questions (review at /spec-plan-pipeline)

**OQ-1 — Cockpit route tree: separate Vercel project/subdomain, or same app?**
- *Recommendation:* **Same Vite app, separate `/cockpit/*` route subtree** for v1 (locked decision says separate subdomain is OPTIONAL). One deploy, one PWA, shared component library; the session-key isolation already keeps booth and cockpit independent.
- *Why:* A separate Vercel project doubles deploy/config surface for zero functional gain in Phase 1.5; the only real driver (a marketing-grade owner domain) is a Phase-2 polish item.

**OQ-2 — Clone partial-failure resume rigor.**
- *Recommendation:* Make the `createOutlet` action **resumable** under the same idempotency key: step 1 (create outlet) is the commit point; on re-run, if an outlet with that `code` exists *and* was created by this idempotency key (stamp the key on the row or in an action-cache blob), resume the remaining copy steps with per-step existence guards (skip skus/products/components/settings/access rows already present for the target outlet). Reject re-run if the `code` exists but belongs to a *different* key (`OUTLET_CODE_TAKEN`).
- *Why:* A multi-step cross-table clone WILL eventually crash mid-sequence (deploy, timeout). Without resume, the owner is stuck with a half-built outlet and a taken code. The alternative (one giant internalMutation that's atomic) is cleanest IF Frollie's row counts stay tiny — which they do today. **Decision needed:** atomic-single-mutation (simplest, relies on small catalogs) vs resumable-action (robust, more code). Lean atomic-single-mutation for v1 given the tiny catalog, upgrade to resumable if a tenant's catalog grows past a few hundred rows.

**OQ-3 — Does the owner role inherit manager capabilities at the booth, or is `owner` cockpit-only?**
- *Recommendation:* `owner` is a **superset of manager** for *authorization* (any manager-PIN gate an owner could satisfy), but owners are **not** in the booth staff-picker by default (they're not device-bound). If an owner needs to operate a booth, they get `staff_outlet_access` like anyone else. Confirm with Spec 2 whether `role: "owner"` short-circuits `requireManagerSession` checks.
- *Why:* Keeps the booth picker clean (owners aren't daily operators) while letting an owner act as manager when present. This is mostly a Spec-2 concern; flagged here because the cockpit roadmap's product/voucher writes assume owner ≥ manager.

**OQ-4 — Vouchers in the clone set?**
- *Recommendation:* **Skip vouchers in clone for v1** (not in the locked copy set). Promotions are outlet-specific campaigns; cloning stale vouchers risks accidental cross-outlet discount reuse.
- *Why:* The locked decision lists catalog + skus + components + photos + settings only. Add vouchers later if owners explicitly ask to template promotions across outlets.

**OQ-5 — `geo` on `outlets` — defined in Spec 1 or here?**
- *Recommendation:* **Spec 1 defines `outlets` including `geo` + `timezone`**; this spec only *writes* them via the wizard. Confirm Spec 1's `outlets` shape matches the wizard fields (name/code/address/geo/timezone/active/created_at) so there's no field drift.
- *Why:* Avoids two specs defining the same table differently. The wizard's step list is the de-facto field requirement — Spec 1 should adopt it.
