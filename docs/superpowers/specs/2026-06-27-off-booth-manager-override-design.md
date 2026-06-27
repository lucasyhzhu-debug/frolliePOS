# Off-booth manager override — `shift_override` approval kind

**Date:** 2026-06-27
**Target version:** v1.3.1 (shift-lifecycle hardening)
**Status:** design — pending staffreview

## Problem

A booth can be left in an **open + held** state by a staffer who is unreachable (left without
end-of-day close, or opened then locked the phone). The next staffer cannot log in / start their
day because the outlet is open and the shift is held by someone else. The only release valve today
is `shifts.managerOverride` — a **booth-inline, manager-PIN** action. If no manager is physically
at the booth, the booth is stuck until someone with the manager PIN arrives.

This actually happened in prod on 2026-06-27 (booth "Block M": Sasi opened + locked, Sisca blocked).
It was resolved by a manual prod write (`_managerOverrideCommit_internal` + `_setOutletClosed_internal`
via CLI) — proof the fix is two writes, but also proof there is no remote, owner-driven path.

## Goal

Let a manager release a stranded booth **remotely, from Telegram**, by approving an override with
their booth PIN — exactly the way manual-payment / refund / spoilage / PIN-reset approvals already
go off-booth (ADR-035: token authorises VIEW, PIN authorises ACT). The booth-inline override stays
as the present-manager fast path.

## Non-goals

- No change to the override's *meaning* beyond making the resulting booth-state a choice (below).
- No owner-cockpit-OTP approval path (decided: manager booth-PIN only — see Decisions).
- No new Telegram role / chat. Reuses the per-outlet `managers` chat (Spec 4 routing).
- No auto-override / time-based auto-release. A human manager must approve every override.

## Decisions (from brainstorm 2026-06-27)

1. **Approver & credential:** *any active manager*, via their **booth manager-PIN**, through the
   existing `/approve/:token` flow. (The owner row `Lucas` has no booth PIN — `owner-cockpit-no-booth-pin`
   — so the owner approves as the *manager* row `Lucas` S-0001. No OTP bridge.)
2. **Resulting booth state: approver picks.** The `/approve` screen offers two outcomes —
   **Close booth** (end hold + `is_open=false`; next staff does a fresh start-of-day) or
   **Release, keep open** (end hold only; next staff steps into the open booth). The commit takes
   the choice as a parameter; the booth-inline path offers the same choice.
3. **Booth UX: both paths.** The "Manager override" control opens the same two-path sheet every
   manager-PIN gate uses — *Enter manager PIN here* (inline) **or** *Request via Telegram* (off-booth).

## Architecture — new approval kind (the sanctioned mechanism)

Adding `"shift_override"` follows CLAUDE.md rule #19 / "How to add a feature" #8 — the four
touchpoints that `manual_payment_override`, `refund`, and `spoilage` already wire. No new
architecture: reuses `pos_approval_requests`, the single-use hashed token (`mintUrlSafeToken`,
60-min TTL), the `/approve/:token` UI, per-outlet Telegram routing, and the PIN-verify approve-action
pattern. The single-writer invariants (`_createRequest_internal`, `validateContext`) are preserved.

### Touchpoint (a) — kind + context (`convex/approvals/`)

- `kinds.ts`: add `"shift_override"` to the `ApprovalKind` union; add a `validateContext` case;
  add `KIND_AUDIT` (`shift_override.requested` / `.approval_resolved` / `.denied`); add
  `KIND_TEMPLATE` (`shift_override`).
- `ShiftOverrideContext` — snapshotted at request time so the approver previews exactly what they
  release, **before** entering PIN:
  ```ts
  type ShiftOverrideContext = {
    shift_id: string;            // Id<"pos_shifts"> serialised — the active hold being ended
    device_id: string;           // booth device; commit resolves outlet from it (existing path)
    outlet_label: string;        // display only
    stranded_staff_name: string; // who currently holds the booth
    shift_started_at: number;    // for duration display
    sales_so_far_idr: number;    // integer rupiah (ADR-015) — what's been rung since open
    txn_count: number;
  };
  ```
  `validateContext("shift_override", …)` enforces non-empty `shift_id`/`device_id`, integer
  `sales_so_far_idr`/`txn_count`, and string display fields. (No cross-sum check like refund —
  there is no total-vs-lines lie surface here.)
- `schema.ts` / `internal.ts` validators: extend the kind/context validators so the row inserts.

### Touchpoint (b) — Telegram template (`convex/telegram/send.ts` + `convex/lib/telegramHtml.ts`)

- Add `"shift_override"` literal to `sendTemplate`'s `kind` union.
- `renderShiftOverride(ctx)` in `telegramHtml.ts` — a card showing outlet, stranded staff, how long
  the booth's been open, and sales-so-far, with a **URL button → `${POS_BASE_URL}/approve/${rawToken}`**
  (never `callback_data`, per #8). Routes to the **per-outlet `managers` chat** via
  `resolveOutletChatId(ctx, "managers", outletId)` (Spec 4); the request carries `outlet_id`.

### Touchpoint (c) — `/approve` UI variant (`src/routes/approve/index.tsx`)

`src/routes/approve/index.tsx` holds **one component per kind** (`staff_pin_reset`,
`manual_payment_override`, `refund`), each with its own `staffCode` + PIN `useState` and an
`approve.err*` error map. There is **no** `approve/pin.tsx`.

- Add a `ShiftOverride` component there: renders the context card (outlet, stranded staff, how long
  open, sales-so-far) + **two outcome buttons** ("Close booth" / "Release, keep open") + the standard
  **staff-code + PIN** entry (every kind component collects the approver's `managerStaffCode`).
- The chosen outcome sets `resultingState`; the approve button calls `approveShiftOverride({ token,
  managerStaffCode, managerPin, resultingState, idempotencyKey })`.
- Register any new error literals in the `t("approve.err*")` switch (reuse `NOT_MANAGER`,
  `INVALID_PIN`, `TOKEN_*`, `REQUEST_*` — all already mapped).

### Touchpoint (d) — request + approve actions (`convex/approvals/actions.ts`)

- `requestShiftOverride` (action) — **session-less**, called from the blocked login screen. The
  next staffer has NO session (the booth is blocked — that's the whole problem), so this takes
  `{ deviceId, idempotencyKey }`, NOT a `sessionId`. It resolves the outlet from the device
  (`internal.auth.internal._getDeviceOutletId_internal`), reads the active hold
  (`_getActiveShift_internal(outletId)`) — **if none, return early WITHOUT a card** — builds the
  context (sales snapshot via `_buildSignoffSummary_internal`, see I2), calls
  `_createRequest_internal(kind:"shift_override", entity_type:"pos_shifts", entity_id: shift_id,
  outletId, …)`, sends the Telegram card, then `_markNotified_internal`. **Dedup** via the existing
  `_listPendingByKind_internal({ kind:"shift_override", entityId: shift_id, outletId })` → return the
  existing request if found (manual-payment precedent; no new internal). Session-less device→outlet
  resolution mirrors `notifyStaffLockout`.
- `approveShiftOverride` (action) — `{ token, managerStaffCode, managerPin, resultingState,
  idempotencyKey }`. **Copy `approveSpoilage`'s envelope verbatim** (it is the closest precedent):
  (1) token lookup `_getByTokenHash_internal` + constant-time `timingSafeEqual` compare + state
  guards (`kind === "shift_override"`, pending, not expired) — **before** the idempotency cache
  pre-check (rule #21 / I5); (2) `_lookup_internal` cache pre-check; (3) resolve approver via
  `_getByCode_internal(managerStaffCode)` (active `manager` only, else `NOT_MANAGER`); (4)
  `argon2Verify({ password: managerPin, hash: manager.pin_hash })` — **NOT** `verifyPinOrThrow`; on
  miss `_recordFailedAttempt_internal({ deviceId:"approve-route", countTowardLockout:false,
  source:"telegram_approval" })` + `_recordTokenPinFailure_internal` (cap → `REQUEST_REVOKED`); (5)
  call the **shared commit** with `closeOutlet = (resultingState === "close")`,
  `source:"telegram_approval"`, `managerStaffId: manager._id`, `deviceId: ctx.device_id`; (6)
  `_markResolved_internal`.
- Denial reuses the generic kind-agnostic `denyRequest`.

### Touchpoint — shared commit refactor (`convex/shifts/shiftsInternal.ts`)

`_managerOverrideCommit_internal` becomes the single writer for **both** the booth-inline action and
the off-booth approve action. Add two params:

- `closeOutlet: boolean` — when true, after ending the hold, call
  `internal.outlets.status._setOutletClosed_internal(outletId, managerStaffId)`.
- `source: "booth_inline" | "telegram_approval"` — threaded into `logAudit` (today hardcoded
  `"booth_inline"`; the Telegram path must record `"telegram_approval"` per the approval-source rule).

Existing behaviour is preserved: read active hold → no hold ⇒ idempotent no-op; else end shift
(`ended_via:"manager_override"`, `outgoing_uncounted:true`), emit `shift.manager_override` audit
(actor = approving manager, now with correct `source`), schedule the deferred Telegram signoff
summary. `withIdempotency` wrap unchanged.

The booth-inline `shifts.managerOverride` action gains a `resultingState` arg and passes
`closeOutlet` + `source:"booth_inline"` through to the same commit.

## Flows

Both paths start from the blocked login screen (`login.tsx`, `boothState` held-by-other) and are
**session-less** — the booth is blocked, so nobody is logged in.

**Booth-inline (manager present):** tap "Manager override" → `PinSheet` → pick manager name + Close/
Release + PIN → `shifts.managerOverride({ deviceId, managerStaffId, managerPin, resultingState })` →
shared commit. (Today's flow + the Close/Release choice + `resultingState` arg.)

**Off-booth (manager remote — the new path):**
1. Staff taps "Manager override" → sheet → "Request via Telegram".
2. `requestShiftOverride({ deviceId, idempotencyKey })` resolves outlet from device, reads the active
   hold, mints a token, inserts the `shift_override` request (outlet-scoped), sends the per-outlet
   `managers` card with the `/approve/:token` button.
3. Manager opens the link → `/approve` `ShiftOverride` shows the context → picks **Close booth** or
   **Release** → enters staff code + PIN.
4. `approveShiftOverride` (argon2 verify) → shared commit (`closeOutlet` per choice) → request resolved.
5. Booth's reactive `boothState` flips; the next staffer logs in (closed ⇒ start-of-day; released ⇒
   steps into the open booth).

## Security & routing

- **Token authorises VIEW, PIN authorises ACT** (ADR-029). Token = single-use, 60-min TTL, hashed
  at rest. A leaked token cannot DoS-lock a booth login: the token-PIN attempt path runs with
  `countTowardLockout:false` (SEC-07) and writes the per-token cap, not `pos_auth_attempts`.
- **Per-outlet (Spec 4):** the request is session-less, so `outlet_id` is resolved from the booth
  **device** binding (`_getDeviceOutletId_internal`), not a session — the only client arg over the
  wire is `deviceId`, never `outlet_id` (ADR-051). The card routes only to that outlet's `managers`
  chat via `resolveOutletChatId`.
- **Manager-only:** `approveShiftOverride` rejects a non-manager PIN (the approver must be an active
  `manager`). Audit records the approving manager as actor.

## Audit verbs

- `shift_override.requested` / `shift_override.approval_resolved` / `shift_override.denied`
  (approval-row state, per `KIND_AUDIT`).
- `shift.manager_override` (the commit verb) stays — now emitted with `source` of either
  `booth_inline` or `telegram_approval`, and `metadata.resulting_state: "closed" | "released"`.

## Testing

- `validateContext("shift_override", …)`: accepts a good context, rejects empty `shift_id`/`device_id`,
  non-integer `sales_so_far_idr`.
- Dedup: a second `requestShiftOverride` while one is pending returns the existing request (one card).
- Session-less request: resolves outlet from `deviceId`; no active hold ⇒ no card (early return).
- Shared commit, both branches: `closeOutlet:true` ends hold **and** flips `is_open=false`;
  `closeOutlet:false` ends hold only, outlet stays open. No-hold ⇒ idempotent no-op (both branches).
- `approveShiftOverride`: happy path (manager PIN → commit + resolved); wrong PIN increments the
  per-token cap without touching `pos_auth_attempts`; non-manager PIN rejected; token reuse rejected.
- Per-outlet routing: the card resolves to the request's outlet `managers` chat (not business-wide).
- Audit: `source` is `telegram_approval` on the off-booth path, `booth_inline` inline.

## Verified during staffreview (2026-06-27, against real code)

Report: `docs/reviews/staffreview-off-booth-manager-override-spec-2026-06-27.md`. Corrections C1–C3
+ I1–I4 are already folded into the touchpoints above. Confirmed facts:

1. `_managerOverrideCommit_internal` (`convex/shifts/shiftsInternal.ts`) takes
   `{ idempotencyKey, deviceId, managerStaffId }`, resolves outlet from `deviceId`, hardcodes
   `source:"booth_inline"`, ends the active hold or no-ops if none. Add `closeOutlet` + `source`. ✓
2. `shifts.managerOverride` (`convex/shifts/actions.ts`) is the only caller — session-LESS, takes
   `{ idempotencyKey, deviceId, managerStaffId, managerPin }`, verifies inline via `verifyPinOrThrow`. ✓
3. **(C1)** Off-booth approve uses `argon2Verify` + `_getByCode_internal(managerStaffCode)`, NOT
   `verifyPinOrThrow`; miss path = `_recordFailedAttempt_internal({ deviceId:"approve-route",
   countTowardLockout:false })` + `_recordTokenPinFailure_internal` (cap). Verified across all four
   `approve*` actions. ✓
4. **(I1)** Dedup precedent is `_listPendingByKind_internal({ kind, entityId, outletId })` → return
   existing (used by `requestManualPaymentApproval`). No new cancel fn. ✓
5. `resolveOutletChatId(ctx, role, outletId)`, `sendTemplate`'s `kind` union, and the per-kind
   component in `src/routes/approve/index.tsx` (no `pin.tsx`) are the touch-points. ✓ (I3)
6. **(C2/I4)** The override lives in `src/routes/login.tsx` — a session-less `PinSheet` + manager
   picker keyed on `deviceId`, shown on `login.shiftHeldBy`. Extend it (two-path + Close/Release). ✓
7. **(R1)** No dedicated "pending" query needed — the reactive `boothState` flip already returns the
   login screen to normal when the override resolves. An explicit pending banner is an optional R1.
