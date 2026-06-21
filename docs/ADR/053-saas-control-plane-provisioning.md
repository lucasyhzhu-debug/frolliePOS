# ADR-053. Control-plane / data-plane split for multi-tenant SaaS; per-tenant provisioning is an open spike

**Date:** 2026-06-21
**Status:** Proposed
**Group:** Strategic

## Context

The POS started as an internal tool for one booth (one Convex deployment, `savory-zebra-800`). The SaaS program (brainstorm 2026-06-21) turns it into a product sold to many *businesses*. Three sibling specs decompose the program:

- **Spec 1** ([`2026-06-21-outlet-id-data-plane-design.md`](../superpowers/specs/2026-06-21-outlet-id-data-plane-design.md)) — threads `outlet_id` through the data plane so one business can run **multiple outlets** in **one deployment**. The deployment *is* the business (the **silo** model).
- **Spec 2** (owner cockpit) — a business OWNER managing all their outlets, Telegram-OTP auth, durable session, **inside the data plane**.
- **Spec 3** (per-outlet Telegram routing).
- **Spec 4 / this ADR** — the **control plane**: Frollie THE VENDOR managing all *businesses*, billing, and per-tenant provisioning.

The decision the program already locked: **isolation model = SILO. One Convex project per business.** This buys hard data isolation (a tenant's data physically cannot leak into another's — there is no shared row space), per-tenant blast-radius containment, and lets Frollie's own prod deployment become Frollie's silo unchanged. The cost it buys is **operational fan-out**: N deployments to migrate, monitor, and provision.

This ADR records the architecture that fan-out demands — a **separate shared control-plane Convex project** that knows about all the silos — and is honest that the single hardest piece, **programmatic per-tenant provisioning**, is **not turnkey on Convex today** and must be de-risked by a spike before any self-serve signup is promised.

Two concrete failure modes this ADR exists to prevent:

1. **The "just add `business_id`" reflex.** A shared-deployment, row-level-tenancy design is the textbook SaaS pattern, but it re-introduces exactly the cross-tenant-leak risk the silo model eliminates, and it would force a `business_id` filter onto every index/query in the data plane — the precise post-filter foot-gun Spec 1's `outlet_id` prefix-scoping is built to avoid. We reject it as the *default* (see Decision C for the hybrid escape hatch).
2. **Promising self-serve signup before the provisioning spike.** "Sign up → your POS is live in 30 seconds" requires creating a fresh Convex project + pushing schema + seeding a bootstrap manager, programmatically, on demand. Convex exposes **no documented turnkey API** for project creation as of this writing. Building the billing UI first and discovering provisioning is manual-only would strand paying customers in a queue.

## Decision

### Decision A — Two planes, one shared control-plane project

There are exactly **two planes**, and they never share a Convex deployment:

| Plane | Convex project | Owns | Audience |
|---|---|---|---|
| **Control plane** | shared `frollie-platform` (new) | businesses registry, billing/subscriptions, deployment mapping, platform admins, provisioning jobs | Frollie the vendor |
| **Data plane** | one project **per business** (Frollie's own = `savory-zebra-800`) | today's POS schema + `outlet_id` (Spec 1) | one business's staff/managers/owner |

The control plane is **outside** every tenant silo. It holds **no POS transactional data** — never a `pos_transactions` row, never a `staff` row. It holds only the *registry of silos* and the *commercial relationship*. A tenant's silo holds no knowledge of other tenants or of billing. This is the load-bearing invariant: **billing/identity-of-business lives in the control plane; operational data lives in the silo.** It mirrors the existing rule that POS data shape is independent of Frollie Pro and integrates via a versioned API, not shared tables ([ADR-034](./034-deep-modules-surface-apis.md)).

The **only** link from control plane to a silo is the `business_deployments` row: `business_id → { deployment_url, scoped_deploy_key_ref, convex_project_slug }`. The control plane reaches into a silo at runtime **only** via that silo's deployment URL + a scoped key (e.g. to read a usage counter for plan-gating, or to run a seed mutation during provisioning) — never by sharing a database.

### Decision B — Provisioning is an OPEN SPIKE, not a solved design

Creating a new tenant = **create a fresh Convex project + push the shared `convex/` schema + seed a bootstrap manager + a default outlet "Pakuwon"-equivalent + register the resulting URL/key in `business_deployments`.** Step 1 (programmatic project creation) is the unknown. We record **three candidate strategies** and commit to **spiking them before** any self-serve signup ships:

1. **Convex Team/Management API + deploy keys.** *If* Convex exposes (or will expose) an API to create a project and mint a prod deploy key, the control plane orchestrates: create project → `npx convex deploy` the shared codebase against it → run the bootstrap seed mutation → write `business_deployments`. Cleanest if it exists. **Risk: may not exist / may be partner-only.** Verify first.
2. **Pre-provisioned pool.** Keep a warm pool of M empty, schema-deployed deployments. Signup *claims* one from the pool (seed bootstrap + mark assigned) — O(seconds), no live project creation in the request path. A background job refills the pool. Decouples signup latency from the (possibly manual) creation step. **Risk: pool exhaustion; cost of idle deployments; refill is still manual if (1) fails.**
3. **Manual-first-N.** For the first N enterprise customers, Frollie provisions by hand (create project in dashboard, deploy, seed, paste URL/key into the platform console). The control-plane schema and console are built to *record* a manually-created tenant from day one; automation is layered on later. **Lowest risk, ships first, does not scale to self-serve.**

**Decision: ship Manual-first-N now (strategy 3) as the v1 of the control plane; run the strategy-1 spike in parallel; keep strategy-2 (pool) as the fallback if strategy-1 is unavailable.** The control-plane schema and console MUST support a manually-entered tenant with zero automation — that is the always-true path. Automation is an enhancement to the *creation* step only; everything downstream (billing, gating, registry) is identical regardless of how the deployment got made.

### Decision C — Migration fan-out is real; one shared codebase + a deploy-orchestration script

A silo per business means **every schema change must be pushed to N deployments**. Mitigation, in priority order:

1. **One shared `convex/` codebase.** All silos run the *same* functions/schema. There is exactly one source tree; tenants differ only in data + env vars + the `outlet_id`/`business_deployments` rows. Schema migrations are written once (optional-add → backfill → enforce, the same pattern Spec 1 uses for `outlet_id`).
2. **A deploy-orchestration script** (`scripts/deploy-all-tenants.mjs`) that reads the `business_deployments` list from the control plane and runs `npx convex deploy` against each, sequentially, with a per-tenant scoped deploy key, halting on first failure and reporting which tenants are on which schema version. This is the operational answer to fan-out; it is a script, not a turnkey feature.
3. **Schema-version tracking** in `business_deployments.schema_version` so the orchestrator (and the console) can see drift — "tenant X is 2 migrations behind."

This is a real, named operational cost. We accept it for the isolation it buys, and we cap it with the hybrid escape hatch:

**Hybrid escape hatch.** If fan-out becomes painful at scale (dozens-to-hundreds of small tenants), **pool small tenants behind a `business_id` in a shared deployment, keep the silo for enterprise.** Crucially, **the Spec-1 `outlet_id` work survives either way**: in a pooled shared deployment, the same prefix-scoping discipline simply gains an outer `business_id` column (`[business_id, outlet_id, ...]` composite indexes), and `withOutletScope` becomes `withTenantScope`. The structural scoping investment is not wasted under either topology — that is *why* Spec 1 scopes on a session-derived id with a prefix index rather than post-filtering. We do **not** build the hybrid now (YAGNI); we record that the data-plane design is compatible with it.

### Decision D — Platform console is vendor-only, distinct from the owner cockpit

Three management surfaces, never conflated (the program's central rule):

| Surface | Plane | Auth | Scope |
|---|---|---|---|
| Booth app (today) | data | 4-digit PIN + registered device | one outlet |
| Owner cockpit (Spec 2) | data | Telegram-OTP, durable session | all outlets in ONE business |
| **Platform console (this ADR)** | **control** | platform-admin auth (vendor staff) | **all businesses** |

The platform console is a separate route tree / Vercel target gated by `platform_admins`. It never renders a tenant's POS data inline; it renders the *registry* (businesses, plans, deployment health, provisioning job status) and offers *operations* (provision/suspend/upgrade a tenant, run the deploy-orchestration). When a vendor admin needs to inspect a tenant's data they do it *as* that tenant (impersonation through the tenant's own cockpit, audited), not by joining across silos — because there is nothing to join across.

### Decision E — Billing / plan-gating touchpoints

Subscription state lives in the control plane (`subscriptions`). Plan limits (e.g. max outlets, max staff, feature flags) are **enforced at the data plane** by having the silo read its own plan envelope. Two viable wiring options:

- **Push (recommended for v1):** on plan change, the control plane writes a small `plan_envelope` blob into the tenant's `pos_settings`-adjacent singleton (a new `pos_plan` per-deployment row) via the scoped deploy key. The silo gates locally (e.g. `createOutlet` checks `pos_plan.max_outlets`). No control-plane round-trip on the hot path. Stale-tolerant: a downgrade takes effect on next push.
- **Pull:** the silo queries the control plane for its envelope. Rejected for v1 — adds a cross-deployment dependency on the hot path and a failure mode where billing-plane downtime breaks the POS.

Billing provider (Stripe / Xendit-for-subscriptions / Midtrans) is **out of scope for this ADR** — the registry stores a provider-agnostic `subscriptions` row keyed by an external `provider_subscription_id`. Webhook ingestion lives in the control plane only.

## Alternatives considered

- **Single shared deployment, row-level `business_id` tenancy (no silo).** Rejected as default — re-introduces cross-tenant leak risk, forces `business_id` post-filtering onto every query, contradicts the locked silo decision. Preserved as the hybrid escape hatch for small tenants (Decision C).
- **Control-plane data co-located in Frollie's own deployment.** Rejected — makes Frollie's silo special-cased and couples vendor billing to one tenant's uptime/blast-radius.
- **Build self-serve signup first, solve provisioning later.** Rejected — strands paying customers if provisioning turns out manual-only. Manual-first-N (Decision B) ships the commercial path without betting on an unverified API.
- **Pull-based plan gating.** Rejected for v1 — cross-deployment hot-path dependency (Decision E).

## Consequences

*Easier:*
- Hard tenant isolation by construction; no cross-tenant-leak class of bug.
- Frollie's existing prod becomes tenant #1 with no special-casing.
- The commercial path (record a tenant, bill it, gate it) ships independently of the provisioning-automation spike.
- Spec-1 `outlet_id` scoping is reused verbatim under both silo and hybrid topologies.

*Harder:*
- Migration fan-out: every schema change is an N-deployment rollout (mitigated by one shared codebase + orchestration script, Decision C).
- Provisioning automation is an unsolved spike (Decision B) — self-serve signup is gated on it.
- Cross-tenant analytics (vendor-level "total GMV across all businesses") requires fan-out reads or an export pipeline, not a single query.

*Reversal cost:*
- Switching to the hybrid/pooled model later is **low** for the scoping code (Spec 1 already prefix-scopes) but **high** for any provisioning automation built against the silo assumption. Defer provisioning automation until the model is settled.
- Abandoning the control plane entirely (back to internal-tool-only) costs only the unused `frollie-platform` project — no data-plane changes.

## Cross-references

- Spec (this ADR's design doc): [`docs/superpowers/specs/2026-06-21-saas-control-plane-design.md`](../superpowers/specs/2026-06-21-saas-control-plane-design.md)
- Spec 1 (the silo boundary this provisions): [`docs/superpowers/specs/2026-06-21-outlet-id-data-plane-design.md`](../superpowers/specs/2026-06-21-outlet-id-data-plane-design.md)
- [ADR-034](./034-deep-modules-surface-apis.md) — POS data shape independent; integrate via versioned API, not shared tables (the same principle, applied vendor↔tenant).
- [ADR-029](./029-token-authorizes-view-pin-authorizes-act.md) — auth-principle lineage the cockpit/console extend ("OTP authorizes MANAGE").
- Convex deployment skew note (CLAUDE.md §"Convex deployment") — atomic FE+BE ship; the orchestration script (Decision C) inherits the mutation↔action skew-fatal constraint per tenant.

## Related

| Touchpoint | Lives in |
|---|---|
| `businesses`, `subscriptions`, `business_deployments`, `platform_admins`, `provisioning_jobs` | control plane (`frollie-platform`) |
| `pos_plan` (per-deployment plan envelope) | data plane (each silo) |
| `scripts/deploy-all-tenants.mjs` (orchestration) | shared `convex/` repo tooling |
