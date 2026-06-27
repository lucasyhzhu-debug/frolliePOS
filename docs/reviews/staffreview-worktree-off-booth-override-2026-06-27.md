# Staffreview — off-booth manager override (`shift_override`, v1.3.1)

**Branch:** `worktree-off-booth-override` · **Base:** `c0f8241..7547062`
**Reviewer lens:** senior-engineer architectural review through the deep-module / surface-API philosophy (ADR-034)
**Date:** 2026-06-27

## Summary

**Verdict: this change makes the affected modules DEEPER, not shallower.** `_managerOverrideCommit_internal`
stays the single deep writer and now serves *both* the booth-inline and off-booth approve callers behind the
same narrow interface; the two new args (`closeOutlet`, `source`) are earned, not bloat. `approvals/` adds
`shift_override` strictly through the sanctioned add-a-kind envelope (rule #19 / "How to add a feature" #8) with
**no new architecture** — it reuses `pos_approval_requests`, the hashed single-use token, `/approve/:token`,
per-outlet Telegram routing, and the PIN-verify approve pattern. Every cross-module read is routed through an
existing `_internal` facade (`auth._getDeviceOutletId_internal`, `auth._listStaffNames_internal`,
`auth._getByCode_internal`, `shifts._getActiveShift_internal`, `shifts._buildSignoffSummary_internal`,
`outlets._getOutlet_internal`, `outlets.status._setOutletClosed_internal`) — no reach into another module's
`schema.ts` or table internals. The public surface widens by exactly two earned entry points
(`requestShiftOverride`, `approveShiftOverride`). All four touch-points are fully wired and internally
consistent; the single-writer invariants (`validateContext`, `_createRequest_internal`, the shared commit) are
preserved. SEC-07 lockout isolation, token-before-cache (rule #21/I5), and distinct `:commit` idempotency keys
are all correctly carried from `approveSpoilage`/`approveManualPayment`.

The defects below are **logic/audit/UX gaps inside an otherwise sound envelope**, not structural erosion. One is
a correctness defect in the new writer path (acts on the wrong entity under a race) and should be fixed before
merge.

## Critical Issues

### C1 — Off-booth approve can force-end the *wrong* active shift (stale-snapshot TOCTOU)

`approveShiftOverride` → `_managerOverrideCommit_internal` ends **"the current active hold for this outlet,"**
resolved at *approve* time via `_getActiveShift_internal(outletId)` (`shiftsInternal.ts:181`, ends
`holder._id`). The commit takes **no `shift_id`** and never compares the live hold to the
`ShiftOverrideContext.shift_id` that was snapshotted at request time and shown on the approval card.

The token lives for 60 minutes. During that window the holder shown on the card ("Booth held by: Sasi") can turn
over — e.g. Sasi's hold is ended by some other path (a booth-inline override, or Sasi returns and closes) and a
new staffer (Sisca) starts. The original off-booth request is still pending (single-use token unredeemed). The
manager opens the link, still sees **"held by Sasi,"** taps **Close booth**, and the commit force-ends
**Sisca's** active shift *and* shuts the booth on her mid-session. The approver released a different person from
the one they were shown.

This is a silent wrong-target state mutation in the new writer path, and the field needed to prevent it
(`shift_id`) is **already captured** — it is just unused as a guard. The dedup keys on `entity_id = hold._id`,
so a fresh hold spawns a *new* request rather than invalidating the old one, which is exactly what leaves the
stale request approvable.

**Fix:** thread the snapshotted `shift_id` into the commit (or guard in the approve action) and compare to
`holder._id`; on mismatch, no-op (treat like "hold already gone") or throw `SHIFT_CHANGED` so the manager gets a
"booth state changed — re-request" message instead of releasing an unintended staffer. The booth-inline path
does not need this (the manager acts immediately, no stale snapshot), so the guard can be scoped to the
non-empty-`shift_id` case.

## Improvements

### I1 — Outlet close via the override path is unaudited (`outlet.closed` blind spot)

`_setOutletClosed_internal` (`outlets/status.ts:31`) is a bare `db.patch` — it emits **no audit row**. In the
override-close path the only audit is `shift.manager_override` with `metadata.resulting_state:"closed"` (holder
branch only). Consequences:

- **No-holder + `closeOutlet:true`** (reachable via inline `managerOverride` "Close" on an open holderless
  booth — and exercised verbatim by the new test `_managerOverrideCommit closeOutlet:true with NO hold still
  closes the outlet`) produces **zero audit rows** for a Level-1 booth state change. That violates the
  "every state-changing mutation emits `logAudit`" discipline (ADR-007, "How to add a feature" #4).
- Any consumer that counts `outlet.closed` (dashboards, "when did this booth close today," the managers daily
  summary) **silently undercounts** override-closes, because the override-close never emits that verb — it is
  only discoverable by parsing `shift.manager_override` metadata.

`endOfDay` emits `outlet.closed`; the override-close should too. Add an explicit `outlet.closed` audit (with the
correct `source`) in the `closeOutlet` branch of the commit, independent of whether a holder existed.

### I2 — A denied request leaves the requester stuck on "waiting" with no feedback

The login waiting-state only clears reactively when `ctx.holderStaffId === null` (`login.tsx` useEffect). A
**denial** (`denyRequest`) does **not** end the hold, so `holderStaffId` stays non-null and the blocked booth
shows **"Requested — waiting for a manager to approve"** indefinitely. The requester gets no signal that the
override was declined (and no reason, even though the manager is prompted for one). The "Back" button is still
rendered, so it is not a hard lock — but the messaging is actively misleading.

The FE already has the handle to fix this: `requestShiftOverride` returns `{ requestId }`, which is currently
discarded. Subscribe to `approvals.public.getRequestStatus` / `useApproval` on that id and surface a
"declined — try inline override or re-request" state on `denied`/`expired`, mirroring how the approve screen
handles terminal states.

## Refinements

### R1 — API_REFERENCE doc regression on `managerOverride` args

The edited row documents `shifts.actions.managerOverride` as taking `managerStaffCode: string`, but the action
still takes `managerStaffId: v.id("staff")` (`shifts/actions.ts`). The pre-edit row was correct
(`managerStaffId`); the edit introduced the wrong arg name. Fix the doc back to `managerStaffId`.

### R2 — Commit closes the outlet *before* the no-hold check (intentional, lightly commented)

`_managerOverrideCommit_internal` now calls `_setOutletClosed_internal` unconditionally (when `closeOutlet`)
ahead of the holder lookup, so a close still happens with no holder. This is correct and test-covered, and the
inline comment explains the edge — fine. It is the right ordering (one transaction, atomic rollback on throw).
No change beyond the I1 audit addition.

### R3 — Send-failure deletes the request row but orphans the append-only `shift_override.requested` audit

`_createRequest_internal` emits `KIND_AUDIT.shift_override.requested` *before* the action sends the card; on
Telegram failure the action deletes the request row and rethrows, leaving an orphan `.requested` with no
follow-up. This is **consistent with `requestManualPaymentApproval`/`notifyStaffLockout`** (the established
delete-on-send-failure recovery), so it is acceptable as-is — noting only for parity awareness, not as a change
request.

### R4 — Minor duplication / nits

- `login.outcomeClose|outcomeRelease` and `approve.outcomeClose|outcomeRelease` are identical strings in
  different namespaces — acceptable, could share one key.
- `ShiftOverrideVariant` computes `shiftDurationMs = Date.now() - shift_started_at` once per render
  (non-reactive) — fine for a static review screen.
- `ShiftOverrideContext.shift_id` is presently only a dedup/display field; once C1's guard lands it becomes
  load-bearing (a good outcome — it stops being dead context).

## Scope checks (clean)

- **Graft integrity (Frollie Pro):** nothing here touches `api/v1/` or the cross-deployment HTTP contract.
  `shift_override` is POS-internal; the new audit verbs and kind literal are additive. No new coupling that
  makes the v1.1+ integration harder.
- **Schema/migration:** adding `"shift_override"` to the `kind` union (schema + both internal validators) is an
  additive validator widening — safe, no migration, no field removal (the safe direction per the
  field-removal-blocks-deploy hazard).
- **Idempotency harness:** reused, not bypassed. Distinct keys (`:commit` for the commit, bare key for
  `_markResolved`) correctly avoid the shared-key replay collision; token-auth runs before the cache lookup
  (rule #21/I5). SEC-07 isolation (`countTowardLockout:false`, `OFF_BOOTH_DEVICE_ID`, per-token cap) is intact.
- **Deploy skew:** `managerOverride` gains a *required* `resultingState` arg; both FE callers (`lock.tsx`,
  `login.tsx`) are updated and there are no other callsites. Ships atomically via the single build — safe.
- **Over/under-engineering:** no gratuitous abstraction; the shared-commit funnel is the correct single-writer
  call and the two new args are earned. No shallow pass-throughs introduced.
