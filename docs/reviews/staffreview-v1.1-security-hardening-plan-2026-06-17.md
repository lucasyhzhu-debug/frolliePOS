# Staff Review: v1.1 Security Hardening — Implementation Plan

**Date:** 2026-06-17
**Plan:** `docs/superpowers/plans/2026-06-17-v1.1-security-hardening.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, File Changes, Tasks with TDD steps, Success Criteria, Rollback/Deployment, Self-Review all present).

---

## 1. Summary

**Overall Assessment:** Revise (two Critical correctness gaps; otherwise execution-ready)

The plan is well-grounded — real signatures, the 6-caller sweep is enumerated, the `auth.test.ts:261` migration is explicit, and the SEC-01/07 coupling is handled atomically. Verifying the plan's flagged assumptions against live code surfaced two must-fix gaps the plan stage exists to catch: a **test that omits a required `commitCart` arg** (would assert the wrong throw), and a **wrong "no system caller" assumption for `getCurrentInvoice`** (it has one at `payments/actions.ts:97`, so the signature change would break the charge-retry path). Both are cheap to fix in the plan.

**Evidence-Before-Mitigation Gate (§4.9):** ✅ PASS. All seven are verified security *fixes* (each cites `file:line` + survived adversarial verification in the audit artefact), not flake/race mitigations. No Task-0 instrumentation required.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | Task 1 test omits the required `intent` arg → wrong-throw false signal | Testing | Task 1 Step 1 |
| C2 | `getCurrentInvoice` has a system caller; required `sessionId` breaks it | Logic/Completeness | Task 4 |

### C1: `commitCart` requires `intent` — the Task 1 test will throw the wrong error
`convex/transactions/public.ts:144-153` declares `intent: v.union(v.literal("draft"), v.literal("charge"))` as a **required** arg. The Task 1 test calls `commitCart({ idempotencyKey, sessionId, lines })` with no `intent`, so Convex argument validation rejects the call *before* the handler runs — the `.rejects.toThrow("QTY_INVALID")` would pass for the wrong reason (arg-validation error, not the guard) or fail outright, giving a false-green/false-red that doesn't actually exercise the SEC-02 guard.

**Recommendation:** add `intent: "charge"` (or `"draft"`) to every `commitCart` call in the Task 1 test. Also note the guard sits at line ~182 (after `EMPTY_CART:181`, before `resolveSessionStaff:183`) — so a valid `sessionId` isn't strictly required for the guard to fire, but the test should still pass a real one to mirror production and avoid coupling the assertion to ordering.

### C2: `getCurrentInvoice` is called server-side — needs its own internal variant
`grep` confirms `getCurrentInvoice` is consumed not only by the FE hook but by **`convex/payments/actions.ts:97`** (`const prev = await ctx.runQuery(api.payments.public.getCurrentInvoice, { txnId })` — the retry-supersede path). The plan's Task 4 verify-first (spec I4) assumed "no server-side caller" — that's wrong. Adding a required `sessionId` to `getCurrentInvoice` would break this system call at runtime (internal→public api inference won't catch a missing arg the same way, and there's no session in an action's system context).

`getById`'s three system callers (`transactions/actions.ts:58`, `payments/actions.ts:42`, `:100`) ARE covered by the plan's `_getTxnById_internal` migration — good. But the symmetric fix for `getCurrentInvoice` is missing.

**Recommendation:** Task 4 must add `_getCurrentInvoice_internal` (full invoice row, `{txnId}` only) and repoint `payments/actions.ts:97` to it, exactly mirroring the `_getTxnById_internal` treatment. Update the verify-first note: `getCurrentInvoice` has one system caller (`:97`); confirm no others.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | SEC-04 global-breach "invalidate all pending setups" is over-aggressive (re-issue DoS) | M | L |
| I2 | Confirm `charge-success.tsx` doesn't consume `receipt_token`/fields dropped by the projection | M | L |

### I1: Global-breach pending-setup invalidation creates a re-issue DoS
Task 5 Step 3 invalidates **all** live `pending_device_setups` on a global-window breach. An attacker spraying 50 bad codes/15min could repeatedly wipe a legitimate manager's freshly-issued code, so the manager can never complete activation (availability DoS). The hard-block-the-window behavior alone already stops the brute force — wiping live codes adds attacker-controlled denial of a legit flow.

**Recommendation:** on global breach, **hard-block new activation attempts for the lockout window** but do NOT wipe pending setups. With a 15-min code TTL and a 50/15min cap against a ~900k space, the code almost certainly expires before a brute-forcer lands it, without handing the attacker a way to nuke legit codes. Keep the audit event. (If wiping is still wanted later, gate it behind a higher threshold.)

### I2: Verify the `getById` projection covers all FE consumers
Task 4 drops `receipt_token`/`xendit_*`/`confirmed_*` and returns an explicit field list. `useXenditPayment` only reads `txn.status` (confirmed), but `charge-success.tsx` was not read. If it consumes `receipt_token` (to build a receipt link) or any dropped field, the projection breaks it.

**Recommendation:** the plan's Step 1 verify already enumerates consumers — make it explicit that if `charge-success.tsx` needs the receipt, it must route through `shareReceipt` (the established token-minting seam, per `getTransactionDetail:528-531`), not read `receipt_token` off `getById`. Add the actually-consumed fields to the projection; keep capabilities out.

## 4. Refinements (Optional)
- Task 3 Step 7: the SEC-01 action-level `loginWithPin` test needs a seeded staff + (per the audit) no device registration is required by `loginWithPin` — note this so the implementer doesn't over-scaffold a `registered_devices` row.
- Task 5 helper bodies (`recordActivationFailure`/`assertActivationNotLocked`) are described as clones of `cleanupAndGetAttempt`/`_getLockState_internal` rather than spelled out — acceptable given the cited template, but the executor should write them test-first.
- Reuse `MAX_FAILS`/`LOCKOUT_MS` from `auth/internal.ts` only if exported; otherwise local consts in `staff/internal.ts` are fine (don't export auth internals just for this).

## 5. Duplication Analysis
### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `getTransactionDetail` gate | `transactions/public.ts:498` | Task 4 `getById`/`getCurrentInvoice` template (resolve→scope→project) |
| `_getTxnById_internal` pattern | (new) | Mirror for `_getCurrentInvoice_internal` (C2) |
| `cleanupAndGetAttempt` / `_getLockState_internal` | `auth/internal.ts:109/130` | Task 5 activation-throttle helpers (keyed on `key` not `staff_id`) |
| `QTY_INVALID` guard | `_recordSpoilage_internal` | Task 1 (exact pattern) |
| `wibDayWindow`, `_resolveSessionRole_internal` | used in `getTransactionDetail` | Task 4 |

### Potential duplication risks
- None new. `_getCurrentInvoice_internal` + `_getTxnById_internal` are thin and intentional (system-caller seams).

## 6. Phase / Wave Accuracy
| Task | Assessment | Notes |
|------|------------|-------|
| 1 SEC-02 | Good | fix C1 test arg |
| 2 SEC-03 | Good | touch-points verified (`_changePinCommit_internal:401`, `getSession:32`) |
| 3 SEC-01+07 | Good | atomic; 6-caller sweep + test migration explicit |
| 4 SEC-05+06 | Needs adjustment | add `_getCurrentInvoice_internal` (C2) |
| 5 SEC-04 | Needs adjustment | soften global-breach action (I1) |
| 6 Docs | Good | — |
**Ordering:** sound (independent tasks; 3 and 4 each atomic). No hazard.

## 7. Specialist Agent Recommendations
| Work | Agent | Rationale |
|------|-------|-----------|
| Tasks 1–5 backend | `convex-expert` | mutation/query/schema + idempotency semantics |
| Task 4 FE threading | `frontend-integrator` | `useXenditPayment(sessionId)` wiring |
| Close-out | `/triple-review` → `/simplify xhigh` | repo standard (in handoff) |

## 8. Git Workflow Assessment
| Check | Status |
|-------|--------|
| Feature branch specified | ✅ `worktree-v1.1-security-hardening` |
| Commit boundaries | ✅ one per task |
| Merge strategy | ✅ squash-PR (Global Constraints) |
| `npm run typecheck` pre-push | ✅ |
| Local tests pre-push | ✅ `npx vitest run` |
| Rollback strategy | ✅ single squash revert; backward-safe schema |
| Deployment order | ✅ Convex atomic schema+functions; both additions optional/new-table |
| Migration safety | ✅ |

## 9. Documentation Checkpoints
| Task | Docs |
|------|------|
| 6 | `docs/SCHEMA.md` (must_change_pin, pos_device_activation_attempts, countTowardLockout, new audit verb), `docs/CHANGELOG.md`, `CLAUDE.md` (BOOTSTRAP_MANAGER_PIN env, activation throttle) |
Plan's CHANGELOG draft is adequate.

## 10. Testing Plan Assessment
**Verdict:** Adequate (after C1 fix). Every SEC-NN has a red→green test; SEC-07 has the cross-channel no-booth-lock regression; the `auth.test.ts:261` migration is explicit (not just additive).

### Missing/needs-fix coverage
| # | Test | Why | Approach |
|---|------|-----|----------|
| 1 | Task 1 `commitCart` calls | C1 — missing `intent` arg | add `intent: "charge"` |
| 2 | `getCurrentInvoice` system-caller still works | C2 | assert `payments/actions.ts:97` path via `_getCurrentInvoice_internal` unaffected |
| 3 | `getCurrentInvoice` anon/other-day → null | Task 4 Step 5 (already planned) | keep |

### Regression risk
- `auth.test.ts` "Fix 10" block (migrated by design). Grep `lockoutScheduler.test.ts` for derived-key assertions (Task 3 Step 8).
- Any test calling `commitCart` without the guard expectation — should be unaffected (valid carts pass the guard).

## 11. Edge Cases to Address
- [ ] C2: `getCurrentInvoice` system caller (`payments/actions.ts:97`).
- [ ] I1: global-breach must not let an attacker DoS legit activation by wiping pending codes.
- [ ] SEC-01: legit network-retry over-counts by one (fail-safe) — assert/comment so it isn't "fixed."
- [ ] Task 4: manager reads any-day (assert both roles); staff other-day → null.
- [ ] Task 2: `changePin` failure must not strip the `must_change_pin` prompt mid-flow (FE prompt resilient to a failed rotation).

## 12. Approval Conditions
**To approve, address:**
1. C1 — add `intent` to the Task 1 `commitCart` test calls.
2. C2 — add `_getCurrentInvoice_internal` + migrate `payments/actions.ts:97`; correct the verify-first note.

**Recommended:**
1. I1 — soften the SEC-04 global-breach action (block window, don't wipe pending).
2. I2 — confirm `charge-success.tsx` consumers; route receipt via `shareReceipt`.

---

*Generated by /staffreview*
