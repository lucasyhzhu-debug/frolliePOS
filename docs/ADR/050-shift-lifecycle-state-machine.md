# ADR-050: Booth shift lifecycle as a state machine over `pos_shift_events`

**Status:** Accepted (2026-06-19)

## Context

The Frollie booth runs 2–3 staff per day in overlapping shifts. Before this ADR, "shift" was an informal concept: staff logged in, sold, and locked the screen — but nothing tracked *when* a shift started, who was on it, or what the opening/closing stock count was. This made the daily Founders summary a rough estimate and left handovers entirely undocumented.

Three concrete problems that triggered the design:

1. **No shift boundary.** The daily cron at 22:00 WIB produced a summary covering the whole calendar day, not the actual trading window. If a handover happened at 15:00 WIB, there was no way to attribute sales to the correct staff.
2. **No structured handover.** The outgoing staff locked the screen; the incoming staff logged in. No checklist, no stock count, no receipted handover record.
3. **No audience-split summary.** The staff who closed did not need financials; the Founders did. Both audiences received the same daily blast, or nothing at-all.

The Frollie Pro roadmap already anticipated a shift module; this ADR instantiates it for the POS v1.2 milestone.

## Decision

### Booth state machine

Booth state is a **derived value** — never stored directly. The single source of truth is the `pos_shift_events` table. The pure function `deriveBoothState(latestEvent, wibDayStartMs)` in `convex/shifts/lib.ts` maps the most-recent row to one of four states:

| State | Meaning | Next legal events |
|---|---|---|
| `closed` | No shift open today | `start_of_day` |
| `open` | Staff is on shift and can sell | `lock`, `signoff_close`, `handover_out` |
| `locked` | Booth locked; no active session | `resume` (same staff), `manager_takeover` |
| `handover_pending` | Outgoing done; waiting for incoming staff | `handover_in` |

**Stale-autoclose rule:** if the latest event is from a prior WIB calendar day and is not `signoff_close`, `deriveBoothState` returns `closed` with `staleAutoclose: true`. This covers the "forgot to close last night" case without requiring a migration or a nightly write.

When `completeStartOfDay` runs and finds this stale condition, it does **not** silently discard the prior shift. Before opening today's shift it **auto-closes the stale shift server-side**: it records a `signoff_close` event for the *displaced* staff with `stale_autoclose: true` and that shift's computed summary (window = `[stale.shift_started_at, stale.shift_ended_at ?? wibDayWindow(stale.shift_started_at).dayEndMs]` — a locked-overnight event carries its lock time as the end; an open-overnight one clamps to the stale day's WIB end), audits `shift.signoff` (`metadata.stale_autoclose: true`), and **schedules the displaced staff's Founders summary** via the same deferred `_sendSignoffSummary` action used by a normal self-close (`endedBy: "self"`). Only then is the new `start_of_day` recorded. This guarantees a forgotten close never suppresses the prior shift's Founders summary or the morning's start-of-day record. (Because `deriveBoothState` already reports `closed` for the stale case, the CLOSED write-side guard below passes through to this branch.)

**State transitions:**

```
CLOSED ──start_of_day──► OPEN
OPEN   ──lock──────────► LOCKED ──resume──────────► OPEN
OPEN   ──signoff_close──► CLOSED
OPEN   ──handover_out──► HANDOVER_PENDING ──handover_in──► OPEN (new staff)
LOCKED ──manager_takeover──► OPEN (manager)
```

### Event types

Seven event types cover the full lifecycle. Each is a row in `pos_shift_events`:

| Event type | Transition | Session effect |
|---|---|---|
| `start_of_day` | CLOSED → OPEN | Session continues (staff already logged in) |
| `lock` | OPEN → LOCKED | Session ended (`end_reason: "manual_lock"`) |
| `resume` | LOCKED → OPEN | Fresh session required before calling `recordResume` |
| `signoff_close` | OPEN → CLOSED | Session ended (`end_reason: "force_logout"`) |
| `handover_out` | OPEN → HANDOVER_PENDING | Session ended (`end_reason: "force_logout"`) |
| `handover_in` | HANDOVER_PENDING → OPEN | Session continues (incoming staff already logged in) |
| `manager_takeover` | LOCKED → OPEN | Displaced session force-ended; manager session created |

### ADR-003 amendment: lock still ends the session

[ADR-003](./003-shared-device-ephemeral-session.md) decided that the **Lock** screen ends the session explicitly (`end_reason: "manual_lock"`). This ADR confirms that decision holds with the shift layer added on top.

The LOCKED booth state is a **booth-state-layer property** derived from the `pos_shift_events` row — it is not held by a live session. When a staff member locks, their session is ended immediately, exactly as before. Resuming requires a fresh `loginWithPin` to create a new session, then a call to `recordResume`.

This means the session lifecycle is unchanged: `staff_sessions` has no new columns, no schema migration, and the existing `end_reason` literals (`"manual_lock"`, `"force_logout"`) cover all shift-lifecycle session endings. The `"force_logout"` literal is reused for signoff, handover-out, and the displaced session in manager-takeover — the intent is recorded on the `pos_shift_events` row, not the session.

**ADR-034 ownership:** `staff_sessions` is owned by the auth module, so the shift mutations never patch it directly. End-of-day sign-off, handover-out, and lock route their session end through the internal `auth.internal._endShiftSession_internal` (`endReason ∈ {"force_logout", "manual_lock"}`), mirroring how `_commitManagerTakeover_internal` reaches `auth.internal._managerTakeoverSession_internal`. (A `ctx.db.patch` on `staff_sessions` from within `shifts/` was the C2 finding this corrects; the cross-module lint missed it because the rule keys on string-literal table names, not the `args.sessionId` indirection — `pos_shift_events` is now in the lint OWNERSHIP map.)

### Write-side state guards

`deriveBoothState` is the single source of state truth, but the lifecycle *mutations* must not assume the booth is in a legal source state — a stale client, a double-tap, or a replayed request could otherwise (e.g.) sign off a CLOSED booth or resume an OPEN one, producing a 0-duration summary or an orphan event. Each lifecycle mutation therefore re-derives the current state from the latest event (reusing the pure `deriveBoothState` — **no duplicated state logic**) **after** `requireSession` (auth first) and inside the idempotency handler, and throws a stable error unless the booth is in the allowed source state:

| Mutation | Required state | Error |
|---|---|---|
| `completeStartOfDay` | `closed` | `BOOTH_NOT_CLOSED` |
| `endOfDaySignOff` | `open` | `BOOTH_NOT_OPEN` |
| `handoverOut` | `open` | `BOOTH_NOT_OPEN` |
| `lockShift` | `open` | `BOOTH_NOT_OPEN` |
| `recordResume` | `locked` | `BOOTH_NOT_LOCKED` |
| `completeHandoverIn` | `handover_pending` | `NO_HANDOVER_PENDING` |

The stale auto-close path runs *within* the `closed` state, so `completeStartOfDay`'s CLOSED guard passes for the forgot-to-close case. `completeHandoverIn` derives its guard from the same `_latestShiftEvent_internal` read it already uses to set `linked_event_id`, so no extra query is added. Error strings are stable and surfaced verbatim to the FE.

### Hours anchored to the shift-start event

Shift duration is computed from `shift_started_at` on the `lock` / `resume` / `signoff_close` / `handover_out` rows, not from the session boundary. The `_shiftStartAnchor_internal` query recovers the most recent `start_of_day`, `handover_in`, or `manager_takeover` event (skipping `lock` events). This means accumulated shift hours **survive a lock/resume cycle** — a staff member who locks for a break then resumes later has the full shift duration, including the period before the lock.

The anchor scan is **bounded to today's WIB-day window** (`by_device_created` `gte wibDayWindow(now).dayStartMs`, then a full collect — a single day's events are few) rather than an arbitrary `.take(50)` ceiling. A busy day could otherwise push the anchor past the 50-row window, silently miss it, and fall back to `?? now` → a 0-duration / 0-sales summary. Because stale prior-day shifts are auto-closed by `completeStartOfDay`, the current shift's anchor is always within today's window, so the day-bound is correct; a null return is reachable only for a genuinely anchorless booth (unreachable in normal flow).

The `computeShiftHoursMs(shiftStartedAt, endedAt)` pure helper in `lib.ts` is a simple subtraction. The anchor walk is the only complexity.

### Manager-takeover-as-handover

A manager at a locked booth can take over without waiting for a formal handover-out from the displaced staff. The `managerTakeover` action (Node runtime, argon2id PIN verify) does the following atomically in `_commitManagerTakeover_internal`:

1. Force-ends any active session on the device (`end_reason: "force_logout"`).
2. Creates a new manager session.
3. Records a `manager_takeover` event with `takeover: true` and `outgoing_uncounted: true` (the displaced staff did not complete a stock count).

The `outgoing_uncounted: true` flag is surfaced in the Founders Telegram summary so managers know the opening count for the manager's shift cannot be reconciled against the prior staff's closing count.

After the commit, a deferred `_sendTakeoverSummary` action reconstructs the displaced staff's shift window from the anchor and dispatches a `staff_shift_signoff` Founders summary with `endedBy: "manager"` + `outgoingUncounted: true`.

### Audience-split summary

The staff-facing close screen shows **shift hours + stock count only** — no financials. Financials (total sales IDR, transaction count, manual-BCA items and totals) go exclusively to the **Founders** Telegram group via the `staff_shift_signoff` template.

This split applies to all three closing paths: `signoff_close` (self-close), `handover_out` (outgoing in a handover pair), and the displaced staff in a `manager_takeover`. The Founders see all three.

### Stock counts use the existing recount path

SOP checklists include a stock count step. These counts write `recount` movements via the existing `api.inventory.public.recordRecount` mutation — no new stock path is introduced. The shift module has no direct write access to `pos_stock_movements`; it delegates entirely to the inventory module.

### SOP steps stored on the event

Each event carries a `steps` array (`{ key, label, type, confirmed_at }[]`) capturing which SOP checklist items the staff completed and when. The `confirmed_at` timestamp is client-supplied for display only — all server-side business logic uses `shift_started_at` / `shift_ended_at` / `created_at`, which are set by the server (ADR-031).

## Alternatives considered

**Store booth state as a field on `pos_settings` or a separate singleton table.** Rejected: a mutable state field is a concurrent-write hazard (two events racing to update the same row) and loses history. The event-sourced approach makes the full shift log queryable and requires no special conflict resolution.

**Derive state from the session rather than from shift events.** Rejected: sessions already end on lock (ADR-003). A locked booth has no live session, so session state cannot represent LOCKED vs CLOSED. Separating the shift layer from the session layer is the key architectural insight.

**New `end_reason` literals for signoff/handover.** Rejected: the existing `"force_logout"` literal is accurate (the shift machinery forces the logout), and adding new literals would require a schema migration with no meaningful behavioural difference. The shift event type carries the intent.

**Manager takeover as a separate approval flow (Telegram token + PIN).** Considered but deferred: the v1.2 scope is booth-only. A Telegram-routed takeover for off-booth managers is a natural follow-up but not required for the single-device POS.

## Consequences

**Positive:**
- Shift boundaries are exact (event timestamps, WIB-anchored) — the Founders daily summary can be decomposed by shift for the first time.
- The state machine is pure and deterministic (`deriveBoothState` has no side effects, no DB reads).
- Hours survive lock/resume without special casing — the anchor walk is a single index scan.
- The audience split (staff sees hours+stock; Founders see financials) is enforced at the data layer, not via screen-level filtering.
- `outgoing_uncounted` provides a clear audit signal when a manager takeover bypasses the normal stock count.

**Costs / risks:**
- A new table (`pos_shift_events`) must be deployed before the FE routes go live. The atomic Vercel build (backend-first) handles this.
- The stale-autoclose logic (prior-day events treated as closed) depends on `wibDayWindow` from `convex/lib/time.ts`. Any drift in the WIB offset would cause the wrong boundary.
- Staff who forget to close at night will trigger `staleAutoclose: true` on the next day's login — the FE should surface this clearly so they complete a belated close before starting the new day.

## Cross-references

- [ADR-003](./003-shared-device-ephemeral-session.md) — shared device, ephemeral session (amended above: lock still ends session; LOCKED is booth-state not session-state).
- [ADR-031](./031-convex-server-time-wins.md) — server time wins; `shift_started_at` / `shift_ended_at` set inside the handler.
- [ADR-034](./034-deep-modules-surface-apis.md) — deep modules / surface APIs; `shifts/` is a standalone module; stock counts route through `inventory/` not a direct write.
- [ADR-041](./041-recount-staff-absolute-stock-update.md) — recount source; SOP stock counts use the `recordRecount` mutation.
- [ADR-046](./046-action-cache-auth-before-lookup.md) — auth-before-cache for `managerTakeover` action.
- **`convex/shifts/`** — `schema.ts`, `lib.ts`, `public.ts`, `internal.ts`, `actions.ts`.
- **Telegram template:** `staff_shift_signoff` (in `convex/telegram/send.ts` + `convex/lib/telegramHtml.ts`).
