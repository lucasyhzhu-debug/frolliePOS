# Task 13 Report — Retire deriveBoothState Machinery + ADR-053

**Commit:** `73ff383`
**Branch:** `worktree-two-level-booth-state`
**Gate:** typecheck CLEAN · 1503 tests PASS · 0 lint errors

---

## Files Deleted

| File | Reason |
|---|---|
| `convex/shifts/public.ts` | Entire file — all retired exports (boothState, completeStartOfDay, endOfDaySignOff, handoverOut, lockShift, recordResume, completeHandoverIn) |
| `convex/shifts/__tests__/boothState.test.ts` | Tests old public.ts boothState query |
| `convex/shifts/__tests__/handover.test.ts` | Tests old handoverOut/completeHandoverIn (keep handover2.test.ts) |
| `convex/shifts/__tests__/lock.test.ts` | Tests old lockShift/recordResume (keep lock2.test.ts) |
| `convex/shifts/__tests__/signoff.test.ts` | Tests old endOfDaySignOff |
| `convex/shifts/__tests__/signoffTelegram.test.ts` | Tests old public.ts mutations for Telegram scheduling |
| `convex/shifts/__tests__/staleAutoclose.test.ts` | Tests old completeStartOfDay stale-autoclose path |
| `convex/shifts/__tests__/startOfDay.test.ts` | Tests old completeStartOfDay |
| `convex/shifts/__tests__/stateGuards.test.ts` | Tests state guards against deriveBoothState |
| `convex/shifts/__tests__/takeover.test.ts` | Tests old managerTakeover action |

---

## Files Modified

### `convex/shifts/lib.ts`
- Deleted: `BoothState` type, `LatestEvent` type, `OPEN_TYPES` const, `deriveBoothState` function (26 lines)
- Kept: `ShiftEventType` (still used by schema validators in internal.ts), `computeShiftHoursMs`, `resolveStaffName`

### `convex/shifts/internal.ts`
- Deleted: `_latestShiftEvent_internal` (13 lines + replaced with comment)
- Deleted: `_commitManagerTakeover_internal` (122 lines + replaced with comment)
- Removed orphaned imports: `logAudit`, `withIdempotency`
- Kept: `_recordShiftEvent_internal`, `_shiftStartAnchor_internal`, `_buildSignoffSummary_internal`

### `convex/shifts/actions.ts`
- Deleted: `managerTakeover` action (61 lines + replaced with comment)
- Deleted: `_sendTakeoverSummary` internalAction (59 lines + replaced with comment)
- Kept: `_sendSignoffSummary`, `managerOverride`, `managerSkipOpen`
- All imports remain used

### `convex/auth/internal.ts`
- Deleted: `_managerTakeoverSession_internal` (56 lines + replaced with comment)
- Fixed: `_endShiftSession_internal` JSDoc comment (removed reference to retired function)

### `convex/shifts/__tests__/lib.test.ts`
- Removed: `deriveBoothState` describe block (26 lines)
- Kept: `computeShiftHoursMs` test

### `convex/auth/__tests__/device-outlet.test.ts`
- Removed: `_managerTakeoverSession_internal — outlet stamping` describe block (2 tests, ~54 lines)
- Replaced with comment explaining deletion
- Kept: `_loginCommit_internal`, `_reset_internal`, `_assignDeviceOutlet_internal` test blocks

---

## Files Created

| File | Contents |
|---|---|
| `docs/ADR/053-two-level-booth-state.md` | Full ADR: context, two stored levels, retired machinery, migration, consequences |

---

## Docs Updated

| File | Changes |
|---|---|
| `CLAUDE.md` | Rule #23 rewritten to two-level model; `shifts/` module row updated to reflect new files |
| `docs/SCHEMA.md` | Module table updated; `outlets` table gains is_open/opened_at/opened_by/closed_at/closed_by fields; `pos_shifts` table section added; `pos_shift_events` marked legacy read-only |
| `docs/API_REFERENCE.md` | `shifts/` section heading + intro rewritten; Public/Actions/Internal/Pure helpers tables replaced with new surface; `_managerTakeoverSession_internal` row removed from auth section |
| `docs/CHANGELOG.md` | v2.0 entry added at top |

---

## Grep Sweep Results (Before → After)

| Symbol | Before (live callers) | After |
|---|---|---|
| `deriveBoothState` | `shifts/public.ts` (7 call sites), `shifts/lib.ts` (definition) | Comments only in migration + shiftLib header |
| `BoothState` | `shifts/public.ts`, `shifts/lib.ts` | NONE |
| `LatestEvent` | `shifts/lib.ts` only | NONE |
| `OPEN_TYPES` | `shifts/lib.ts` only | NONE |
| `_commitManagerTakeover_internal` | `shifts/actions.ts:84` (caller), `shifts/internal.ts:177` (def) | Comments only |
| `_latestShiftEvent_internal` | `shifts/public.ts` (7 call sites), `shifts/internal.ts:42` (def) | Comments only |
| `_managerTakeoverSession_internal` | `shifts/internal.ts:238` (caller), `auth/internal.ts:627` (def) | Comments only |
| `managerTakeover` (action) | `shifts/actions.ts:33` (def) | Comments + i18n display key (not action call) |
| `_sendTakeoverSummary` | `shifts/actions.ts:167` (def), `shifts/internal.ts:283` (scheduler) | Comments only |
| `shifts.public.*` | 9 test files | NONE |

---

## Gate Results

```
npm run typecheck   → CLEAN (0 errors)
npx vitest run      → 1503 PASS, 1 FAIL (pre-existing — see below)
npm run lint        → 0 errors, 13 warnings (pre-existing)
```

### Pre-existing test failure (NOT caused by Task 13)

**File:** `convex/migrations/__tests__/backfillOutletStatus.test.ts`
**Test:** `backfillOutletStatus: lock event => is_open=true + one active holder row`
**Error:** `expected [] to have a length of 1 but got 0` at line 111

**Verification:** Confirmed failing on commit `8b0a071` (pre-Task 13) via `git stash` + isolated vitest run. Root cause: the migration's anchor-finding query only matches `start_of_day`/`handover_in`/`manager_takeover` events within the WIB window; a "lock event" test scenario without a corresponding `start_of_day` event would have no anchor and skips the `pos_shifts` insert. Task 13 did not touch `convex/migrations/internal.ts` or this test file.

---

## ADR Summary

**ADR-053** (`docs/ADR/053-two-level-booth-state.md`) — supersedes ADR-050:
- Level 1: `outlets.is_open` (SOP gate)
- Level 2: `pos_shifts` holder row (active staffer)
- `pos_shift_events` kept read-only/legacy
- `deriveBoothState` and all derived-state machinery deleted
