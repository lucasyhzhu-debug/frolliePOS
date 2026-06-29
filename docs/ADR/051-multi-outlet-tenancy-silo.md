# ADR-051. Multi-outlet tenancy — silo deployment + `outlet_id` as the sole data-plane scoping column

**Date:** 2026-06-21
**Status:** Accepted
**Group:** Strategic / Arch

> Bedrock decision for the Frollie POS **multi-outlet** program (single business, many outlets).
> Three sibling specs depend on this: `2026-06-21-multi-tenancy-foundation-design.md` (this ADR's
> implementation spec — data plane), the owner-cockpit spec, and the Telegram-per-outlet spec.
> Read this first; it sets the isolation model the others assume.
>
> **Scope note (2026-06-22):** the **multi-business / SaaS** axis (selling the POS to other
> businesses — a shared control plane, business registry, billing, per-tenant provisioning) is
> **deferred to a future roadmap** and is NOT part of this program. See *Future roadmap (multi-business)*
> below. ADR-054 + the SaaS control-plane spec are retained as deferred design artifacts only.

---

## Context

Frollie POS today is a **single-business, single-booth** internal tool running in its own Convex
project (`savory-zebra-800` prod). The business wants to run **multiple physical outlets** (a second
Pakuwon booth, a Block M store) on the same data. (Selling the POS to *other businesses* — the
multi-business / SaaS axis — is a separate, later concern; see *Future roadmap* below. We design so
that path stays open, but we do **not** build for it now.)

The design must scope by outlet cleanly **without** prematurely adding a heavier multi-business
column we don't yet need:

1. **A `business_id` column threaded through every table would be a tax on every query forever** —
   every index leading with it, every mutation filtering on it, one missed filter a cross-tenant
   leak. There is no second business today, so adding it now is speculative generality (YAGNI).
2. **Convex has no row-level-security primitive.** Tenant isolation is purely code discipline, so
   the scoping column we *do* add (`outlet_id`) must be enforced mechanically, not by vigilance.

We need an isolation model that ships multi-outlet for Frollie immediately, keeps cross-outlet
blast radius near zero via a lint fence, and does not foreclose a future multi-business roadmap.

---

## Decision

### Decision A — One Convex deployment = the business. No `business_id` column.

Frollie's existing prod deployment (`savory-zebra-800`) stays as Frollie's single deployment — except
every operational table gains `outlet_id`. There is **no `business_id` column anywhere in the data
plane.** With one business, the deployment boundary trivially *is* the business boundary. Should a
multi-business future arrive, this stays the natural unit (one deployment per business — a "silo");
that path is preserved but unbuilt (see *Future roadmap*). No control plane, registry, or
cross-deployment machinery is part of this program.

### Decision B — `outlet_id` is the SOLE tenant-scoping column in the data plane.

Within one business's silo, the only scoping axis is the **outlet** (a physical store/booth).
"Multi-location" is simply "multiple `outlets` rows." The hierarchy is:

```
Business  =  the deployment            (no column — IS the silo)
   └─ Outlet  =  outlets row           (outlet_id  — the ONLY scoping column)
        └─ Device  =  registered_devices row (bound to exactly one outlet)
```

This is the central elegance: **one scoping column, derived structurally from the authenticated
session, never client-supplied.** Every operational index leads with `outlet_id` (prefix scoping,
not post-filter). A new lint fence (`index-leads-with-outlet_id`, mirroring `no-cross-module-db-access`)
makes "forgot to scope" a CI failure, not a production leak.

### Decision C — Staff are business-level identities; outlet access is a join.

One person = one `staff` row = one PIN, **business-wide**. A staff member's access to a given
outlet is granted by a `staff_outlet_access` join row (`staff_id × outlet_id`). The `owner` role
(introduced by the cockpit spec) **bypasses the join** — implicit access to all outlets in the silo.

`staff` is therefore one of the very few operational tables that does **not** carry `outlet_id`
(it is business-scoped). The roster a device shows is `staff` filtered through `staff_outlet_access`
for that device's bound outlet.

### Decision D — Session-derived scoping; `outlet_id` never crosses the wire as an arg.

`outlet_id` is **derived from the authenticated session**, never accepted as a mutation/query
argument. The chain:

1. `registered_devices.outlet_id` binds a phone to exactly one outlet. Binding is a **post-activation
   manager-PIN assign** (`staff.assignDeviceOutlet`) — devices activate *unbound* (staffreview OQ4,
   2026-06-21); no outlet is chosen at activation time.
2. At login, `_loginCommit_internal` (and the `managerTakeover` + `seed` session writers) resolves the
   device's `outlet_id` and stamps it on the new `staff_sessions` row.
3. `requireSession(ctx, sessionId)` returns `{ staffId, deviceId, role, outlet_id }`.
4. Every operational query/mutation scopes by that `outlet_id` via a `withOutletScope` helper.

A client cannot ask for another outlet's data because it never supplies the outlet — the server
reads it from the session it already authenticated.

### Decision E — Per-outlet singletons; outlet-prefixed receipt numbers.

`pos_settings` and `pos_recount_state` (deployment-singletons today) become **one row per outlet**.
`pos_receipt_counters` re-keys to `(outlet_id, year)`, and the human-facing receipt number gains the
outlet code prefix: **`R-<outletcode>-YYYY-NNNN`** (stays unique + distinguishable across outlets on
a shared receipt printer or in a consolidated owner report).

---

## Alternatives considered

- **A `business_id` multi-business column now** — *Deferred (not rejected).* No second business
  exists, so it's YAGNI today; revisited only in the future multi-business roadmap. `outlet_id` is
  additive and identical work in either world, so deferring costs nothing.
- **A separate "location" level between business and outlet** — *Rejected.* Outlet already *is* the
  physical location. A third level is generality with no current consumer.
- **Per-outlet Convex deployments (deployment-per-outlet)** — *Rejected.* Owner cross-outlet reads
  (consolidated financials) would require cross-deployment fan-out for the most common owner query.
  Outlets must share one deployment so the cockpit can read them in a single query.
- **Row-level filtering with no lint fence (discipline only)** — *Rejected.* "Never forget to filter"
  is exactly the human-error class we are trying to design out. The fence is load-bearing.

---

## Consequences

*Easier:*
- Multi-outlet ships for Frollie with one column + one join table.
- Cross-outlet blast radius is **near zero** — a missed `outlet_id` filter is caught by the lint
  fence in CI, never reaching production.
- Owner cross-outlet reads (cockpit) are a single in-deployment query.
- New surfaces inherit scoping "for free" once they call `requireSession` + `withOutletScope`.

*Harder:*
- Every operational query gains an `outlet_id` prefix on its index; existing indexes are restructured
  (see the foundation spec's index table). The migration is a three-step optional→backfill→enforce.

*Reversal cost:*
- **Low.** `outlet_id` is purely additive and is identical work whether or not a multi-business future
  ever arrives; nothing here is wasted under any later direction.

---

## Future roadmap (multi-business) — out of scope for this program

Deferred to a future roadmap (designed-for, not built). Captured so the multi-outlet work doesn't
foreclose it; **none of this ships in the multi-outlet program**:

- **Selling the POS to other businesses (SaaS).** Each business would get its own deployment (the
  "silo" — one deployment = one business), keeping cross-business blast radius at the deployment wall.
- **Shared control plane** (`frollie-platform`): business registry, billing, per-deployment routing —
  a *separate* Convex project that never reaches into a business's data plane. (Deferred design:
  ADR-054 + the SaaS control-plane spec, both retained as roadmap artifacts only.)
- **Per-tenant provisioning** (fresh Convex project + schema push + bootstrap seed on signup) is not a
  turnkey Convex feature; it must be SPIKEd (Convex team API + scoped deploy keys, a pre-provisioned
  deployment pool, or manual provisioning) **before** any self-serve-signup work is planned.
- **Silo fan-out** (pushing each schema change to N deployments) and a **`business_id`-pooled hybrid**
  for small tenants are the open questions to resolve *if and when* that roadmap is picked up.

*Affects other ADRs:*
- **Supersedes the PR #124 `outlet_device_id` interim hotfix** (squash `144e43f`, prod 2026-06-21):
  real device→outlet binding (`registered_devices.outlet_id`, Decision D) replaces the single-device
  designation flag — `pos_settings.outlet_device_id`, `settings.outletStatus`, `staff.setOutletDevice`,
  and the `settings.outlet_device_set` audit verb are retired, not carried forward.
- **Amends ADR-003** (shared-device ephemeral session): sessions now carry `outlet_id` (resolved from
  the device) and, per the cockpit spec, a `kind: "booth" | "cockpit"` discriminant.
- **Amends ADR-031** (server-time-wins) only in spirit — extends the principle to *scope*: outlet, like
  time, is server-resolved, never client-supplied.
- **Amends ADR-039** (receipt numbering): receipt counter re-keys to `(outlet_id, year)`; format gains
  outlet-code prefix.
- **Extends ADR-034** (deep modules): a new module-boundary-style lint fence
  (`index-leads-with-outlet_id`) enforces prefix scoping.
- **Builds on ADR-029** (token authorizes view, PIN authorizes act): the cockpit spec adds "OTP
  authorizes MANAGE" as the third leg — out of scope here, noted for coherence.

---

## Cross-references

- **Implementation spec:** `docs/superpowers/specs/2026-06-21-multi-tenancy-foundation-design.md`
- **Sibling specs (same program):** owner-cockpit design, Telegram-per-outlet design.
- **Deferred roadmap artifacts (not in this program):** ADR-054 + SaaS control-plane / provisioning spec.
- **Affected schema modules:** `auth/`, `catalog/`, `transactions/`, `payments/`, `receipts/`,
  `refunds/`, `inventory/`, `vouchers/`, `approvals/`, `settings/`, `shifts/`, `telegram/`.
- **Affected helpers:** `convex/auth/sessions.ts` (`requireSession`), `convex/auth/internal.ts`
  (`_loginCommit_internal`), new `convex/lib/outletScope.ts` (`withOutletScope`).
- **Affected enforcement:** `eslint.config.js` OWNERSHIP/scoping map +
  `tools/eslint-rules/index-leads-with-outlet_id.js`.
- **Business rules touched:** #1 (snapshots — unchanged), #20 (idempotency — key now namespaces
  outlet), #23 (booth state — derives per device, already outlet-local).
