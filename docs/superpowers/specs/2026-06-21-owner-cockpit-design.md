# Owner cockpit — a business owner manages all their outlets from one same-backend route tree

**Date:** 2026-06-21
**Phase:** v2 (multi-tenancy program, Phase 1.5)
**Branch (target):** feat/v2-owner-cockpit
**Decomposition rationale:** brainstorm 2026-06-21 (multi-outlet program); staffreview at `/spec-plan-pipeline`
**Status:** Reviewed — drift-reconciled 2026-06-25 (Specs 1/2/4 now shipped); ready to plan

> **Drift reconciliation (2026-06-25 staffreview — `docs/reviews/staffreview-spec3-owner-cockpit-drift-2026-06-25.md`).** This spec was written 2026-06-21, **before** Specs 1/2/4 executed. The forward-references have been corrected to shipped names. The load-bearing reconciliations (authoritative — override any stale prose below):
> 1. **Auth gate is `requireCockpitSession`** (`convex/auth/sessions.ts:54`), not `requireOwnerSession`. It throws **`NOT_COCKPIT_SESSION` / `NO_SESSION` / `SESSION_IDLE_TIMEOUT`** (never `NO_OWNER_SESSION`). Cockpit sessions are minted **only** via owner OTP (`_cockpitLoginCommit_internal`), so `kind === "cockpit" ⟹ role === "owner"`; the plan confirms this and, if not guaranteed, adds an explicit `role === "owner"` assert in the cockpit readers. The `createOutlet` **action** runs `"use node"`, so its authCheck bridges via `internal.auth.ownerInternal._assertCockpitSession_internal` (the pattern `issueOwnerTelegramBindLink` uses), not a direct `requireCockpitSession` import.
> 2. **`outlets.created_by` is REQUIRED** (`convex/outlets/schema.ts:11` — `v.union(v.id("staff"), v.null())`). The create step MUST pass `created_by: ownerStaffId` (the backfilled default outlet uses `null`; owner-created outlets always carry the owner id).
> 3. **Audit `source` is a CLOSED union** — adding `"cockpit"` is a two-file code edit: `convex/audit/schema.ts` (the `v.union` validator) **and** `convex/audit/internal.ts` (the matching TS type + literal list). SCHEMA.md is docs only. Widening a union is additive/deploy-safe.
> 4. **Clone is ONE atomic mutation, not a sequenced action** (resolves OQ-2 — see Workstream E). The `createOutlet` action stays a thin `withActionCache` + `_assertCockpitSession_internal` shell calling a single `cockpit.outlets._createOutletAtomic_internal` mutation, which calls **plain V8-safe clone helpers physically located in each owning module's `lib.ts`** (`catalog/lib.ts`, `settings/lib.ts`). Convex mutations are transactional → a mid-clone crash rolls back ALL writes → no half-built outlet. The partial-failure-resume machinery is dropped.
> 5. **Reuse shipped internals:** `_listActiveOutlets_internal` / `_getDefaultOutlet_internal` (`convex/outlets/internal.ts:52,42`); `_grantOutletAccess_internal` (`convex/auth/internal.ts`, via `staff.grantOutletAccess`); `_fetchDayWindow_internal` / `computeDaySummary` (`convex/transactions/internal.ts:621`); `_getSettings_internal(outletId?)` (`convex/settings/internal.ts:33`); `getSession` (`convex/auth/public.ts:88` — already projects `kind`, reused by the FE cockpit gate instead of a new `getOwnerSession`); `withActionCache` (`convex/idempotency/action.ts:43`).
> 6. **Cockpit sessions have a SLIDING 30-min idle timeout** (`COCKPIT_IDLE_MS`, `SESSION_IDLE_TIMEOUT`), NOT "durable." Spec 2 shipped `touchCockpitSession` (`convex/auth/public.ts:139`) unwired — wiring the keepalive ping is a **Stream A obligation** (or owners log out mid-session).
> 7. **The "Spec 1 allowlisted `convex/cockpit/**`" claim is FALSE** (`OUTLET_FENCE_ALLOWLIST = ["migrations","seed"]`). It's also mostly unneeded: if the cockpit reads ONLY via owning-module internal readers (ADR-034) and never uses an outlet-scoped index on raw `ctx.db`, neither fence fires. Add an allowlist entry only if a concrete callsite trips a fence, preferring a line-level `eslint-disable` with justification.
> 8. **`docs/PROGRESS.md` is RETIRED (2026-06-25).** Roadmap items live in `docs/ROADMAP.md`; progress is `docs/CHANGELOG.md` at ship time. Ignore the spec's Task-ID/PROGRESS process notes.
> 9. **Stream A is ~90% SHIPPED — do NOT build `CockpitLayout` / `useOwnerSession` / `COCKPIT_SESSION_KEY`.** Spec 2 shipped the cockpit plane *inside* `RootLayout` (not a sibling subtree): the gate is `RootLayout.tsx:117` (branches on `session.kind === "cockpit"` from the **same** `useSession()` hook), the shell is `CockpitShell` (`RootLayout.tsx:227`), the routes are registered under RootLayout (`router.tsx:103–109`), `/cockpit/login` + a placeholder `/cockpit` home exist, and `.theme-owner` is applied on `/cockpit/*`. Cockpit + booth sessions **share one `SESSION_KEY`** (`storeCockpitSession` writes the same key — one session per device, by design). So the remaining FE work is: the **OutletSwitcher + context** (Stream B, wired into `CockpitShell`'s header), the **wizard** (Stream D), the **real dashboard + outlets list** replacing the placeholder home (Stream F-FE), the **keepalive ping** (`touchCockpitSession` from `CockpitShell`), and docs. Build all FE via `/frontend-design` (standing rule).

> **No new ADR.** This spec implements decisions already recorded in the multi-tenancy program. It **depends on** and references:
> - **Spec 1 — outlet data plane** (`docs/superpowers/specs/2026-06-21-multi-tenancy-foundation-design.md`): the `outlets` table, the `outlet_id` column threaded through every operational table, `staff_outlet_access`, session-derived outlet scoping, the `withOutletScope` helper, per-outlet singletons, the `R-<outletcode>-YYYY-NNNN` receipt counter.
> - **Spec 2 — owner session / Telegram-OTP auth** (`docs/superpowers/specs/2026-06-21-owner-auth-plane-design.md`): the `owner` role, `staff_sessions.kind` discriminator (`"booth" | "cockpit"`), `staff.telegram_user_id`, OTP-to-DM binding, `requireCockpitSession(...)`, durable cockpit session, the new auth principle **"OTP authorizes MANAGE"** (extends ADR-029).
> - **Spec 4 — Telegram per-outlet routing** (`docs/superpowers/specs/2026-06-21-per-outlet-telegram-routing-design.md`): `telegramChats.outlet_id`, the `by_role_outlet` index, `getChatIdByRoleAndOutlet`, owners chat = business-wide / managers chat = per-outlet, optional managers-chat provisioning from the wizard.
>
> This spec OWNS: the cockpit route tree + owner-scoped query/mutation layer, the **new-outlet wizard** (primary flow) and its underlying **clone mutation**, the **outlet switcher / context** for owners, and the **dashboard feature roadmap**.

---

## Identity

The **owner cockpit** is a new, durable-session product surface for a business **owner** — distinct from the device-bound booth app (and from a future, deferred multi-business platform console). It runs on the **same Convex deployment** as that business's outlets (mandatory: its whole job is cross-outlet reads inside the one deployment), under a **separate route tree** (`src/routes/cockpit/*`) gated by an owner session (Spec 2), served by **owner-scoped, outlet-UNSCOPED** Convex queries/mutations.

This slice ships concretely:

1. **The cockpit shell + owner session gate** — a `CockpitLayout` route subtree that mounts only for `session.kind === "cockpit"` + `role === "owner"`, with an **outlet switcher** that sets a client-side outlet-context (the owner is the one principal NOT outlet-locked).
2. **The guided new-outlet wizard** — the *primary* owner flow: clone-from-existing OR blank → name → address → timezone → bank/receipt config → staff access → (optional) provision managers Telegram chat → review/create.
3. **The owner clone mutation** — single-writer, idempotent, audited; copies/remaps/skips exactly the tables in the locked clone decision.
4. **Owner-scoped query layer scaffolding** — the `requireCockpitSession`-gated read surface (`cockpit/*` Convex modules) that the dashboard roadmap builds on, with **one** dashboard landing page (`cockpit/index`) shipped to prove the cross-outlet read path.

**Out of scope for this slice (roadmap, named below):** consolidated + per-outlet financial dashboards, cross-outlet transactions browser, product management, promotions management, staff-access management UI. Each is specced incrementally; this doc names their data sources and owner-scoped queries so the route tree and access layer don't get redesigned later. Also out of scope: the multi-business control plane (registry/billing/provisioning) and any cross-deployment behavior — **deferred to a future roadmap** (ADR-051 *Future roadmap*).

---

## Architecture overview

| # | Stream | Owner module(s) | Risk |
|---|---|---|---|
| A | Cockpit route tree + owner session gate + `CockpitLayout` | `src/routes/cockpit/*`, `src/components/layout/CockpitLayout` | Med — must not leak into booth `RootLayout`; depends on Spec 2 session kind |
| B | Owner outlet context + switcher | `src/contexts/OutletContext`, `convex/cockpit/outlets` | Low |
| C | Owner-scoped query layer (`requireCockpitSession`-gated, outlet-unscoped) | `convex/cockpit/*` | Med — outlet-UNSCOPED reads are the inverse of the Spec-1 fence; needs its own ESLint carve-out |
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

`/cockpit/login` is **owned by Spec 2** (the Telegram-OTP surface). This spec assumes `requireCockpitSession` resolves and the FE has a cockpit-kind session id in storage.

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
  // requireCockpitSession(ctx, sessionId)  → throws NOT_COCKPIT_SESSION if not cockpit+owner
  // returns: { _id, name, code, address?, timezone, active, created_at }[]
});
```

Returns the full `outlets` list (Spec 1 table). No `outlet_id` arg — the owner sees the business, not one outlet. This is the canonical example of an **owner-scoped, outlet-unscoped read** (Stream C invariant).

### Tests
- `listOutlets` returns all outlets for an owner session; throws `NOT_COCKPIT_SESSION` for a booth/staff/manager session.

---

## Workstream C — Owner-scoped (outlet-unscoped) query layer

**Goal:** a dedicated `convex/cockpit/*` module namespace where queries deliberately read **across all outlets** — the structural inverse of Spec 1's `withOutletScope` fence.

### Invariant
Spec 1 makes session-derived `outlet_id` mandatory on operational reads (booth/manager). The cockpit is the **sanctioned exception**: an owner reads the whole silo. To keep this auditable and prevent accidental cross-outlet leaks elsewhere:

- **All** owner-unscoped reads live under `convex/cockpit/` and gate on `requireCockpitSession(ctx, sessionId)` (Spec 2) as their **first line**.
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
  // requireCockpitSession; returns { _id, name, code, role }[] (NO pin_hash)
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

**Why an action wrapping ONE mutation (reconciled 2026-06-25 — resolves OQ-2):** the action is a thin idempotency/auth shell; the actual clone is a **single `cockpit.outlets._createOutletAtomic_internal` mutation**. Convex mutations are transactional, so the whole clone (outlet row + catalog + settings + access + audit) commits or rolls back atomically — a mid-clone crash leaves **zero** rows, never a half-built outlet. This is both simpler and safer than sequencing per-module internal mutations, and it dissolves the partial-failure-resume problem entirely (OQ-2). It is viable because Frollie's catalog is tiny (~5 products); revisit only if a tenant's catalog grows into the thousands.

**Table ownership under one mutation (ADR-034):** `cockpit` is NOT in the `no-cross-module-db-access` ALLOWLIST (`eslint.config.js:160`), so the mutation must not raw-`ctx.db` another module's tables directly. Instead it calls **plain V8-safe clone helpers physically located in each owning module's `lib.ts`** — `catalog/lib.ts::cloneCatalogRows(ctx, src, tgt)`, `settings/lib.ts::cloneSettingsRow(ctx, src, tgt, overrides)`. The raw writes lexically live in the owning module's file (the per-file fence is satisfied) but execute inside the single cockpit transaction (atomic). Staff-access reuses the shipped `_grantOutletAccess_internal` logic the same way.

**authCheck:** the action's authCheck bridges via `internal.auth.ownerInternal._assertCockpitSession_internal` (the cockpit action cannot import `requireCockpitSession` into a `"use node"` context — same bridge `issueOwnerTelegramBindLink` uses) and runs **before** the idempotency cache lookup (ADR-013 dual-call; action-level cache carries the same invariant per ADR-046). The mutation re-resolves the owner staff id inside for `created_by` / `actor_id`.

### Commit sequence (clone mode) — all steps inside the ONE `_createOutletAtomic_internal` mutation
The mutation runs the steps below in order, calling owning-module `lib.ts` helpers so table ownership (ADR-034) is respected — the raw writes live in each owning module's file, but all execute in this single transaction (atomic; a throw at any step rolls back every prior write):

1. **Create the outlet row** — insert `outlets` via `outlets/lib.ts` helper: `name, code, address?, geo?, timezone, active: true, created_at: Date.now()`, **`created_by: ownerStaffId`** (REQUIRED — `convex/outlets/schema.ts:11`). Server time wins. Re-check `by_code` FIRST and throw `OUTLET_CODE_TAKEN` if `code` exists (before any copy — the atomic rollback also covers this, but failing first keeps the error clean).
2. **Copy catalog** (clone only) — `catalog/lib.ts::cloneCatalogRows(ctx, { source_outlet_id, target_outlet_id })`:
   - Copy `pos_inventory_skus` rows → new rows stamped `outlet_id = target`. Build an `sku_id_map: Map<oldSkuId, newSkuId>`.
   - Copy `pos_products` rows → new rows stamped `outlet_id = target`. Build `product_id_map`.
   - Copy `pos_product_components` rows → **remap** `product_id` via `product_id_map` and `inventory_sku_id` via `sku_id_map`; stamp `outlet_id = target`.
   - **Photos: reuse the same `_storage` ids** (`photo_storage_id` copied by value — same deployment, cheap; rows diverge on later edit). No file re-upload.
3. **Copy settings** (clone only) — `internal.settings._cloneSettingsToOutlet_internal({ source_outlet_id, target_outlet_id })`: copy the source `pos_settings` row (bank details `manual_bca_*`, receipt branding `receipt_*` incl. `receipt_logo_storage_id` reused by value, `founders_summary_enabled`, `txn_ticker_enabled`) into a new per-outlet `pos_settings` row stamped `outlet_id = target`. **Override** with any wizard edits from step 4 (the action passes the merged `settings` object). Blank mode: insert a `pos_settings` row from the wizard step-4 values + read-time defaults.
4. **Grant staff access** — reuse the shipped grant logic (`_grantOutletAccess_internal`, `convex/auth/internal.ts`, called today by `staff.grantOutletAccess`): insert one `staff_outlet_access` row per `(staff_id, target_outlet_id)` with `granted_by: ownerStaffId` (Spec 1 join table; `granted_by` is `v.union(v.id, v.null)`). Skip the owner (implicit access). Dedup: skip if a `by_staff_outlet` row already exists. (Factor the row-write into a shared helper if the internal mutation can't be called from inside this mutation.)
5. **(Optional) Telegram** — if `provision_managers_chat`, the mutation does NOT auto-create a chat (bots can't). It records intent + the action's return surfaces the `/register` deep-link instruction for the FE review screen (Spec 4 owns the actual `telegramChats.outlet_id` binding once a manager runs `/register` in the new outlet's group).
6. **Audit** — `logAudit(ctx, { action: "outlet.created", entity_type: "outlets", entity_id: outlet_id, actor_id: ownerStaffId, source: "cockpit", metadata: JSON.stringify({ mode, source_outlet_id?, code, cloned_counts: { skus, products, components }, staff_granted }) })`. New audit verb: **`outlet.created`** (free `v.string()` — no enum). `source: "cockpit"` requires a **two-file code edit**: add `v.literal("cockpit")` to the `source` union in `convex/audit/schema.ts` AND the matching TS type/literal list in `convex/audit/internal.ts` — without both, the arg validator rejects the write at runtime. Also document in `docs/SCHEMA.md`.

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
- Action wrapped with `withActionCache` keyed on `idempotencyKey` (`convex/idempotency/action.ts:43`; ADR-046 authCheck-before-lookup). A retry with the same key returns the same `{ outlet_id }` — **no second outlet, no duplicate copies**.
- Because the clone is **one atomic mutation**, there is no partial-failure-resume problem: the mutation either fully commits (cache stores `{ outlet_id }`, retries replay it) or fully rolls back (no rows, no cache entry, retry re-runs cleanly). The owner never ends up with a half-built outlet or a taken-but-orphaned `code`. (This supersedes OQ-2, now resolved.)

### Tests
- Clone copies skus/products/components with remapped FKs; component `product_id`/`inventory_sku_id` point at the NEW rows.
- Clone reuses `photo_storage_id` (same id value on source + target product).
- Clone SKIPS stock + transactions (target outlet has zero of each).
- Blank mode creates outlet + settings + access, no catalog copy.
- Idempotent re-run with same key returns same `outlet_id`, creates no duplicates.
- `staff_outlet_access` granted for selected staff, owner skipped.
- Non-owner session → `NOT_COCKPIT_SESSION` (no writes).
- Duplicate `code` → `OUTLET_CODE_TAKEN` (no partial outlet left behind — runs in step 1 before any copy).
- Audit row `outlet.created` with `source: "cockpit"` + `cloned_counts` metadata.

---

## Workstream F — Dashboard feature roadmap (named; one landing page shipped this slice)

**Goal:** ship a single cross-outlet landing page to prove the owner-scoped read path; name the rest as roadmap with concrete data sources so the route tree + query layer aren't redesigned later.

### Shipped this slice — `cockpit/index.tsx`
- **Consolidated headline** (all outlets, today WIB): gross sales, txn count, refund total.
- **Per-outlet cards**: name, code, today's sales, active/closed booth state.
- Data: `api.cockpit.dashboard.consolidatedSummary` + `api.cockpit.dashboard.perOutletSummary` (both `requireCockpitSession`, outlet-unscoped, aggregating per-module internal readers).

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
| New audit verb `outlet.created` | `docs/SCHEMA.md` (verb list) | emitted by `createOutlet`; `audit_log.action` is free `v.string()` (no enum edit) |
| New audit source `cockpit` | `convex/audit/schema.ts` (`v.union`) **+** `convex/audit/internal.ts` (TS type) **+** `docs/SCHEMA.md` | closed union — both code edits required or the validator rejects the write; for owner-initiated cockpit writes (no device, no booth) |
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
- `created_by: v.union(v.id("staff"), v.null())` — **REQUIRED**; pass the owner staff id on create (never null for owner-created outlets)
- index: `by_code` (`["code"]`) for the uniqueness re-check, `by_active` (`["active"]`)

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
- **Owner is outlet-unscoped by design.** Every `convex/cockpit/*` read gates on `requireCockpitSession` first; the ESLint outlet-scope fence (Spec 1) allowlists `convex/cockpit/**`. Audit any new cockpit read against this — a cockpit query that forgets the owner gate is a cross-outlet data leak.
- **Clone is the riskiest write in the program.** Keep id-remap maps explicit (`Map<oldId,newId>`); never reuse a source row's `_id`. Photos + receipt-logo reuse `_storage` ids **by value** (cheap, same deployment) — this is intentional, annotated inline.
- **Partial-failure resume.** The action is the orchestrator; a crash mid-sequence must be safe to re-run under the same idempotency key. See OQ-2.
- **Manager-PIN tiers still apply inside the cockpit.** The owner has elevated *read* scope, but identity/money writes that are manager-PIN-gated at the booth (`createProduct`, `createVoucher`, refunds) stay PIN-gated when surfaced in cockpit roadmap pages — "OTP authorizes MANAGE" (Spec 2) gates *access to the cockpit*, not individual money writes. Outlet **creation** itself is owner-session-gated (no extra PIN) because only owners can do it and it moves no money.
- **Rollback.** If the cockpit needs to be disabled, the route subtree is independent — pulling `/cockpit/*` and the `cockpit/*` Convex modules leaves the booth untouched. Created outlets persist (they're real data) but become invisible until the cockpit is re-enabled; booth devices bound to a real outlet keep working regardless.

---

## Cross-references

- **Spec 1** `docs/superpowers/specs/2026-06-21-multi-tenancy-foundation-design.md` — `outlets`, `staff_outlet_access`, `outlet_id` threading, `withOutletScope`, per-outlet singletons, receipt-counter prefix, the outlet-scope ESLint fence (allowlists `convex/cockpit/**`).
- **Spec 2** `docs/superpowers/specs/2026-06-21-owner-auth-plane-design.md` — `owner` role, `staff_sessions.kind`, `requireCockpitSession`, Telegram-OTP cockpit login (`/cockpit/login`), `getOwnerSession`, "OTP authorizes MANAGE" (extends **ADR-029**).
- **Spec 4** `docs/superpowers/specs/2026-06-21-per-outlet-telegram-routing-design.md` — `telegramChats.outlet_id`, owners chat (business-wide) vs managers chat (per-outlet), wizard's optional managers-chat provisioning hint.
- **ADR-034** deep-modules/surface-APIs — cockpit reads other modules via their `internal.ts`, never raw `ctx.db`.
- **ADR-013 / ADR-046** idempotency + action-cache auth-before-lookup — `createOutlet` action contract.
- **ADR-007** audit append-only — `outlet.created` verb, `cockpit` source.
- **ADR-048 / ADR-049** inline messaging + i18n fences — wizard FieldMessage + brand-string idiom.

---

## Open questions (review at /spec-plan-pipeline)

**OQ-1 — Cockpit route tree: separate Vercel project/subdomain, or same app?**
- *Recommendation:* **Same Vite app, separate `/cockpit/*` route subtree** for v1 (locked decision says separate subdomain is OPTIONAL). One deploy, one PWA, shared component library; the session-key isolation already keeps booth and cockpit independent.
- *Why:* A separate Vercel project doubles deploy/config surface for zero functional gain in Phase 1.5; the only real driver (a marketing-grade owner domain) is a future-roadmap polish item.

**OQ-2 — Clone partial-failure resume rigor. → RESOLVED (2026-06-25): atomic single mutation.**
- *Decision:* The clone is **one transactional `_createOutletAtomic_internal` mutation** (see Workstream E). Convex mutations commit-or-rollback atomically, so there is no mid-sequence partial state to resume — a crash leaves zero rows. The resumable-action design is dropped. This is viable because Frollie's catalog is tiny (~5 products); the only revisit trigger is a tenant catalog growing into the thousands (mutation read/write or time limits), at which point the clone splits into a paginated background job — out of scope for v1.

**OQ-3 — Does the owner role inherit manager capabilities at the booth, or is `owner` cockpit-only?**
- *Recommendation:* `owner` is a **superset of manager** for *authorization* (any manager-PIN gate an owner could satisfy), but owners are **not** in the booth staff-picker by default (they're not device-bound). If an owner needs to operate a booth, they get `staff_outlet_access` like anyone else. Confirm with Spec 2 whether `role: "owner"` short-circuits `requireManagerSession` checks.
- *Why:* Keeps the booth picker clean (owners aren't daily operators) while letting an owner act as manager when present. This is mostly a Spec-2 concern; flagged here because the cockpit roadmap's product/voucher writes assume owner ≥ manager.

**OQ-4 — Vouchers in the clone set?**
- *Recommendation:* **Skip vouchers in clone for v1** (not in the locked copy set). Promotions are outlet-specific campaigns; cloning stale vouchers risks accidental cross-outlet discount reuse.
- *Why:* The locked decision lists catalog + skus + components + photos + settings only. Add vouchers later if owners explicitly ask to template promotions across outlets.

**OQ-5 — `geo` on `outlets` — defined in Spec 1 or here? → RESOLVED.**
- Spec 1 shipped `outlets` with `geo` + `timezone` (`convex/outlets/schema.ts`): `code, name, address?, geo?, timezone, active, created_at, created_by`. Matches the wizard fields. No drift. Closed.
