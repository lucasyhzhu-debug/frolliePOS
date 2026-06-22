# Task 9D Report — Chunk D: vouchers / approvals / shifts / ops / auth / telegram

**Commit:** `1b99e4f`
**Branch:** `feat/v2.0-multi-outlet-foundation`
**Worktree:** `D:/Claude/frolliepos/.claude/worktrees/v2.0-impl`

---

## Summary

Chunk D completes the Stream 5 outlet-scoped read/write migration for the remaining backend modules: vouchers, approvals, shifts (public + internal + actions), telegram (foundersSummary), and auth (new helper). All changes are migration-window-tolerant — old indexes preserved, no new throws, `outletId` is always optional.

---

## Changes by module

### `convex/vouchers/public.ts`
- `getActiveVouchers`: added `sessionId: v.optional(v.id("staff_sessions"))` arg. Resolves `outlet_id` from session inline via `ctx.db.get(sessionId)` + `ctx.runQuery(internal.outlets.internal._getDefaultOutlet_internal)` fallback (ADR-034: outlets table routed via internal). Uses `by_outlet_active_expires` when outlet available, `by_active_expires` otherwise.

### `convex/vouchers/internal.ts`
- `_getVoucherByCode_internal`: accepts `outletId`; uses `by_outlet_code` when available.
- `_redeemVoucher_internal`: accepts `outletId`; stamps `outlet_id` on `pos_voucher_redemptions` insert; uses `by_outlet_transaction` for idempotency check.
- `_createVoucher_internal`: accepts `outletId`; stamps `outlet_id` on `pos_vouchers` insert.

### `convex/vouchers/actions.ts`
- `createVoucher`: resolves `outletId` from session via `_resolveSession_internal`; passes to `_getVoucherByCode_internal` and `_createVoucher_internal`.

### `convex/approvals/internal.ts`
- `_createRequest_internal`: accepts `outletId`; stamps `outlet_id` on `pos_approval_requests` insert.
- `_listPendingByKind_internal`: accepts `outletId`; uses `by_outlet_kind_status` when available.
- `_cancelPendingManualPaymentForTxn_internal`: accepts `outletId`; uses `by_outlet_kind_status` when available.

### `convex/approvals/actions.ts`
- `requestManualPaymentApproval`: extracts `outletId` from `_resolveSession_internal`, passes to `_listPendingByKind_internal` and `_createRequest_internal`.
- `requestSpoilageApproval`: switched to `_resolveSession_internal` for `outletId` + separate `_resolveSessionRole_internal` for role check; passes `outletId` to `_createRequest_internal`.

### `convex/shifts/internal.ts`
- `_latestShiftEvent_internal`: accepts `outletId`; uses `by_outlet_device_created` when available.
- `_shiftStartAnchor_internal`: accepts `outletId`; uses `by_outlet_device_created` when available.
- `_recordShiftEvent_internal`: accepts `outletId`; stamps `outlet_id` on `pos_shift_events` insert.
- `_buildSignoffSummary_internal`: accepts `outletId`; passes to `_dailySalesSummary_internal` and `_manualBcaReconciliation_internal`.
- `_commitManagerTakeover_internal`: resolves outlet via `ctx.runQuery(internal.auth.internal._getDeviceOutletId_internal, { deviceId })` (ADR-034: registered_devices owned by auth); stamps `outlet_id` on `manager_takeover` event insert; passes `outletId` to `_sendTakeoverSummary`.

### `convex/shifts/public.ts`
- `boothState`: accepts `outletId: v.optional(v.id("outlets"))` arg; passes to `_latestShiftEvent_internal`.
- `assertBoothState` helper: accepts optional `outletId` 5th param; passes to `_latestShiftEvent_internal`.
- All lifecycle mutations (`completeStartOfDay`, `endOfDaySignOff`, `handoverOut`, `lockShift`, `recordResume`, `completeHandoverIn`): extract `outlet_id` from `requireSession()`; pass to `_latestShiftEvent_internal`, `_shiftStartAnchor_internal`, `_recordShiftEvent_internal`, `_buildSignoffSummary_internal`, and `_sendSignoffSummary` scheduler call.

### `convex/shifts/actions.ts`
- `_sendSignoffSummary`: accepts `outletId: v.optional(v.id("outlets"))`; passes to `_manualBcaReconciliation_internal`.
- `_sendTakeoverSummary`: accepts `outletId: v.optional(v.id("outlets"))`; passes to `_dailySalesSummary_internal` and `_manualBcaReconciliation_internal`.

### `convex/telegram/foundersSummary.ts`
- `sendFoundersSummary`: resolves default outlet via `ctx.runQuery(internal.outlets.internal._getDefaultOutlet_internal, {})` (cron has no session); passes `outletId` to `_dailySalesSummary_internal` and `_manualBcaReconciliation_internal`.

### `convex/auth/internal.ts`
- Added `_getDeviceOutletId_internal`: resolves `outlet_id` from `registered_devices.by_device_id`, falls back to first active outlet. ADR-034 canonical helper for cross-module device→outlet resolution. Used by `shifts/internal._commitManagerTakeover_internal`.

---

## Task 12 notes

- **`staff_sessions.by_device_active`** in `_managerTakeoverSession_internal` (`auth/internal.ts`) — KEPT as-is. This query is inside auth's own module where session ownership lives. The new `by_outlet_device_active` index migration is deferred to Task 12 enforcement.
- **`boothState` query `outletId` arg** — added as optional to allow FE callers that know the outlet to pass it. Callers that don't (pre-v2 FE) still get the legacy unscoped index result. Task 12 will make this required + enforce.

---

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` | PASS (zero errors) |
| `npm run lint` | PASS (0 errors, 8 pre-existing warnings) |
| `npx vitest run convex/approvals/__tests__/outlet-scope.test.ts` | PASS (2/2) |
| `npx vitest run` (full suite) | 1389 pass, 3 fail — failures are pre-existing in `manualPayment.test.ts` (NO_DEFAULT_OUTLET, introduced by earlier task work, NOT regressions from chunk D — confirmed by `git stash` isolation test) |

---

## Pre-existing test failures (NOT regressions)

`convex/approvals/__tests__/manualPayment.test.ts` — 3 tests fail with `NO_DEFAULT_OUTLET`. These tests exercise the manual-payment-approval flow which calls `_confirmPaid` which requires an outlet. The test seeds don't set up an outlet row — this is a known gap from earlier task migration work. Confirmed pre-existing: failures identical on `git stash` (before chunk D changes).
