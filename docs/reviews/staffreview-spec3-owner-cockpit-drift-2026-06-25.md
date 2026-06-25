# Staff Review: Spec 3 — Owner Cockpit (drift reconciliation)

**Date:** 2026-06-25
**Plan:** `docs/superpowers/specs/2026-06-21-owner-cockpit-design.md` (design spec; no plan exists yet)
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ This is a design spec, not a plan — reviewed for **drift against shipped Specs 1/2/4** + implementation-readiness, per the user's request. No PLAN.md exists; that is the next pipeline step.

---

## 1. Summary

**Overall Assessment:** Revise (small, surgical) — then **implementation-ready**.

The spec is architecturally sound and the clone decision (copy/remap/skip table set) is correct. Its one weakness is **age**: it was written 2026-06-21, before Specs 1/2/4 executed, so it forward-references names that drifted. Every drift is a rename or a one-line schema fact, not a design flaw. Fix the four Criticals inline and the BE phase (`v13-be-cockpit-queries` = Streams C + E + F-backend) is ready to plan. Streams A/B/D are **FE-only downstream phases** (separate ROADMAP items, `/frontend-design`) — not this phase.

The highest-value catch is **Critical 4**: the table-ownership fence and the atomicity requirement, taken together, actually *simplify* the clone into a single transactional mutation and **dissolve OQ-2 entirely**.

---

## 2. Critical Issues (Must Fix before the plan is written)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Auth resolver renamed `requireOwnerSession` → `requireCockpitSession`; error names drifted | Security/Naming | §78, §109, §128, §211, all Stream C/E/F |
| 2 | `outlets.created_by` is a **required** field the create step omits | Schema | §216, §308–316 |
| 3 | Audit `source` is a **closed union** — adding `"cockpit"` is a 2-file code edit | Schema/Logic | §225, §301 |
| 4 | Clone-writer design (sequenced action) is non-atomic AND breaches the table-ownership fence | Architecture | §209, §214, §244, OQ-2 |

### Issue 1: Auth resolver + error-name drift
Spec gates every cockpit read/write on `requireOwnerSession` and tests for `NO_OWNER_SESSION`. Shipped (Spec 2):
- Resolver is **`requireCockpitSession`** (`convex/auth/sessions.ts:54`).
- Throws **`NOT_COCKPIT_SESSION`** / **`NO_SESSION`** / **`SESSION_IDLE_TIMEOUT`** — never `NO_OWNER_SESSION`.
- For action authChecks (the `createOutlet` action runs `"use node"`), use the bridge `internal.auth.ownerInternal._assertCockpitSession_internal` (the pattern `issueOwnerTelegramBindLink` uses, `convex/auth/ownerActions.ts:72`).

**Recommendation:** Global rename in the spec. Add an explicit note: `requireCockpitSession` proves `kind==="cockpit"` — confirm in the plan that cockpit sessions are minted **only** for owners (`_cockpitLoginCommit_internal` is reached only via owner OTP), so `kind==="cockpit" ⟹ role==="owner"`; if not guaranteed, cockpit readers must additionally assert `role==="owner"`.

### Issue 2: `outlets.created_by` is required
`convex/outlets/schema.ts:11`: `created_by: v.union(v.id("staff"), v.null())`. The spec's `_createOutletRow_internal` (§216) inserts `name, code, address?, geo?, timezone, active, created_at` only. The insert **fails the table validator** without `created_by`.

**Recommendation:** Pass `created_by: ownerStaffId` (resolved from the cockpit session). Backfilled default outlet uses `null`; owner-created outlets always carry the owner id. Add to the field-copy contract (§308).

### Issue 3: Audit `source` is a closed union
`convex/audit/schema.ts:14` and `convex/audit/internal.ts:8,35` define `source` as `v.union(v.literal("booth_inline"), "wa_approval", "telegram_approval", "system", "reaper")` + a matching TS type. `logAudit({ source: "cockpit" })` **fails the arg validator at runtime** until `"cockpit"` is added in **both** files. The spec (§225/§301) frames this as a SCHEMA.md doc note — the binding change is the two code edits; SCHEMA.md is just docs.

**Recommendation:** Add `v.literal("cockpit")` to the union (`schema.ts`) + the TS union type (`internal.ts:35`). Widening a union is additive/deploy-safe (cf. `[[convex-schema-field-removal-prod-block]]` — only *removals* block). List both files as explicit touch-points in the plan.

### Issue 4: Go atomic — one mutation via per-module helpers — and OQ-2 dissolves
The spec proposes the `createOutlet` **action** sequencing per-module internal mutations (catalog → settings → staff), which is **non-atomic across steps** → hence OQ-2's "partial-failure resume" anxiety. But `cockpit` is **not** in the `no-cross-module-db-access` ALLOWLIST (`eslint.config.js:160` = auth, idempotency, audit, seed, staff, _codes, migrations), so a single cockpit mutation can't raw-write other modules' tables either.

Both constraints resolve to the **same, simpler design**:

- One internal mutation `cockpit.outlets._createOutletAtomic_internal` that calls **plain V8-safe clone helpers physically located in each owning module's `lib.ts`** — e.g. `catalog/lib.ts::cloneCatalogRows(ctx, src, tgt)`, `settings/lib.ts::cloneSettingsRow(ctx, src, tgt, overrides)`. The raw `ctx.db` writes lexically live in the owning module's file (the fence is per-file → satisfied), but **execute inside ONE transaction** (atomic).
- Reuse the existing grant for staff access (see Improvement 1).
- The `createOutlet` **action** stays a thin `withActionCache` (`convex/idempotency/action.ts:43`) + `_assertCockpitSession_internal` authCheck wrapper that calls the one mutation.

Convex mutations are transactional → a crash mid-clone rolls back **all** writes (`[[convex-throw-rolls-back-mutation-writes]]`) → no half-built outlet, no taken-but-orphaned code. **OQ-2 evaporates.** Given Frollie's catalog (~5 products), this is strictly simpler and safer than the sequenced-action + resume design.

**Recommendation:** Lock atomic-single-mutation-via-owning-module-helpers. Drop the resumable-action path and the OQ-2 resume machinery. Keep the action only as the idempotency/auth shell.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Reuse existing internal readers/grants; don't invent new names | H | L |
| 2 | `listOutlets` needs a cockpit-plane sibling (not reuse) — but for the right reason | M | L |
| 3 | Stream F dashboard: per-outlet fan-out over new outlet-unscoped indexes | M | M |
| 4 | Cockpit ESLint-allowlist claim is false — and mostly unneeded | M | L |
| 5 | Cockpit sessions idle-timeout in 30 min — wire the keepalive | M | M |
| 6 | `getOwnerSession` doesn't exist — Stream A reuses `getSession` | L | L |

### Improvement 1: Reuse shipped internals
- **Staff-access grant:** spec §223 names `internal.staff._grantOutletAccess_internal`. Shipped is **`internal.auth.internal._grantOutletAccess_internal`** (used by `staff.grantOutletAccess`, `convex/staff/actions.ts:77`); `_revokeOutletAccess_internal` also exists (for the roadmap staff-matrix). For the atomic path, call its underlying logic from the clone mutation (or factor a shared `lib` helper). Dedup-on-existing already lives there.
- **Outlet enumeration:** `_listActiveOutlets_internal` + `_getDefaultOutlet_internal` already exist (`convex/outlets/internal.ts:52,42`). The switcher source + dashboard fan-out reuse them — don't write new scanners.

### Improvement 2: `listOutlets` — genuinely a new cockpit sibling
Existing `outlets.listOutlets` (`convex/outlets/public.ts:5`) is **`requireManagerSession`-gated** — a cockpit session is rejected with `NOT_BOOTH_SESSION` — and projects only `{_id, code, name, active}`, active-only. So a new `cockpit.outlets.listOutlets` (gated on `requireCockpitSession`, returns `address/timezone/created_at`, includes inactive) is **required**, not duplication. Flag the auth-plane reason in the plan so it isn't naively "reused."

### Improvement 3: Dashboard fan-out, not new indexes
`_fetchDayWindow_internal` / `computeDaySummary` are already per-outlet (`by_outlet_status_paid_at`, `convex/transactions/internal.ts:621,365`). For the consolidated landing, loop `_listActiveOutlets_internal` → call the existing per-outlet reader per outlet → aggregate in the cockpit query. N is tiny. This avoids adding outlet-unscoped indexes + the `eslint-disable index-leads-with-outlet_id` justifications the spec's `_dashboardAcrossOutlets_internal` would otherwise need. Document the choice; revisit only if outlet count grows large.

### Improvement 4: Strike the false allowlist claim
Spec §129/§340 claims "Spec 1 allowlisted `convex/cockpit/**`" for the outlet-scope fence. It did **not** (`OUTLET_FENCE_ALLOWLIST = ["migrations","seed"]`, `eslint.config.js:124`; `ALLOWLIST` has no cockpit). If the cockpit reads **only** via owning-module internal readers (ADR-034) and never defines/uses an outlet-scoped index directly (Improvement 3 ensures this), **neither fence fires** — no allowlist entry needed. Strike the claim; add an allowlist entry only if a concrete callsite trips a fence, preferring a line-level `eslint-disable` with justification (like the 16 existing exceptions in CLAUDE.md rule #26).

### Improvement 5: Wire the cockpit keepalive
Spec §11/§20 calls the cockpit session "durable." Spec 2 actually shipped a **30-min idle timeout** (`COCKPIT_IDLE_MS`, `SESSION_IDLE_TIMEOUT`) with `touchCockpitSession` (`convex/auth/public.ts:139`) **explicitly unwired** — its own comment says "ships with the Spec-3 dashboard." Stream A/F must ping `touchCockpitSession` (focus/interval) or owners are logged out mid-session. Reword "durable" → "sliding 30-min idle"; name the keepalive wiring as a Stream-A obligation. (FE — downstream phase, but it belongs in this program's scope note.)

### Improvement 6: Reuse `getSession` for the FE gate
Spec §78 invents `api.cockpit.session.getOwnerSession`. Shipped `getSession` (`convex/auth/public.ts:88`) already projects `kind` plane-agnostically. Stream A reuses it (gate on `kind==="cockpit" && role==="owner"`); no new `cockpit/session.ts` query. The spec even hedges "re-exported OR imported" — lock: import `getSession`.

---

## 4. Refinements (Optional)

- `staff_outlet_access.granted_by` is `v.union(v.id, v.null)` not `v.optional` (§322) — pass `granted_by: ownerStaffId` (never null for owner grants).
- Spec §290 + the "do not retrofit Task IDs" note reference the **retired** `docs/PROGRESS.md` board (retired 2026-06-25). Roadmap items live in `docs/ROADMAP.md`; progress is the CHANGELOG. Update the process note.
- OQ-5 (`geo` on `outlets`) is **resolved**: Spec 1 shipped `geo` + `timezone` on `outlets` (`convex/outlets/schema.ts`) — matches the wizard fields. Mark closed.

---

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `requireCockpitSession` | `convex/auth/sessions.ts:54` | cockpit query gate (V8) |
| `_assertCockpitSession_internal` | `convex/auth/ownerInternal.ts:145` | `createOutlet` action authCheck (node bridge) |
| `getSession` | `convex/auth/public.ts:88` | Stream A FE cockpit gate |
| `_listActiveOutlets_internal`, `_getDefaultOutlet_internal` | `convex/outlets/internal.ts:52,42` | switcher + dashboard fan-out |
| `_grantOutletAccess_internal` | `convex/auth/internal.ts` (via `staff.grantOutletAccess`) | clone access step |
| `_fetchDayWindow_internal`, `computeDaySummary` | `convex/transactions/internal.ts:621` | per-outlet dashboard reader |
| `_getSettings_internal(outletId?)`, `settingsRowForOutlet` | `convex/settings/internal.ts:33`, `public.ts:17` | settings read for clone |
| `withActionCache` | `convex/idempotency/action.ts:43` | `createOutlet` action idempotency |

### Potential duplication risks
- New `cockpit.outlets.listOutlets` vs existing `outlets.listOutlets` — **justified** (different auth plane + projection), not a dup. Document why.
- `_dashboardAcrossOutlets_internal` (spec) vs looping existing per-outlet readers — prefer the loop (Improvement 3).

---

## 6. Phase / Wave Accuracy

This phase (`v13-be-cockpit-queries`) covers **Streams C (query layer), E (clone mutation/action), F-backend (dashboard queries)**. Streams **A/B/D are FE-only** downstream ROADMAP phases (`v13-fe-cockpit-shell`, `-outlet-wizard`, `-cockpit-dashboards`). The plan should scope to BE and name the FE handoff (the `getSession` gate, keepalive wiring, wizard payload shape).

**Suggested BE wave map (for the plan):**
- Wave 1 (parallel): audit-source union edit · `cockpit/outlets.listOutlets` + `listAssignableStaff` · per-module clone helpers in `catalog/lib.ts` + `settings/lib.ts`.
- Wave 2 (barrier): `_createOutletAtomic_internal` (consumes the helpers) → `createOutlet` action wrapper.
- Wave 3: `cockpit/dashboard.ts` (consolidated + per-outlet, fan-out over `_listActiveOutlets_internal`).
- Shared/generated file: `convex/_generated/api.d.ts` regenerates once per wave on the merged tree; `convex/audit/{schema,internal}.ts` edited once (Wave 1) then read-only.

---

## 7. Specialist Agent Recommendations

| Work | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Whole BE phase | `convex-expert` | matches ROADMAP tag; clone + cross-outlet readers are Convex-shaped |
| Clone correctness review | `code-reviewer` | post-impl, the FK-remap is the bug-prone part |

---

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ⚠️ spec names `feat/v2-owner-cockpit`; plan will branch off synced `main` via pipeline worktree |
| Merge strategy | ✅ squash-PR (repo convention) |
| Rollback | ✅ §344 — route subtree + cockpit modules are independent; created outlets persist as real data |
| Deployment order | ✅ no schema **table** changes (Spec 1/2 own them); audit-union widening is additive |
| Migration safety | ✅ forward-only (creating outlets); no backfill in this spec |

Commit checkpoints: audit-union edit → cockpit queries → clone helpers+mutation → action → dashboard. One logical commit each.

---

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Audit | `docs/SCHEMA.md` — new verb `outlet.created`, new source `cockpit` |
| Clone/queries | `docs/API_REFERENCE.md` — `cockpit/*` functions |
| Ship | `docs/CHANGELOG.md` entry + remove cockpit-queries from `docs/ROADMAP.md` |
| Rules | `CLAUDE.md` — `convex/cockpit/` module row in the file-locations table |

### CHANGELOG draft
~~~markdown
## 2026-06-?? — v1.3.0 owner cockpit (backend)
- Owner-scoped, outlet-UNSCOPED cockpit query layer (`convex/cockpit/*`, `requireCockpitSession`-gated).
- `createOutlet` action (blank + clone) — single atomic mutation via owning-module helpers; idempotent, audited (`outlet.created`, source `cockpit`).
- Cross-outlet dashboard readers (consolidated + per-outlet), fan-out over active outlets.
~~~

---

## 10. Testing Plan Assessment

**Verdict:** Adequate (spec §247–256 is a solid list) — augment for the atomic design.

### Augment with
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | `created_by` stamped = owner staff id | Critical 2; insert would fail without it | assert on created row |
| 2 | Atomic rollback on mid-clone throw | proves OQ-2 is truly gone | force a throw after catalog copy → assert ZERO rows for target outlet (no outlet, no skus, no access) |
| 3 | Non-cockpit/booth session → `NOT_COCKPIT_SESSION` | Critical 1 (was `NO_OWNER_SESSION`) | rename assertion |
| 4 | Audit row carries `source: "cockpit"` | Critical 3 | parse `JSON.stringify` metadata (`[[v055-sku-admin-triple-simplify-lessons]]`) |

Existing list keeps: FK remap, photo `_storage` reuse-by-value, skip stock/txns, idempotent re-run same key, `OUTLET_CODE_TAKEN`, blank-mode no-catalog.

### Regression risk
- Audit-union widening: re-run the audit module tests; any exhaustive `source` switch must handle `"cockpit"`.
- `convex-test` uses a fresh DB → won't catch the `created_by`-required prod fact; the explicit test (1) is the guard.

---

## 11. Edge Cases to Address

- [ ] Cockpit session minted only for owners — confirm `kind==="cockpit" ⟹ owner`, else assert role in cockpit readers.
- [ ] Clone `code` collision with an existing outlet → `OUTLET_CODE_TAKEN` before any write (atomic mutation: re-check `by_code` first).
- [ ] Blank mode: `pos_settings` row inserted from wizard step-4 + read-time defaults (no source to copy).
- [ ] Owner skipped in `staff_outlet_access` grant (implicit access) — and dedup on re-run.
- [ ] Photos/receipt-logo `_storage` ids reused **by value** (same deployment) — annotate inline; rows diverge on later edit.
- [ ] Idle-timeout: cockpit dashboard pings `touchCockpitSession` (Stream A) or session dies at 30 min.

---

## 12. Approval Conditions

**To approve (fix inline in the spec before writing the plan):**
1. Critical 1 — rename `requireOwnerSession` → `requireCockpitSession`; error names; action authCheck via `_assertCockpitSession_internal`.
2. Critical 2 — add `created_by: ownerStaffId` to the create step + field contract.
3. Critical 3 — name the two audit-union code edits (`schema.ts` + `internal.ts`).
4. Critical 4 — lock atomic-single-mutation-via-owning-module-helpers; drop OQ-2 resume path.

**Recommended before implementation:**
1. Improvements 1–6 (reuse shipped internals; cockpit-sibling `listOutlets`; fan-out dashboard; strike false allowlist claim; keepalive note; reuse `getSession`).

**Readiness verdict:** With the four Criticals applied inline, **Spec 3's backend (this phase) is implementation-ready.** No plan exists yet — writing it is the next pipeline step. The FE streams (A/B/D) are separately-planned downstream phases.

---

*Generated by /staffreview*
