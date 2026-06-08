# Staff Review: v0.7 — Xendit settlement reconciliation (SPEC gate)

**Date:** 2026-06-08
**Plan:** `docs/superpowers/specs/2026-06-08-v0.7-xendit-settlement-reconciliation-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (design spec; Goals/Non-goals, Schema, Components, FE, Testing, Risks, Out-of-scope all present)

---

## 1. Summary

**Overall Assessment: Approve** (fold in 4 Improvements, then proceed to writing-plans).

The architecture is sound and unusually well-grounded — every load-bearing backend assumption verified against real code: `withActionCache(ctx, params, authCheck, fn)` with the **required** `authCheck` (ADR-046, `convex/idempotency/action.ts:43-49`), `assertManagerSessionInAction` (`convex/auth/verifyPin.ts:68`), `verifyManagerPinOrThrow` (`:88`), the `cronRetry` exports (`convex/lib/cronRetry.ts:39-52`), schema-fragment composition (`convex/schema.ts:14,29`), and the `"use node"` actions.ts / V8 cronActions.ts split (matches `inventory/` exactly). `pos_settlements` is confirmed absent from `convex/schema.ts` — additive, as claimed. The manual-first + KYB-gated-auto-poll scoping is the correct ADR-036-Decision-C playbook.

No Critical issues. Four Improvements are codebase-reality corrections that would otherwise mislead the plan.

## 2. Critical Issues (Must Fix)

None.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | `/settlements` route + `Settlements` stub ALREADY exist — spec says "create + register" | H | L |
| 2 | `reference_id` has two forms (base + retry-suffixed) — join-key claim assumes one | M | L |
| 3 | FE: reusable primitive is `PinSheet`; `PinAction` is a local union pattern, not a component | M | L |
| 4 | Data-flow: `listTransactions` is a plain adapter fn called directly, not via `ctx.runAction` | M | L |

### Improvement 1: `/settlements` route already exists — extend the stub, don't create + re-register

`src/router.tsx:57` already does `const Settlements = lazy(() => import("@/routes/settlements"))` and `:114` registers `{ path: "settlements", element: <Settlements /> }`. The target file `src/routes/settlements.tsx` exists today as a stub:

```tsx
export default function Settlements() {
  return (<SpokeLayout title="Settlements"><Stub name="Settlements" /></SpokeLayout>);
}
```

The spec §5 says "create `src/routes/settlements/index.tsx` (+ route registration in `src/router.tsx`)." Both are wrong: the route is **already registered**, and the existing file is `settlements.tsx` (single file), not a `settlements/` directory.

**Recommendation:** §5 should say **replace the existing `src/routes/settlements.tsx` stub in place** (keep `SpokeLayout`; drop `Stub`). No `router.tsx` change is needed — the import path `@/routes/settlements` resolves to either `settlements.tsx` or `settlements/index.tsx`, so a directory split (if the file grows) is allowed without touching the router, but the default is editing the single file. Remove the "create + register" framing.

### Improvement 2: `reference_id` has two forms — record both for the deferred match-back

Spec §1 (motivation) and §4.1 frame the settlement→`pos_transaction` join key as `reference_id` = `pos-${txnId}`. Verified in code: the initial charge uses `pos-${args.txnId}` (`convex/payments/actions.ts:47`), but the **retry path uses `pos-${args.txnId}-r-${crypto.randomUUID()}`** (`:111`). A retried transaction therefore has **multiple** `reference_id`s, only one of which is the bare `pos-${txnId}`.

Match-back is N1 (out of scope this phase), so this is **not blocking** — but the spec is the place this fact should be recorded so the future match-back isn't built on a false "one reference_id per txn" assumption. (`pos_xendit_invoices.reference_id` already persists the value — `convex/payments/schema.ts:8` — so the data to match on exists; it just isn't a clean `pos-${txnId}` parse.)

**Recommendation:** add a one-line note in §1 fact #3 and §8 (N1) that `reference_id` has a base and a retry-suffixed form (`-r-<uuid>`), so match-back must match by prefix or via the stored invoice row, not by reconstructing `pos-${txnId}`.

### Improvement 3: FE component naming — `PinSheet` is the component; `PinAction` is a local pattern

`grep "export const/function PinAction"` returns nothing. The reusable primitive is **`PinSheet`** (`src/components/pos/PinSheet.tsx`). `PinAction` is a **local discriminated-union state type** repeated per route (`src/routes/mgr/products.tsx:58` `type PinAction = …` + `useState<PinAction | null>`), used to drive the shared `PinSheet`. The spec §4.4/§5 "reuses the v0.5.5 `PinAction` pattern" reads as if `PinAction` is importable.

**Recommendation:** §5 should say: "replicate the local `PinAction` discriminated-union pattern (as in `mgr/products.tsx`/`mgr/spoilage.tsx`) to drive the shared **`PinSheet`** component (`src/components/pos/PinSheet.tsx`)" — naming the actual importable component so the FE agent doesn't hunt for a `PinAction` export.

### Improvement 4: `listTransactions` is a plain adapter fn — call it directly, not via `ctx.runAction`

Spec §4.5 step 2 says "`ctx.runAction` → `payments/xendit.listTransactions(window)`." But the xendit.ts adapter functions are **plain async functions** (`createQrisCharge`, `createBcaVaCharge`), imported and called **directly** inside `payments/actions.ts:50-51` — not registered as actions. `fetch` works in the V8 action runtime, so `syncSettlements` (V8 `internalAction` in `cronActions.ts`) can `import { listTransactions } from "../payments/xendit"` and call it directly.

**Recommendation:** §4.5 should call `listTransactions(window)` directly (mirroring `createQrisCharge`'s call site), not via `ctx.runAction`. This also keeps the Xendit HTTP surface as plain testable functions, consistent with the module's existing shape.

## 4. Refinements (Optional)

- §4.5 cron slot 03:30 WIB = **20:30 UTC** — verify against `crons.ts` neighbours (19:00 stock-recon, 20:00/20:05 purges); 20:30 is clear. Good as-is; just confirm in the plan.
- Audit verbs (`settlement.entered`, `settlement.poll_superseded_manual`, sync skip reasons) are free `v.string()` values (`audit_log.action` has no enum — CLAUDE.md note) — the plan only documents them in `SCHEMA.md`, no validator edit. Spec already implies this; make it explicit in the plan to avoid a phantom "add to enum" task.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `Settlements` route stub | `src/routes/settlements.tsx` (+ `router.tsx:57,114`) | Extend in place (Improvement 1) |
| `PinSheet` | `src/components/pos/PinSheet.tsx` | The manual-entry PIN sheet (Improvement 3) |
| `withActionCache` + `assertManagerSessionInAction` + `verifyManagerPinOrThrow` | `convex/idempotency/action.ts`, `convex/auth/verifyPin.ts` | PIN-gated `enterSettlementManually` (spec §4.4) — verified correct |
| `cronRetry` (`isTransientError`/`resilientRetryDelayMs`/`RESILIENT_MAX_ATTEMPTS`) | `convex/lib/cronRetry.ts` | Resilient cron wrapper (spec §4.5) — verified correct |
| `inventory/cronActions.ts` resilient-cron shape | `convex/inventory/cronActions.ts` | Structural template for `settlements/cronActions.ts` |
| `xendit.ts` adapter (`buildQrisHeaders`, `fetch`+`!res.ok` guard) | `convex/payments/xendit.ts` | Add `listTransactions` alongside (Improvement 4) |
| `WIB_OFFSET_MS` | `convex/lib/time.ts` | WIB date bucketing (spec R3) — verified exported |

### Potential duplication risks
- Re-creating a settlements route component instead of extending the stub (Improvement 1).

## 6. Phase / Wave Accuracy

Spec, not yet phased — the plan will sequence. Implied order is correct: schema fragment → pure `lib` (golden-tested) → `listTransactions` adapter (gated on the R1 field-confirmation step) → single-writer internal → manual-entry action → cron → public query → FE. The R1 field-confirmation must be an early gating task (spec §7a item 5 already calls this out).

## 7. Specialist Agent Recommendations

| Work | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Backend (schema, lib, adapter, action, cron, query) | `convex-expert` | Convex module + action/cron patterns |
| Frontend (`settlements.tsx`, manual-entry form) | `ui-component-builder` then `frontend-integrator` | Build the view + wire `enterSettlementManually` |
| Docs (SCHEMA/ADR-012/API_REFERENCE/CLAUDE/CHANGELOG) | `—` | Cross-cutting |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch | ✅ (pipeline worktree off `main`) |
| Commit boundaries | ✅ (commit-per-task, plan will template) |
| Squash-merge | ✅ repo convention |
| Pre-push typecheck/build/test | ⚠️ plan must list (`npm run typecheck` + `npx vitest run` touched modules + full `npm test` + `build`) |
| Rollback | ✅ additive module + one table; revert = drop module + cron registration; no migration |
| Deployment order | ✅ `npx convex deploy` (schema additive, all-optional new fields) |

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Schema | `SCHEMA.md` (corrected `pos_settlements` §3) + ADR-012 amendment |
| Backend | `API_REFERENCE.md` (`listSettlements`, `enterSettlementManually`, sync internals) + new audit verbs in `SCHEMA.md` |
| Cross-cutting | `CLAUDE.md` (new `settlements/` module in file-locations; rule #22 manual-entry = manager-PIN) + `CHANGELOG.md` + `docs/xendit-reference/settlement-reconciliation.md` (record R1-confirmed field paths) |

## 10. Testing Plan Assessment

**Verdict: Adequate** (for a spec). Pure `lib` golden tests (incl. EARLY_SETTLED, PENDING/null filtered, fee sum, parser-throws-on-unknown-shape), convex-test for manual-entry (auth reject, wrong-PIN lockout, server-computed net, idempotent replay, ADR-046 cached-replay reject), upsert (no-dupe, poll-supersedes-manual + audit, multi-day backfill), and sync (mocked body → upserts, zero-rows audited skip, resilient retry parity). The plan must turn these into TDD steps with the real fixture shape. Live verification of the auto-poll is correctly deferred (R2/N3).

### Missing test coverage (must add in plan)
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | WIB-vs-UTC `settlement_date` bucketing (R3) | Wrong-day aggregation is a silent financial bug | Once R3 resolved, a fixture row near the WIB midnight boundary asserts the bucket |

## 11. Edge Cases to Address

- [ ] `settlement_date` near WIB/UTC midnight boundary (R3)
- [ ] Retry-suffixed `reference_id` rows in a settlement window (Improvement 2)
- [ ] Poll overwrites a manual row for the same day (supersede + audit)
- [ ] Zero settled rows (the normal pre-KYB result — must not look like an error)
- [ ] Manual entry with `net < 0` (mdr > gross) → reject

## 12. Approval Conditions

**To approve:** none blocking — Approve.

**Fold in before writing-plans (Improvements 1-4):**
1. §5 — extend existing `settlements.tsx` stub; no route re-registration.
2. §1/§8 — record `reference_id` base + retry forms for deferred match-back.
3. §4.4/§5 — name `PinSheet` as the component; `PinAction` is a local pattern.
4. §4.5 — call `listTransactions` directly, not via `ctx.runAction`.

---

*Generated by /staffreview*
