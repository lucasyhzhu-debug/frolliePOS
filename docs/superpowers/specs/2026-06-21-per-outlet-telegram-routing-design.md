# Per-outlet Telegram routing — two-tier (role, outlet_id) chat resolution under multi-tenancy

**Date:** 2026-06-21
**Phase:** v2.0 (Phase 1 — data plane companion)
**Branch (target):** feat/v2.0-telegram-per-outlet-routing
**Decomposition rationale:** brainstorm 2026-06-21 (locked decisions in the assignment brief)
**Status:** Reviewed — staffreview gate passed 2026-06-22 (6 open questions + 2 grounding catches resolved inline; see `docs/reviews/staffreview-per-outlet-telegram-routing-spec-2026-06-22.md`). Ready to plan.
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
- `outlet_id` threading, `outlets` table, `staff_outlet_access`, session-derived scoping, and
  **device→outlet binding** →
  [`2026-06-21-multi-tenancy-foundation-design.md`](./2026-06-21-multi-tenancy-foundation-design.md)
  (Spec 1). **Device→outlet binding is Spec 1's post-activation manager-PIN assign (resolved OQ4):
  devices activate UNBOUND and a manager binds the outlet afterward via `staff.assignDeviceOutlet`.**
  Per RESOLVED decision C (plan gate, 2026-06-22) this spec does **NOT** add
  `pending_device_setups.target_outlet_id` and does **NOT** pre-assign an outlet on activation — that
  would contradict Spec 1's OQ4. `/activatepos` minting moves to per-outlet managers chats (gate change
  only; see Workstream 6), but the minted setup code stays **outlet-less**. This spec **consumes** the
  migration's default-outlet id for the backfill.
- The **`owner_otp`** template kind + its private-DM routing — owned by
  [`2026-06-21-owner-auth-plane-design.md`](./2026-06-21-owner-auth-plane-design.md) (Spec 2). It is
  the **one kind that bypasses role routing entirely** (sent via `chatIdOverride =
  String(telegram_user_id)`). Noted here for completeness; not modified by this spec.
- The **clone wizard** that provisions a new outlet's managers chat — UI/flow owned by
  [`2026-06-21-owner-cockpit-design.md`](./2026-06-21-owner-cockpit-design.md) (Spec 3). This spec
  owns the *binding* primitive the wizard's `/register` deep-link lands on.
- Multi-deployment provisioning / per-tenant bot tokens →
  [`2026-06-21-saas-control-plane-design.md`](./2026-06-21-saas-control-plane-design.md) (**deferred
  future multi-business roadmap**, not this program). In this program (one deployment, one bot) all
  outlets share one `TELEGRAM_BOT_TOKEN`.

---

## Architecture overview

| # | Stream | Owner module(s) | Risk |
|---|--------|-----------------|------|
| 1 | `telegramChats.outlet_id` + `by_role_outlet` index | `telegram/` | Low — additive optional column |
| 2 | `getChatIdByRoleAndOutlet` two-tier resolver + `owners`/`ops` business-wide path | `telegram/` (`chatRegistry/internal.ts`) | Med — the core routing change |
| 3 | `sendTemplate` gains `outletId?` + per-kind scope table + `dispatchRoleAlert`/cron self-resolve sweep | `telegram/` (`send.ts`, `dispatch.ts`, `txnTicker.ts`), `inventory/cronActions.ts` | Med-High — every send callsite threads the originating outlet; the `chatIdOverride` paths have no safety net |
| 4 | `KNOWN_TELEGRAM_ROLES` recast (`founders`→`owners`) + per-kind callsite re-wiring | `telegram/`, `approvals/`, `inventory/`, `transactions/`, `refunds/`, `shifts/` | Med — sweep every send callsite |
| 5 | Business-wide owners summary (aggregate across outlets) **+ per-outlet `managers_daily_summary`** + cron | `telegram/foundersSummary.ts` → `ownersSummary.ts`, `crons.ts` | Med-High — aggregation rewrite + dual-send (business rollup + per-outlet) |
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

| Template kind | Originates from | Routing role | Scope | Routing key | Resolves via |
|---|---|---|---|---|---|
| `manual_payment_override` | a txn at outlet X | `managers` | **outlet** | `(managers, X)` | `sendTemplate` (safety net applies) |
| `refund` | a refund of a txn at outlet X | `managers` | **outlet** | `(managers, X)` | `sendTemplate` (safety net applies) |
| `spoilage` | a spoilage event at outlet X | `managers` | **outlet** | `(managers, X)` | `sendTemplate` (safety net applies) |
| `staff_pin_reset` | a staff lockout on a device bound to outlet X | `managers` | **outlet** | `(managers, X)` | `sendTemplate` (safety net applies) |
| `recount_notice` | a recount at outlet X | `managers` | **outlet** | `(managers, X)` | `dispatchRoleAlert` (**chatIdOverride — no safety net**) |
| `low_stock_alert` | a SKU at outlet X crossing threshold | `inventory` | **outlet** | `(inventory, X)` | `dispatchRoleAlert` (**chatIdOverride — no safety net**) |
| `stock_drift_alert` | the drift cron, per outlet X | `inventory` | **outlet** | `(inventory, X)` | `cronActions` self-resolve (**chatIdOverride — no safety net**) |
| `txn_ticker` | a paid sale at outlet X | `managers` | **outlet** | `(managers, X)` | `txnTicker` self-resolve (**chatIdOverride — no safety net**) |
| `staff_shift_signoff` | a single staff shift end at outlet X | `managers` | **outlet** | `(managers, X)` | `sendTemplate` (safety net applies) |
| `shift_summary` (→ owners) | the daily cron, all outlets rolled up | `owners` | **business** | `(owners)` | `ownersSummary` self-resolve (chatIdOverride; business) |
| `managers_daily_summary` (NEW) | the daily cron, per outlet X | `managers` | **outlet** | `(managers, X)` | `ownersSummary` self-resolve (**chatIdOverride — no safety net**) |
| `system_error` | any POS crash (outlet may be unknown) | `ops` | **business** | `(ops)` | `ops/actions` self-resolve (chatIdOverride; business) |
| `owner_otp` *(Spec 2)* | an owner OTP request | — *(audit label `"owner"`, not a chat role)* | **none (bypass)** | `chatIdOverride = telegram_user_id` (private DM) | n/a — bypasses the resolver |

Notes:
- **`recount_notice` routes to `managers`, not `inventory` (RESOLVED decision 3 — corrects the
  brainstorm draft).** Verified against `convex/inventory/public.ts:177` (`dispatchRoleAlert` with
  `role: "managers"`). Only `low_stock_alert` (`inventory/internal.ts:334`) and `stock_drift_alert`
  (`inventory/cronActions.ts:116`) route to `inventory`. Both `managers` and `inventory` are
  outlet-scoped, so per-outlet routing applies identically — but the role mapping must be preserved as
  coded (no silent move to the inventory chat).
- **`staff_shift_signoff` routes to per-outlet `managers` (RESOLVED decision 2).** Today it routes to
  `founders` (`convex/shifts/actions.ts:133` self-signoff, `:197` manager-takeover). This is a
  deliberate **behavior change**: sign-offs move off the (now-`owners`) chat onto the originating
  outlet's `managers` chat — operational, per-staff-per-outlet, avoids flooding the owner feed.
- **`managers_daily_summary` is NEW (RESOLVED decision 1 — ship per-outlet now).** Each outlet's
  `managers` chat receives its own end-of-day summary in addition to the business-wide `owners` rollup.
  See Workstream 5.
- **The `chatIdOverride` callsites bypass `sendTemplate`'s OUTLET_REQUIRED_FOR_ROLE safety net.** Every
  kind marked "**no safety net**" above resolves its chatId itself and passes `chatIdOverride`, which
  short-circuits the resolver. These callsites MUST each call `getChatIdByRoleAndOutlet(role, outletId)`
  explicitly (or, for `dispatchRoleAlert`, take an `outletId` param and resolve inside the helper) — a
  missed thread here is a silent misroute, NOT a caught throw. See Routing-resolution algorithm +
  Callsite threading (Stream 4) for the per-callsite sweep.
- `staff_pin_reset` routes to **`managers`** today (lockout → approval link). It is outlet-scoped
  because the locked staff sit at a specific outlet's device (device→outlet binding, Spec 1
  Workstream 6). The originating `outlet_id` is the device's outlet.
- `txn_ticker` is per-outlet so each outlet's managers see their own sales feed (kill-switch
  `pos_settings.txn_ticker_enabled` is already per-outlet after Spec 1 Workstream 4).
- `system_error` is business-wide: a crash may fire **before** a session resolves an outlet
  (`pos_error_reports.outlet_id` is *optional* per Spec 1), so routing it per-outlet would drop
  outlet-unknown errors. Keep it business-wide so no crash is silently lost. **(RESOLVED decision 6:
  render the originating outlet label in the message *body* when `pos_error_reports.outlet_id` is
  present; routing stays business-wide.)**
- `owner_otp` (Spec 2) is the **only** kind that resolves no role — it DMs the owner directly via
  `chatIdOverride`. This spec leaves it untouched; it is listed so the routing matrix is complete.
  **Naming coherence (Spec 2 vs Spec 4):** Spec 2's `role: "owner"` arg on `owner_otp` is an *audit
  label* (singular), **not** a chat role — it is never looked up against the registry (the
  `chatIdOverride` short-circuits before `ROLE_SCOPE` is consulted). The chat role added by this spec is
  `owners` (plural). `ROLE_SCOPE` has **no `owner` key**; if a future change removed `owner_otp`'s
  `chatIdOverride`, `ROLE_SCOPE["owner"]` would be `undefined` → the business path → `getChatIdByRole("owner")`
  throws (safe-fail, never misroutes). Keep the two names distinct.

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
cron/system flows).

> **Two classes of callsite (load-bearing).** A send either (a) goes **through `sendTemplate`'s
> resolver** (pass `outletId`; the OUTLET_REQUIRED_FOR_ROLE throw is the safety net for a missed
> thread), or (b) **resolves the chatId itself and passes `chatIdOverride`** (the race-safe pattern in
> crons/ticker/dispatch). Class (b) **bypasses the safety net entirely** — `chatIdOverride`
> short-circuits the resolver. So every class-(b) outlet-scoped callsite must call
> `getChatIdByRoleAndOutlet(role, outletId)` itself; a missed thread is a silent misroute, never a
> caught throw. Each class-(b) path therefore needs its **own** per-callsite test asserting it resolves
> the per-outlet chat (the fence the safety net would otherwise provide).

**Class (a) — through `sendTemplate` (pass `outletId`):**
- **`approvals/actions.ts`** (`requestManualPaymentApproval` `:82`, refund request `:314`,
  `requestSpoilageApproval`/staff-pin-reset notify `:863`): read `outlet_id` from the approval request
  row / triggering session and pass it into `sendTemplate`. (`pos_approval_requests.outlet_id` is added
  by Spec 1.)
- **`refunds/actions.ts`** (`refund` notify `:293`): pass the refunded txn's `outlet_id`.
- **`shifts/actions.ts`** (`staff_shift_signoff` — self-signoff `_sendSignoffSummary` `:132`,
  manager-takeover `_sendTakeoverSummary` `:196`): change `role: "founders"` → `role: "managers"`
  (decision 2) and pass the shift's `outlet_id` (the `pos_shift_events` row carries it, Spec 1). These
  currently call `sendTemplate` **without** `chatIdOverride`, so the safety net applies.

**Class (b) — self-resolve + `chatIdOverride` (must call `getChatIdByRoleAndOutlet` explicitly):**
- **`telegram/dispatch.ts` `dispatchRoleAlert`** — the shared helper for `low_stock_alert`
  (`inventory/internal.ts:333`, role `inventory`) **and** `recount_notice` (`inventory/public.ts:176`,
  role `managers`). Add an `outletId: v.id("outlets")` arg; replace its `getChatIdByRole(role)` call
  with `getChatIdByRoleAndOutlet(role, outletId)`. Both callers pass the SKU's / recount's `outlet_id`
  (Spec 1). The `role_unbound` skip-audit branch is preserved (now keyed on the per-outlet miss).
- **`inventory/cronActions.ts`** (`stock_drift_alert`, role `inventory`): the drift cron iterates **per
  active outlet** and resolves `(inventory, outletId)` per outlet — one alert per outlet. (Today it
  resolves `getChatIdByRole("inventory")` once at `:91`.)
- **`telegram/txnTicker.ts`** (`txn_ticker`, role `managers`): replace the
  `getChatIdByRole("managers")` at `:47` with `getChatIdByRoleAndOutlet("managers", outletId)`; the txn
  row carries `outlet_id` (Spec 1, stamped at `_confirmPaid`).
- **`telegram/ownersSummary.ts`** (`shift_summary` → `owners` business path stays single-resolve via
  `getChatIdByRole("owners")`; the NEW per-outlet `managers_daily_summary` resolves
  `(managers, outletId)` per active outlet — see Workstream 5).

**Unchanged (business-wide, no `outletId`):**
- **`ops/actions.ts`** (`system_error`, role `ops`): routing unchanged. Only the *render payload* gains
  the outlet label when `pos_error_reports.outlet_id` is present (decision 6).

> **ADR-034 boundary note.** Modules continue to route notifications through `convex/telegram/`
> (foundational allow-listed boundary, ADR-035 amendment). They do **not** read `telegramChats`
> directly; they pass `outletId` into `sendTemplate` and the resolver does the lookup. The cross-module
> `outlet_id` reads each module needs already route through `outlets.internal._getOutlet_internal`
> (Spec 1) where a label is required.

---

## Workstream 5 — Owners summary (business rollup) + per-outlet managers summary + cron

**Goal (RESOLVED decision 1 — ship BOTH now):** one cron tick produces **two** kinds of post:
1. **Business-wide `shift_summary` → `owners` chat:** all outlets rolled up into one post, with a
   per-outlet breakdown section.
2. **Per-outlet `managers_daily_summary` → each `(managers, outlet)` chat:** that outlet's own
   end-of-day tally, so each outlet's managers see their own numbers.

### File + cron rename

- Rename `convex/telegram/foundersSummary.ts` → `convex/telegram/ownersSummary.ts` (mechanical;
  internalActions `sendFoundersSummary*` → `sendOwnersSummary*`). The cron entry in `convex/crons.ts`
  (`founders-shift-summary`, 22:00 WIB / 15:00 UTC) is renamed `owners-shift-summary` and points at
  `sendOwnersSummaryResilient`. (Cron rename is server-only — not deploy-skew-fatal; but sweep the
  on-demand command doc in CLAUDE.md / RUNBOOK: `telegram/foundersSummary:sendFoundersSummary` →
  `telegram/ownersSummary:sendOwnersSummary`.) **No cron-slot collision** with Spec 2's
  `owner-auth-housekeeping` (20:10 UTC) — `owners-shift-summary` stays at 15:00 UTC.

### Aggregation (multi-outlet)

- The action lists active outlets (`outlets.internal._listActiveOutlets_internal` — **new helper in
  Spec 1's `outlets/` module; ⛔ blocked-on-Spec-1 execution**; if absent, use
  `_getDefaultOutlet_internal` for single-outlet and add the list helper as a Spec-1 amendment) and
  aggregates **per outlet** via the existing `_dailySalesSummary_internal` + `_manualBcaReconciliation_internal`
  (both gain an `outletId` arg under Spec 1 / are scoped by outlet). It then sums into a business total
  **plus** a per-outlet breakdown.
- The `shift_summary` payload gains an optional `perOutlet: Array<{ outletLabel, totalSalesIdr,
  txnCount, flaggedCount }>` block; `renderFoundersSummary` (→ `renderOwnersSummary`) appends a
  per-outlet section beneath the business total. Single-outlet deployments render exactly as today (one
  outlet → the breakdown collapses to the total).
- **`managers_daily_summary` is a NEW template kind** (add to the `sendTemplate` `kind` union + the
  exhaustive `switch` + a `renderManagersDailySummary` in `convex/lib/telegramHtml.ts`). Payload =
  one outlet's `{ dateLabel, outletLabel, totalSalesIdr, txnCount, flaggedCount, manualBca? }`. It is
  **outlet-scoped** → resolved per outlet via `getChatIdByRoleAndOutlet("managers", outletId)` and sent
  with `chatIdOverride` (class-(b) callsite — see Stream 4; needs its own per-outlet test).

### Routing + toggles

- **Owners (business):** resolve the `owners` chat **once** up-front via `getChatIdByRole("owners")` and
  thread it as `chatIdOverride` (the existing race-window-closing pattern — `role_unbound` skip-audit
  branch preserved, retargeted to `"owners"`).
- **Per-outlet managers:** resolve `(managers, outletId)` per outlet; an unbound per-outlet managers
  chat → audited skip for THAT outlet only (don't abort the whole cron / the owners rollup).
- **Owners-summary toggle (RESOLVED decision 5):** the business-wide owners rollup reads
  `pos_settings.founders_summary_enabled` from the **default outlet** (resolved via Spec 1's
  `_getDefaultOutlet_internal`; `_getSettings_internal` now takes `outletId`). **Keep the field name
  `founders_summary_enabled` and the mutation `setFoundersSummaryEnabled` unchanged** (no schema rename
  — zero-migration; only UI copy changes via i18n). The proper long-term home is a business-level
  `businesses` row (deferred multi-business roadmap).
- **Per-outlet managers-summary toggle:** each outlet's `managers_daily_summary` is gated by **that
  outlet's own** `pos_settings.founders_summary_enabled` (per-outlet after Spec 1) — natural per-outlet
  opt-out, no new field.

**Tests:** two outlets aggregate into a business total + per-outlet breakdown to `owners`; each outlet's
`managers_daily_summary` lands in its own `(managers, X)` chat; single-outlet renders the owners post
unchanged; `owners` role unbound → audited skip (no send, no throw); ONE outlet's managers chat unbound
→ that outlet skipped, others + the owners rollup still send; default-outlet disabled toggle → owners
rollup skipped; a per-outlet disabled toggle → only that outlet's managers summary skipped.

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
3. A binder opens `/mgr/telegram-chats`, picks the dormant chat, assigns role `managers` **+ the new
   outlet** → `mgrAssignRole(role: "managers", outletId: <new>)` binds it. Same for the new outlet's
   `inventory` chat.

> **Who can bind (RESOLVED decision 8 — cross-spec).** This slice keeps the binding primitive
> (`mgrAssignRole` + `outletId`) gated by a **manager session** (`requireManagerSession`), exactly as
> `/mgr/telegram-chats` is today (`session.staff.role === "manager"`, route file
> `src/routes/mgr/telegram-chats.tsx:395`). The user's plan-gate decision adds **two reaches that this
> routing slice does NOT build but records as required cross-spec amendments:**
> - **Owners may also operate as booth managers** when needed — this **revisits Spec 2's locked Q3**
>   ("owner = cockpit-plane only"). Implementing owner-as-booth-manager (so an owner can hold a
>   `kind:"booth"` manager session and thus reach `/mgr/telegram-chats`) belongs to **Spec 2's auth
>   plane**, not here. Recorded in Cross-references as a Spec-2 amendment. Until Spec 2 ships it, the
>   binder is whoever holds a booth manager session.
> - **A cockpit-side binding surface** (so an owner binds chats from the cockpit without a booth
>   session) belongs to **Spec 3's cockpit route tree**. This spec's `mgrAssignRole`+`outletId` is the
>   primitive that surface would call; building the surface is Spec 3. Recorded as a Spec-3 cross-ref.
> The data-layer primitive is intentionally left **auth-gate-agnostic at the mutation boundary** beyond
> "a privileged session" so a future cockpit/owner caller can reuse it without a second writer.

This spec owns step 3's binding primitive; Spec 3 owns steps 1–2's wizard UX.

### `/activatepos` — multi-managers-chat gate (NO outlet pre-assignment, RESOLVED decision C)

> **Device→outlet pre-assignment is DROPPED (plan gate, 2026-06-22).** Honoring Spec 1's resolved OQ4
> (devices activate **unbound**; a manager binds the outlet afterward via `staff.assignDeviceOutlet`),
> this spec does **not** add `pending_device_setups.target_outlet_id` and does **not** pre-bind the
> device on activation. `/activatepos` still mints an **outlet-less** setup code; the device's outlet is
> assigned by the post-activation manager-PIN flow (Spec 1, Workstream 6). The *only* `/activatepos`
> change is the chat-role gate (below), because there are now N managers chats instead of one.

Today the `/activatepos` gate (`convex/telegram/activatePos.ts:45-56`) resolves the **single** managers
chat via `getChatIdByRole("managers")` and rejects any other chat. Under per-outlet routing there are
**multiple** `(managers, outlet)` chats, so this gate must change:

- **New gate:** resolve the sending chat's `telegramChats` row by `chatId` (existing
  `chatRegistry.internal.getChatRow`) and accept it iff `row.role === "managers"` (any per-outlet
  managers chat), instead of equality against the single `getChatIdByRole("managers")` result. A chat
  whose role is not `managers` (owners/inventory/ops/dormant) → silent no-op as today.
- The minted code is **outlet-less** — `_issueDeviceSetupCodeFromTelegram_internal`
  (`convex/staff/internal.ts`) is **unchanged**; no `outlet_id`/`target_outlet_id` threading.
- The reply text is unchanged (the 15-min setup-code card). After the manager activates the device on
  the new phone, they bind its outlet via Spec 1's `staff.assignDeviceOutlet` (manager-PIN) — the same
  one step every genuinely-new device hits.

> **Why no "which outlet?" loop here.** Closing that loop on the Telegram path *was* the dropped
> pre-assignment. With it dropped, the per-outlet managers chat still scopes **who can mint** a code
> (operational containment — outlet B's managers mint codes from outlet B's chat) but the device's
> outlet is set explicitly by the manager-assign step, keeping a single binding writer (Spec 1) and one
> binding model across the manual `/activate` and Telegram paths.

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
- **`index-leads-with-outlet_id` fence: `telegramChats` STAYS business-excluded.** Spec 1's plan lists
  `telegramChats` in the fence's business-level **exclusion** list (Spec-1 plan Global Constraints +
  schema §"Tables that DO NOT get `outlet_id`": *"`telegramChats` gains optional `outlet_id` in the
  Telegram-per-outlet spec, not here"*). This spec **adds** `outlet_id` to `telegramChats` but its new
  `by_role_outlet` index deliberately **leads with `role`, not `outlet_id`** (two-tier resolution keys
  on role first, then the optional outlet). That is the *opposite* of Spec 1's "every operational index
  leads with `outlet_id`" rule — which is exactly why `telegramChats` must **remain in the fence's
  exclusion list** (do NOT add it to `OUTLET_SCOPED`). Document this so a later sweep doesn't "fix" the
  index lead order and break the resolver. (⛔ blocked-on-Spec-1: the fence + exclusion list ship in
  Spec 1; this spec only relies on `telegramChats` staying excluded.)
- **Fence verification.** The single-outlet fallback is a correctness-critical branch — add a test that
  proves it fires **only** with exactly one active outlet and is bypassed the moment a second outlet
  exists (mirrors the codebase's "verify a fence is LIVE, never trust 'it passes'" lesson).
- **Money/time invariants intact** — integer rupiah (ADR-015), server-time-wins (ADR-031); the owners
  summary aggregation sums integer rupiah per outlet, no floats.
- **`logAudit` on every state change** — role bind/rebind (`telegram.role_assigned` +
  `telegram.chat_outlet_bound`), send-failure (`_auditSendFailed_internal` gains `outlet_id`). Append
  only.
- **One bot, one token.** All outlets share `TELEGRAM_BOT_TOKEN`. Per-tenant bot tokens are a deferred
  future multi-business concern (multi-deployment provisioning), not part of this program.

---

## Cross-references

- **ADR:** [ADR-035](../../ADR/035-telegram-as-internal-comms.md) — Telegram as internal comms + role
  routing (this spec adds the per-outlet amendment: routing key `(role, outlet_id)` for outlet-scoped
  roles). Token-VIEW / PIN-ACT ([ADR-029](../../ADR/029-token-authorizes-view-pin-authorizes-act.md))
  unchanged.
- **Sibling specs:**
  - [`2026-06-21-multi-tenancy-foundation-design.md`](./2026-06-21-multi-tenancy-foundation-design.md)
    (Spec 1) — defines `outlet_id`, `outlets`, session-derived scoping, and **device→outlet binding
    (post-activation manager-PIN assign, OQ4)** which this spec defers to entirely. The default-outlet
    migration (this spec's backfill depends on it). Per decision C (plan gate), this spec does **not**
    add `pending_device_setups.target_outlet_id` and does **not** pre-assign on activation.
  - [`2026-06-21-owner-auth-plane-design.md`](./2026-06-21-owner-auth-plane-design.md) (Spec 2) — owns
    the `owner_otp` template kind + private-DM `chatIdOverride` bypass and the `/start <token>`
    binding; this spec's resolver leaves `owner_otp` untouched. **Naming distinction:** Spec 2's
    `owner` is a *staff role*; this spec's `owners` is a *chat role* — kept distinct (see Routing-table
    notes). **Required Spec-2 amendment (decision 8):** owners may also operate as **booth managers**
    when needed — this revisits Spec-2's resolved Q3 ("owner = cockpit-plane only"). Spec 2 owns the
    owner-as-booth-manager auth change; this routing slice only relies on "a manager session can bind
    chats". **Coordination on shared Telegram surface:** Spec 2 modifies the command matcher
    (`acceptsArgs`) + adds `/start <token>` and states *"Spec 4 owns the final command-list assembly"* —
    **this routing spec does NOT restructure the `http.ts` command list** (its scope is resolution +
    `/activatepos` outlet pre-assignment, not command registration). Command-list assembly for `/start`
    stays with **Spec 2** (whichever of Spec 2/3 executes last reconciles the `http.ts` list); both
    specs add to the `sendTemplate` `kind` union but to **different** literals (`owner_otp` vs
    `managers_daily_summary`) — no collision, just two additive cases in the exhaustive `switch`.
  - [`2026-06-21-owner-cockpit-design.md`](./2026-06-21-owner-cockpit-design.md) (Spec 3) — owns the
    clone wizard + `createOutlet`; this spec owns the `(managers, outlet)` binding the wizard's
    `/register` deep-link lands on. **Required Spec-3 cross-ref (decision 8):** a **cockpit-side
    chat-binding surface** (owner binds chats without a booth session) is Spec 3's to build, calling
    this spec's `mgrAssignRole`+`outletId` primitive.
  - [`2026-06-21-saas-control-plane-design.md`](./2026-06-21-saas-control-plane-design.md) — per-tenant
    provisioning / per-tenant bot tokens; **deferred future multi-business roadmap**, out of scope here.
- **Key files:** `convex/telegram/config.ts` (`KNOWN_TELEGRAM_ROLES`, new `ROLE_SCOPE`),
  `convex/telegram/chatRegistry/internal.ts` (`getChatIdByRoleAndOutlet`, `assignRoleImpl`),
  `convex/telegram/chatRegistry/public.ts` (`mgrAssignRole` + `outletId`), `convex/telegram/send.ts`
  (`sendTemplate` + `outletId`), `convex/lib/telegramHtml.ts` (`renderOwnersSummary` per-outlet block),
  `convex/telegram/ownersSummary.ts` (renamed), `convex/crons.ts` (`owners-shift-summary`),
  `convex/telegram/commands.ts` / registry (`/activatepos` outlet resolution), `convex/migrations/`
  (`bindTelegramChatsToDefaultOutlet`), `src/routes/mgr/telegram-chats`, `docs/SCHEMA.md`
  (`telegramChats.outlet_id` row), `docs/RUNBOOK-telegram.md` (role table update).

---

## Resolved decisions (staffreview gate, 2026-06-22)

All open questions were resolved at the `/spec-plan-pipeline` staffreview gate (user-decided; the
recommendation was not auto-applied). Two grounding catches (A, B) were surfaced as new ambiguities and
also decided here.

**1. Owners summary scope → BUSINESS ROLLUP **AND** PER-OUTLET MANAGERS SUMMARY, both now.**
The daily cron posts a business-wide `shift_summary` (all outlets aggregated, per-outlet breakdown
section) to the `owners` chat AND a per-outlet `managers_daily_summary` to each `(managers, outlet)`
chat. (User chose "Business + per-outlet now" over the defer-managers recommendation.) See Workstream 5.

**2. `staff_shift_signoff` routing → PER-OUTLET `managers` (`(managers, X)`).** Behavior change: today
it routes to `founders` (`shifts/actions.ts:133,:197`); it moves to the originating outlet's managers
chat. A shift sign-off is operational, per-staff-per-outlet.

**3. `founders`→`owners` → RENAME with `"founders"` as a TEMPORARY legacy alias** through the migration
window, then dropped. Cockpit/owner specs standardise on `owner`; the alias avoids a flag-day while the
backfill rebinds the existing chat. *Sweep:* `docs/RUNBOOK-telegram.md` + on-demand command docs in the
same PR.

**4. Single-outlet resolver fallback → KEEP PERMANENTLY, gated on "exactly one active outlet."** Makes
single-outlet deployments bind-free for outlet-scoped roles; the gate makes multi-outlet misroute
impossible. A test must prove the fence fires ONLY with exactly one active outlet and is bypassed the
moment a second outlet exists.

**5. Owners-summary toggle source → DEFAULT OUTLET'S `pos_settings.founders_summary_enabled`.** Single
deterministic source for the business-wide rollup. **Field + mutation names stay unchanged**
(`founders_summary_enabled` / `setFoundersSummaryEnabled`) — no schema rename, only UI copy. Each
outlet's per-outlet `managers_daily_summary` is gated by that outlet's own toggle. Long-term home: a
business-level `businesses` row (deferred roadmap).

**6. `system_error` (ops) → BUSINESS-WIDE routing (locked) + render the outlet label in the BODY when
known.** `pos_error_reports.outlet_id` is optional (Spec 1) — render "outlet: Frollie — Block M" when
present, omit when absent. Pure render-payload addition; no routing change.

**A. (Grounding catch) `recount_notice` role → PRESERVE `managers`.** The brainstorm draft's routing
table said `inventory`, but the code routes recount_notice to `managers` (`inventory/public.ts:177`).
Decision: keep `managers` (corrected in the routing table); no silent move to the inventory chat.

**B. (Grounding catch) Who binds outlet chats → MANAGER SESSION in this slice; owners-as-booth-managers
+ cockpit binding surface deferred to Spec 2 / Spec 3.** `/mgr/telegram-chats` is booth-manager-gated;
Spec 2's resolved Q3 made `owner` cockpit-only. The user's decision (owners may also act as booth
managers, plus a cockpit binding surface) is recorded as required cross-spec amendments to Spec 2 (Q3)
and Spec 3 — NOT built in this routing slice. See Workstream 6 + Cross-references.

**C. (Grounding catch, plan gate) `/activatepos` device pre-assignment → DROPPED; honor Spec 1 OQ4.**
The brainstorm draft had `/activatepos` pre-assign the device's outlet via a new
`pending_device_setups.target_outlet_id`, copied to the device on activation. This **contradicts Spec
1's resolved OQ4** (devices activate UNBOUND; manager-PIN assigns the outlet afterward; "no Telegram
pre-assignment") and Spec 1 adds no such column. Decision: **drop the pre-assignment.** This spec adds
no `target_outlet_id`, mints an outlet-less code, and defers device→outlet binding entirely to Spec 1's
`staff.assignDeviceOutlet`. The only `/activatepos` change is the chat-role gate (accept any
`(managers, *)` chat instead of the single managers chat). See Workstream 6 §`/activatepos`.
