# Staff Review: v0.3 cleanup refactors (CL1 / CL2 / CL3)

**Date:** 2026-05-28
**Target:** uncommitted working-tree changes on `feat/v0.3-sale-xendit` (post-`/simplify`)
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Note:** This is a review of *implemented, behavior-preserving refactors* (not a forward plan). The skill's plan-structure validation is N/A; methodology adapted to a diff.

---

## 1. Summary

**Overall Assessment: Approve.**

Three DRY refactors, all behavior-preserving, verified green: `tsc -b` clean, ESLint clean on `convex`/`src`, **277 tests pass**, and — critically for CL1 — **`npx convex dev` pushed clean**, confirming the new hash-wasm-importing helper bundles through the real Convex bundler (vitest alone wouldn't catch a bundling failure). No Critical issues. Two test-coverage Improvements and one boundary note below.

## 2. Critical Issues

None.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Add a direct unit test for `computeVoucherDiscount` | M | L |
| 2 | Add a test for the `manuallyConfirmPayment` lockout path | M | M |
| 3 | Document the `payments → auth/verifyPin` cross-module import intent | L | L |

### Improvement 1: unit-test the extracted money helper
`convex/lib/voucher.ts:computeVoucherDiscount` is the single source of the ADR-024/ADR-015 discount formula now shared by `validateVoucher` and `commitCart`. It's covered *indirectly* (validateVoucher.test.ts + commitCart.test.ts), but a money formula deserves a direct table test (percentage floor, amount cap at subtotal, zero/boundary). **Added in this pass** — see §10.

### Improvement 2: lockout path on manual confirm is untested
The `/simplify` I1 fix added a lockout pre-check to `manuallyConfirmPayment`, now routed through `verifyPinOrThrow`. No test exercises a locked manager hitting the override. Existing payments tests only cover the happy path + (implicitly) wrong PIN. Recommend a test: lock the manager (3 fails), then assert `manuallyConfirmPayment` throws `LOCKED_OUT:*` before argon2. Deferred (needs the multi-fail seeding harness already used in `auth.test.ts`).

### Improvement 3: cross-module helper import
`convex/payments/actions.ts` now imports `verifyPinOrThrow` from `../auth/verifyPin`. Strictly, ADR-034 routes cross-module access through a module's `public.ts`. **Assessed acceptable:** (a) `manuallyConfirmPayment` already depends on auth internals via the generated API (`_getStaffPinHash_internal`, `_getLockState_internal`, `_recordFailedAttempt_internal`, `_auditLockProbe_internal`), so this adds no new coupling in spirit; (b) `verifyPin` is a pure helper that itself routes only through sanctioned `internal.auth.*` queries — it touches no table directly (ESLint cross-module-db rule passes). A one-line comment on the helper noting it's auth-owned-but-shared would help future readers; a neutral home (`convex/lib/`) was rejected because the logic is intrinsically auth's.

## 4. Refinements (Optional)

- `verifyPin.ts` has no `"use node"` directive. Confirmed fine (it's bundled with its node-action importers, and the dev push proves it). A brief comment stating that intent would pre-empt a future "why no directive?" question.

## 5. Duplication Analysis

These refactors *remove* duplication — the analysis is inverted and favorable:

| Was duplicated | Now | Location |
|----------------|-----|----------|
| webhook/polling invoice-resolve bodies (byte-identical) | `_resolveAndConfirm` helper + 2 thin entry points | `convex/payments/internal.ts` |
| voucher discount formula (2 copies) | `computeVoucherDiscount` | `convex/lib/voucher.ts` |
| lockout→argon2→record-fail block (4 copies) | `verifyPinOrThrow` | `convex/auth/verifyPin.ts` |

No *new* duplication introduced. `approveStaffPinReset` correctly left out of CL1 (it intentionally skips the lockout pre-check per ADR-029 — folding it into the helper would have silently added a check and broken locked-manager self-reset).

## 6. Behavior-Preservation Audit (the core risk)

| Call site | Before | After | Preserved? |
|-----------|--------|-------|-----------|
| `loginWithPin` | bad PIN → record; `newly_locked ? LOCKED_OUT : INVALID_PIN` | `verifyPinOrThrow(..., {lockOnFail:true})` | ✅ exact |
| `changePin` | bad PIN → record; throw INVALID_PIN (no newly_locked check) | `verifyPinOrThrow(...)` (no lockOnFail) | ✅ exact |
| `resetStaffPin` | verify MANAGER hash; bad → record; INVALID_PIN | `verifyPinOrThrow(...)` against `manager.pin_hash` | ✅ exact |
| `manuallyConfirmPayment` | (I1) lockout precheck; verify; bad → record; INVALID_PIN | `verifyPinOrThrow(...)` against `actor.pin_hash` | ✅ exact |

Lockout pre-check, `${key}:failed` derived idempotency key, `_auditLockProbe_internal` probe row, and the staff/device/hash sources are all faithfully threaded. Ordering (staff-existence check → lockout → verify) preserved.

## 7. Architecture Fit (Principal)

- **Module depth:** each refactor narrows a surface by hiding repeated logic behind one helper — depth-positive, no new public exports on Convex modules.
- **Funnels intact:** `_resolveAndConfirm` still delegates to the status-guarded `_confirmPaid_internal`; voucher/PIN funnels unchanged downstream.
- **Bundling:** `verifyPin.ts` imports `hash-wasm`; imported only by `"use node"` actions (`auth/actions`, `payments/actions`), so it bundles into the node runtime. Confirmed by a clean `convex dev` push.
- **Security:** `resetStaffPin` still verifies the **manager's** hash, never the target's — the SECURITY comment was retained at the call site.

## 8. Git Workflow

Recommend committing as **two** commits for rollback granularity, isolating the auth-critical one:
1. `refactor(v0.3): dedup webhook/polling + voucher discount math (CL2/CL3)` + the new voucher test
2. `refactor(v0.3): extract verifyPinOrThrow PIN-verify funnel (CL1)`

Pre-push: `tsc -b` ✅, `npm test` ✅, ESLint ✅ — all already run.

## 9. Documentation

No SCHEMA/CLAUDE/CHANGELOG changes required — behavior-preserving, no new tables/rules/audit actions. (The audit action added earlier in this branch, `payment.confirmed_on_terminal`, is already documented.)

## 10. Testing Plan Assessment

**Verdict: Adequate (with Improvement 1 applied).**

- Existing 277 tests cover all four PIN paths, webhook/polling, and voucher apply — they pass unchanged, which *is* the behavior-preservation proof for a refactor.
- **Added:** `convex/lib/voucher.test.ts` — direct table test of `computeVoucherDiscount`.
- **Deferred (Improvement 2):** manual-confirm lockout path.

**Regression risk:** Low. The green existing suite is the regression guard; the only un-covered new behavior is the (pre-existing, untested) manual-confirm lockout precheck.

## 11. Edge Cases

- [x] Voucher percentage flooring / amount cap — covered by new helper test.
- [x] `approveStaffPinReset` lockout-skip preserved (excluded from CL1).
- [ ] Manual-confirm while manager locked out (Improvement 2).

## 12. Approval Conditions

**Approved.** No blocking conditions. Recommended before merge: Improvement 1 (done) + consider Improvement 2.

---

*Generated by /staffreview (adapted to an implemented diff)*
