# Multi-tenancy foundation (data plane) — outlet_id threading + session-derived scoping

**Date:** 2026-06-21
**Phase:** v2.0 (Phase 1 — data plane)
**Branch (target):** feat/v2.0-multi-outlet-foundation
**Decomposition rationale:** brainstorm 2026-06-21 (locked decisions in the assignment brief)
**Status:** Reviewed — staffreview gate passed 2026-06-21 (decisions resolved; ready to plan)
**Fulfils:** [ADR-051](../../ADR/051-multi-outlet-tenancy-silo.md)

> This is the **bedrock** spec of the **multi-outlet** program (single business, many outlets). The
> owner-cockpit and Telegram-per-outlet specs assume `outlet_id` threading, `staff_outlet_access`, and
> session-derived scoping land here first. The multi-business / SaaS control plane is **deferred to a
> future roadmap** and is not part of this program (ADR-051 *Future roadmap*).

---

## Identity

Phase 1 ships **multi-outlet + multi-phone for Frollie's existing deployment**: a new `outlets`
table; `outlet_id` threaded through every operational table (and its indexes, leading with
`outlet_id`); a `staff_outlet_access` join making staff business-level identities; per-outlet
conversion of the three singletons/counters (`pos_settings`, `pos_recount_state`,
`pos_receipt_counters` → `R-<outletcode>-YYYY-NNNN`); **session-derived** outlet scoping
(`requireSession` returns `outlet_id`, a `withOutletScope` helper, and a new
`index-leads-with-outlet_id` ESLint fence); post-activation **manager-PIN device→outlet assign**
(devices activate unbound; OQ4); the account-first **sticky-per-device** login change; and a production
**optional → backfill → enforce** migration that lands every existing prod row under a default
outlet **"Frollie — Pakuwon"**.

**Out of scope (deferred to sibling specs / later phases):**
- The `owner` role, owner cockpit routes, Telegram-OTP auth, new-outlet/clone wizard, financial
  dashboards → **owner-cockpit spec** (Phase 1.5).
- Per-outlet Telegram chat routing + OTP-to-DM binding → **Telegram-per-outlet spec**.
- **Multi-business / SaaS** (control plane, business registry, billing, per-tenant provisioning, the
  `business_id`-pooled hybrid) → **deferred to a future roadmap**, not this program (ADR-051 *Future
  roadmap*; ADR-054 + SaaS spec retained as deferred artifacts only).
- Cross-deployment `products` sync to Frollie Pro (already out of v1; unchanged).

---

## Architecture overview

| # | Stream | Owner module(s) | Risk |
|---|--------|-----------------|------|
| 1 | `outlets` table + outlet module | new `outlets/` | Low — additive |
| 2 | `outlet_id` schema threading + index restructure | every operational module | **High** — touches 23 tables + indexes |
| 3 | `staff_outlet_access` join + staff-as-identity | `auth/` (or new `access/`) | Med — roster filter rewrite |
| 4 | Per-outlet singletons + receipt-counter re-key | `settings/`, `inventory/`, `transactions/` | Med — upsert-key change, receipt format |
| 5 | Session-derived scoping (`requireSession`, `withOutletScope`) | `auth/`, new `lib/outletScope.ts` | **High** — every operational read/write touches it |
| 6 | Device→outlet binding (post-activation manager assign) | `auth/`, `staff/` | Med — all 3 session writers + assign UX |
| 7 | Account-first sticky-per-device login | `src/routes/login.tsx`, `useSession`, `useDeviceId` | Med — FE flow change |
| 8 | `index-leads-with-outlet_id` ESLint fence | `tools/eslint-rules/`, `eslint.config.js` | Med — false-positive tuning |
| 9 | Production migration (optional → backfill → enforce) | `convex/migrations/` + scripts | **High** — prod data, idempotent backfill |

---

## Schema changes

### New tables

```
outlets: defineTable({
  code: v.string(),              // short, stable, human: "PKW", "BLKM". Used in R-<code>-YYYY-NNNN.
  name: v.string(),              // "Frollie — Pakuwon"
  address: v.optional(v.string()),
  geo: v.optional(v.object({ lat: v.number(), lng: v.number() })),
  timezone: v.string(),          // IANA, default "Asia/Jakarta" (WIB). Schema-ready; v1 still WIB-anchored.
  active: v.boolean(),
  created_at: v.number(),
  created_by: v.optional(v.id("staff")),  // null for the backfilled default outlet
})
  .index("by_code", ["code"])
  .index("by_active", ["active"]),

staff_outlet_access: defineTable({
  staff_id: v.id("staff"),
  outlet_id: v.id("outlets"),
  granted_at: v.number(),
  granted_by: v.optional(v.id("staff")),  // null for backfilled access
})
  .index("by_staff", ["staff_id"])
  .index("by_outlet", ["outlet_id"])
  .index("by_staff_outlet", ["staff_id", "outlet_id"]),  // existence check + uniqueness guard
```

`outlet_id` is typed `v.id("outlets")` everywhere it appears on a data-plane row (FK discipline,
house convention). The *session* carries it as `v.id("outlets")` too; the FE treats it opaquely.

> **Note on the `string` vs `Id<"outlets">` question.** The research pack sketched `outlet_id: string`
> on sessions/devices. We deliberately use `v.id("outlets")` (a real FK) so the lint fence, schema
> validators, and `ctx.db.get(outletId)` all work. See Open questions.

### `outlet_id` threading — full table-by-table list (Stream 2)

23 operational tables gain `outlet_id: v.id("outlets")`. Every primary scan index gains a
**`by_outlet_*` variant that LEADS with `outlet_id`** (prefix scoping). Existing single-purpose
indexes are restructured in place where they are the only scan path; lookup-by-unique-token indexes
(`by_token_hash`, `by_xendit_invoice_id`, `by_code` on globally-unique codes) stay as-is but the row
still carries `outlet_id` for post-read assertion.

| Table | Module | New field | Index change (leads with `outlet_id`) |
|---|---|---|---|
| `staff_sessions` | auth | `outlet_id` | `by_outlet_device_active` `[outlet_id, device_id, ended_at]` (subsumes the existing `by_device_active` `[device_id, ended_at]` — **drop `by_device_active` in Step 3** after its readers, e.g. device-session lookup + awaiting-payment recovery, migrate to the scoped variant); keep `by_staff_active` (staff is business-level) |
| `pos_auth_attempts` | auth | `outlet_id` | keep `by_staff` (lockout is per-staff identity); add `outlet_id` for audit context |
| `registered_devices` | auth | `outlet_id` | `by_outlet_active` `[outlet_id, active]`; keep `by_device_id` (device id globally unique) |
| `pending_device_setups` | auth | *(none in Phase 1)* | unchanged. **No `target_outlet_id`** — the post-activation-manager-assign decision (OQ4) means activation does not pre-assign an outlet; a device activates unbound and a manager binds it afterward (see Stream 6). The `target_outlet_id` field is deferred to the Telegram-per-outlet spec if pre-assignment is ever added. |
| `pos_inventory_skus` | catalog | `outlet_id` | `by_outlet_active` `[outlet_id, active]`; `by_outlet_code` `[outlet_id, code]` (code now unique *per outlet*) |
| `pos_products` | catalog | `outlet_id` | `by_outlet_active_sort` `[outlet_id, active, sort_order]`; `by_outlet_family` `[outlet_id, family]`; `by_outlet_code` `[outlet_id, code]` |
| `pos_product_components` | catalog | `outlet_id` | `by_outlet_product` `[outlet_id, product_id]`; `by_outlet_sku` `[outlet_id, inventory_sku_id]` |
| `pos_transactions` | transactions | `outlet_id` | `by_outlet_status_created` `[outlet_id, status, created_at]`; `by_outlet_status_paid_at` `[outlet_id, status, paid_at]`; `by_outlet_staff_created` `[outlet_id, staff_id, created_at]`; keep `by_receipt_token` AND `by_receipt_number` (both globally unique — the outlet-code-prefixed `R-<code>-YYYY-NNNN` string stays globally unique; both on the GLOBAL_UNIQUE allowlist) |
| `pos_transaction_lines` | transactions | `outlet_id` | `by_outlet_transaction` `[outlet_id, transaction_id]` |
| `pos_xendit_invoices` | payments | `outlet_id` | `by_outlet_transaction` `[outlet_id, transaction_id]`; keep `by_xendit_invoice_id` (webhook dedup, globally unique) |
| `pos_receipt_html_cache` | receipts | `outlet_id` | keep `by_token` (token globally unique); outlet for purge scoping |
| `pos_refunds` | refunds | `outlet_id` | `by_outlet_transaction` `[outlet_id, transaction_id]`; `by_outlet_settlement_status` `[outlet_id, settlement_status, created_at]`; `by_outlet_created_at` `[outlet_id, created_at]` |
| `pos_stock_movements` | inventory | `outlet_id` | `by_outlet_sku_created` `[outlet_id, inventory_sku_id, created_at]`; keep `by_line_and_sku` (ADR-026 dedup, line id globally unique) |
| `pos_stock_levels` | inventory | `outlet_id` | `by_outlet_sku` `[outlet_id, inventory_sku_id]` |
| `pos_low_stock_alerts` | inventory | `outlet_id` | `by_outlet_sku` `[outlet_id, inventory_sku_id]` |
| `pos_stock_drift_log` | inventory | `outlet_id` | `by_outlet_sku_detected` `[outlet_id, inventory_sku_id, detected_at]`; `by_outlet_unresolved` `[outlet_id, resolved_at]` |
| `pos_recount_state` | inventory | `outlet_id` | **new** `by_outlet` `[outlet_id]` (was singleton; now one row per outlet) |
| `pos_vouchers` | vouchers | `outlet_id` | `by_outlet_active_expires` `[outlet_id, active, expires_at]`; `by_outlet_code` `[outlet_id, code]` (voucher codes unique *per outlet*) |
| `pos_voucher_redemptions` | vouchers | `outlet_id` | `by_outlet_voucher` `[outlet_id, voucher_id]`; `by_outlet_transaction` `[outlet_id, transaction_id]` (ADR-010 one-per-txn) |
| `pos_approval_requests` | approvals | `outlet_id` | `by_outlet_status_triggered` `[outlet_id, status, triggered_at]`; `by_outlet_kind_status` `[outlet_id, kind, status]`; keep `by_token_hash` (token globally unique) |
| `pos_shift_events` | shifts | `outlet_id` | `by_outlet_device_created` `[outlet_id, device_id, created_at]`; keep `by_staff_started` |
| `pos_settings` | settings | `outlet_id` | **new** `by_outlet` `[outlet_id]` (was singleton; now one row per outlet) |
| `pos_error_reports` | ops | `outlet_id` (optional) | `by_outlet_created` `[outlet_id, created_at]`; keep `by_signature_created` (dedup is business-wide) |

**Receipt counter — special re-key (Stream 4):**

| Table | Module | Change |
|---|---|---|
| `pos_receipt_counters` | transactions | field `outlet_id` added; **upsert key + index becomes `[outlet_id, year]`** (was `[year]`). Index renamed `by_outlet_year`. |

### Tables that DO NOT get `outlet_id` (business-level — keep shared)

- `staff` — **business-level identity** (Decision C). Outlet access via `staff_outlet_access`.
- `audit_log` — company-wide compliance trail (ADR-007, append-only). **Locked decision:** it stays
  **one shared append-only log**; its primary indexes remain **unscoped** by outlet, and `outlet_id`
  is added only as an **optional context-only** field (so owner-cockpit can filter). System/cron/reaper
  rows have no session and therefore no outlet — scoping the indexes by outlet would orphan them. OQ-2
  reopens this; the answer is settled here. (See Open questions for the rationale.)
- `api_tokens`, `api_rate_buckets`, `api_request_log` — global API governance (Frollie Pro sync);
  the public API is business-level, not per-outlet. (Per-outlet API filtering is a later-phase concern.)
- `pos_settlements` — **business-level (Decision, 2026-06-21).** Xendit settles to **one merchant
  bank account per deployment** (`bca_account_destination`) and knows nothing about outlets;
  settlement is matched per-txn on `reference_id` then aggregated per *day* for the whole silo. The
  aggregate is therefore business-wide: **no `outlet_id`**, `settlement_key` stays `settle-YYYY-MM-DD`,
  and the Stream-9 backfill **skips it** (the exclusion list here is the authoritative backfill
  filter). Per-outlet payout *attribution*, if the owner cockpit ever needs it, is a **derived join** —
  settled `pos_transactions` already carry `outlet_id` — not a column on the aggregate. (Surfaced to
  the owner-cockpit spec.)
- `pos_idempotency` — keyed by `key` alone (shared namespace). Do not add a field; instead the
  **client must namespace `idempotencyKey` with outlet** (see Idempotency below).
- `pos_device_activation_attempts` — already keyed by `device_id`/`"__global__"` sentinel; device
  is hardware-scoped and pre-auth. The global throttle ceiling must stay business-wide. No `outlet_id`.
- `telegram_log`, `telegramUpdates` — global forensic/dedup trail. (`telegramChats` gains optional
  `outlet_id` in the **Telegram-per-outlet spec**, not here.)
- `pos_voucher_redemptions` carries `outlet_id` (it is operational) but note vouchers are per-outlet
  by Decision B.

---

## Workstream 1 — `outlets` table + module

**Goal:** A first-class outlet entity with a stable short `code` used in receipt numbering and a
default outlet that every existing prod row backfills onto.

- New module `convex/outlets/` (`schema.ts`, `public.ts`, `internal.ts`).
- `internal._getOutlet_internal(outletId)` — cross-module read helper (catalog/transactions/etc.
  must not `ctx.db.get("outlets", …)` directly per ADR-034; they route through this).
- `internal._requireOutletCode_internal(outletId)` — returns the `code` for receipt-number prefixing
  (called by transactions module).
- `public.listOutlets(sessionId)` — outlet-unscoped read **gated to manager/owner** (booth staff see
  only their bound outlet's context, surfaced via `getSession`). v1 returns active outlets.
- Outlet **creation is owner-only** and lands in the **owner-cockpit spec** (clone wizard). Phase 1
  seeds exactly one outlet via the migration; no booth-facing create.
- ESLint OWNERSHIP map: `outlets: "outlets"`, `staff_outlet_access: "auth"` (access join lives with
  identity; see Stream 3).

**Tests:** outlet code uniqueness; `_requireOutletCode_internal` returns the prefix; `listOutlets`
rejects non-manager sessions.

---

## Workstream 2 — `outlet_id` schema threading + index restructure

**Goal:** Every operational row carries `outlet_id`; every scan index leads with it.

- Add `outlet_id` per the table-by-table list above, **first as `v.optional(v.id("outlets"))`**
  (migration step 1; Convex backward-compatible additive change), then flip to required once
  backfill completes (step 3).
- Restructure indexes: add the `by_outlet_*` variants. Where an old index is fully subsumed by its
  `by_outlet_*` variant, remove the old one **after** all readers migrate to the scoped variant.
- Index-rename caution: Convex treats index changes as additive/destructive at deploy. **Add new
  indexes first, migrate readers, then drop old** — never rename in one deploy if a reader still uses
  the old name (deploy-skew-fatal, same class as mutation↔action rename).

**Tests:** schema compiles; every `by_outlet_*` index is queried with an `outlet_id` prefix in at
least one reader (caught by the Stream-8 lint fence in CI).

---

## Workstream 3 — `staff_outlet_access` join + staff-as-identity

**Goal:** Staff are business-wide; the roster a device shows is filtered to the device's outlet.

- `staff_outlet_access` join (schema above), owned by `auth` module (it gates identity↔outlet).
- New internal: `auth.internal._listStaffForOutlet_internal(outletId)` — returns active staff who
  have a `staff_outlet_access` row for `outletId` (owner role bypasses — but owner is cockpit-only,
  deferred). Replaces the booth login picker's "all active staff" read.
- `auth.internal._assertStaffHasOutletAccess_internal(staffId, outletId)` — called inside
  `_loginCommit_internal` (Stream 5/6): a staff member can only open a session on a device whose
  outlet they have access to. Throws `NO_OUTLET_ACCESS`.
- Grant/revoke access mutations (`grantOutletAccess` / `revokeOutletAccess`, manager-PIN-gated,
  `idempotencyKey` + `withIdempotency` + `authCheck`, `logAudit` verbs `staff.grantOutletAccess` /
  `staff.revokeOutletAccess`) — **stub in Phase 1**, fully wired in the owner-cockpit spec. Phase-1
  backfill grants every active staff access to the default outlet directly.

**Tests:** roster filter returns only access-granted staff; login on an unauthorised outlet throws
`NO_OUTLET_ACCESS`; uniqueness guard via `by_staff_outlet`.

---

## Workstream 4 — Per-outlet singletons + receipt-counter re-key

**Goal:** Settings, recount-state, and receipt counters become per-outlet; receipt numbers gain the
outlet code prefix.

- **`pos_settings`** (settings module): every read goes through `settings.internal._getSettings_internal(outletId)`
  — signature gains `outletId`; returns the outlet's row or read-time defaults when absent (ADR-031
  defaults pattern preserved). All receipt-branding / manual-BCA / toggle fields are now per-outlet.
  Every settings mutation re-scopes its single-row lookup to `by_outlet`.
- **`pos_recount_state`** (inventory module): `last_recount_at` lookup re-keys to `by_outlet`.
- **`pos_receipt_counters`** (transactions module): upsert now keyed `[outlet_id, year]`. The mint
  helper is **`_allocateReceiptNumber_internal`** (`convex/transactions/internal.ts:80`, an
  `internalMutation`) — it both allocates `next_number` AND formats the string inline (today
  `return \`R-${year}-${NNNN}\`` at line 96; there is **no separate formatter**). The edit: take
  `outletId`, re-key the counter read/insert to `[outlet_id, year]` (index `by_outlet_year`), resolve
  the code via `outlets.internal._requireOutletCode_internal`, and change the template to
  **`R-${code}-${year}-${NNNN}`**. NNNN is per-outlet-per-year (each outlet starts at 0001). Its caller
  `_confirmPaid` (same file) passes `outletId` (already available from the session at confirm time).
  Existing prod receipts keep their old `R-YYYY-NNNN` strings (snapshotted; never reformatted).
  > **Snapshot rule (business rule #1) intact:** historical receipt numbers are frozen on the
  > transaction row; only *new* mints use the outlet-prefixed format.

**Tests:** two outlets mint independent `NNNN` sequences in the same year; format includes the code;
settings/recount reads return per-outlet rows; absent settings row → defaults.

---

## Workstream 5 — Session-derived outlet scoping

**Goal:** `outlet_id` is resolved from the session, available to every backend handler, and never a
client arg.

### `requireSession` / `requireManagerSession` (convex/auth/sessions.ts)

```ts
requireSession(ctx, sessionId): Promise<{
  staffId: Id<"staff">; deviceId: string; role: "staff" | "manager"; outlet_id: Id<"outlets">;
}>
```

- Read `outlet_id` from the `staff_sessions` row (stamped at login). Throw `NO_SESSION` as today if
  ended/missing/inactive.
- **Migration-tolerant window (I4 — collides with ADR-003 "no auto-logout").** Sessions never expire,
  so **old active sessions with no `outlet_id`** exist between the Step-1 deploy and the Step-2
  backfill. A hard `SESSION_NO_OUTLET` throw here would kick out **every currently-logged-in staff** at
  deploy. So during Steps 1–2 the return is typed `outlet_id: Id<"outlets"> | undefined` and, when
  absent, **falls back to the single default outlet** (resolved via `outlets`); only at **Step 3
  (enforce)** does the type flip to required `Id<"outlets">` and the hard `SESSION_NO_OUTLET` throw
  turn on (by then backfill guarantees every active session carries it). The Step-2 backfill stamps
  active `staff_sessions` **early** (before any reader relies on the value).
- `requireManagerSession` (which today returns `{ staffId, deviceId }`, no `role`) gains `outlet_id`
  in its return too, with the same window semantics.
- Every existing caller of these helpers gets `outlet_id` for free; the migration of call sites is to
  *use* it (pass into `withOutletScope` / scoped index queries).

### `getSession` public projection (convex/auth/public.ts)

Response gains `outlet_id` + `outlet_label` (the outlet `name`, fetched via
`outlets.internal._getOutlet_internal`) so the FE always has outlet context:

```ts
staff: { _id, name, role, must_change_pin, locale, outlet_id, outlet_label }
```

> **Window note (I4):** `getSession` runs the same default-outlet fallback during Steps 1–2 — it must
> not call `_getOutlet_internal(undefined)` for a pre-backfill session. Resolve to the default outlet
> when `outlet_id` is absent; the hard invariant only holds post-enforce.

### `withOutletScope` helper (new `convex/lib/outletScope.ts`, V8-safe)

A thin, well-documented wrapper that makes "scope every query by the session's outlet" the path of
least resistance and pairs with the Stream-8 lint fence:

```ts
// convex/lib/outletScope.ts  (no "use node"; V8-safe per ADR / lib convention)
export function outletScoped<T extends string>(
  q: QueryInitializer, indexName: T, outletId: Id<"outlets">,
) {
  // returns q.withIndex(indexName, (ix) => ix.eq("outlet_id", outletId)) — callers chain further .eq()
}
```

- The helper is **advisory ergonomics**; the *enforcement* is the lint fence (a query that uses a
  `by_outlet_*` index but does not lead with `.eq("outlet_id", …)` fails CI).
- Cross-module reads still route through each module's internal API (ADR-034); those internals take
  `outletId` as an explicit param and scope internally.

**Tests:** `requireSession` returns the session's outlet; cross-outlet denial (a session for outlet A
cannot read outlet B's transactions — internal helper scoped by A's id returns empty);
`SESSION_NO_OUTLET` defensive throw.

### Idempotency (business rule #20) under multi-outlet

`pos_idempotency` is keyed by `key` alone (shared namespace, documented collision hazard). To prevent
a client key from one outlet colliding with another, the **client prefixes every `idempotencyKey`
with its session outlet**: `idempotencyKey = \`${outlet_id}:${uuid}\``. This is a FE convention
(documented in `docs/PATTERNS/idempotency-dual-call-authcheck.md`), not a schema change. The dual-call
`authCheck` already re-runs `requireSession` (which now yields `outlet_id`), so the handler can assert
the key's outlet prefix matches the session outlet (defensive; reject `OUTLET_KEY_MISMATCH`).

---

## Workstream 6 — Device → outlet binding

**Goal:** A phone is bound to exactly one outlet by an explicit **manager-PIN assign** step *after*
activation (OQ4 decision, 2026-06-21); re-assigning is the same gated action. `registered_devices.outlet_id`
is the **single source of truth** for "which outlet uses this device."

### Activation (convex/staff/internal.ts `_activateDeviceCommit_internal`) — produces an *unbound* device

Activation is **pre-auth** (no session) and, per OQ4, does **not** pre-assign an outlet. The device
registers with `outlet_id: null` (optional during the window; required only after a manager binds it).
No Telegram pre-assignment, no single-outlet auto-bind — binding is an explicit manager action below.

### Manager assign (primary binding path — manager-PIN-gated)

- New action `staff.assignDeviceOutlet(sessionId, targetDeviceId, targetOutletId, managerPin, idempotencyKey)`
  — manager-PIN via `verifyManagerPinOrThrow`; patches `registered_devices.outlet_id`; if the device
  already had an outlet (re-assign), ends any active session on that device (`force_logout`);
  `logAudit` verb `device.assignOutlet` (metadata: `device_id`, `from_outlet_id`, `to_outlet_id`).
  Public mutation/action rules apply (`idempotencyKey` + `withIdempotency` + `authCheck`).
- This is the **single binding writer** for both first-bind and re-bind — there is no separate
  `rebindDeviceOutlet`; one action covers both (the `from_outlet_id` is null on first bind).
- FE: a manager-only "Assign this device to an outlet" panel (a new `mgr/device` route, or extend
  `mgr/device-setup`) listing outlets (`listOutlets`) + a manager-PIN confirm — FE detail in Stream 7.

> **Single-outlet present (Frollie today):** the Step-2 backfill stamps every *existing* device with the
> default outlet, so current phones keep working with **zero** manager action. The assign step is only
> hit by genuinely new device activations going forward — at which point a manager binds the new phone
> once.

### Login resolves + stamps — **all three `staff_sessions` writers (C2)**

A `grep insert("staff_sessions")` finds **three** session writers; **every** one must stamp `outlet_id`
(or, after enforce, the insert is a schema violation and `requireSession` throws `SESSION_NO_OUTLET`):

1. **`_loginCommit_internal`** (convex/auth/internal.ts:274) — after staff is resolved, look up
   `registered_devices.by_device_id` → `outlet_id`. Throw **`DEVICE_HAS_NO_OUTLET`** (user-facing: "ask
   a manager to assign this device to an outlet") if the device is missing or unbound. Run
   `_assertStaffHasOutletAccess_internal(staffId, outlet_id)` (Stream 3), then insert the session
   **with `outlet_id`** and thread it into the `staff.login` audit row.
2. **`managerTakeover`** (convex/auth/internal.ts:613 — business rule #23 escape hatch) — "mirrors
   `_loginCommit_internal` shape" and **also inserts a session**. It must do the same device→outlet
   resolution + stamp. (Owner/manager bypasses the access-join assertion per Decision C, but still
   needs a bound device — a takeover on an unbound device throws `DEVICE_HAS_NO_OUTLET`.)
3. **`seed`** (convex/seed/internal.ts:242 — allowlisted) — seeds its manager session with the seeded
   default outlet's id (the seed also creates the default outlet + `staff_outlet_access` rows so dev
   fixtures are consistent post-migration).

### `requireManagerSession` callers that mint sessions

`managerTakeover` is the only takeover writer; if a future reset path mirrors it, it inherits the same
stamp requirement. Document this in the C2 task so the writer set stays swept.

**Tests:** activation produces an unbound device (`outlet_id` null); `assignDeviceOutlet` binds +
requires manager PIN; re-assign ends active sessions on that device; **login on an unbound device
throws `DEVICE_HAS_NO_OUTLET`**; login stamps the session outlet; **`managerTakeover` session carries
`outlet_id`**; takeover on an unbound device throws; seed fixtures carry the default outlet.

---

## Workstream 7 — Account-first, sticky-per-device login

**Goal:** Daily login is unchanged in feel (pick account + PIN); the bound outlet is shown as context;
the roster is filtered to the device's outlet.

- **FE `src/routes/login.tsx`:** roster source switches from "all active staff" to a new query
  `auth.public.listStaffForDevice(deviceId)` (wraps `_listStaffForOutlet_internal` after resolving the
  device's outlet) — the picker shows only staff with access to *this device's* outlet. The bound
  outlet name is shown as a header chip ("Frollie — Block M").
- **Sticky-per-device:** outlet is a property of the device, not chosen at login. No outlet picker on
  the login screen. (Owner is the exception — cockpit-only, deferred.)
- **`useSession` (src/hooks/useSession.ts):** `SessionState.staff` gains `outlet_id: Id<"outlets">`
  and `outlet_label?: string`, projected from the extended `getSession`.
- **`useDeviceId`:** unchanged contract; optionally a post-activation step caches the outlet label
  under a new `storage-keys` entry for instant pre-session display.
- **Manager device-assign panel (OQ4):** a manager-only surface (new `mgr/device` route, or extend
  `mgr/device-setup`) that lists outlets and binds/re-binds the chosen device via
  `staff.assignDeviceOutlet` (manager-PIN). This is how a newly-activated, unbound phone gets its
  outlet. An unbound device's login screen shows a clear "ask a manager to assign this device" state
  (the `DEVICE_HAS_NO_OUTLET` path) rather than a dead login.
- **No outlet arg ever leaves the client** for operational mutations (Decision D). The FE passes
  `sessionId`; the server derives outlet.
- ESLint i18n fence: `login.tsx` is already in the i18n + inline-messaging registries — any new copy
  (outlet chip label) goes through `t(...)`.

**Tests (e2e):** login shows the device's outlet chip; roster filtered; a staff with no access to the
device's outlet does not appear; existing single-outlet flow unchanged after backfill.

---

## Workstream 8 — `index-leads-with-outlet_id` ESLint fence

**Goal:** "Forgot to scope by outlet" is a CI failure, not a production cross-outlet leak — mirroring
`no-cross-module-db-access`.

- New rule `tools/eslint-rules/index-leads-with-outlet_id.js`, structured exactly like the existing
  module-boundary rule (path-derived caller module, single source-of-truth config in
  `eslint.config.js`, user-facing messages, graceful degrade without options).
- **What it checks:** a `ctx.db.query("<table>").withIndex("<by_outlet_*>", (q) => …)` call where the
  table is in the OUTLET_SCOPED set **must** have its index callback lead with `.eq("outlet_id", …)`.
  A query against an outlet-scoped table that uses a non-`by_outlet_*` index is **allowed only if the
  index is on the GLOBAL_UNIQUE allowlist** (`by_token_hash`, `by_xendit_invoice_id`, `by_device_id`,
  `by_receipt_token`, `by_receipt_number`, `by_line_and_sku`, `by_signature_created`) — those are
  deliberate globally-unique lookups; the row still carries `outlet_id` for post-read assertion.
- **Config block in `eslint.config.js`:** a new `OUTLET_SCOPED` set (the 23 tables) + `GLOBAL_UNIQUE`
  index allowlist, applied to `convex/**/*.ts` (ignoring `__tests__`). Place the block **after** the
  i18n/inline-messaging blocks if it ever reuses `no-restricted-syntax`; this rule is a *custom* rule,
  not `no-restricted-syntax`, so the flat-config last-wins merge hazard does not apply — but document
  it anyway (the codebase has been bitten by fence ordering before).
- Allowlist modules (like `no-cross-module-db-access`'s `seed`, `migrations`, `_codes`) skip the
  fence: the **migration module** legitimately writes pre-scoping rows, and `seed` builds fixtures.

**Tests:** rule fixtures — a `by_outlet_*` query missing the `outlet_id` prefix reports; a
GLOBAL_UNIQUE lookup passes; an allowlisted module passes; scratch-injection proves the fence is LIVE
(per the codebase's "verify a fence is live, never trust 'lint passes'" lesson).

---

## Workstream 9 — Production migration / backfill plan

**Pattern (locked):** add optional → backfill all rows → enforce required. Idempotent, resumable,
zero-downtime, runs against `savory-zebra-800` prod (one deployment in Phase 1).

### Supersedes the PR #124 `outlet_device_id` hotfix

PR #124 (squash `144e43f`, shipped to prod 2026-06-21) added a **single-outlet hotfix** that
designates ONE registered device as "the outlet" via a flag on the settings singleton. It is an
interim mechanism, **not** the canonical model — this multi-tenancy program **replaces** it with real
device→outlet binding (`registered_devices.outlet_id` + the Stream-6 binding workstream). The hotfix's
single-device-designation flag is **retired (removed), not carried forward**. The Step-2 backfill must
**rationalize the existing hotfix state**, not preserve the flag:

- The booth's currently-designated outlet device (whatever `pos_settings.outlet_device_id` points at,
  if set) becomes a `registered_devices.outlet_id` binding to the default **"Frollie — Pakuwon"**
  outlet — i.e. it is folded into the normal device-binding backfill, with no special carry-over of the
  designation itself.
- The following are **RETIRED** (verified symbols): `pos_settings.outlet_device_id` (field,
  `settings/schema.ts:37`); `settings.outletStatus` (unauthenticated query, `settings/public.ts:30`);
  `settings._setOutletDevice_internal` (`settings/internal.ts:123`); `staff.setOutletDevice`
  (manager-session writer + its audit verb, `staff/public.ts:274,288`); and the `useOutletStatus` hook
  (`src/hooks/useOutletStatus.ts`). The field is dropped from `settings/schema.ts`, the query/mutation/
  hook are removed, and no new code reads the flag. (Historical `staff.setOutletDevice` audit rows stay
  — audit log is append-only, ADR-007 — but no new rows are written.) **Note:** the audit verb is
  `staff.setOutletDevice`, not `settings.outlet_device_set`.
- The SOP-gate logic in `RootLayout` that currently keys on `outletStatus.isOutlet` (via
  `useOutletStatus`) must **re-key on the device's bound outlet** — the start-of-day gate now runs for
  the device whose `registered_devices.outlet_id` matches the session outlet, derived through the
  Stream-5/6 device-binding path, not the standalone designation flag.

### Step 0 — seed the default outlet

Internal mutation `migrations.seedDefaultOutlet` (allowlisted module): inserts the default outlet if
absent:
```
{ code: "PKW", name: "Frollie — Pakuwon", timezone: "Asia/Jakarta", active: true, created_at: now, created_by: null }
```
Records its id for the backfill. Idempotent (no-op if a `by_code "PKW"` row exists).

### Step 1 — schema additive (optional)

Deploy schema with every `outlet_id` as `v.optional(v.id("outlets"))` and the new `by_outlet_*`
indexes added **alongside** the old ones (no drops yet). New writes (post-deploy) start stamping
`outlet_id` immediately via the updated handlers reading the (single) default outlet.

### Step 2 — backfill (idempotent, batched)

`migrations.backfillOutletId` (internal action → batched mutations, `runMutation` per page, cursor-
based; **not** `runMutation`-in-a-loop anti-pattern — page through with `paginate`). For every
operational table **in the OUTLET_SCOPED set** (the 23 + `pos_receipt_counters`), set
`outlet_id = <default outlet id>` where absent. **The "DO NOT get outlet_id" exclusion list is the
authoritative filter** — the backfill must NOT touch `pos_settlements`, `audit_log`, `api_*`,
`pos_idempotency`, `pos_device_activation_attempts`, `telegram_log`, `telegramUpdates`, or `staff`.
Per-table specifics:
- **`staff_sessions`: stamp ACTIVE sessions FIRST (I4)** — before any reader (`requireSession`/
  `getSession`) relies on the value, so no logged-in staff is interrupted (ADR-003 no auto-logout).
- `staff_outlet_access`: one row per active staff → default outlet (`granted_by: null`).
- `pos_settings`: stamp the existing singleton row with `outlet_id` (it becomes the default outlet's row).
- `pos_recount_state`: stamp the singleton.
- `pos_receipt_counters`: stamp existing `(year)` rows with `outlet_id`; they continue the *old*
  numbering for that year (no resequencing — historical receipts already minted are frozen).
- `registered_devices`: stamp `outlet_id` = default outlet (so existing phones keep working without
  re-activation **or a manager assign** — the OQ4 assign step is only for genuinely new devices).
Batched, resumable via stored cursor, safe to re-run (skips already-stamped rows). A migration test
asserts the excluded tables are **untouched**.

### Step 3 — enforce (required)

Once `backfillOutletId` reports zero remaining null `outlet_id` across all tables, deploy schema with
`outlet_id` flipped to **required** `v.id("outlets")`, drop the now-subsumed old indexes, and ship the
updated handlers/lint fence atomically (single `npm run build` → `convex deploy` per the deploy-skew
rule; FE + backend together).

### Rollback

- Steps 1–2 are additive/idempotent — rollback = redeploy prior schema (optional fields tolerate
  absent values; new rows simply carry an unused `outlet_id`).
- Step 3 (enforce) is the only one-way door. Gate it behind a verification query that asserts zero
  nulls; keep the prior build tagged for break-glass redeploy. Because Frollie is a single deployment
  in Phase 1, blast radius is one business.

---

## Implementation notes

- **Order of deploys is load-bearing.** Step 1 (optional + new indexes), then code that writes
  `outlet_id`, then backfill, then Step 3 (enforce + drop old indexes). Never enforce before backfill
  completes; never drop an old index a reader still uses (deploy-skew-fatal class).
- **`requireSession` change is the riskiest single edit** — it's the foundational auth helper called
  everywhere. Land it returning `outlet_id` early (Step 1 window) so downstream call-site migration is
  incremental; the field is present but unused until each reader scopes on it.
- **WIB anchoring unchanged.** `outlets.timezone` is schema-ready but v1 still anchors all WIB
  calendar logic (`convex/lib/time.ts`) to `Asia/Jakarta`. Per-outlet timezones are a later phase.
- **Money/time invariants intact** — integer rupiah (ADR-015), server-time-wins (ADR-031); no change.
- **Audit threading:** add `outlet_id` to the `logAudit` metadata for state changes that have a
  session (booth_inline); system/cron sources without a session may omit it (audit `outlet_id` is
  optional — see Open questions on whether the whole audit log scopes).
- **Telegram + cockpit are deliberately absent** — they consume this foundation. Per OQ4, device→outlet
  binding is a post-activation **manager assign** (`staff.assignDeviceOutlet`), so **no
  `pending_device_setups.target_outlet_id`** is added in Phase 1; Telegram pre-assignment (if ever
  wanted) is deferred to the Telegram-per-outlet spec.
- **Single deployment.** This program runs against Frollie's one deployment; multi-deployment fan-out
  (multi-business) is a future-roadmap concern, not built here.

---

## Cross-references

- **ADR:** [ADR-051](../../ADR/051-multi-outlet-tenancy-silo.md) (`outlet_id`-as-sole-scoping rationale; multi-business deferred to *Future roadmap*).
- **Amended ADRs:** ADR-003 (session carries outlet), ADR-031 (scope server-resolved, in spirit),
  ADR-039 (receipt `R-<outletcode>-YYYY-NNNN`), ADR-034 (new scoping lint fence).
- **Sibling specs (depend on this):** owner-cockpit design (owner role, cockpit auth, clone wizard);
  Telegram-per-outlet design (`telegramChats.outlet_id`, per-outlet routing, OTP-to-DM; may add
  `pending_device_setups.target_outlet_id` if Telegram pre-assignment is ever wanted — not in Phase 1 per OQ4).
- **Deferred (future roadmap, not this program):** ADR-054 + SaaS control-plane / provisioning spec.
- **Key files:** `convex/auth/sessions.ts`, `convex/auth/internal.ts` (`_loginCommit_internal`),
  `convex/auth/public.ts` (`getSession`), `convex/staff/internal.ts`
  (`_activateDeviceCommit_internal`), new `convex/outlets/`, new `convex/lib/outletScope.ts`, new
  `convex/migrations/`, `eslint.config.js`, `tools/eslint-rules/index-leads-with-outlet_id.js`,
  `src/routes/login.tsx`, `src/hooks/useSession.ts`.

---

## Resolved decisions (staffreview gate, 2026-06-21)

All open questions were resolved at the `/spec-plan-pipeline` staffreview gate. See
`docs/reviews/staffreview-v2.0-multi-outlet-foundation-spec-2026-06-21.md` for the full review.

**C1. `pos_settlements` scoping → BUSINESS-LEVEL (no `outlet_id`).** One Xendit merchant account per
deployment; settlement is matched per-txn on `reference_id` then aggregated per day for the whole silo.
Added to the exclusion list; backfill skips it; per-outlet attribution (if ever needed) is a derived
join in the cockpit spec.

**1. `outlet_id` type → `v.id("outlets")` (real FK).** Enables `ctx.db.get(outletId)`, schema
validation, and the typed lint-fence assertion. FE handles the opaque id as it already does `sessionId`.

**2. `audit_log` scoping → one shared log + OPTIONAL `outlet_id` context field.** ADR-007 append-only
company compliance; system/cron/reaper rows have no outlet; primary indexes unchanged; cockpit filters
on the optional field.

**3. `staff_outlet_access` module → `auth/`.** Gates identity↔outlet; `auth` is already the allowlisted
foundational module; avoids new-module + lint-allowlist churn for one join table.

**4. Device→outlet binding → POST-ACTIVATION MANAGER ASSIGN.** Devices activate **unbound**; a
manager-PIN `staff.assignDeviceOutlet` binds them (one action for first-bind + re-bind). **No Telegram
pre-assignment and no single-outlet auto-bind.** The Step-2 backfill stamps existing devices with the
default outlet, so Frollie's current phones need no manager action; only genuinely new devices hit the
assign step. (See Stream 6.)

**5. `pos_idempotency` outlet handling → client key prefix `${outlet_id}:${uuid}` + defensive
`OUTLET_KEY_MISMATCH` check; no schema column.** Table is keyed by `key` alone by design; the prefix is
simpler and the dual-call `authCheck` already re-runs `requireSession`. (Orthogonal to the documented
action→mutation distinct-key hazard — the prefix does not change chaining semantics.)

**6. Drop old indexes in Step 3 → DROP the subsumed ones; KEEP GLOBAL_UNIQUE lookups.** Keep
`by_token_hash`, `by_xendit_invoice_id`, `by_device_id`, `by_receipt_token`, `by_receipt_number`,
`by_line_and_sku`, `by_signature_created`. Dead indexes are write-amplification + a scoping foot-gun;
unique-token lookups are legitimately outlet-agnostic.
