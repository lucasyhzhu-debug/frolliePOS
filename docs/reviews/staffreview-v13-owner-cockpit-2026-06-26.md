# Staffreview — v1.3.0 Owner Cockpit (Spec 3)

**Reviewer lens:** Deep-Module Architecture (Staff/Principal) — ADR-034 fidelity, interface cost, Frollie Pro graft integrity.
**Branch:** `v13-owner-cockpit` · **Diff:** `e4717b1..14c127c` (16 commits) · **Date:** 2026-06-26

## Summary

**Verdict: this makes the module graph DEEPER, not shallower.** The new `convex/cockpit/` is a genuinely deep module — a narrow public surface (3 outlet functions + 2 dashboard queries), it **owns zero tables**, and it makes **zero raw `ctx.db` calls against any table** (verified across `outlets.ts` + `dashboard.ts`). All cross-outlet complexity is hidden behind: (a) owning-module plain helpers (`cloneCatalogRows`, `cloneSettingsRow`/`seedSettingsRow`, `grantOutletAccessRow`, `getOutletByCode`/`insertOutletRow`), and (b) existing internal readers (`_listActiveOutlets_internal`, `_fetchDayWindow_internal`, `_listAssignableStaff_internal`). The clone is one atomic mutation (resolves OQ-2). This is textbook ADR-034.

The controller's headline deviation — routing `outlets`-table access through a new `convex/outlets/lib.ts` instead of the plan's literal `ctx.db.insert("outlets")` — **was the correct call**. `cockpit` is *not* in the `no-cross-module-db-access` ALLOWLIST (`["auth","idempotency","audit","seed","staff","_codes","migrations"]`), and `outlets` is owned by the `outlets` module. The plan's draft code (`ctx.db.query("outlets")` inside `listOutlets`) would have failed the fence. The plain-helper-in-owning-module pattern is moreover *forced*, not stylistic: `_createOutletAtomic_internal` is a mutation, and Convex mutations cannot `runMutation`/`runQuery`, so every cross-table write inside the single transaction must be a plain V8-safe helper that executes lexically in the owning module's file. Allowlisting `cockpit` (the alternative) would have permanently weakened the fence for *all* future cockpit code — rightly rejected.

No Critical issues. One Important issue (idempotency-contract drift between code and `API_REFERENCE.md`), plus a handful of Improvements/Refinements below. Graft integrity to Frollie Pro is intact: no `api/v1/` surface change, no schema mirroring, photo reuse is intra-deployment by `_storage` id.

## Critical Issues

None.

## Improvements

### I1 (Important) — Idempotency contract drift: doc claims a `withIdempotency` wrap that does not exist; crash-window gap

`docs/API_REFERENCE.md` states `_createOutletAtomic_internal` is *"Single writer. Wrapped by `withIdempotency`."* It is **not** — the internalMutation takes no `idempotencyKey` arg and has no wrap. Idempotency lives only at the action layer (`createOutlet` → `withActionCache`, ADR-046 auth-before-lookup, which is correct).

The consequence is the exact window `withActionCache`'s own doc-comment warns about: if `createOutlet` crashes **after** the inner `_createOutletAtomic_internal` commits but **before** the action cache is written, a retry (same `idempotencyKey`) re-runs `fn()`, misses the never-written cache, and calls the inner mutation again → it throws `OUTLET_CODE_TAKEN` (the code is now taken by the first, committed run). The caller sees a confusing error for an outlet that *was* created. The established pattern (documented in `withActionCache`) is to pass `${key}:commit` to the inner `runMutation` and wrap the inner mutation with `withIdempotency`, so the second inner call short-circuits to the original `{ outlet_id }`.

**Severity is bounded, not data-corrupting:** the `OUTLET_CODE_TAKEN` dup-guard plus the all-or-nothing transaction guarantee that the worst case is "one outlet created + a misleading error toast on a rare retry," never a duplicate outlet. The FE also helps — the wizard uses `useIdempotency` and only `clearIntent`s (rotates the key) on success, so ordinary retries reuse the key and hit the action cache once it's written.

**Fix (pick one):**
1. Make the doc true: add `idempotencyKey` to `_createOutletAtomic_internal`, wrap it with `withIdempotency`, and pass `${args.idempotencyKey}:commit` from the action's inner `runMutation`. This closes the crash window per the canonical dual-cache discipline.
2. Or accept the dup-code guard as the idempotency boundary, **correct `API_REFERENCE.md`** to say so, and add a one-line code comment that the `OUTLET_CODE_TAKEN` guard (not a `withIdempotency` wrap) is what makes the inner mutation safe to re-enter.

Given the team's own lessons (`idempotency-shared-key-collision`, the `withActionCache` dual-cache note), option 1 is the more consistent landing; at minimum the doc must stop asserting a wrap that isn't there.

### I2 — Dashboard double fan-out + sequential per-outlet scan

`consolidatedSummary` and `perOutletSummary` each independently fan out over all active outlets, calling `_fetchDayWindow_internal` once per outlet (sequential `await` in a `for` loop). The cockpit landing subscribes to **both**, so the cross-outlet day-window scan — and its reactive read-set — runs **twice**. `consolidatedSummary` is almost entirely derivable from `perOutletSummary` (the only extra is `refundTotal`, which `perOutletSummary` omits).

At the realistic scale (1–3 outlets) this is fine and not worth blocking on. But the redundancy is real and cheaply removed:
- Add `refundTotal` to each `perOutletSummary` row and compute the consolidated card client-side with a `reduce`, dropping `consolidatedSummary` entirely; **or** have a single query return `{ consolidated, perOutlet }` so the fan-out happens once.
- Independently, parallelize the per-outlet loop with `Promise.all` over the `runQuery` calls.

Flag as a scaling watch-item: both the work and the reactive invalidation surface grow linearly with outlet count and double via the two-subscription split.

### I3 — `provision_managers_chat` is a dead parameter

The flag is accepted by the action, threaded into `_createOutletAtomic_internal`, and recorded in the `outlet.created` audit metadata — but it has **no effect**; no Telegram `managers` chat is provisioned. It currently reads as implemented while being a no-op. Either wire it (provision/bind a per-outlet `managers` chat per Spec-4 routing) or drop it from the surface until that work lands (YAGNI). A threaded-but-inert boolean is interface cost with no behavior behind it.

## Refinements

### R1 — `as any` on `ctx.db.insert` in `settings/lib.ts`

`cloneSettingsRow`/`seedSettingsRow` insert with `as any` (the spread-copy of `...base, ...overrides`). This defeats the static validator typing on the insert and, per the team's own `delegated-test-sweep-both-gates` lesson, `as any` is exactly the shape that passes `tsc` but can fail at runtime. Runtime Convex schema validation still catches a bad shape in tests, so the risk is low — but prefer building a typed insert object (or a `Doc<"pos_settings">`-derived partial) so a future schema change to `pos_settings` surfaces as a type error here rather than only at insert time.

### R2 — `listAssignableStaff` includes owners

`_listAssignableStaff_internal` returns all active staff including `role: "owner"`. Granting an owner `staff_outlet_access` is a redundant no-op (owners bypass access, Spec 1 / ADR-052). The atomic mutation already skips the requesting owner, but a *second* owner selected in the wizard would get a harmless dead row. Consider filtering `role === "owner"` out of the assignable list to keep `staff_outlet_access` honest.

### R3 — Pure-lib cross-module import is fine but uncodified

`dashboard.ts` imports the pure `computeDaySummary` from `transactions/lib`. This is acceptable and consistent with existing pure-helper sharing (e.g. `refunds/lib`, `audit`'s `logAudit`), and the data it operates on crossed the boundary through the proper `_fetchDayWindow_internal` reader. Worth noting only that the `no-cross-module-db-access` fence governs `ctx.db` ownership, not pure-function imports — so this class of cross-module coupling is enforced by convention, not CI. No change required.

## Things verified as correct (positive notes)

- **`grantOutletAccessRow` refactor is behavior-preserving.** Original `_grantOutletAccess_internal` returned early (no audit) on an existing row and audited only on insert; the refactor preserves exactly that (`if (created) logAudit`). `now` is still `Date.now()` at the internal-mutation layer (ADR-031). Test `grant-access-helper.test.ts` covers the dedup.
- **`cloneCatalogRows` fix (commit bc00e07) is right** — counting real inserts (not source `.length`) and cloning active-only rows; the dangling-FK `continue` makes the component count honest.
- **`cockpit` is fully fence-clean** — zero raw `ctx.db` on any table; all writes via owning-module helpers executing in their own files; `logAudit` (allowlisted `audit`) imported per the sanctioned ADR-034 audit pattern.
- **Graft integrity preserved** — no `convex/api/v1/` change, no Frollie-Pro schema mirroring, `outlets` is POS-owned, photo `_storage` id reused by value within the single deployment. Nothing here makes the v1.1+ cross-deployment integration harder.
- **Atomicity** — single transactional mutation; dup-code guard runs before any write; any throw rolls back all inserts (verified by the `OUTLET_CODE_TAKEN`/`SOURCE_OUTLET_REQUIRED` tests).
- **Plan fidelity** — all 12 tasks landed; the lone deviation (outlets access via `outlets/lib.ts`) is documented in the code header and is the architecturally superior choice over allowlisting `cockpit`.

## STAFFREVIEW FINDINGS

### Critical
None.

### Important
- **I1 — Idempotency drift.** `API_REFERENCE.md` claims `_createOutletAtomic_internal` is `withIdempotency`-wrapped; it is not. Idempotency is action-only (`withActionCache`), leaving the crash-after-commit/before-cache-write window unprotected — a retry throws `OUTLET_CODE_TAKEN` instead of returning the cached `{ outlet_id }`. Bounded (dup-guard + atomic txn prevent duplication; worst case is a misleading error on a rare retry) but it diverges from the documented dual-cache discipline. Fix: wrap inner + pass `${key}:commit`, OR correct the doc and assert the dup-guard as the idempotency boundary in a comment.

### Minor
- **I2 — Dashboard double fan-out.** `consolidatedSummary` + `perOutletSummary` each fan out over all active outlets; the landing subscribes to both → 2× cross-outlet scan + reactive read-set. Consolidated is derivable from per-outlet (add `refundTotal`, reduce client-side) or merge into one query; also `Promise.all` the sequential per-outlet loop. Fine at 1–3 outlets; scaling watch-item.
- **I3 — `provision_managers_chat` dead parameter.** Threaded + audited but no chat is provisioned. Wire it or drop it.

### Nitpick
- **R1 — `as any` insert** in `settings/lib.ts` defeats validator typing (team's own "passes tsc, fails runtime" lesson). Prefer a typed insert object.
- **R2 — `listAssignableStaff` returns owners**; granting an owner outlet access is a redundant no-op row. Filter `role === "owner"`.
- **R3 — pure `computeDaySummary` cross-import** from `transactions/lib` is fine/consistent but enforced by convention, not the (ctx.db-only) fence. No action.

## STAFFREVIEW COMPLETE
