# Per-outlet Telegram routing — two-tier (role, outlet_id) chat resolution under multi-tenancy

**Date:** 2026-06-21
**Phase:** v2.0 (Phase 1 — data plane companion)
**Branch (target):** feat/v2.0-telegram-per-outlet-routing
**Decomposition rationale:** brainstorm 2026-06-21 (locked decisions in the assignment brief)
**Status:** Brainstorm (DRAFT — review at /spec-plan-pipeline)
**Fulfils:** [ADR-035](../../ADR/035-telegram-as-internal-comms.md) (per-outlet amendment), consumes [ADR-051](../../ADR/051-multi-outlet-tenancy-silo.md)

> This is the **Telegram routing** spec of the multi-tenancy program. It depends on the `outlet_id`
> data plane landing first (foundation spec) and is referenced by name from three sibling drafts. It
> recasts today's single-chat-per-role registry into a **two-tier** registry where outlet-scoped roles
> (`managers`, `inventory`) resolve by `(role, outlet_id)` and business-wide roles (`owners`, `ops`)
> resolve by `(role)` alone.

---

## Identity

Today every outbound Telegram message resolves its destination chat through a single primitive:
`getChatIdByRole(role)` (`convex/telegram/chatRegistry/internal.ts`), which scans `telegramChats`
`by_role` and returns the **one** active chat bound to that role. There are four roles
(`KNOWN_TELEGRAM_ROLES = ["managers", "founders", "inventory", "ops"]` in `convex/telegram/config.ts`)
and exactly one chat per role. Every approval, alert, and summary template — refund,
`manual_payment_override`, spoilage, `recount_notice`, `low_stock_alert`, `stock_drift_alert`,
`txn_ticker`, `shift_summary`, `staff_shift_signoff` — funnels through `sendTemplate(role, kind,
payload, idempotencyKey)` (`convex/telegram/send.ts`), which calls `getChatIdByRole` (or accepts a
caller-supplied `chatIdOverride` for the race-safe cron path).

Once the booth runs **N outlets** (foundation spec), a single managers chat can no longer be correct:
an approval that originates at outlet B must reach **outlet B's** managers, and a low-stock alert for
outlet B's SKUs must reach **outlet B's** inventory chat — not a shared firehose where the manager
cannot tell which outlet a refund belongs to.

This spec ships **two-tier role routing**:

- Recast today's **`founders`** role as **`owners`** — **business-wide** (cross-outlet rollups +
  owner updates; no `outlet_id`).
- **`managers`** becomes **per-outlet** (that outlet's approvals + updates).
- **`inventory`** becomes **per-outlet** (stock is per-outlet).
- **`ops`** (`system_error`) stays **business-wide**.

The mechanism: `telegramChats` gains an **optional `outlet_id`**, set for outlet-scoped roles and
**absent** for business-scoped roles. The routing key becomes `(role, outlet_id)` for outlet-scoped
templates and `(role)` for business-scoped ones. A new `getChatIdByRoleAndOutlet(role, outlet_id)`
primitive performs the two-tier lookup; `getChatIdByRole(role)` is retained for business-wide kinds.

**Out of scope (owned by sibling specs / deferred):**
- `outlet_id` threading, `outlets` table, `staff_outlet_access`, session-derived scoping, the
  `pending_device_setups.target_outlet_id` *column* and migration scaffolding →
  [`2026-06-21-multi-tenancy-foundation-design.md`](./2026-06-21-multi-tenancy-foundation-design.md)
  (Spec 1). This spec **populates** `target_outlet_id` from the per-outlet managers chat and
  **consumes** the migration's default-outlet id; it does not define the column.
- The **`owner_otp`** template kind + its private-DM routing — owned by
  [`2026-06-21-owner-auth-plane-design.md`](./2026-06-21-owner-auth-plane-design.md) (Spec 2). It is
  the **one kind that bypasses role routing entirely** (sent via `chatIdOverride =
  String(telegram_user_id)`). Noted here for completeness; not modified by this spec.
- The **clone wizard** that provisions a new outlet's managers chat — UI/flow owned by
  [`2026-06-21-owner-cockpit-design.md`](./2026-06-21-owner-cockpit-design.md) (Spec 3). This spec
  owns the *binding* primitive the wizard's `/register` deep-link lands on.
- Multi-deployment provisioning / per-tenant bot tokens →
  [`2026-06-21-saas-control-plane-design.md`](./2026-06-21-saas-control-plane-design.md) (Spec 4 /
  Phase 2). In Phase 1 (one silo, one bot) all outlets share one `TELEGRAM_BOT_TOKEN`.

---

## Architecture overview

| # | Stream | Owner module(s) | Risk |
|---|--------|-----------------|------|
| 1 | `telegramChats.outlet_id` + `by_role_outlet` index | `telegram/` | Low — additive optional column |
| 2 | `getChatIdByRoleAndOutlet` two-tier resolver + `owners`/`ops` business-wide path | `telegram/` (`chatRegistry/internal.ts`) | Med — the core routing change |
| 3 | `sendTemplate` gains `outletId?` + per-kind scope table | `telegram/` (`send.ts`) | Med — every callsite threads the originating outlet |
| 4 | `KNOWN_TELEGRAM_ROLES` recast (`founders`→`owners`) + per-kind callsite re-wiring | `telegram/`, `approvals/`, `inventory/`, `transactions/` | Med — sweep every send callsite |
| 5 | Business-wide owners summary (aggregate across outlets) + cron | `telegram/foundersSummary.ts` → `ownersSummary.ts`, `crons.ts` | Med — aggregation rewrite |
| 6 | `mgr*` admin surface gains `outlet_id` binding + per-outlet `/register` provisioning | `telegram/chatRegistry/public.ts`, `src/routes/mgr/telegram-chats` | Med — admin UX |
| 7 | Migration/backfill: bind Frollie's existing managers+inventory chats to the default outlet | `convex/migrations/` (allowlisted) | Med — prod data, idempotent |

---

## Schema changes

### `telegramChats` — additive optional `outlet_id` + new compound index

`telegramChats` (owned by `telegram/`) is the self-registration registry: one row per chat that has
sent `/register@<bot>`. The foundation spec explicitly **defers** this column to here (Spec 1 §"Tables
that DO NOT get `outlet_id`": *"`telegramChats` gains optional `outlet_id` in the Telegram-per-outlet
spec, not here"*).

| Field | Type | Notes |
|---|---|---|
| `outlet_id` | `v.optional(v.id("outlets"))` | **NEW.** Set for **outlet-scoped** roles (`managers`, `inventory`). **ABSENT** for **business-scoped** roles (`owners`, `ops`) and for unbound/dormant chats. Absent ⇒ business-scoped (back-compat: every existing row reads as absent). FK to `outlets` (Spec 1 table), house FK discipline. |

**Index change:**

| Index | Keys | Purpose |
|---|---|---|
| `by_role_outlet` | `["role", "outlet_id"]` | **NEW.** Two-tier resolution for outlet-scoped roles. Lead with `role`, then `outlet_id`. |
| `by_role` | `["role"]` | **KEEP.** Still used for business-scoped roles (`owners`, `ops`) and admin listing. The two indexes coexist; `by_role_outlet` is *not* a strict superset because business-wide rows have `outlet_id` absent (an `outlet_id`-absent equality is the optional-field-filter gotcha — handled in JS, see below). |

> **Optional-field-filter gotcha (load-bearing, documented).** Per the long-standing codebase rule
> (see `getChatIdByRole`'s comment + MEMORY.md), **never** filter an optional Convex field with
> `.eq(field, undefined)` — it diverges between convex-test and prod. The two-tier resolver therefore
> uses `by_role_outlet` with a concrete `outlet_id` for the **outlet-scoped** path (a real equality,
> safe), and uses bare `by_role` + **JS post-filter** (`r.archivedAt === undefined && r.outlet_id ===
> undefined`) for the **business-scoped** path. This mirrors the existing `archivedAt === undefined`
> JS-post-filter pattern already in `getChatIdByRole`.

No other table changes. `telegram_log` and `telegramUpdates` stay global (foundation spec confirms).

### `KNOWN_TELEGRAM_ROLES` recast (`config.ts`)

```ts
// convex/telegram/config.ts  (browser-safe; the /mgr UI imports this)
export const KNOWN_TELEGRAM_ROLES = ["managers", "owners", "inventory", "ops"] as const;
```

- `"founders"` → **`"owners"`** (rename). Rationale: the brainstorm recast founders-as-business-wide
  into owners-as-business-wide; the cockpit/owner specs already speak of `owner`/`owners`. Keep
  `"founders"` recognised as a **legacy alias** in `isKnownTelegramRole` for the duration of the
  migration window (the backfill rebinds the existing founders chat to the `owners` role), then drop
  it. (See Open questions on alias vs hard-rename.)
- The role set stays a 4-tuple; only one literal changes. A `ROLE_SCOPE` map (new, co-located in
  `config.ts`) records which roles are outlet-scoped vs business-wide — the single source of truth the
  resolver and admin UI both read:

```ts
export const ROLE_SCOPE = {
  owners:    "business",   // business-wide rollups + owner updates
  ops:       "business",   // system_error
  managers:  "outlet",     // per-outlet approvals + updates
  inventory: "outlet",     // per-outlet stock
} as const satisfies Record<TelegramRole, "business" | "outlet">;
```

---

## Template-by-template routing table

Every send funnels through `sendTemplate`. The kind determines the routing key. **Outlet-scoped**
kinds must pass the **originating outlet's** `outlet_id`; **business-wide** kinds pass none.

| Template kind | Originates from | Routing role | Scope | Routing key |
|---|---|---|---|---|
| `manual_payment_override` | a txn at outlet X | `managers` | **outlet** | `(managers, X)` |
| `refund` | a refund of a txn at outlet X | `managers` | **outlet** | `(managers, X)` |
| `spoilage` | a spoilage event at outlet X | `managers` | **outlet** | `(managers, X)` |
| `staff_pin_reset` | a staff lockout on a device bound to outlet X | `managers` | **outlet** | `(managers, X)` |
| `recount_notice` | a recount at outlet X | `inventory` | **outlet** | `(inventory, X)` |
| `low_stock_alert` | a SKU at outlet X crossing threshold | `inventory` | **outlet** | `(inventory, X)` |
| `stock_drift_alert` | the drift cron, per outlet X | `inventory` | **outlet** | `(inventory, X)` |
| `txn_ticker` | a paid sale at outlet X | `managers` | **outlet** | `(managers, X)` |
| `shift_summary` (→ owners) | the daily cron, all outlets rolled up | `owners` | **business** | `(owners)` |
| `staff_shift_signoff` | a single staff shift end at outlet X | *see Open Q 2* | *outlet (recommended)* | `(managers, X)` *(recommended)* |
| `system_error` | any POS crash (outlet may be unknown) | `ops` | **business** | `(ops)` |
| `owner_otp` *(Spec 2)* | an owner OTP request | — | **none (bypass)** | `chatIdOverride = telegram_user_id` (private DM) |

Notes:
- `staff_pin_reset` routes to **`managers`** today (lockout → approval link). It is outlet-scoped
  because the locked staff sit at a specific outlet's device (device→outlet binding, Spec 1
  Workstream 6). The originating `outlet_id` is the device's outlet.
- `txn_ticker` is per-outlet so each outlet's managers see their own sales feed (kill-switch
  `pos_settings.txn_ticker_enabled` is already per-outlet after Spec 1 Workstream 4).
- `system_error` is business-wide: a crash may fire **before** a session resolves an outlet
  (`pos_error_reports.outlet_id` is *optional* per Spec 1), so routing it per-outlet would drop
  outlet-unknown errors. Keep it business-wide so no crash is silently lost.
- `owner_otp` (Spec 2) is the **only** kind that resolves no role — it DMs the owner directly via
  `chatIdOverride`. This spec leaves it untouched; it is listed so the routing matrix is complete.

---

## Routing-resolution algorithm

The resolver replaces the single `getChatIdByRole` call inside `sendTemplate` with a scope-aware
dispatch. Pseudocode (V8-safe; lives in `convex/telegram/chatRegistry/internal.ts` as an internalQuery
`getChatIdByRoleAndOutlet`, with `getChatIdByRole` retained for the business path):

```text
resolveChatId(role, outletId?):
  scope = ROLE_SCOPE[role]                       // "outlet" | "business"

  if scope == "outlet":
    require(outletId != null)                    // else throw OUTLET_REQUIRED_FOR_ROLE:{role}
    rows = db.query("telegramChats")
             .withIndex("by_role_outlet", q => q.eq("role", role).eq("outlet_id", outletId))
             .collect()
    active = rows.filter(r => r.archivedAt === undefined)   // JS post-filter (gotcha)
    if active[0]: return active[0].chatId
    // no per-outlet binding → no env fallback (env fallback is a single-chat legacy concept)
    throw "No Telegram chat assigned to role '{role}' for outlet '{outletId}'"

  else:  // scope == "business"
    rows = db.query("telegramChats")
             .withIndex("by_role", q => q.eq("role", role))
             .collect()
    // business-wide rows have outlet_id absent; JS-filter, never .eq(outlet_id, undefined)
    active = rows.filter(r => r.archivedAt === undefined && r.outlet_id === undefined)
    if active[0]: return active[0].chatId
    if env.TELEGRAM_FALLBACK_ROLE == role && env.TELEGRAM_CHAT_ID:  // legacy single-chat fallback
      return env.TELEGRAM_CHAT_ID
    throw "No Telegram chat assigned to role '{role}'"
```

`sendTemplate` (`send.ts`) changes:

```text
sendTemplate(role, kind, payload, idempotencyKey, outletId?, disableNotification?, chatIdOverride?):
  ... idempotency pre-check (unchanged) ...
  chatId =
    chatIdOverride                                          // race-safe path (cron) — unchanged
    ?? (ROLE_SCOPE[role] == "outlet"
          ? getChatIdByRoleAndOutlet(role, outletId)        // NEW — throws if outletId missing
          : getChatIdByRole(role))                          // business-wide — unchanged primitive
  ... render / send / audit / cache (unchanged) ...
```

- `outletId` is a **new optional arg** on `sendTemplate` (`v.optional(v.id("outlets"))`). It is
  **required at runtime** when `ROLE_SCOPE[role] === "outlet"` and `chatIdOverride` is absent — the
  resolver throws `OUTLET_REQUIRED_FOR_ROLE` otherwise. This is the safety net for a missed callsite.
- `chatIdOverride` semantics are unchanged: it short-circuits resolution entirely (used by the
  resilient cron path and by `owner_otp`). When set, `outletId` is not consulted.
- The audit-on-failure row (`_auditSendFailed_internal`) gains the resolved `outlet_id` in metadata so
  operators can attribute a misroute to the originating outlet.

### Callsite threading (Stream 4)

Every outlet-scoped send must supply the **originating outlet**. After Spec 1, the originating
mutation/action already has `outlet_id` in hand (session-derived for booth flows; row-carried for
cron/system flows). The sweep:

- **`approvals/actions.ts`** (`requestManualPaymentApproval`, refund request, `requestSpoilageApproval`,
  staff-pin-reset notify): read `outlet_id` from the approval request row / triggering session and pass
  it into `sendTemplate`. (`pos_approval_requests.outlet_id` is added by Spec 1.)
- **`inventory/`** (`low_stock_alert` dispatch, `recount_notice`, `stock_drift_alert` cron): the SKU /
  recount / drift row carries `outlet_id` (Spec 1). The drift cron (`cronActions.ts`) iterates **per
  outlet** and sends one alert per outlet to `(inventory, outletId)`.
- **`transactions/`** (`txn_ticker` on `_confirmPaid`): the txn row carries `outlet_id`.
- **`ops` error pipe** (`system_error`): unchanged — business-wide, no `outletId`.

> **ADR-034 boundary note.** Modules continue to route notifications through `convex/telegram/`
> (foundational allow-listed boundary, ADR-035 amendment). They do **not** read `telegramChats`
> directly; they pass `outletId` into `sendTemplate` and the resolver does the lookup. The cross-module
> `outlet_id` reads each module needs already route through `outlets.internal._getOutlet_internal`
> (Spec 1) where a label is required.

---

## Workstream 5 — Owners summary (business-wide aggregate) + cron

**Goal:** the daily summary rolls up **all outlets** into one business-wide post to the `owners` chat
(recommendation; see Open questions for the per-outlet managers-summary alternative).

- Rename `convex/telegram/foundersSummary.ts` → `convex/telegram/ownersSummary.ts` (mechanical;
  internalActions `sendFoundersSummary*` → `sendOwnersSummary*`). The cron entry in `convex/crons.ts`
  (`founders-shift-summary`, 22:00 WIB / 15:00 UTC) is renamed `owners-shift-summary` and points at
  `sendOwnersSummaryResilient`.
- The aggregate query becomes **multi-outlet**: instead of one
  `_dailySalesSummary_internal(dayStart, dayEnd)`, the action lists active outlets
  (`outlets.internal._listActiveOutlets_internal`) and aggregates per outlet, then sums into a
  business total **plus** a per-outlet breakdown line. The `shift_summary` payload gains an optional
  `perOutlet: Array<{ outletLabel, totalSalesIdr, txnCount, flaggedCount }>` block; `renderFoundersSummary`
  (→ `renderOwnersSummary`) appends a per-outlet section beneath the business total. Single-outlet
  deployments render exactly as today (one outlet → the breakdown collapses to the total).
- Routing: business-wide. The action resolves the `owners` chat **once** up-front via
  `getChatIdByRole("owners")` and threads it as `chatIdOverride` (the existing race-window-closing
  pattern in `foundersSummary.ts` — `role_unbound` skip-audit branch preserved, retargeted to
  `"owners"`).
- `pos_settings.founders_summary_enabled` is renamed conceptually to the owners summary toggle. Since
  `pos_settings` is **per-outlet** after Spec 1, the **business-wide** owners summary reads the
  **default outlet's** (or any-outlet's) toggle? — **No.** Make the owners-summary opt-out a
  business-level flag. Recommendation: read the toggle from the **default/primary outlet's**
  `pos_settings` row for v2.0 (single source), and flag "where does a business-level toggle live" as an
  Open question (the control-plane `businesses` row, Spec 4, is the proper long-term home).

**Tests:** two outlets aggregate into a business total + per-outlet breakdown; single-outlet renders
unchanged; `owners` role unbound → audited skip (no send, no throw); disabled toggle → audited skip.

---

## Workstream 6 — Admin surface + per-outlet `/register` provisioning

**Goal:** the `/mgr/telegram-chats` admin UI can bind a chat to a `(role, outlet)` pair, and a new
outlet's managers chat is provisioned via the cockpit wizard's `/register` deep-link.

### `mgr*` mutations (`chatRegistry/public.ts`)

- `mgrAssignRole` gains an **optional `outletId: v.optional(v.id("outlets"))`** arg. Validation
  (single source — mirror the resolver's scope check):
  - If `ROLE_SCOPE[role] === "outlet"` → `outletId` **required** (throw `OUTLET_REQUIRED_FOR_ROLE`).
  - If `ROLE_SCOPE[role] === "business"` → `outletId` **must be absent** (throw `OUTLET_NOT_ALLOWED_FOR_ROLE`).
  - `role === null` (unbind) → clear both `role` and `outlet_id`.
- The "one chat per role" uniqueness check becomes **"one chat per `(role, outlet_id)`"** for
  outlet-scoped roles (scan `by_role_outlet`), and **"one chat per role"** for business roles (scan
  `by_role` + JS filter `outlet_id === undefined`). `forceReassign` semantics unchanged but now
  scoped to the `(role, outlet)` pair.
- `assignRoleImpl` patches `{ role, outlet_id }` together (atomic). Audit verb `telegram.role_assigned`
  metadata gains `outlet_id` (and `displaced_from_chat_id` stays).
- `mgrListChats` projection adds `outlet_id` + an `outlet_label` (resolved via
  `outlets.internal._getOutlet_internal`) so the admin table can show "managers · Frollie — Block M".

### FE `/mgr/telegram-chats`

- The role-assign dropdown, when an outlet-scoped role is picked, surfaces a second **outlet picker**
  (`listOutlets`, Spec 1). Business roles hide it. The list groups rows by outlet (business-wide rows
  under a "Business-wide" header). i18n + inline-messaging fences apply (the route is already
  registered — new copy via `t(...)`, errors via `FieldMessage`).

### New-outlet managers-chat provisioning (cockpit wizard cross-ref)

A bot **cannot create a Telegram chat** (platform limit). So provisioning a new outlet's managers chat
is a **bind**, not a create:

1. The owner-cockpit **clone wizard** (Spec 3, Workstream D, step "Telegram (optional)") sets
   `provision_managers_chat: true`. `createOutlet` (Spec 3) does **not** auto-create a chat — it
   surfaces a `/register` deep-link instruction card on the wizard review screen.
2. A manager opens the **new outlet's** Telegram group and runs `/register@<bot>` → a `telegramChats`
   row is inserted **dormant** (no role, no `outlet_id`) by the existing `registerChat` flow
   (unchanged).
3. The owner (or a manager) opens `/mgr/telegram-chats`, picks the dormant chat, assigns role
   `managers` **+ the new outlet** → `mgrAssignRole(role: "managers", outletId: <new>)` binds it. Same
   for the new outlet's `inventory` chat.

This spec owns step 3's binding primitive; Spec 3 owns steps 1–2's wizard UX. The
`pending_device_setups.target_outlet_id` population (so `/activatepos` in a per-outlet managers chat
pre-assigns the outlet to the device) is **this spec's** concern wired onto Spec 1's column — see
below.

### `/activatepos` per-outlet pre-assignment

`/activatepos` (managers-role chat → 6-digit device setup code, 15min TTL) is invoked **in a specific
managers chat**, which is now bound to a `(managers, outlet_id)` pair. The command handler resolves the
sending chat's `outlet_id` (look up the `telegramChats` row by `chatId`, read its `outlet_id`) and
threads it into `issueDeviceSetupCode` so the minted `pending_device_setups` row carries
`target_outlet_id = <that outlet>`. On activation, `_activateDeviceCommit_internal` (Spec 1) copies
`target_outlet_id` → `registered_devices.outlet_id` — closing the "which outlet does this phone belong
to" loop for the Telegram path. (Spec 1 Workstream 6 §"Telegram pre-assignment (primary)" names this
spec as the populator.)

If `/activatepos` is run in a chat with **no** `outlet_id` (e.g. a still-unbound managers chat, or the
business-wide owners chat by mistake), the command replies with an error ("This chat isn't bound to an
outlet — assign it in /mgr/telegram-chats first") rather than minting an outlet-less code.

---

## Workstream 7 — Migration / backfill

**Pattern (locked):** additive optional column → backfill existing chats → no enforce step (column
stays optional forever, since business-wide rows legitimately have it absent). Runs against
`savory-zebra-800` prod (one deployment, Phase 1), **after** Spec 1's default-outlet seed
(`code: "PKW", name: "Frollie — Pakuwon"`) exists.

### Step 0 — depend on Spec 1's default outlet

The backfill reads the default outlet id via `outlets.by_code "PKW"` (Spec 1 Step 0 seeds it). If it is
absent, the migration aborts (`DEFAULT_OUTLET_MISSING`) — it must run after the foundation backfill.

### Step 1 — schema additive

Deploy `telegramChats.outlet_id` as `v.optional(v.id("outlets"))` + add `by_role_outlet` **alongside**
`by_role` (no drops). Every existing row reads `outlet_id` absent — already correct for business-wide
rows, and the **transitional** state for managers/inventory (resolver still finds them on the business
path until rebind, so **no outage** for a single-outlet deployment — see below).

### Step 2 — backfill (idempotent)

Internal mutation `migrations.bindTelegramChatsToDefaultOutlet` (allowlisted module):

- For Frollie's **`managers`** and **`inventory`** chats (the two outlet-scoped roles), patch
  `outlet_id = <default outlet id>`. These become outlet-scoped rows bound to "Frollie — Pakuwon".
- The **`founders`** chat is rebound to role **`owners`** (the recast) with `outlet_id` left
  **absent** (business-wide). The **`ops`** chat stays role `ops`, `outlet_id` absent.
- Idempotent: skip a row already carrying the correct `outlet_id`/role; safe to re-run.
- `logAudit` verb `telegram.chat_outlet_bound` per patched row (source `system`, metadata `{ role,
  outlet_id }`) — append-only trail for the rebind (ADR-007).

> **Why the transitional state is outage-free.** Before Step 2 runs, a `(managers, X)` lookup would
> find no `by_role_outlet` row. To avoid an outage **during** the window, ship the resolver with a
> **single-outlet fallback**: if the outlet-scoped lookup misses **and** the deployment has exactly one
> active outlet **and** a bare `by_role` row exists with `outlet_id` absent, return it (and log a
> one-time deprecation warning). This makes the new-FE+old-data window safe and collapses to the strict
> per-outlet lookup once Step 2 binds the rows. Gate the fallback behind "exactly one active outlet" so
> it can never misroute in a true multi-outlet deployment. (See Open questions on keeping vs dropping
> this fallback.)

### Step 3 — drop the legacy env fallback (deferred)

`TELEGRAM_FALLBACK_ROLE` + `TELEGRAM_CHAT_ID` (the single-chat env fallback) remain honored for the
**business** path only. Once `owners`/`ops` are bound in the registry, the env vars are inert; drop
them in a later cleanup. No enforce step on `outlet_id` — the column is permanently optional.

### Rollback

Steps 1–2 are additive/idempotent — rollback = redeploy prior schema + resolver (optional column
tolerates absent values; the old `getChatIdByRole` path still resolves the bare rows). The
`founders`→`owners` rename is the only semantic one-way-ish step; keep `"founders"` as a recognised
legacy alias through the window so a rollback of the FE/resolver doesn't orphan the chat.

---

## Implementation notes

- **Order of deploys.** Schema (Step 1) → resolver + `sendTemplate` `outletId` arg + single-outlet
  fallback → callsite sweep (Stream 4) → backfill (Step 2). The resolver and `sendTemplate` arg are
  function-signature changes on a **query/action** — ship the FE (`/mgr/telegram-chats`) and backend
  atomically per the deploy-skew rule (`npm run build` → `convex deploy`). `getChatIdByRoleAndOutlet`
  is a **new** internalQuery (not a rename), so no mutation↔action skew hazard.
- **Optional-field-filter discipline** is the single most repeated trap here: outlet-scoped lookups use
  a **concrete** `outlet_id` equality (safe); business-wide lookups use **JS post-filter** on
  `outlet_id === undefined` (never `.eq(..., undefined)`). Mirror `getChatIdByRole`'s existing comment.
- **Fence verification.** The single-outlet fallback is a correctness-critical branch — add a test that
  proves it fires **only** with exactly one active outlet and is bypassed the moment a second outlet
  exists (mirrors the codebase's "verify a fence is LIVE, never trust 'it passes'" lesson).
- **Money/time invariants intact** — integer rupiah (ADR-015), server-time-wins (ADR-031); the owners
  summary aggregation sums integer rupiah per outlet, no floats.
- **`logAudit` on every state change** — role bind/rebind (`telegram.role_assigned` +
  `telegram.chat_outlet_bound`), send-failure (`_auditSendFailed_internal` gains `outlet_id`). Append
  only.
- **One bot, one token in Phase 1.** All outlets share `TELEGRAM_BOT_TOKEN`. Per-tenant bot tokens are
  a Spec 4 / Phase-2 concern (multi-deployment provisioning).

---

## Cross-references

- **ADR:** [ADR-035](../../ADR/035-telegram-as-internal-comms.md) — Telegram as internal comms + role
  routing (this spec adds the per-outlet amendment: routing key `(role, outlet_id)` for outlet-scoped
  roles). Token-VIEW / PIN-ACT ([ADR-029](../../ADR/029-token-authorizes-view-pin-authorizes-act.md))
  unchanged.
- **Sibling specs:**
  - [`2026-06-21-multi-tenancy-foundation-design.md`](./2026-06-21-multi-tenancy-foundation-design.md)
    (Spec 1) — defines `outlet_id`, `outlets`, `pending_device_setups.target_outlet_id` (this spec
    populates it), the default-outlet migration (this spec's backfill depends on it).
  - [`2026-06-21-owner-auth-plane-design.md`](./2026-06-21-owner-auth-plane-design.md) (Spec 2) — owns
    the `owner_otp` template kind + private-DM `chatIdOverride` bypass and the `/start <token>`
    binding; this spec's resolver leaves `owner_otp` untouched.
  - [`2026-06-21-owner-cockpit-design.md`](./2026-06-21-owner-cockpit-design.md) (Spec 3) — owns the
    clone wizard + `createOutlet`; this spec owns the `(managers, outlet)` binding the wizard's
    `/register` deep-link lands on.
  - [`2026-06-21-saas-control-plane-design.md`](./2026-06-21-saas-control-plane-design.md) (Spec 4) —
    per-tenant provisioning / per-tenant bot tokens (Phase 2); out of scope here.
- **Key files:** `convex/telegram/config.ts` (`KNOWN_TELEGRAM_ROLES`, new `ROLE_SCOPE`),
  `convex/telegram/chatRegistry/internal.ts` (`getChatIdByRoleAndOutlet`, `assignRoleImpl`),
  `convex/telegram/chatRegistry/public.ts` (`mgrAssignRole` + `outletId`), `convex/telegram/send.ts`
  (`sendTemplate` + `outletId`), `convex/lib/telegramHtml.ts` (`renderOwnersSummary` per-outlet block),
  `convex/telegram/ownersSummary.ts` (renamed), `convex/crons.ts` (`owners-shift-summary`),
  `convex/telegram/commands.ts` / registry (`/activatepos` outlet resolution), `convex/migrations/`
  (`bindTelegramChatsToDefaultOutlet`), `src/routes/mgr/telegram-chats`, `docs/SCHEMA.md`
  (`telegramChats.outlet_id` row), `docs/RUNBOOK-telegram.md` (role table update).

---

## Open questions (review at /spec-plan-pipeline)

**1. Owners summary: business-wide rollup vs per-outlet managers summary — or both?**
*Recommendation:* ship the **business-wide owners summary** (all outlets aggregated into one post to
the `owners` chat, with a per-outlet breakdown section) for v2.0. *Why:* it preserves today's single
daily post for the owner/founder audience and degrades to exactly today's output for a single-outlet
deployment. **Flag a per-outlet `managers_daily_summary` as a fast-follow:** each outlet's managers
chat gets its own end-of-day post scoped to `(managers, outlet)`. Defer it (not in the locked set) —
it's additive and needs its own toggle. *Cost of deferring:* none; the routing primitive already
supports it.

**2. `staff_shift_signoff` — per-outlet managers, or business-wide owners?**
*Recommendation:* **per-outlet `managers`** (`(managers, X)`). *Why:* a shift sign-off is operational
("staff Y closed outlet X's shift, here's the tally") — it belongs to that outlet's managers, not the
business-wide owner feed. It is per-staff-per-outlet by nature (the shift happens at one outlet). The
alternative (route to `owners`) would flood the owner chat with every outlet's every shift end. Pick
per-outlet managers unless the brainstorm intended sign-offs as an owner-visibility tool.

**3. `founders`→`owners` — hard rename or keep `"founders"` as a permanent alias?**
*Recommendation:* **rename to `owners`** with `"founders"` recognised as a **legacy alias** only
through the migration window, then dropped. *Why:* the cockpit/owner specs standardise on `owner`;
keeping two live names invites split-brain bindings. The alias avoids a flag-day for the existing
founders chat (the backfill rebinds it). *Risk:* `docs/RUNBOOK-telegram.md` and any external runbooks
reference `founders` — sweep them in the same PR.

**4. Single-outlet resolver fallback — keep it permanently or drop after backfill?**
*Recommendation:* **keep it permanently, gated on "exactly one active outlet."** *Why:* it makes every
single-outlet deployment (Frollie today, every future small tenant in the silo model) bind-free for
outlet-scoped roles — they never have to touch `/mgr/telegram-chats` to assign an outlet. The gate
("exactly one active outlet") makes it impossible to misroute in a real multi-outlet deployment, where
the strict `(role, outlet_id)` lookup is the only path. *Alternative:* drop it after Step 2 to force
explicit binding — rejected as unnecessary operator friction for the common single-outlet case.

**5. Where does the business-level owners-summary opt-out toggle live?**
*Recommendation:* read it from the **default/primary outlet's** `pos_settings.founders_summary_enabled`
for v2.0 (single deterministic source). *Why:* `pos_settings` is per-outlet after Spec 1, but the
owners summary is business-wide — it needs **one** toggle, not N. The proper long-term home is a
business-level row (`businesses` table, Spec 4 / control plane). Until that exists, the default outlet's
flag is the pragmatic single source. *Flag:* migrate this to the `businesses` row when Spec 4 lands.

**6. `system_error` (ops) — business-wide is locked, but should multi-outlet errors carry an outlet tag?**
*Recommendation:* keep `ops` **business-wide** (locked) but **include the originating `outlet_id` in the
message body** when known (`pos_error_reports.outlet_id` is optional — render "outlet: Frollie — Block M"
when present, omit when absent). *Why:* routing stays business-wide (no crash lost when outlet is
unknown), but an operator reading the ops chat can still see which outlet a known-outlet crash came
from. Purely a render-payload addition; no routing change.
