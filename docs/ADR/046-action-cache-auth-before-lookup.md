# ADR-046: Action-cache auth runs before the idempotency lookup

**Status:** Accepted (2026-06-07)

## Context
ADR-013 / CLAUDE.md rule #20 require public *mutations* to run `authCheck` BEFORE
the idempotency cache lookup (the `withIdempotency` HOF, `convex/idempotency/internal.ts`).
The *action*-layer helper `withActionCache` (v0.5.3b) omitted this: auth
(`verifyManagerPinOrThrow`) ran inside the cached body, AFTER the lookup. A holder
of a previously-used `idempotencyKey` could replay the cached return value (an
opaque doc id) with no valid session — across all 8 PIN-gated admin actions
(staff.setStaffRole, staff.deactivateStaff, catalog.createProduct,
catalog.createInventorySku, catalog.updateProductPricing, vouchers.createVoucher,
inventory.recordSpoilage, auth.resetStaffPin).

## Decision
`withActionCache` takes a **required** `authCheck` that runs before the lookup. All
PIN-gated admin actions pass `assertManagerSessionInAction` (a fail-cheap active-
manager assert via `_resolveSessionRole_internal`). The expensive argon2 PIN verify
stays inside the cached body, so a legit idempotent retry still skips it ("cache hit
skips PIN").

## Consequences
- Action layer reaches parity with the mutation layer (rule #20).
- A session that ends between the original call and a retry can no longer replay the
  cached result — identical to the mutation-side behaviour, and acceptable.
- The pre-cache gate and the in-body `verifyManagerPinOrThrow` must accept the same
  session set (resolution-parity, guarded by test in
  `convex/idempotency/__tests__/actionCacheAuth.test.ts`).
