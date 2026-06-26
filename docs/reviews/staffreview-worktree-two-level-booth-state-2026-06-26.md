# Staff Review: Two-Level Booth State (worktree `worktree-two-level-booth-state`)

**Date:** 2026-06-26
**Base→Head:** `b96535b` → `5433573` (17 commits)
**Lens:** ADR-034 deep-modules / surface-API discipline + state-machine soundness
**ADRs:** ADR-053 (new) supersedes ADR-050; ADR-034 (deep modules); ADR-051 (outlet scope)

---

## Summary

**Verdict — net DEEPER in concept, slightly messier in file hygiene.** Replacing the derived `deriveBoothState` machine with two *stored* levels (`outlets.is_open` + a single `pos_shifts` holder row) genuinely narrows the public surface and hides the substantial transition logic behind five small mutations + one query. The event-replay derivation that produced the recurring `BOOTH_NOT_OPEN` brick is gone, and the two levels are produced atomically so the impossible `(closed, holder)` cell can't be written at runtime. That is a real depth win.

The erosion is at the *module-internal* level, not the public contract: the refactor left **dead surfaces** (`shiftLib.ts`, two unused shift-hour helpers, the orphaned legacy `pos_shift_events` writer/anchor) and **broke the `public.ts`/`internal.ts` naming convention** every other module follows (`api.shifts.shifts.openBooth`, plus two internal files and two lib files in one module). None of that is load-bearing, but it should be cleaned before merge or the "deep module" reads as "module with a junk drawer."

One genuine **soundness gap**: the persistent `RootLayout` gate only enforces Level-1 (closed → SOP). The `(open, no-holder)` cell is enforced *only at login-time*, so an already-authenticated session that lands on `/` (e.g. PWA reload mid-`/shift/begin`) can operate the booth with no holder claimed and the open-count step silently skipped.

Plan fidelity is high (T1–T13 all landed; `managerSkipOpen` was implemented *better* than the plan snippet, using the ADR-046 two-phase action cache). The migration's inlined `deriveIsOpen` is the correct call. The lock-screen `managerOverride` is a self-flagged redundant surface.

---

## Critical Issues

**None.** No money/audit/security regression. The `.unique()` brick path (see Minor #3) is real but unreachable at runtime.

---

## Improvements (Important)

### I1 — `(open, no-holder)` is operable without claiming the shift
`RootLayout`'s SOP gate (`src/components/layout/RootLayout.tsx:161`) redirects to `/shift/start` only when `!ctx.outletOpen`. The `(open, no-holder)` cell is steered to `/shift/begin` **only by the login navigation target** (`login.tsx:170-174`). An already-active session that reaches `/` — PWA reload while the incoming staffer is mid-`/shift/begin`, or any manual nav — sees `outletOpen === true`, passes the gate, and lands on home. `startShift` (and its open-count capture + holder attribution) is bypassed; sales still record (txns are outlet-scoped, not holder-scoped) but with no `pos_shifts` holder. The state-machine goal "every `(L1,L2)` combination handled by exactly one transition" is met at login but **not** by the persistent gate. Extend the gate: when `session active && deviceIsOutlet && ctx.outletOpen && ctx.holderStaffId === null && path !== "/shift/begin"` → redirect to `/shift/begin`.

### I2 — Incomplete retirement of the `pos_shift_events` write path
ADR-053 declares `pos_shift_events` read-only with "no new writes," but Task 13 left the write/read machinery alive and orphaned:
- `_recordShiftEvent_internal` (`convex/shifts/internal.ts:43`) — the *sole* legacy writer, now zero callers.
- `_shiftStartAnchor_internal` (`convex/shifts/internal.ts:55`) — legacy reader, zero runtime callers (only a comment reference in the migration).

The "no new writes" invariant is enforced only by *absence of callers*, not by removal — exactly the latent-drift footgun this change set out to eliminate. Delete both (only `_buildSignoffSummary_internal` in that file is still live).

### I3 — Module file organization deviates from ADR-034 convention
Every other module exposes its public surface as `public.ts`; here it is `shifts.ts`, producing the doubled `api.shifts.shifts.openBooth` path. The `shifts/` module now carries **two internal files** (`internal.ts` legacy + `shiftsInternal.ts` new) and **two pure-lib files** (`lib.ts` + `shiftLib.ts`). A maintainer asking "where are the shift internals?" faces two files with no ownership boundary. Recommend before merge: rename `shifts.ts` → `public.ts`, fold `shiftsInternal.ts` into `internal.ts` (after deleting the I2 dead fns), delete `shiftLib.ts`. Collapses back to the canonical `public.ts / internal.ts / lib.ts / actions.ts / schema.ts`.

### I4 — `lock.tsx` `managerOverride` is a redundant dead-end surface
Self-flagged DONE_WITH_CONCERNS (`src/routes/lock.tsx:25-32`). The lock screen is reachable only by the *active holder*; their "override" force-ends *their own* shift — there is no stranded shift to rescue from that screen (they'd use `endOfDay`/`handover`). The real escape hatch is the login blocked-stage (`login.tsx`). As shipped it is a second PIN-gated path with no coherent scenario. Remove it, or pin a concrete use-case in the comment; don't leave a confusing duplicate override behind "do not delete without UX sign-off."

---

## Refinements (Minor)

1. **Dead + duplicated pure helpers.** `shiftLib.ts::shiftHoursMs` and `lib.ts::computeShiftHoursMs` are both unused *and* identical (`max(0, end-start)`). The plan said `shiftLib` would also host "summary shaping" — that never moved. Delete both functions (and `shiftLib.ts`).
2. **Unused index.** `pos_shifts.by_staff_started` (`schema.ts:84`) is defined but never queried (copied from `pos_shift_events`). Reads go through `by_outlet_active` / `by_outlet_started`. Drop it.
3. **`openBooth` guards Level-1 only.** It checks `is_open` but not for an existing holder (`shifts.ts:40-52`). On the (unreachable) `(closed, holder)` state it would insert a *second* active row → `_getActiveShift_internal`'s `.unique()` then throws on every read → booth bricked everywhere. Given the whole change targets booth-brick incidents, assert the two levels are consistent at open time (cheap `_getActiveShift` check → `SHIFT_IN_PROGRESS`) rather than assume orthogonality.
4. **`loginContext` over-reads.** It runs 4 sequential `runQuery` hops and resolves the holder name via a *full* `_listStaffNames_internal` scan (`shifts.ts:243`) on every reactive tick — yet `_getStaffNameCode_internal` (single-staff by id) already exists in `auth/internal.ts:15`. This query is subscribed by both `RootLayout` and `login`; resolve the one name by id.
5. **Dev seed inconsistency.** `seed/internal.ts:297` still writes `pos_shift_events` but not the new two-level state, so a seeded "open" booth reads as *closed* to the new runtime (`outlets.is_open` undefined → false). Dev-only, but verify seeded shift fixtures still reflect intended state; consider seeding `outlets.is_open` + a `pos_shifts` holder instead.
6. **Lossy backfill attribution.** `_backfillOneOutletStatus_internal` inserts the cutover holder with `started_via: "sop"` even when the real anchor was `handover_in`/`manager_takeover` (`migrations/internal.ts:717`). Acceptable for a one-shot migration of the single in-flight shift; note it.

---

## Nitpicks

- `pos_shifts` stores `summary` / `steps` / `open_count` / `close_count` / `prev_shift_id` with **no reader** shipping in this branch — speculative record-keeping. Fine if intentionally future-facing for reporting, but nothing consumes the shift chain yet.
- Stale comments: `_sendSignoffSummary` header (`actions.ts:18-25`) still names deleted `endOfDaySignOff`/`handoverOut` and says it routes to the "founders role" though it sends to `managers`.
- ADR-053 Consequences claims the UI "derives locked from outlet open + no holder + lastStaff" — the implementation uses that heuristic only to gate login auto-pre-stage; there is no explicit "locked" UI state. Doc slightly overstates.

---

## What the change got right (depth wins, for the record)

- **Atomic two-level writes.** `openBooth`/`endOfDay` set both levels via in-transaction `runMutation`s — no torn `(L1,L2)` state, so the impossible `(closed, holder)` cell is unreachable at runtime.
- **Stored, not derived.** `loginContext` + the gate read plain DB fields; zero event replay. The recurring `BOOTH_NOT_OPEN` self-anchored-derivation class is eliminated.
- **Migration self-containment.** Inlining `deriveIsOpen` in the migration (rather than sharing the to-be-deleted `deriveBoothState`) is the right call — it removes a deletion-ordering hazard in the same deploy; a one-shot job has nothing to diverge from after the runtime helper is gone.
- **Idempotency layering.** `managerOverride`/`managerSkipOpen` use distinct outer (`key`) vs commit (`key:commit`) idempotency keys — correctly avoids the shared-key replay-collision lesson.
- **Outlet scoping preserved.** Every operational `pos_shifts` scan index leads with `outlet_id`; `outlet_id` stays server-derived from the session. Shifts are not in the `api/v1` surface, so nothing here constrains the Frollie Pro graft.
- **Additive→enforce staging respected.** `outlets.is_open` lands `optional`; the required-flip + index drops are correctly deferred behind the prod backfill + assert.

---
*Generated by /staffreview*
