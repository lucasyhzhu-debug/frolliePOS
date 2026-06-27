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

### Touchpoint (c) — `/approve` UI variant (`src/routes/approve/`)

- `approve/index.tsx` discriminates on `kind`; add the `shift_override` branch rendering the context
  card + **two outcome buttons** ("Close booth" / "Release, keep open") that carry the chosen
  `resultingState` into the PIN screen.
- `approve/pin.tsx` collects the manager PIN and calls `approveShiftOverride` with
  `{ token, pin, resultingState }`.

### Touchpoint (d) — request + approve actions (`convex/approvals/actions.ts`)

Following the `requestManualPaymentApproval` / `approveManualPayment` / `denyRequest` pattern:

- `requestShiftOverride` (action) — called from the booth "Request via Telegram" path. Resolves the
  booth session → outlet, reads the active hold (`_getActiveShift_internal`) + its sales snapshot,
  builds the context, calls `_createRequest_internal(kind:"shift_override", outlet_id, …)`, then
  `_markNotified_internal` after the Telegram send. **Dedup:** at most one *pending* `shift_override`
  per outlet — mirror `_cancelPendingManualPaymentForTxn_internal` with a
  `_cancelPendingShiftOverrideForOutlet_internal`, so a double-tap doesn't fan out two cards.
- `approveShiftOverride` (action) — `{ token, pin, resultingState }`. Loads the request by token
  hash (`_getByTokenHash_internal`), verifies the approver's **booth manager-PIN**
  (`verifyPinOrThrow`, with the token-PIN attempt cap and `countTowardLockout:false` — SEC-07), then
  calls the **shared commit** with `closeOutlet = (resultingState === "close")` and
  `source:"telegram_approval"`, and `_markResolved_internal`.
- Denial reuses the generic `denyRequest`.

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

**Booth-inline (manager present):** tap override → sheet → "Enter manager PIN" → pick Close/Release →
PIN → `managerOverride` action → shared commit. (Today's flow + the Close/Release choice.)

**Off-booth (manager remote — the new path):**
1. Staff taps override → sheet → "Request via Telegram".
2. `requestShiftOverride` mints a token, inserts the `shift_override` request (outlet-scoped),
   sends the per-outlet `managers` card with the `/approve/:token` button. Booth shows a pending state.
3. Manager opens the link → `/approve` shows the context → picks **Close booth** or **Release** → PIN.
4. `approveShiftOverride` verifies PIN → shared commit (`closeOutlet` per choice) → request resolved.
5. Booth's reactive `boothState` / approval-status query flips; the next staffer logs in
   (closed ⇒ start-of-day; released ⇒ steps into the open booth).

## Security & routing

- **Token authorises VIEW, PIN authorises ACT** (ADR-029). Token = single-use, 60-min TTL, hashed
  at rest. A leaked token cannot DoS-lock a booth login: the token-PIN attempt path runs with
  `countTowardLockout:false` (SEC-07) and writes the per-token cap, not `pos_auth_attempts`.
- **Per-outlet (Spec 4):** request carries session-derived `outlet_id`; the card routes only to that
  outlet's `managers` chat. `outlet_id` never crosses the wire as a client arg (ADR-051) — it's
  resolved from the booth session.
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
- Dedup: a second `requestShiftOverride` while one is pending cancels/supersedes the first (one card).
- Shared commit, both branches: `closeOutlet:true` ends hold **and** flips `is_open=false`;
  `closeOutlet:false` ends hold only, outlet stays open. No-hold ⇒ idempotent no-op (both branches).
- `approveShiftOverride`: happy path (manager PIN → commit + resolved); wrong PIN increments the
  per-token cap without touching `pos_auth_attempts`; non-manager PIN rejected; token reuse rejected.
- Per-outlet routing: the card resolves to the request's outlet `managers` chat (not business-wide).
- Audit: `source` is `telegram_approval` on the off-booth path, `booth_inline` inline.

## Assumptions to verify in staffreview (against real code)

1. `_managerOverrideCommit_internal` currently hardcodes `source:"booth_inline"` and takes
   `{ idempotencyKey, deviceId, managerStaffId }` — confirm exact arg shape before adding
   `closeOutlet` + `source`.
2. `shifts.managerOverride` (action) is the only caller of that commit today — confirm so the
   signature change is contained.
3. The approve-action pattern (`approveManualPayment`) verifies PIN via `verifyPinOrThrow` with a
   token-PIN cap helper (`TOKEN_PIN_ATTEMPT_CAP` / `_recordTokenPinFailure_internal`) — confirm the
   exact helper names + that `countTowardLockout:false` is how booth-lockout isolation is expressed.
4. `_cancelPendingManualPaymentForTxn_internal` is the dedup precedent — confirm signature to model
   `_cancelPendingShiftOverrideForOutlet_internal`.
5. `resolveOutletChatId(ctx, role, outletId)` + `sendTemplate`'s `kind` union + the `/approve`
   `kind` discriminator — confirm the exact files/exports the new kind must touch.
6. The booth "Manager override" control's current location (`src/routes/shift/*` or a component) —
   confirm where the two-path sheet attaches.
7. A query exists (or is needed) for the booth to show "override pending" — confirm whether
   `getRequestStatus` / `boothState` already covers this or a small read is needed.
