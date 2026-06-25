# /simplify cleanups — shifts module

Branch: `worktree-two-level-booth-state` (work performed in isolated agent worktree, fast-forwarded onto the target branch).
Base: `fabd5cb`.

## Gate results
- **typecheck**: PASS (`tsc -b && tsc -p convex`, 0 errors)
- **lint**: PASS — 0 errors, 13 pre-existing warnings (all in unrelated test files: unused `Id`/`act`/`beforeEach`/etc. and one `react-hooks/exhaustive-deps` in `src/routes/sale/charge.tsx`). None in any file touched by this change.
- **vitest (full)**: PASS — **267 files / 1508 tests passed**, 0 failed.
- **openBooth.test.ts (focused)**: 5/5 passed, including the new `UNEXPECTED_ACTIVE_HOLDER` test.

## Items

### Deletions

**Item 1 — delete `convex/shifts/shiftLib.ts`** — APPLIED.
Grep: `shiftHoursMs` had zero live callers (only the file itself + docs/plan markdown). File deleted.

**Item 2 — delete `computeShiftHoursMs` from `lib.ts` + test** — APPLIED.
Grep: only caller was `convex/shifts/__tests__/lib.test.ts` (+ docs). Removed the export; rewrote the test block to cover the kept `resolveStaffName` helper instead (kept a live assertion in the file rather than leaving it empty). `resolveStaffName` kept.

**Item 3 — delete `_recordShiftEvent_internal` + `shiftEventFields`** — APPLIED.
Grep: zero runtime callers (only docs/plan/sdd markdown). Deleted the internalMutation and the `shiftEventFields` object. Removed now-unused imports (`internalMutation`, `stepValidator`). schema.ts untouched (per instruction). `pos_shift_events` schema/validators unchanged.

**Item 4 — delete `_shiftStartAnchor_internal`** — APPLIED.
Grep: zero runtime callers (only a migration *comment* + docs). Deleted the internalQuery; removed now-unused imports (`Id`, `wibDayWindow`). `_buildSignoffSummary_internal` kept. Reworded the `convex/migrations/internal.ts` comment (~line 656) so it no longer implies the helper still exists.

**Item 5 — drop `pos_shifts.by_staff_started` index** — APPLIED.
Grep: no live query uses `by_staff_started` on `pos_shifts` (reads go through `by_outlet_active` / `by_outlet_started`). Dropped that one index line from `pos_shifts`. `pos_shift_events.by_staff_started` left intact (still listed in the eslint outlet-fence exclusion + schema).

**Item 6 — delete `login.overrideSuccess` from en.ts + id.ts** — APPLIED.
Grep: zero callers (unwired). Removed from both dictionaries; en/id parity preserved.

### Efficiency

**Item 7 — parallelize `_getOutletStatus_internal` + `_getActiveShift_internal` in `loginContext`** — APPLIED.
After the `outletId` resolve + early-return guard, the two independent reads now run via `Promise.all`.

**Item 8 — replace `resolveStaffName` full-scan with point lookup in `loginContext`** — APPLIED.
Replaced `_listStaffNames_internal` (full scan) + `resolveStaffName` with a single
`internal.auth.internal._getStaffNameCode_internal({ staffId: holder.staff_id })` point lookup
(`holderName = staff?.name ?? null`). `resolveStaffName` is no longer used in `shifts.ts`; its import was removed. (`resolveStaffName` itself is still exported from lib.ts — used elsewhere — so it stays.)

### Stale comments / docs

**Item 9 — `_sendSignoffSummary` docblock (actions.ts)** — APPLIED. Schedulers → "`handover`, `endOfDay`, and `_managerOverrideCommit_internal`"; role `founders` → `managers`.

**Item 10 — comment in shiftsInternal.ts (~line 88)** — APPLIED. `_commitManagerTakeover_internal` → `_managerOverrideCommit_internal`.

**Item 11 — docblock in auth/internal.ts (~line 592)** — APPLIED. `lockShift` → `lock`.

**Item 12 — docs/SCHEMA.md** — APPLIED.
- `shift.lock` audit-verb row: `lockShift` → `lock`.
- `pos_shift_events.stale_autoclose` row: reworded to past-tense/historical ("the now-deleted `completeStartOfDay`"; "Read-only after ADR-053").

### Hardening

**Item 13 — defensive assert in `openBooth` + test** — APPLIED.
After the `BOOTH_ALREADY_OPEN` guard and before `_startShift_internal`, added a
`_getActiveShift_internal` check that throws `UNEXPECTED_ACTIVE_HOLDER` if a CLOSED outlet still
carries an active holder. Added `openBooth.test.ts` case: seed a CLOSED outlet (`is_open:false`)
with a pre-inserted unended `pos_shifts` holder, call `openBooth` → throws `UNEXPECTED_ACTIVE_HOLDER`. PASS.

## Notes / skipped
- Nothing was skipped for live-caller reasons; all deletion targets verified zero runtime callers.
- Minor incidental cleanups kept in scope: reworded the now-stale `lib.ts` header comment (referenced the deleted `shiftEventFields`) and the `migrations/internal.ts` anchor comment.
- **Out of scope, left as-is:** `docs/API_REFERENCE.md` still lists rows for the deleted `_recordShiftEvent_internal`, `_shiftStartAnchor_internal`, and `computeShiftHoursMs`. Not in the prescribed item list — flagged here for a follow-up doc sweep.
- `ShiftEventType` (lib.ts) now has no consumers but is an exported type (no lint error); left in place as it documents the historical `pos_shift_events.type` enum (out of scope to remove).

## Environment note
The harness placed this agent in an isolated worktree branched from an unrelated commit (the v13 cockpit plan), which did not contain the shift files. I created a fresh work branch at the `worktree-two-level-booth-state` tip (`fabd5cb`) inside the agent worktree, applied all edits there, ran the full gate, then fast-forwarded `worktree-two-level-booth-state` to the resulting commit so the deliverable lands on the intended branch.
