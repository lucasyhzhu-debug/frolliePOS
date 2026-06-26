# Triple-Review Fixes Report
**Commit:** 426b301  
**Branch:** worktree-two-level-booth-state  
**Date:** 2026-06-26

---

## C1 — managerOverride idempotency-key replay

**Finding:** Both `login.tsx` and `lock.tsx` used the same key prefix `shift:override:${deviceId}` for their override idempotency keys. After a successful or failed override attempt, the key was never rotated — the next attempt would hit the cached response instead of re-executing the action. This meant: (a) override screens on login vs lock shared a key namespace; (b) a failed override on lock couldn't be retried because the server replayed the cached error or no-op.

**Fix applied:**
- `src/routes/login.tsx`: Added `overrideReset` state. Changed intent to `shift:override:login:${deviceId ?? "none"}:${overrideReset}`. Added `setOverrideReset((n) => n + 1)` in the `finally` block of `handleOverridePin` (fires on both success and failure).
- `src/routes/lock.tsx`: Same pattern — distinct prefix `shift:override:lock:...`, `overrideReset` state, rotation in `finally`.

**Covering test:** `convex/shifts/__tests__/managerOverride.test.ts` — new test "managerOverride: replay of key k1 does NOT end a second stranded holder; k2 does" verifies: key k1 force-ends holder A → seed holder B → replay k1 = no-op (B still active) → fresh k2 ends B. **PASS.**

---

## I-A — loginContext crashes /login on unbound device

**Finding:** `convex/shifts/shifts.ts::loginContext` called `_getDeviceOutletId_internal` which throws `DEVICE_HAS_NO_OUTLET` when a registered device has no outlet binding yet. This crashed the `/login` query subscription on freshly-activated devices.

**Fix applied:** `convex/shifts/shifts.ts` — changed to `_getDeviceOutletIdOrNull_internal` (non-throwing). Added early return `{ outletOpen: false, holderStaffId: null, holderName: null }` when `outletId` is null.

**Covering test:** `convex/shifts/__tests__/loginContext.test.ts` — new test "loginContext: unbound device returns outletOpen:false without throwing" seeds a `registered_devices` row with no `outlet_id` and asserts the query returns safe defaults without throwing. **PASS.**

---

## I-B — single-holder invariant is client-only/racy

**Finding (a):** The pre-stage `useEffect` in `login.tsx` ran before `loginContext` resolved (`ctx === undefined`). The block check (`ctx?.holderStaffId !== null`) used optional chaining, which short-circuits to `false` when `ctx` is undefined — so a blocked staffer could be silently auto-pre-staged to the PIN screen before the holder context arrived.

**Finding (b):** No check was made in `onPinSubmit` before calling `login()`. If holderStaffId changed between the staff-list tap and PIN submission (race), the backend would get a login call for a blocked staffer.

**Fix applied:**
- `src/routes/login.tsx` pre-stage `useEffect`: added `if (ctx === undefined) return;` guard so pre-staging only fires once loginContext has resolved.
- `src/routes/login.tsx::onPinSubmit`: added block-predicate re-check before `login()`. If `ctx.outletOpen && ctx.holderStaffId !== null && ctx.holderStaffId !== stage.staff._id`, sets phase error with `login.shiftHeldBy` message and returns without calling the backend.
- `src/components/layout/RootLayout.tsx`: added Level-2 gate — when `outletOpen === true && holderStaffId === null && pathname !== "/shift/begin"` → Navigate to `/shift/begin`. This ensures incoming staff are always routed to the count wizard after handover-out.

---

## I-C — lock.tsx override error handling

**Finding:** `lock.tsx::handleOverridePin` used `err instanceof Error ? err.message : "Pengalihan gagal"` — a hardcoded Indonesian fallback that bypassed `ConvexError.data` unwrapping. `errorMessage()` already exists in `@/lib/errors` for this purpose.

**Fix applied:** `src/routes/lock.tsx`:
- Added `import { errorMessage } from "@/lib/errors"`.
- Changed `const msg = err instanceof Error ? err.message : "Pengalihan gagal"` to `const msg = errorMessage(err)`.
- The hardcoded "Pengalihan gagal" string is eliminated; `msg` (raw server error) is the last fallback — mirrors `login.tsx`'s override error handling pattern.

---

## I-D — startShift test gap

**Finding:** The test titled "startShift on a closed outlet → BOOTH_NOT_OPEN; with a holder → SHIFT_IN_PROGRESS" only asserted `SHIFT_IN_PROGRESS` (open outlet + existing holder). The BOOTH_NOT_OPEN case (closed outlet, no holder, valid session) had no real assertion.

**Fix applied:** `convex/shifts/__tests__/startShift.test.ts` — added new test "startShift: closed outlet rejects with BOOTH_NOT_OPEN (I-D)" that seeds a fresh closed outlet (`is_open: false`) with a valid session and asserts `startShift` rejects with `/BOOTH_NOT_OPEN/`. **PASS.**

---

## Test run summary

```
convex/shifts/ — 22 tests PASS (11 test files)
  loginContext.test.ts    — 2/2 PASS (includes new unbound-device test)
  managerOverride.test.ts — 5/5 PASS (includes new idempotency-replay test)
  startShift.test.ts      — 3/3 PASS (includes new I-D BOOTH_NOT_OPEN test)
```

## Typecheck / lint

```
npm run typecheck — PASS (0 errors)
npm run lint      — 0 errors, 13 pre-existing warnings
```

## Commit

`426b301` fix(shifts): rotate managerOverride idempotency key; loginContext graceful-degrade on unbound device; enforce single-holder at login+gate; lock error i18n; startShift closed-outlet test
