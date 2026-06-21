# Staff Review: Multi-tenancy foundation (data plane) — Spec 1

**Date:** 2026-06-21
**Spec:** `docs/superpowers/specs/2026-06-21-multi-tenancy-foundation-design.md`
**ADR:** `docs/ADR/051-multi-outlet-tenancy-silo.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Spec Structure:** ✅ Validated (spec, not plan — has Identity, Architecture, Schema, 9 Workstreams w/ per-stream Tests, Migration/Rollback, Open questions)
**Verified against:** worktree `plan/v2.0-multi-outlet-foundation` (= origin/main v1.2.1 445e286 + docs-only drafts)

---

## 1. Summary

**Overall Assessment:** Revise (then approve)

The spec is unusually strong: session-derived scoping, prefix-leading indexes, a lint fence mirroring `no-cross-module-db-access`, and a three-step optional→backfill→enforce migration are all the right calls and grounded in house convention. Helper names, the PR #124 hotfix retirement targets, the eslint OWNERSHIP map, and the absence of a `migrations/` module were all verified present/accurate.

Two **Critical** gaps block approval: (C1) `pos_settlements` is entirely unaccounted-for in the table inventory — the pre-planning inventory re-verification the brief asked for; and (C2) only one of **three** `staff_sessions` writers gets `outlet_id`. Five Improvements correct concrete code-name drift and a migration-sequencing collision with ADR-003.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | `pos_settlements` unclassified — missing from both the scoped list and the exclusion list | Schema/Inventory | Stream 2 table, "DO NOT get outlet_id" list, Stream 9 backfill |
| C2 | Missed session-writers: `managerTakeover` + `seed` also insert `staff_sessions` | Logic/Migration | Stream 6 |

### Issue C1: `pos_settlements` is unaccounted for in the operational-table inventory

The brief's explicit pre-planning check. Live schema has **35** `defineTable`s. The spec scopes 23 + `pos_receipt_counters` (re-key) = 24, and excludes 10 (`staff`, `audit_log`, 3× `api_*`, `pos_idempotency`, `pos_device_activation_attempts`, `telegram_log`, `telegramUpdates`, + `telegramChats` deferred). 24 + 10 = **34**. The 35th — **`pos_settlements`** (v0.7, `convex/settlements/schema.ts`) — appears nowhere: not scoped, not re-keyed, not excluded. Stream 9's "for every operational table, set `outlet_id`" backfill is therefore ambiguous about it.

**Nature of the table (verified):** one row per settlement *day*, keyed `settle-YYYY-MM-DD`, sourced from the nightly Xendit `GET /transactions` poll or a manager manual entry, aggregating gross/MDR/net for the **whole deployment**. Xendit settles to **one merchant bank account per deployment** (`bca_account_destination`) and knows nothing about outlets — settlement is matched per-txn on `reference_id`, then aggregated.

**Recommendation:** classify `pos_settlements` **business-level (no `outlet_id`)** and add it to the "DO NOT get outlet_id" list with that rationale. `settlement_key` stays `settle-YYYY-MM-DD` (no outlet prefix). Per-outlet payout *attribution*, if the owner cockpit ever needs it, is a **derived join** (settled `pos_transactions` already carry `outlet_id`), not a column on the aggregate — note as a cockpit-spec concern. Stream 9 backfill must then skip it (the exclusion list becomes the authoritative backfill filter). **Decision surfaced to user.**

### Issue C2: `outlet_id` threaded through only one of three `staff_sessions` writers

Stream 6 stamps `outlet_id` in `_loginCommit_internal` (auth/internal.ts:274). But `grep insert("staff_sessions")` finds **three** writers:
- `_loginCommit_internal` — auth/internal.ts:274 ✅ (spec covers)
- **`managerTakeover`** — auth/internal.ts:613 ❌ (business rule #23 escape hatch; "mirrors `_loginCommit_internal` shape")
- **`seed`** — seed/internal.ts:242 ❌ (allowlisted, but seeds the default-outlet fixtures)

After Step 3 (enforce), a session inserted without `outlet_id` is a schema violation, and any `requireSession` on it throws `SESSION_NO_OUTLET`. A manager takeover (the one path used precisely when the original staff is unavailable) would break.

**Recommendation:** Stream 6 must sweep **all three** writers. `managerTakeover` resolves the device's `outlet_id` (same `registered_devices` lookup as login) and stamps it + the `_assertStaffHasOutletAccess_internal` check (owner/manager bypass per Decision C). `seed` stamps the seeded default outlet. This is the "canonical-writer sweep" lesson — name all writers in the plan's task list.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | Correct receipt-helper name; note inline formatting | H | L |
| I2 | `pos_transactions.by_receipt_number` unaddressed | M | L |
| I3 | `staff_sessions.by_device_active` subsumed but not declared dropped | M | L |
| I4 | Migration sequencing collides with ADR-003 (no auto-logout) | H | M |
| I5 | Wrong retired audit verb name | L | L |

### Improvement I1: Receipt mint helper — wrong name, formatting is inline

Spec (Stream 4, ~line 226) names `_nextReceiptNumber_internal`. The real helper is **`_allocateReceiptNumber_internal`** (`convex/transactions/internal.ts:80`), an `internalMutation` that both allocates `next_number` *and* formats the string — `return \`R-${year}-${String(n).padStart(4,"0")}\`` at line 96. So outlet-prefixing is one edit to this function: take `outletId`, re-key the counter read/insert to `[outlet_id, year]`, resolve the code via `outlets.internal._requireOutletCode_internal`, and change the template to `R-${code}-${year}-${NNNN}`. **Fix:** correct the name and state the formatting is inline (no separate formatter exists).

### Improvement I2: `pos_transactions.by_receipt_number` not classified

`pos_transactions` has **both** `by_receipt_token` *and* `by_receipt_number` (schema.ts:53-54). Stream 2 only says "keep `by_receipt_token`"; Stream 8's GLOBAL_UNIQUE allowlist also omits `by_receipt_number`. With the outlet code embedded, the formatted `receipt_number` string stays **globally unique** (`R-PKW-2026-0001` ≠ `R-BLKM-2026-0001`). **Fix:** keep `by_receipt_number` as a GLOBAL_UNIQUE lookup and add it to the Stream-8 allowlist (the row still carries `outlet_id` for post-read assertion).

### Improvement I3: `staff_sessions.by_device_active` subsumed but undeclared

Current indexes: `by_staff_active [staff_id, ended_at]`, `by_device_active [device_id, ended_at]`. Stream 2 proposes `by_outlet_device_active [outlet_id, device_id, ended_at]` and says "keep `by_staff_active`" — silent on `by_device_active`, which the new index fully subsumes. **Fix:** state `by_device_active` is dropped in Step 3 *after* its readers (device-session lookups, awaiting-payment recovery) migrate to the scoped variant — same add-new→migrate→drop discipline the spec already mandates.

### Improvement I4: Migration sequencing collides with ADR-003 (no auto-logout)

Sessions never auto-expire (ADR-003), so **old active sessions with no `outlet_id`** exist during the Step-1→Step-2 optional window. `requireSession` typed to return required `outlet_id` + a hard `SESSION_NO_OUTLET` throw (spec line 250), plus `getSession`'s new `outlet_label` lookup via `_getOutlet_internal(outlet_id)`, would **throw for every currently-logged-in staff** at the Step-1 deploy, before backfill runs. **Fix:** (a) backfill active `staff_sessions` early in Step 2; (b) keep `requireSession`/`getSession` *tolerant* of absent `outlet_id` during the window — type it `Id<"outlets"> | undefined`, resolve to the single default outlet as a fallback, and only flip to the required type + hard `SESSION_NO_OUTLET` throw at Step 3 (enforce). Add this to Stream 5 + Stream 9 explicitly.

### Improvement I5: Wrong retired audit verb

Stream 9 (line 417) says retire the `settings.outlet_device_set` audit verb. The actual verb is **`staff.setOutletDevice`** (`convex/staff/public.ts:288`). **Fix:** name the right mutation (`staff.setOutletDevice` + its `_setOutletDevice_internal`) in the retirement list. (Historical rows stay — audit is append-only; only "no new rows" matters.)

---

## 4. Refinements (Optional)

- **R1:** `requireManagerSession` actually returns `{staffId, deviceId}` (no `role`) — spec's "same shape minus nothing" is loose; just add `outlet_id` to its return.
- **R2:** The idempotency outlet-prefix (Stream 5) is orthogonal to the documented `pos_idempotency` action→mutation distinct-key hazard (shared `key` namespace) — fine, but note it so the planner doesn't assume the prefix solves chaining.

---

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `no-cross-module-db-access` rule + OWNERSHIP map | `tools/eslint-rules/`, `eslint.config.js:40` | Structural template for `index-leads-with-outlet_id` (Stream 8) — confirmed present |
| `_getSettings_internal` (internalQuery) | `convex/settings/internal.ts:31` | Add `outletId` param; defaults pattern preserved |
| `_allocateReceiptNumber_internal` | `convex/transactions/internal.ts:80` | The one receipt edit point (see I1) |
| `_getSettings_internal` defaults pattern | settings | Mirror for per-outlet absent-row defaults |

No harmful duplication. The spec correctly reuses existing internal-API + lint-fence patterns rather than inventing new ones.

## 6. Phase / Wave Accuracy

9 workstreams; dependency order is sound (Stream 1 outlets → 2 schema → 3 access → 4 singletons → 5 scoping → 6 device-bind → 7 login FE → 8 fence → 9 migration). Deploy ordering (Step 1 optional + new indexes → write `outlet_id` → backfill → Step 3 enforce + drop) respects the deploy-skew rule. **One adjustment:** Stream 5 + 9 must carry the I4 tolerant-window handling explicitly.

## 7. Specialist Agent Recommendations

| Work | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Schema threading + index restructure (Stream 2) | `convex-expert` | 24 tables, index discipline |
| Migration backfill (Stream 9) | `convex-expert` | batched paginate, idempotent |
| Login FE (Stream 7) | `frontend-integrator` | useSession/login.tsx wiring |
| Lint fence (Stream 8) | `general-purpose` | AST rule + fixtures |

## 8. Git Workflow Assessment

Spec targets `feat/v2.0-multi-outlet-foundation`. Multi-deploy migration → atomic `npm run build` → `convex deploy` (Step 3 only). Rollback documented (Steps 1-2 additive/idempotent; Step 3 the one-way door, gated on a zero-nulls verification query). ✅ sound.

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Schema | `docs/SCHEMA.md` (outlet_id, new tables, index renames), `CLAUDE.md` (business rule for outlet scoping + the new lint fence) |
| ADRs | ADR-051 status → Accepted on land; amend ADR-003/031/039/034 notes |
| Close | `CHANGELOG.md` |

## 10. Testing Plan Assessment

**Verdict:** Adequate. Each workstream lists targeted tests (outlet uniqueness, cross-outlet denial, `SESSION_NO_OUTLET`, two-outlet receipt sequences, roster filter, activation binding, lint-fence fixtures + scratch-injection liveness). **Add:** (a) a `managerTakeover` test asserting the takeover session carries `outlet_id` (C2); (b) a migration test asserting the backfill **skips** `pos_settlements`/`audit_log`/`api_*` (C1); (c) an old-active-session tolerance test for the optional window (I4).

## 11. Edge Cases to Address

- [ ] Old active session (no outlet_id) survives Step-1 deploy (I4)
- [ ] `managerTakeover` session carries outlet_id (C2)
- [ ] `pos_settlements` excluded from backfill (C1)
- [ ] `by_receipt_number` lookup still resolves cross-outlet (I2)
- [ ] Single-outlet auto-bind at activation (spec covers; keep test)

## 12. Approval Conditions

**To approve, address:** C1 (settlements classification), C2 (all three session writers).
**Recommended before planning:** I1–I5.
**Surface to user (Open Questions + C1):** see §13.

---

## 13. Open Questions surfaced to user (spec OQ1-6 + C1)

| Ref | Question | Recommendation |
|-----|----------|----------------|
| C1 | `pos_settlements` scoping | **Business-level (no outlet_id)** |
| OQ1 | `outlet_id` type | **`v.id("outlets")` (real FK)** |
| OQ2 | `audit_log` scoping | **Shared log + optional `outlet_id` context field** |
| OQ3 | `staff_outlet_access` module | **`auth/`** (apply rec) |
| OQ4 | Pre-auth activation outlet source | **Telegram pre-assign + single-outlet auto-bind** |
| OQ5 | `pos_idempotency` outlet | **Client key prefix, no column** (apply rec) |
| OQ6 | Drop old indexes in Step 3 | **Drop subsumed; keep GLOBAL_UNIQUE** (apply rec) |

OQ3/OQ5/OQ6 are low-stakes → applying recommendations. C1, OQ1, OQ2, OQ4 surfaced for explicit decision.

---

*Generated by /staffreview*
