# Frollie POS — SaaS Control Plane & Per-Tenant Provisioning (Spec 4, Phase 2) — sell the POS to many businesses from a vendor console

**Date:** 2026-06-21
**Phase:** Phase 2 (SaaS / control plane) — the most exploratory of the four-spec multi-tenancy program
**Branch (target):** `feat/phase2-saas-control-plane` (control plane is a **separate Convex project** — likely a sibling repo `frollie-platform/`, not a branch of `frolliepos`)
**Status:** Brainstorm → DRAFT for `/spec-plan-pipeline` review
**ADR:** [`docs/ADR/053-saas-control-plane-provisioning.md`](../../ADR/053-saas-control-plane-provisioning.md)

**Sibling specs (one coherent program):**
- Spec 1 — data plane / `outlet_id`: [`2026-06-21-multi-tenancy-foundation-design.md`](./2026-06-21-multi-tenancy-foundation-design.md) — **this spec provisions the silo that spec defines.**
- Spec 2 — owner cockpit: [`2026-06-21-owner-cockpit-design.md`](./2026-06-21-owner-cockpit-design.md)
- Spec 3 — per-outlet Telegram: [`2026-06-21-per-outlet-telegram-routing-design.md`](./2026-06-21-per-outlet-telegram-routing-design.md)

> ⚠️ **Exploratory.** Phase 2 is the SaaS bet. The single hardest piece — programmatic per-tenant provisioning — is **NOT turnkey on Convex** and is recorded here as a **SPIKE**, not a solved design. Do not promise self-serve signup until §6's spike resolves. Read ADR-053 first.

---

## 1. Identity

Stand up a **vendor-only control plane** — a separate, shared `frollie-platform` Convex project — that knows about every business Frollie sells the POS to, maps each business to its own **data-plane deployment** (one Convex project per business = the **silo**, Spec 1), tracks the commercial relationship (subscriptions/billing), and provides a **platform console** for Frollie staff to provision, suspend, upgrade, and monitor tenants.

This spec ships the **commercial + operational scaffolding** for SaaS. It deliberately ships **Manual-first-N provisioning** (a vendor admin records a hand-created deployment) and treats **automated provisioning** as a parallel spike.

**Out of scope (this spec):**
- The owner cockpit itself (Spec 2) and per-outlet Telegram (Spec 3) — both data-plane.
- Choosing/integrating a specific billing provider (Stripe/Midtrans/Xendit-subscriptions) — the registry is provider-agnostic; provider wiring is a follow-up.
- Automated self-serve signup (the public "sign up and your POS is live" flow) — **gated on the §6 spike**.
- Cross-tenant vendor analytics dashboards (GMV across all businesses) — noted as a fan-out concern, deferred.
- Any data-plane schema change — those are Spec 1. The one data-plane addition this spec *touches* is the `pos_plan` envelope row (§7), and even that is written *by* the control plane, read *by* the silo.

**You'll be able to (as Frollie the vendor):**
- Register a new business in the platform console, attach its deployment URL + scoped key (manually created at first), and see it go live.
- See every tenant's deployment health and schema version in one list.
- Set a tenant's plan; the limit envelope pushes into that tenant's silo and gates outlet/staff creation locally.
- Suspend / reactivate a tenant.
- Run a one-command schema migration across all tenant deployments.

---

## 2. Architecture overview

| # | Stream | Owner module (control plane) | Risk |
|---|---|---|---|
| A | Control-plane schema + registry | `platform/businesses`, `platform/deployments` | Low — plain tables |
| B | Platform-admin auth + console route tree | `platform/admins`, `frollie-platform` FE | Medium — new auth surface (vendor) |
| C | Subscriptions / billing registry + plan-gating push | `platform/billing` + data-plane `pos_plan` | Medium — provider-agnostic now, webhook later |
| D | **Provisioning (Manual-first-N + spike)** | `platform/provisioning` | **HIGH — spike; programmatic Convex project creation unverified** |
| E | Migration fan-out orchestration | `scripts/deploy-all-tenants.mjs` | Medium — operational tooling, skew-fatal per tenant |
| F | Plane boundary & isolation invariants | cross-cutting | Low — enforced by "no shared DB" |

The **control plane holds no POS transactional data.** Its only link to a silo is the `business_deployments` row (URL + scoped key ref). All cross-plane runtime calls go *through that URL*, never a shared table (ADR-053 Decision A).

```
                ┌──────────────────────────────────────────┐
                │  CONTROL PLANE  (frollie-platform)         │
                │  businesses · subscriptions ·              │
                │  business_deployments · platform_admins ·  │
                │  provisioning_jobs · platform_audit_log    │
                └───────────────┬──────────────────────────┘
        scoped deploy key /     │  (URL + key per tenant; never shared DB)
        seed mutation / plan    │
        envelope push           ▼
   ┌────────────────┐   ┌────────────────┐   ┌────────────────┐
   │ SILO: Frollie  │   │ SILO: Biz B    │   │ SILO: Biz C    │  …N silos
   │ savory-zebra-  │   │ <project-B>    │   │ <project-C>    │
   │ 800 + outlet_id│   │ + outlet_id    │   │ + outlet_id    │
   │ (Spec 1)       │   │                │   │                │
   └────────────────┘   └────────────────┘   └────────────────┘
```

---

## 3. Workstream A — Control-plane schema + registry

**Goal:** the registry of who Frollie sells to and where their silo lives.

New Convex project `frollie-platform`, its own `convex/` tree (deep-modules per ADR-034). Tables (snake_case, money = integer rupiah per ADR-015, server-time-wins per ADR-031):

### `businesses`
```
defineTable({
  name: v.string(),
  slug: v.string(),                 // url-safe short id, e.g. "frollie"
  status: v.union(                  // commercial lifecycle
    v.literal("provisioning"),      // deployment being created/seeded
    v.literal("active"),
    v.literal("suspended"),         // non-payment / TOS — silo read-only
    v.literal("churned"),           // offboarded; deployment archived
  ),
  owner_name: v.string(),
  owner_email: v.string(),
  owner_telegram_user_id: v.optional(v.number()),  // for cockpit OTP bootstrap (Spec 2)
  country: v.string(),              // "ID" for now
  created_at: v.number(),
  updated_at: v.number(),
})
  .index("by_slug", ["slug"])
  .index("by_status", ["status"])
```

### `business_deployments` — the ONLY control→data link
```
defineTable({
  business_id: v.id("businesses"),
  convex_project_slug: v.string(),       // e.g. "savory-zebra-800"
  deployment_url: v.string(),            // .convex.cloud client URL
  deployment_site_url: v.string(),       // .convex.site (httpAction/webhooks)
  deploy_key_ref: v.string(),            // SECRET REF, not the key — see §3.1
  schema_version: v.string(),            // last migration applied (drift tracking, Stream E)
  provisioned_via: v.union(
    v.literal("manual"),                 // Manual-first-N (v1)
    v.literal("team_api"),               // spike strategy 1
    v.literal("pool_claim"),             // spike strategy 2
  ),
  health: v.optional(v.object({          // last orchestration/health probe
    at: v.number(),
    ok: v.boolean(),
    message: v.optional(v.string()),
  })),
  created_at: v.number(),
})
  .index("by_business", ["business_id"])
  .index("by_project_slug", ["convex_project_slug"])
```

### `platform_admins`
```
defineTable({
  email: v.string(),
  name: v.string(),
  role: v.union(v.literal("superadmin"), v.literal("ops")),  // superadmin = provision/suspend; ops = read + run-migration
  active: v.boolean(),
  created_at: v.number(),
})
  .index("by_email", ["email"])
```

### `platform_admin_sessions`
```
defineTable({
  admin_id: v.id("platform_admins"),
  started_at: v.number(),
  ended_at: v.union(v.number(), v.null()),
  idle_expires_at: v.number(),           // durable session, idle timeout
})
  .index("by_admin_active", ["admin_id", "ended_at"])
```

### `platform_audit_log` — append-only, mirrors data-plane `audit_log` discipline (ADR-007)
```
defineTable({
  actor_id: v.union(v.id("platform_admins"), v.literal("system")),
  action: v.string(),                    // free string, no enum — "tenant.provisioned", "tenant.suspended", "plan.changed", "migration.run"
  business_id: v.optional(v.id("businesses")),
  metadata: v.string(),                  // JSON.stringify
  created_at: v.number(),
})
  .index("by_actor_date", ["actor_id", "created_at"])
  .index("by_business_date", ["business_id", "created_at"])
  .index("by_action_date", ["action", "created_at"])
```

#### §3.1 — Deploy-key handling (security)
`deploy_key_ref` stores a **reference** (env-var name / secret-manager key id), **never the key bytes** in a Convex row. The orchestration script and provisioning actions resolve the actual key from the platform deployment's env at runtime. A scoped **prod** deploy key per tenant is what lets the control plane `convex deploy` and run seed mutations against that silo. Rotation = mint new key in the tenant project, update the secret store, leave `deploy_key_ref` unchanged. **A leaked control-plane key = access to ALL tenant deployments** — this is the highest-value secret in the system; document break-glass rotation in a runbook.

**Tests:** registry CRUD smoke; `by_slug` uniqueness guard; audit row written on every status transition.

---

## 4. Workstream B — Platform-admin auth + console route tree

**Goal:** a vendor-only surface, structurally distinct from the owner cockpit (Spec 2) and the booth app.

- **Auth:** platform admins are NOT `staff`. Separate identity (`platform_admins`), separate session (`platform_admin_sessions`), durable with idle timeout. v1 auth recommendation: **email magic-link or OAuth (Google Workspace) for Frollie staff** — small fixed set of vendor employees, not OTP-to-Telegram (that's the owner cockpit pattern). Reuse the "token authorizes view, PIN/OTP authorizes act" lineage (ADR-029) only loosely — vendor admins are trusted internal staff, gate on session + role.
- **Route tree:** `frollie-platform` is its own Vercel project / subdomain (e.g. `console.frollie.*`), separate from any tenant FE. Routes: `/console/businesses` (list + health), `/console/businesses/:id` (detail: deployment, plan, provisioning jobs, audit), `/console/provision` (new-tenant wizard), `/console/migrations` (run + drift view).
- **Console NEVER renders tenant POS data inline.** It renders the registry + operations. Inspecting a tenant's actual sales = impersonate through that tenant's cockpit (Spec 2), audited — because there is nothing to cross-silo-join (ADR-053 Decision D).

**Per-route checklist:**
- [ ] `/console/businesses` — table of businesses (name, status, plan, schema_version, health dot).
- [ ] `/console/businesses/:id` — deployment card, plan card, provisioning-job log, `platform_audit_log` slice.
- [ ] `/console/provision` — Stream D wizard.
- [ ] `/console/migrations` — Stream E trigger + per-tenant version drift.

**Tests:** non-admin session → 403 on every console query; `ops` role cannot provision/suspend (only `superadmin`); session idle-timeout expiry.

---

## 5. Workstream C — Subscriptions / billing registry + plan-gating push

**Goal:** record the commercial relationship; gate tenant capability by plan.

### `subscriptions`
```
defineTable({
  business_id: v.id("businesses"),
  plan: v.union(v.literal("starter"), v.literal("growth"), v.literal("enterprise")),
  status: v.union(
    v.literal("trialing"), v.literal("active"),
    v.literal("past_due"), v.literal("canceled"),
  ),
  provider: v.optional(v.string()),               // "stripe" | "midtrans" | ... — provider-agnostic
  provider_subscription_id: v.optional(v.string()),
  current_period_end: v.optional(v.number()),
  limits: v.object({                              // the plan envelope pushed to the silo
    max_outlets: v.number(),
    max_staff: v.number(),
    features: v.array(v.string()),                // feature-flag strings, e.g. "public_api", "settlements"
  }),
  created_at: v.number(),
  updated_at: v.number(),
})
  .index("by_business", ["business_id"])
  .index("by_provider_sub", ["provider_subscription_id"])
```

### Plan-gating — PUSH model (ADR-053 Decision E)
On plan change (admin edit, or later a billing webhook), the control plane **pushes** a `plan_envelope` into the tenant silo by running a seed-style mutation against that deployment (via the scoped key): writes/updates a **per-deployment `pos_plan` singleton** (data-plane, §7). The silo gates **locally** — `createOutlet` (Spec 2 owner action) reads `pos_plan.max_outlets`; `createStaff` reads `pos_plan.max_staff`; feature-flagged surfaces read `pos_plan.features`. No control-plane round-trip on the hot path; stale-tolerant (downgrade applies on next push).

- **Billing provider integration is a follow-up.** v1 stores the subscription row, set manually by an admin. Webhook ingestion (`POST /platform-webhook/billing`) lands when a provider is chosen — it lives in the **control plane only** and updates `subscriptions.status` + re-pushes the envelope.

**Tests:** plan change writes `platform_audit_log` `plan.changed`; envelope-push action targets the correct deployment URL; silo `createOutlet` rejects past `max_outlets` (data-plane test, cross-referenced from Spec 1/2).

---

## 6. Workstream D — Provisioning (Manual-first-N now; automation = SPIKE)

> **This is the exploratory core.** Programmatic Convex project creation is **not a documented turnkey feature**. We ship Manual-first-N and spike automation in parallel (ADR-053 Decision B).

### What "provision a tenant" means (the always-true sequence)
1. A Convex **project** exists for the business (the unknown — *how* it gets created varies by strategy).
2. The shared `convex/` schema/functions are **deployed** to it (`npx convex deploy`).
3. A **bootstrap manager** is seeded (`BOOTSTRAP_MANAGER_PIN` env per the existing v1.1 bootstrap path) + a **default outlet** "<Business> — Main" (Spec 1's backfill default, generalized).
4. The control plane writes `businesses` (status `active`) + `business_deployments` (URL + key ref + `schema_version`).
5. The plan envelope is pushed (Stream C).

### `provisioning_jobs` — state machine for the above
```
defineTable({
  business_id: v.id("businesses"),
  strategy: v.union(v.literal("manual"), v.literal("team_api"), v.literal("pool_claim")),
  state: v.union(
    v.literal("pending"),
    v.literal("project_ready"),     // step 1 done
    v.literal("deployed"),          // step 2 done
    v.literal("seeded"),            // step 3 done
    v.literal("registered"),        // step 4 done
    v.literal("done"),              // step 5 done
    v.literal("failed"),
  ),
  last_error: v.optional(v.string()),
  started_at: v.number(),
  updated_at: v.number(),
})
  .index("by_business", ["business_id"])
  .index("by_state", ["state"])
```

### v1 — Manual-first-N (SHIP THIS)
The platform-console new-tenant wizard:
1. Admin creates the Convex project **by hand** (dashboard) + runs `npx convex deploy` + the bootstrap seed locally (a documented runbook).
2. Admin pastes `deployment_url`, `deployment_site_url`, `convex_project_slug`, `deploy_key_ref` into the wizard.
3. Wizard writes `businesses` + `business_deployments` + a `provisioning_jobs` row already at `state: "done"`, `strategy: "manual"`.
4. Pushes the plan envelope.

**The console + schema support a fully-manual tenant with zero automation — this is the path that always works.**

### Spike strategies (run in parallel; pick the winner before self-serve signup)
1. **Convex Team/Management API + deploy keys** — verify whether Convex exposes project-creation + key-minting programmatically. **Action item: confirm against Convex docs/support before designing the automated wizard.** If yes → a `provisionTenant` action drives steps 1–5 end-to-end.
2. **Pre-provisioned pool** — a warm pool of M empty schema-deployed deployments (a `deployment_pool` table in the control plane). Signup *claims* one (atomic mark-assigned), seeds bootstrap, registers. Background refill job. Decouples signup latency from creation. Fallback if (1) is unavailable.
3. **Manual-first-N** — already shipped above; the floor.

### Open spike (must resolve before promising self-serve signup)
- Can Convex create a project + mint a scoped prod deploy key via API? → determines strategy 1 viability.
- Pool economics: cost of M idle deployments vs signup-latency SLA → determines strategy 2.
- Suspend/offboard mechanics: does `businesses.status = "suspended"` push a read-only flag into the silo (a `pos_plan.suspended` bit the booth honours), or do we revoke the deploy key / pause the deployment? → recommend the **read-only-flag push** (graceful, reversible) for v1; deployment-pause is a Convex-feature unknown.

**Tests:** manual-wizard happy path writes all three rows + pushes envelope; `provisioning_jobs` transitions audited; idempotent re-run of a `done` job is a no-op.

---

## 7. Workstream E — Migration fan-out orchestration + the `pos_plan` envelope

**Goal:** one schema change → all N silos, safely; track drift.

### Data-plane addition (the only thing this spec adds to a silo)
`pos_plan` — per-deployment singleton (like `pos_settings`, no schema enforcement; read-time default = most-generous/locked-down as chosen):
```
// convex/settings/schema.ts (or a new convex/plan/ module — recommend co-locate in settings)
pos_plan: defineTable({
  max_outlets: v.number(),
  max_staff: v.number(),
  features: v.array(v.string()),
  suspended: v.boolean(),          // control-plane push sets this; booth + cockpit honour it
  pushed_at: v.number(),
  // written ONLY by the control-plane-invoked seed mutation; read by createOutlet/createStaff/feature gates
})
```
*This is the only cross-plane data write into a silo, and it is one small singleton.* Owner-action gates (Spec 2 `createOutlet`, existing `createStaff`) read it; absent row → permissive default for the legacy single-tenant deployment.

### `scripts/deploy-all-tenants.mjs` (shared `convex/` repo tooling)
- Reads `business_deployments` list from the control plane (via the platform deployment URL + a read key).
- For each tenant, sequentially: resolve scoped deploy key from secret store → `npx convex deploy` the shared codebase → on success, write back `business_deployments.schema_version` + `health`.
- **Halts on first failure**, reports which tenant + which version each is on.
- Inherits the **mutation↔action skew-fatal** constraint per tenant (CLAUDE.md §"Convex deployment"): each tenant's FE+BE must ship atomically; the script deploys BE, and tenant FEs (shared Vercel build or per-tenant) must be coordinated. **Recommend: shared FE build pinned to a schema version; deploy BE first across all tenants, then flip FE — or accept a brief skew window and design migrations additive-only (optional-add → backfill → enforce, the Spec-1 pattern).**

### Drift view
`/console/migrations` reads every `business_deployments.schema_version` and flags tenants behind the current shared-codebase version.

**Tests:** orchestrator dry-run lists tenants + versions; halt-on-failure leaves remaining tenants untouched; schema_version write-back on success.

---

## 8. Workstream F — Plane boundary & isolation invariants (cross-cutting)

The invariants reviewers must hold the line on:

1. **No shared DB across the plane boundary.** The control plane never holds a `pos_*`/`staff` row; a silo never holds a `businesses`/`subscriptions` row. The ONLY link is `business_deployments` (URL + key ref).
2. **Cross-plane calls go through the deployment URL + scoped key**, never a table read.
3. **`outlet_id` (Spec 1) survives the hybrid escape hatch.** If small tenants are later pooled behind `business_id` in a shared deployment (ADR-053 Decision C), the prefix-scoping discipline gains an outer `business_id` column (`[business_id, outlet_id, ...]`); `withOutletScope` → `withTenantScope`. **Do not build the hybrid now (YAGNI)** — just keep data-plane scoping prefix-based, not post-filtered, so the option stays cheap.
4. **Three surfaces never conflate** (booth / owner cockpit / platform console) — separate auth, separate route trees, separate planes for the console.

---

## 9. Implementation notes

- **Build order:** Stream A (schema) → B (console+auth) → C (billing registry + envelope push) → D (manual wizard) → E (orchestration). Ship A–E as the v1 control plane; the provisioning spike (D's strategies 1/2) runs in parallel and does **not** block the manual path.
- **Frollie-as-tenant-#1:** backfill the control plane with one `businesses` row for Frollie + a `business_deployments` row pointing at `savory-zebra-800`. This makes the existing prod the first registered tenant with no data-plane change.
- **Rollback:** the control plane is purely additive and external — tearing it down touches no silo. The only silo touch is the `pos_plan` row (absent → permissive default), so a silo runs fine with no control plane at all (the internal-tool mode).
- **Prod ops:** the per-tenant deploy key is the highest-value secret — runbook the rotation + break-glass. Suspend should be reversible (read-only flag push, §6 open spike) not destructive.
- **Billing webhooks** land only when a provider is chosen — control-plane `POST /platform-webhook/billing`, signature-verified, idempotent (mirror the Xendit webhook discipline: always 200, dedup by event id).

## 10. Cross-references

- ADR fulfilled: [`docs/ADR/053-saas-control-plane-provisioning.md`](../../ADR/053-saas-control-plane-provisioning.md).
- Spec 1 (silo this provisions, `outlet_id`, hybrid-survival rationale): [`2026-06-21-multi-tenancy-foundation-design.md`](./2026-06-21-multi-tenancy-foundation-design.md).
- Spec 2 (owner cockpit — `createOutlet` reads `pos_plan`, OTP bootstrap uses `businesses.owner_telegram_user_id`): [`2026-06-21-owner-cockpit-design.md`](./2026-06-21-owner-cockpit-design.md).
- [ADR-034](../../ADR/034-deep-modules-surface-apis.md) — vendor↔tenant integration via API/URL, not shared tables.
- CLAUDE.md §"Convex deployment" — mutation↔action skew-fatal, inherited per-tenant by Stream E.

---

## Open questions (review at /spec-plan-pipeline)

**Q1 — Is programmatic Convex project + deploy-key creation available?**
*Recommendation:* Treat as UNKNOWN; ship Manual-first-N; run the spike against Convex docs/support before designing the automated wizard.
*Why:* This is the single gate on self-serve signup. Designing automation on an unverified API is the costliest possible bet (ADR-053 Decision B).

**Q2 — Plan gating push vs pull?**
*Recommendation:* PUSH the envelope into a `pos_plan` silo singleton; gate locally.
*Why:* Avoids a cross-deployment hot-path dependency where billing-plane downtime would break the POS (ADR-053 Decision E).

**Q3 — Platform-admin auth mechanism?**
*Recommendation:* Email magic-link or Google-Workspace OAuth for the small fixed set of Frollie staff — NOT Telegram-OTP (that's the owner cockpit).
*Why:* Vendor admins are trusted internal employees, not field operators; reuse the simplest secure flow, keep it distinct from the cockpit.

**Q4 — Suspend mechanics: read-only flag vs key-revoke vs deployment-pause?**
*Recommendation:* v1 = push `pos_plan.suspended = true` (graceful, reversible, booth honours it). Defer deployment-pause (Convex-feature unknown).
*Why:* Reversibility for non-payment churn; a paused deployment may be hard to resume cleanly.

**Q5 — Does the control plane live in a separate repo (`frollie-platform/`) or a top-level package in this monorepo?**
*Recommendation:* Separate repo. It's a separate Convex project, separate Vercel target, separate audience; the shared `convex/` *data-plane* codebase is what tenants share, not the control plane.
*Why:* Keeps the plane boundary physical, prevents accidental data-plane↔control-plane imports.

**Q6 — Migration FE/BE skew across N tenants?**
*Recommendation:* Make all data-plane migrations additive-only (optional-add → backfill → enforce, Spec-1 pattern) so a brief BE-ahead-of-FE window is safe; reserve atomic-flip orchestration for unavoidable mutation↔action renames.
*Why:* Atomic FE+BE across N tenants is operationally heavy; additive migrations dodge the skew-fatal class entirely (CLAUDE.md §"Convex deployment").

**Q7 — When (if ever) do we trigger the hybrid escape hatch?**
*Recommendation:* Do NOT build it now. Document the trigger as "silo fan-out ops cost exceeds X engineer-hours/month at Y tenants" and revisit; keep data-plane scoping prefix-based so the switch stays cheap.
*Why:* YAGNI; the Spec-1 investment already survives the switch (ADR-053 Decision C).
