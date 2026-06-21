# ADR-051. Multi-outlet tenancy — silo deployment + `outlet_id` as the sole data-plane scoping column

**Date:** 2026-06-21
**Status:** Proposed
**Group:** Strategic / Arch

> Bedrock decision for the Frollie POS multi-tenancy / SaaS program. Three sibling specs depend on this:
> `2026-06-21-multi-tenancy-foundation-design.md` (this ADR's implementation spec — data plane),
> the owner-cockpit spec, the Telegram-per-outlet spec, and the Phase-2 control-plane spec.
> Read this first; it sets the isolation model the others assume.

---

## Context

Frollie POS today is a **single-business, single-booth** internal tool running in its own Convex
project (`savory-zebra-800` prod). The business wants to (a) run **multiple physical outlets**
(a second Pakuwon booth, a Block M store) on the same data, and (b) eventually sell the POS to
**other businesses** as a product (the SaaS arc). These are two different axes and conflating them
is the classic multi-tenant trap.

Three concrete failure modes drive this ADR:

1. **A `business_id` column threaded through 35 tables is a tax on every query forever.** Every
   index must lead with it, every mutation must filter on it, and a single missed filter is a
   cross-tenant data leak — the worst class of bug for a product that handles other people's money.
2. **Convex has no row-level-security primitive.** Tenant isolation is purely a code discipline.
   The more tenants share one deployment, the higher the blast radius of one missed `.eq("business_id", …)`.
3. **The business already needs multi-outlet *now*** (second booth), but does **not** yet need
   multi-business. Building the heavyweight multi-business column today, before a single paying
   external customer exists, is speculative generality (YAGNI) — and it would still not solve the
   isolation-blast-radius problem.

We need an isolation model that ships multi-outlet for Frollie immediately, keeps cross-tenant
blast radius near zero, and does not paint us into a corner when external customers arrive.

---

## Decision

### Decision A — SILO: one Convex deployment per business. The deployment *is* the business.

Each business gets its **own Convex project (deployment)**. Frollie's existing prod deployment
(`savory-zebra-800`) **becomes Frollie's silo unchanged** — except every operational table gains
`outlet_id`. There is **no `business_id` column anywhere in the data plane.** The deployment
boundary *is* the business boundary, enforced by Convex's project isolation (separate auth,
separate storage, separate function namespace) rather than by a column we must never forget to filter.

A future shared **control plane** (`frollie-platform`, Phase 2) holds the business registry,
billing, and per-deployment routing — but it is a *separate* Convex project and never reaches into
a business's data plane. (Control plane is out of scope for this ADR; see the Phase-2 spec.)

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

1. `registered_devices.outlet_id` binds a phone to exactly one outlet (chosen at activation).
2. At login, `_loginCommit_internal` resolves the device's `outlet_id` and stamps it on the new
   `staff_sessions` row.
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

- **`business_id` column in a single shared deployment (pooled multi-tenant)** — *Rejected for v1.*
  Highest isolation blast radius (one missed filter = cross-business leak), and not needed until a
  paying external customer exists. Kept as the **hybrid escape hatch** (see Consequences) for small
  tenants if silo fan-out hurts.
- **A separate "location" level between business and outlet** — *Rejected.* Outlet already *is* the
  physical location. A third level is generality with no current consumer.
- **Per-outlet Convex deployments (deployment-per-outlet)** — *Rejected.* Owner cross-outlet reads
  (consolidated financials) would require cross-deployment fan-out for the most common owner query.
  Outlets must share a deployment so the cockpit can read them in one query.
- **Row-level filtering with no lint fence (discipline only)** — *Rejected.* "Never forget to filter"
  is exactly the human-error class we are trying to design out. The fence is load-bearing.

---

## Consequences

*Easier:*
- Multi-outlet ships for Frollie **in Phase 1** with one column + one join table.
- Cross-business blast radius is **near zero** — a missed `outlet_id` filter leaks *within one
  business*, never across businesses (the deployment wall holds).
- Owner cross-outlet reads (cockpit) are a single in-deployment query, not cross-deployment fan-out.
- New surfaces inherit scoping "for free" once they call `requireSession` + `withOutletScope`.

*Harder:*
- **Silo migration fan-out:** every schema change must be pushed to **N deployments** (one per
  business). Mitigation: a single shared `convex/` codebase + a deploy-orchestration script that
  iterates the control-plane registry's deployment list (Phase 2). For Phase 1 there is exactly one
  deployment, so this cost is deferred and real only once external customers exist.
- **Per-tenant provisioning** (creating a fresh Convex project + pushing schema + seeding a bootstrap
  manager/default outlet on signup) is **not a turnkey Convex feature today** — it is the biggest
  Phase-2 unknown and must be SPIKEd before promising self-serve signup. Options: Convex team API +
  scoped deploy keys; a pre-provisioned pool of empty deployments the control plane hands out; or
  manual provisioning for the first N enterprise customers.
- Every operational query gains an `outlet_id` prefix on its index; existing indexes are restructured
  (see the foundation spec's index table). The migration is a three-step optional→backfill→enforce.

*Reversal cost:*
- **Low-to-moderate.** `outlet_id` is additive; the work is not wasted under the hybrid escape hatch.
  If silo fan-out proves too painful, small tenants can be **pooled behind a `business_id` in a shared
  deployment** while enterprise tenants keep silos — and the `outlet_id` threading is identical in both
  worlds (a pooled tenant just also carries `business_id` at the deployment-routing layer). The hybrid
  is the documented escape hatch; choosing silo first does not foreclose it.

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
- **Sibling specs (same program):** owner-cockpit design, Telegram-per-outlet design, Phase-2
  control-plane / SaaS design.
- **Affected schema modules:** `auth/`, `catalog/`, `transactions/`, `payments/`, `receipts/`,
  `refunds/`, `inventory/`, `vouchers/`, `approvals/`, `settings/`, `shifts/`, `telegram/`.
- **Affected helpers:** `convex/auth/sessions.ts` (`requireSession`), `convex/auth/internal.ts`
  (`_loginCommit_internal`), new `convex/lib/outletScope.ts` (`withOutletScope`).
- **Affected enforcement:** `eslint.config.js` OWNERSHIP/scoping map +
  `tools/eslint-rules/index-leads-with-outlet_id.js`.
- **Business rules touched:** #1 (snapshots — unchanged), #20 (idempotency — key now namespaces
  outlet), #23 (booth state — derives per device, already outlet-local).
