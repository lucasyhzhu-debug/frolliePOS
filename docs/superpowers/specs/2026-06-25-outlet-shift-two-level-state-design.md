# Two-Level Booth State: Outlet Status + Shift Holder (supersedes ADR-050)

**Date:** 2026-06-25
**Status:** Design — pending review
**Supersedes:** ADR-050 (shift lifecycle state machine), the user-anchored / derived `deriveBoothState` model
**Related incidents:** #138/#139 (this design IS #139), #140 (stopgap), PR #143 (stopgap-2), `handover-no-session-deadlock`, `countstep-handover-dead-button`

---

## 1. Problem

Booth open/closed is currently **derived** from the latest `pos_shift_events` row via `deriveBoothState` (`closed`/`open`/`locked`/`handover_pending`), and the state machine is **user-anchored**: `lock` ends the session, only the *same* staffer can `resume`, and re-opening a stranded booth needs a racy client-side `recordResume` or a manager takeover.

This has caused repeated production booth-down incidents because **one derived state simultaneously gates logins, locks, and handovers**, and the un-stick paths fail closed:

- **2026-06-23 (#138):** end-of-day sign-off threw `BOOTH_NOT_OPEN` on a locked booth.
- **2026-06-25 (recurrence):** `lockShift` / handover threw `BOOTH_NOT_OPEN` on a locked booth — the #140 stopgap had only relaxed sign-off. (Stopgap-2: PR #143.)
- **2026-06-20:** session-less handover screen ↔ login bounce-loop deadlock.

Root cause (owner's framing): **outlet open/closed and shift start/end are two different levels that are currently conflated into one derived value.** The fix is to separate them and make outlet status *stored*, not derived.

## 2. Goals

- Outlet open/closed is a **stored per-outlet flag**, the single source for the start-of-day SOP gate.
- Logins, logouts, locks, and handovers **never** change outlet status. Only end-of-day closes the outlet; only start-of-day SOP (or a manager skip) opens it.
- Every blocked state has a **guaranteed, signposted resolution** — no silent dead-ends.
- Eliminate the `locked` / `handover_pending` / same-staff-resume / session-less-handover machinery that caused the incidents.

## 3. The two-level taxonomy

### Level 1 — Outlet status (day-level, per outlet)
A stored boolean: the physical booth is operating today.

- `closed → open`: completing the **start-of-day SOP**, or a **manager skip** (opens without the checklist).
- `open → closed`: the final step of **end-of-day sign-off**.
- Nothing else touches it.

### Level 2 — Shift (staffer-level, within an open outlet)
*Who is working right now.* At most **one active shift holder** per open outlet. Many shifts per outlet-open day.

- A shift **starts** when a staffer takes over: at outlet-open (the opener), or at a handover.
- A shift **ends** at handover-out, end-of-day, or manager override.
- A shift spans **multiple login sessions**: lock = logout = a pause inside the shift; the holder logging back in resumes the *same* shift (wall-clock hours keep accumulating, lunch breaks included).
- The **only** way to transfer the booth between people is **handover**, driven by the outgoing staffer. There is no session-less incoming-handover screen.

### The gate that fixes the bug
The start-of-day SOP redirect keys off **Level 1 (`outlet.is_open`) only** — never off a derived event chain. A locked/handed-over/mid-shift booth is still `open` at Level 1, so logging in, locking, and handing over can never raise `BOOTH_NOT_OPEN`.

## 4. Login behaviour (the new gate)

When a staffer taps their name on the login screen:

1. `outlet.is_open == false` → **start-of-day SOP** (`openBooth`; managers may skip → `managerSkipOpen`, no checklist).
2. `is_open == true`, **holder == me** → resume the same shift → POS. No mutation (the shift row is untouched; a fresh login session just attaches to the existing holder shift). Never blocked.
3. `is_open == true`, **holder ≠ me** → **BLOCKED**: *"{Holder} hasn't closed their shift yet. They need to log in and hand over first."* Login does not proceed. Offers a **Manager override** action.
4. `is_open == true`, **no holder** (prior shift released via handover/override) → **`startShift`**: create a new shift (`started_via: "handover"`, `prev_shift_id` = the last ended shift); if the previous shift ended via handover, the first step is a **stock-count confirm** recorded as `open_count` (the incoming count). → POS.

The holder check is a public read (staff list is already public; current holder is exposed by the `loginContext` query) so the block is shown *before* PIN entry. The holder can always log in, so they are never stuck. `loginContext` is pre-login and session-less; it resolves the outlet from the device (`_getDeviceOutletId_internal`) and must **degrade gracefully on an unbound device** (return `{outletOpen:false, holderStaffId:null}` rather than throwing `DEVICE_HAS_NO_OUTLET`, so an unactivated device still renders the login screen instead of erroring).

> **Why `startShift` is distinct from `openBooth`:** `openBooth` is the Level-1 open (closed → open) and rejects an already-open outlet (`BOOTH_ALREADY_OPEN`); `handover` requires the caller to be the current holder. The *open-outlet, no-holder* takeover (case 4) is neither — it is a Level-2-only shift start on an outlet that is already open. It needs its own mutation. Symmetry: `openBooth`/`managerSkipOpen` start the **first** shift of the day (and flip Level 1); `startShift` starts every **subsequent** shift after a handover/override (Level 1 untouched).

## 5. Manager override (escape hatch)

When a staffer is blocked (case 3) and the holder is genuinely unavailable:

- A **manager enters their own PIN** → **force-ends** the absent holder's shift: records the shift's summary, sets `ended_via: "manager_override"`, flags it uncounted (`outgoing_uncounted: true`), releases the holder.
- The override does **not** make the manager the holder. The shift is now released, so the staffer who was trying to log in proceeds as a normal **new shift** (case 4).

This replaces the old "manager takeover of a locked booth."

## 6. Schema

### Level 1 — new fields on `outlets`
```ts
is_open:    v.boolean(),                                  // THE SOP gate
opened_at:  v.union(v.number(), v.null()),
opened_by:  v.union(v.id("staff"), v.null()),
opened_via: v.union(v.literal("sop"), v.literal("manager_skip"), v.null()),
closed_at:  v.union(v.number(), v.null()),
closed_by:  v.union(v.id("staff"), v.null()),
```
Current status is one boolean read. Full open/close history lives in `audit_log` (append-only, ADR-007). No derivation.

### Level 2 — new table `pos_shifts` (one row per shift segment)
```ts
pos_shifts: defineTable({
  outlet_id:     v.id("outlets"),
  device_id:     v.string(),
  staff_id:      v.id("staff"),                           // the holder
  started_at:    v.number(),
  started_via:   v.union(v.literal("sop"), v.literal("manager_skip"), v.literal("handover")),
  ended_at:      v.union(v.number(), v.null()),           // null ⇒ ACTIVE holder (the gate)
  ended_via:     v.union(
                   v.literal("handover"),
                   v.literal("end_of_day"),
                   v.literal("manager_override"),
                   v.null(),
                 ),
  open_count:    v.union(v.number(), v.null()),           // incoming stock count
  close_count:   v.union(v.number(), v.null()),           // outgoing stock count
  outgoing_uncounted: v.union(v.boolean(), v.null()),     // true on manager_override
  steps:         v.array(stepValidator),                  // checklist confirmations
  summary:       v.union(
                   v.object({
                     durationMs: v.number(),
                     totalSalesIdr: v.number(),
                     txnCount: v.number(),
                     manualBcaCount: v.number(),
                     manualBcaTotalIdr: v.number(),
                   }),
                   v.null(),
                 ),
  prev_shift_id: v.union(v.id("pos_shifts"), v.null()),   // handover chain
  created_at:    v.number(),
})
  .index("by_outlet_active", ["outlet_id", "ended_at"])   // current holder = ended_at == null
  .index("by_staff_started", ["staff_id", "started_at"])
  .index("by_outlet_started", ["outlet_id", "started_at"])
```
**Current holder = the single `pos_shifts` row for the outlet with `ended_at == null`.** Outlet-fence compliant (every scan index leads with `outlet_id`, per business rule #26).

### Unchanged
`staff_sessions` (login→logout, many per shift, `manual_lock` stays). A shift spans multiple sessions.

## 7. Transitions

| Action | Level 1 (outlet) | Level 2 (`pos_shifts`) | Session |
|---|---|---|---|
| Start-of-day SOP (closed) | `is_open=true`, `opened_via="sop"`, `opened_by` | create, `started_via="sop"`, holder, `open_count` | — |
| Manager skip (closed) | `is_open=true`, `opened_via="manager_skip"` | create, `started_via="manager_skip"`, no checklist | — |
| Lock | unchanged | unchanged (holder keeps shift) | end, `manual_lock` |
| Holder logs back in | unchanged | unchanged (resume) | new session → POS |
| Different staffer, holder active | — | **BLOCKED** | refused |
| Handover (holder, outgoing) | unchanged | end, `ended_via="handover"`, `close_count`, `summary` | end session |
| Next staffer, no holder (**`startShift`**) | unchanged | create, `started_via="handover"`, `open_count` confirm, `prev_shift_id` | new session → POS |
| End-of-day (holder) | `is_open=false`, `closed_by/at` | end, `ended_via="end_of_day"`, `summary` | end session |
| Manager override (blocked) | unchanged | force-end prior, `ended_via="manager_override"`, `summary`, `outgoing_uncounted=true` | then normal new shift |

**Per-shift hours** = `ended_at − started_at` (wall-clock; includes lock gaps). **Per-shift summary** (hours + sales over the shift window) fires on every shift end (handover, end-of-day, manager-override) — same Telegram payload/path as today's `_sendSignoffSummary`.

## 8. Retired (superseded by the new ADR)

- `deriveBoothState` + `BoothState` (`locked` / `handover_pending`).
- `pos_shift_events` event types `lock` / `resume` / `handover_in` / `handover_out` / `start_of_day` / `signoff_close` / `manager_takeover` as state transitions.
- `recordResume`, session-less `completeHandoverIn`, `assertBoothState`'s `BOOTH_NOT_OPEN/LOCKED/NO_HANDOVER_PENDING` guards.
- RootLayout `/shift/handover` no-session exemption + bounce handling; login.tsx racy `recordResume`-on-login.
- `shiftSkip.ts` client-only sessionStorage bypass → real server `managerSkipOpen` action (audited, flips Level 1).
- The `manager_takeover` locked-booth action → repurposed as `managerOverride` (force-end shift).

`pos_shift_events` is **kept read-only** for historical/audit reads; **no new writes** — all new shift writes go to `pos_shifts`.

**PR #143 stopgap is folded in.** The interim `lockShift`/`handoverOut` "tolerate `locked`" relaxations (deployed to prod 2026-06-25) live on the `assertBoothState` guards that this rework deletes outright. #143 stays merged/deployed as the interim safety net; this phase removes those mutations and their guards entirely, so the stopgap is superseded rather than carried forward. No separate revert needed — the rewrite replaces the files.

## 9. Migration (additive, prod-safe)

1. Add `outlets.is_open` (+ metadata) as **optional**, defaulting closed.
2. Add `pos_shifts` table.
3. Backfill, per outlet: derive current status from the latest `pos_shift_events` row using **derivation logic inlined into the migration** (latest type ∈ `lock`/`resume`/`handover_in`/`handover_out`/`manager_takeover`/`start_of_day` from the current WIB day → `is_open=true`; `signoff_close`/none/prior-WIB-day → `false`). For any outlet that backfills open with an active staffer, create one `pos_shifts` holder row (`started_at` = the shift anchor, `ended_at=null`). **The migration MUST NOT import `deriveBoothState`** — that function is deleted in this same phase, so by the time the backfill is *run* on prod (post-deploy) it would no longer exist. Inline the small mapping so the backfill is self-contained.
4. Flip `is_open` to **required** once backfilled (mirrors the v2.0 additive→enforce pattern; see `staged-migration-additive-enforce-lessons`).

**Deploy atomicity (load-bearing).** This phase **renames public functions** (`lockShift→lock`, `completeStartOfDay→openBooth`, `endOfDaySignOff→endOfDay`, `handoverOut→handover`, removes `recordResume`/`completeHandoverIn`/`boothState`). Per CLAUDE.md, a public-function rename is **deploy-skew-fatal** — old FE + new BE (or vice-versa) throws. It MUST ship in the single atomic Vercel production build (`npx convex deploy` + FE together), never hand-deployed one side. The PR #143 stopgap (old names, currently on prod) is replaced wholesale by this build.

**This also self-heals prod live:** today's stuck `locked` booth backfills to `is_open=true` + holder=Sisca, so it becomes immediately operable under the new model (independent of the PR #143 stopgap already deployed).

## 10. New ADR

Write **ADR-053: two-level booth state (outlet status + shift holder)**, superseding ADR-050. Capture: the two levels, why stored-not-derived, the single-holder rule, handover as the only transfer, manager override, and the retired machinery. Update CLAUDE.md business rule #23 + the `shifts/` module row.

## 11. Testing

- **Level 1:** SOP opens; manager-skip opens without checklist; end-of-day closes; login gate keys off `is_open`.
- **Level 2:** holder resume across lock/logout (same shift, hours accumulate); different-staffer block; handover release → next staffer starts with incoming count; manager override force-end → blocked staffer starts.
- **No-regression:** the #138/#140/#143 scenarios (return to a non-open booth) now resolve cleanly — lock/handover/login never raise `BOOTH_NOT_OPEN`.
- **Migration:** backfill maps each `deriveBoothState` value to the correct `is_open` + creates the holder row.
- Per-shift summary fires once per shift end with the correct window; payload parity with today's path.

## 12. Out of scope

- Multiple concurrent holders per outlet (explicitly rejected — one holder, transfer via handover only).
- Changing the daily owners/managers rollup content (it consumes the same per-shift summaries).
- Cross-outlet shift moves; cockpit/owner plane (separate, ADR-052).
