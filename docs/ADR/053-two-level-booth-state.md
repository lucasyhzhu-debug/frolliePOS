# ADR-053: Two-Level Booth State (Stored)

**Status:** Accepted
**Date:** 2026-06-26
**Supersedes:** [ADR-050](./050-shift-lifecycle-state-machine.md)

## Context

ADR-050 derived booth state from a `pos_shift_events` event log via a pure function `deriveBoothState`. This worked for a single-device single-outlet world but created two problems:

1. **State is ephemeral** — any new subscriber (new device load, background cron) had to re-derive from the latest event row on every query. The event table became a state-machine log masquerading as a database.
2. **Outlet scoping is implicit** — multi-outlet expansion (ADR-051) required every state derivation to carry outlet context through the call chain.

## Decision

Replace the derived single-level state with **two explicitly stored levels**:

### Level 1 — Outlet open flag (`outlets.is_open`)
- Set to `true` by `openBooth` (start-of-day) or `managerSkipOpen` (skip SOD).
- Cleared to `false` by `endOfDay` (end-of-day sign-off).
- This is the **SOP gate**: a shift cannot start unless the outlet is open; a day cannot end unless the outlet is open.
- Fields: `outlets.is_open`, `outlets.opened_at`, `outlets.opened_by`, `outlets.closed_at`, `outlets.closed_by`.

### Level 2 — Active shift holder (`pos_shifts` table)
- A row with `ended_at == null` means a staff member currently holds the shift.
- `startShift` creates the row; `endOfDay` (or `handover` out-half) sets `ended_at`.
- **Handover** is a person-to-person transfer: the outgoing holder's shift ends (`ended_at` set), the incoming holder's shift starts (new row inserted) — no intermediate `handover_pending` booth state.
- **Lock** is a plain session logout (`lock`): the holder row and `outlets.is_open` stay unchanged; the same staff re-authenticates via standard login to resume (no separate resume mutation — the holder was never released). No "locked" booth state exists.
- **`managerOverride`** is the escape hatch when the original holder is unavailable: force-ends the stranded `pos_shifts` row and writes an audit entry. No Telegram approval required (manager is present at the booth and authenticates with PIN).

### Retired machinery (ADR-050)
- `deriveBoothState` pure function — deleted.
- `BoothState` / `LatestEvent` / `OPEN_TYPES` types/consts — deleted.
- `pos_shift_events` table — kept read-only/legacy for historical rows; no new writes.
- Old lifecycle mutations: `completeStartOfDay`, `endOfDaySignOff`, `handoverOut`, `lockShift`, `recordResume`, `completeHandoverIn` — deleted from `shifts/public.ts` (entire file deleted).
- `managerTakeover` action + `_commitManagerTakeover_internal` + `_managerTakeoverSession_internal` + `_latestShiftEvent_internal` + `_sendTakeoverSummary` — deleted.

## Migration

`backfillOutletStatus` (migration Task 10): back-fills `outlets.is_open` from the last known `pos_shift_events` row per outlet. Run before deploying new FE that calls `openBooth`/`startShift`.

## Consequences

- **Simpler state reads**: `outlets.is_open` + `pos_shifts` are plain DB fields — no derivation, no event replay.
- **Outlet scoping is explicit**: every Level-1 and Level-2 mutation carries `outlet_id` from the session context.
- **`pos_shift_events` is legacy**: existing rows are preserved for audit history; no new rows are written.
- **Lock behaviour change**: "locked" is no longer a booth state — it is a session state. UI derives "locked" from: outlet is_open AND no active shift holder AND there is a `lastStaff` in localStorage.
- **Handover is synchronous**: no `handover_pending` intermediate state. The outgoing staff ends their shift; the incoming staff immediately starts theirs.
