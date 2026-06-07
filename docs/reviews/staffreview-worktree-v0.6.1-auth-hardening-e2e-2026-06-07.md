# Staffreview — v0.6.1 admin-action auth hardening + e2e un-skip

**Date:** 2026-06-07
**Reviewer:** senior-engineer architectural pass (ADR-034 lens)
**Base:** `0f6bd17` · **Head:** `d4b8b22`
**Scope:** Wave A (`withActionCache` required pre-cache authCheck + 8 wired actions + ADR-046) and Wave B (6 e2e specs un-skipped + seed stable test IDs).

---

## Summary

**Verdict: this change makes the affected modules MARGINALLY DEEPER, and at worst unchanged — no module was made shallower.**

`withActionCache` gained one required parameter (`authCheck`), but that parameter encodes a *security invariant the helper previously left to chance*. A deep module hides decisions behind its interface; the prior `withActionCache` hid the cache lookup but left the auth ordering to each caller's discretion — and every caller got it wrong identically (auth ran inside the cached body, after the lookup). Promoting `authCheck` to a required, positionally-first argument moves the "auth-before-cache" decision *inside* the helper's contract. The interface widened by exactly one parameter; the guarantee it now enforces is worth far more than one parameter of cognitive cost. This is the textbook "forced safety contract" widening, not a shallow leak.

`assertManagerSessionInAction` lands in `auth/verifyPin.ts` and is imported by 5 other modules' actions. That is a *sanctioned foundational-module import* under ADR-034 §"Cross-module patterns" (the `auth`/`idempotency`/`audit` allow-list) — the same pattern `verifyManagerPinOrThrow` already established in v0.5.3b. No new cross-module **table** reach was introduced; `verifyPin.ts` reaches only into `auth/internal._resolveSessionRole_internal`, which is same-module. Graft integrity is intact — nothing here touches the `convex/api/v1/` surface or couples POS internals to Frollie Pro's shape.

Plan fidelity is high. The one documented deviation (plan said 7 actions, impl wired 8 by adding `auth.resetStaffPin`) is the architecturally **correct** call and is the only such gap. Wave B un-skipped all 6 specs against three evidenced root causes, with the seed change correctly gated dev-only behind the existing prod-slug guard.

No Critical issues. A handful of Minor/Nitpick refinements below.

---

## Critical Issues

None.

The replay gap that motivated ADR-046 is real and is now closed with a regression test (`actionCacheAuth.test.ts`) that exercises the red state (staff-session replay of a spent key), the cache-hit-skips-PIN path, and the ended-session parity case. The fix mirrors the mutation-side ordering in `idempotency/internal.ts` exactly.

---

## Improvements (Important)

### I1 — Resolution-parity is a hand-maintained invariant with only a partial test guard

ADR-046 §Consequences and the `assertManagerSessionInAction` docblock both state the pre-cache gate "must accept exactly the session set `verifyManagerPinOrThrow` accepts." Today that parity holds:

- `assertManagerSessionInAction` → `_resolveSessionRole_internal` → rejects if `session.ended_at != null` OR `!staff.active` OR `role !== "manager"`.
- `verifyManagerPinOrThrow` → `getSession` (rejects ended) + `_getStaffPinHash_internal` (rejects `!active || role !== "manager"`).

These are two **independent** resolution paths that happen to agree. The test (`actionCacheAuth.test.ts`) proves parity for the *staff-role* and *ended-session* cases, but not for the `staff.active === false` case, and nothing structurally prevents the two paths from drifting if one query's predicate changes. This is the classic "two writers, one invariant" smell the codebase has hit before (per the v0.5.5 SKU-admin lesson: multi-writer drift → canonical helper).

Not blocking — the invariant holds today and the docblock flags it loudly. But the cleanest long-term shape is for `verifyManagerPinOrThrow` to **call** `assertManagerSessionInAction` (or a shared `_resolveManagerSession` helper) as its front-half rather than re-deriving the manager check via a different query. That would collapse the parity from "two paths that must agree" to "one path." Worth a follow-up issue; see also R1 below for why I do *not* recommend folding the whole thing the other way.

### I2 — `_e2eFixtureIds_internal` is dev-only by convention, not by guard

`_e2eFixtureIds_internal` is an `internalQuery`, so it is not client-reachable (Convex enforces this) and cannot be called from the `api.*` surface — that is the right primary defense and it is correctly noted in the docblock ("INTERNAL — not exposed via api.*"). It reads three IDs (manager session, voucher, manager staff code) that are already low-sensitivity and only meaningful in a freshly-seeded dev deployment.

However, unlike `seed/actions.ts::reset` — which carries an explicit `KNOWN_PROD_SLUG` deny-list guard — `_e2eFixtureIds_internal` has **no deployment guard**. On prod it would simply fail to find the seeded "Lucas" manager and throw, so the practical blast radius is nil. But the asymmetry is worth noting: the rows it surfaces (an *active manager session ID* + a voucher ID) are exactly the credentials the offline spec then feeds to a real `archiveVoucher` mutation. If a future refactor ever made this query callable in a context where a real manager session existed on a non-dev deployment, it would hand out a live session ID. Recommend either (a) a one-line prod-slug guard mirroring `reset`, or (b) a comment explicitly stating it relies on "no seeded Lucas on prod" as its safety property. Minor, because `internalQuery` + no-seed-on-prod already covers it.

---

## Refinements (Minor)

### M1 — `withActionCache` parameter ordering: `authCheck` before `fn` is correct, but consider an options object

The helper now has signature `(ctx, params, authCheck, fn)`. Two bare callbacks in positional sequence is mildly error-prone — a caller could swap them and TypeScript would not catch it (both are `() => Promise<...>`, and `authCheck`'s `Promise<void>` is assignable-from any `fn` return at the call boundary in practice). The current call sites are all correct and the inline comment (`// ADR-046: runs BEFORE cache lookup`) helps. If this helper grows a third callback or any caller ever mis-orders, fold `authCheck`/`fn` into a named-field object. Not worth churning now for 8 correct call sites.

### M2 — Error-name migration (`NOT_MANAGER` → `MANAGER_SESSION_REQUIRED`) is a semantic improvement but a contract change for any FE that string-matches

The pre-cache gate now throws `MANAGER_SESSION_REQUIRED` where a staff caller previously got `NOT_MANAGER` from inside the body. The changePin test and the docblocks were updated, and the new error is genuinely more precise (it fires on *session* invalidity before any PIN consideration). Confirm no frontend toast/error-mapping switch still keys on `NOT_MANAGER` for these 8 actions — `NOT_MANAGER` is still thrown by `verifyManagerPinOrThrow` for the in-body path, so both literals now coexist and a FE handler should tolerate both. (I did not find a FE matcher in scope; flagging for the wave-verification pass.)

### M3 — Offline-voucher spec leans on real-time `waitForTimeout(1_000)` + out-of-process CLI calls

`voucher-offline.spec.ts` does two `execSync("npx convex run …")` calls plus a fixed `waitForTimeout(1_000)` to let `useCatalogCache` flush to IDB. The 60s test timeout accommodates this, and the loud `expect(...).toBeTruthy()` guards prevent the old false-green. This is acceptable for the inherently cross-process race the spec models (offline apply vs out-of-band manager archive), but the fixed 1s catalog-flush wait is a latent flake source on a slow CI runner. Prefer waiting on an observable signal (e.g. the voucher appearing in a cached-list affordance) over a wall-clock sleep when this next gets touched.

### M4 — `_reset_internal` now inserts an active session + voucher unconditionally on every reset

The seed mutation always inserts a `staff_sessions` row for Lucas and an `OFFLINE10` voucher. This is correct for the e2e fixture and the tables are wiped first, so it is idempotent across resets. Worth noting it slightly broadens what "seed" *means* — the dev seed now ships a pre-authenticated manager session, not just catalog/staff data. That is exactly what the offline spec needs (and is documented), but anyone reasoning about "a fresh dev deployment has no live sessions" should know this is no longer true. The docblock covers it; calling it out for the seed-shape memory.

---

## Nitpick

### N1 — ADR-046 is terse (29 lines) relative to peer ADRs

ADR-046 is correct and cites the exact line numbers it mirrors (`idempotency/internal.ts` lines 57–63), which is excellent for a forward reader. It omits an "Alternatives considered" section — specifically *why* the auth wasn't folded into `verifyManagerPinOrThrow` (the R1 question below). One sentence would close the loop for the next reader who asks the same thing. Not required; the decision is sound regardless.

### N2 — `_e2eFixtureIds_internal` finds the manager by `name === "Lucas"`

Resolving the seeded manager by display name (`name === "Lucas"`) couples the e2e fixture to a mutable display field rather than the stable `staffCode` the codebase otherwise treats as the durable identifier (ADR-034 §"Stable string identifiers"). It is test-only and the seed controls the name, so this is harmless, but `role === "manager" && active` alone (the seed creates exactly one) or a code lookup would be marginally more robust to a seed rename.

---

## Focus-area findings (per review brief)

1. **Deep-module discipline (ADR-034).** The required `authCheck` param widened the `withActionCache` interface *appropriately* — it's a forced safety contract, not a shallow leak (the helper now owns the auth-before-lookup ordering decision instead of trusting 8 callers). `assertManagerSessionInAction` in `auth/verifyPin.ts` is the right module: it's a foundational-module (`auth`) helper consumed via sanctioned cross-module import, identical to the established `verifyManagerPinOrThrow` pattern. **No new cross-module internal reach** — `verifyPin.ts` → `auth/internal._resolveSessionRole_internal` is same-module; `_resolveSessionRole_internal` predates this change (v0.5.3a). Confirmed clean.

2. **Seed change / `_e2eFixtureIds_internal`.** Does not widen a client-facing surface — it's an `internalQuery`, Convex-enforced unreachable from `api.*`. Dev-only by the no-seed-on-prod property rather than an explicit guard (see I2). No meaningful information leakage: the IDs are seed-deterministic and only live on a freshly-reset dev deployment.

3. **Graft integrity.** Nothing here touches `convex/api/v1/`, no Frollie-Pro shape coupling, no `Id<>` leaking to an external surface. Auth/idempotency changes are POS-internal-only — the externally-facing idempotency model (ADR-034 §Related: `Idempotency-Key` header) is untouched. Graft stays clean.

4. **Plan fidelity.** Matches the v0.6.1 PROGRESS block and plan intent (close auth-before-cache gap; un-skip 6 specs evidence-gated by C1/C2/C3). The 7→8 deviation (adding `auth.resetStaffPin`) is **the right call**: `resetStaffPin` is a PIN-gated admin action behind `withActionCache` with the same replay exposure; excluding it would have left the gap half-closed. The C3 "submit-disable repro + fix" task was satisfied **spec-side only** (root cause was `.fill()` racing the Radix Select close, not the qty normalizer or any product disable-gate) — correctly resisting a product-code change the evidence didn't justify.

5. **Over/under-engineering.** The contract is near-minimal. The one cleaner shape — folding the auth into `verifyManagerPinOrThrow` so callers pass nothing — was correctly *rejected*: the PIN verify (argon2) must stay *inside* the cached body so a legit retry skips it ("cache hit skips PIN"), while the session assert must run *before* the lookup. Those are two different points in the cache lifecycle, so they cannot be the same call. The split (cheap assert before, expensive PIN-verify inside) is the correct decomposition, and the cache-hit-skips-PIN test pins it.

---

## STAFFREVIEW COMPLETE
