# Spec — Peer takeover of a locked booth (v1.5.0)

**Status:** design (post-brainstorm, both open decisions resolved). Pre-plan.
**Target version:** v1.5.0 (new user-facing capability → minor bump).
**Amends:** business rule #23 / ADR-053. Related: rule #9, issue #158, v1.4.7 (self-handover).

---

## Problem (prod context — Block M, `savory-zebra-800`)

The booth is one shared Android phone, 2–3 staff. Under **ADR-053** the booth has two stored
levels: `outlets.is_open` (Level 1) and a `pos_shifts` holder row (Level 2, `ended_at==null` =
active holder). **Lock = plain logout; the holder row is unchanged** — so a *locked* holder is a
holder with **no live session**.

**The friction (has forced a manager approval 3 mornings running):** when the holder taps **Lock**
(instead of **Handover**) and leaves, the booth stays held by them with no live session. The next
staffer who taps their own name at login hits the **blocked** stage ("shift held by X") and can
only get in via a **manager override** (rule #23) — inline manager-PIN or a Telegram
`shift_override` request. Verified 2026-07-07: Sasi opened 09:44:54 → Lock 09:44:58 → stranded
holder → Sisca blocked → Telegram `shift_override` → Lucas approved → force-end → Sisca took over.
Clean but needless manager involvement every morning.

**Distinct from v1.4.7** (PR #160, merged): v1.4.7 fixed *self*-handover (same person re-claims
after handing over). THIS fixes *peer* takeover of a booth left **locked** by a *different* person.

---

## Core rule

A booth held by a holder with **no live session** (locked / went home) can be taken over by any
*other* staff with their **own PIN** — no manager. A holder **with a live session** (actively
working) is unchanged: peer is blocked → manager override. **Holder session-liveness is the gate**
separating "stepped away" from "currently working." A live shift can never be hijacked.

### Resolved decisions
1. **Signoff to the displaced holder: KEPT.** When a peer takes over a locked booth, schedule
   `_sendSignoffSummary` for the displaced holder (mirrors `manager_override`). She left uncounted
   but still sees her numbers.
2. **`ended_via`: NEW literal `"peer_takeover"`.** Added to the `pos_shifts.ended_via` union +
   the `_endShift_internal` validator (additive, safe). Clean reporting/audit distinction from
   `handover` / `manager_override`.

---

## Backend

### B1 — Schema (additive, safe)
Add `v.literal("peer_takeover")` to the `pos_shifts.ended_via` union in
`convex/shifts/schema.ts` (currently `handover | end_of_day | manager_override | null`, lines
60–65) **and** to the `_endShift_internal` `endedVia` validator in
`convex/shifts/shiftsInternal.ts:61` (currently `handover | end_of_day | manager_override`).
Adding a union literal is additive; existing rows unaffected. No new index, no field.

### B2 — Holder-liveness internal query (auth-owned)
`staff_sessions` is auth-owned (ADR-034). Add an internal query in `convex/auth/internal.ts`:

```ts
// _hasActiveSession_internal({ staffId }) → boolean
// True iff staff has any session with ended_at == null (single-device booth ⇒
// an active session anywhere = present at the booth).
export const _hasActiveSession_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, { staffId }): Promise<boolean> => {
    const s = await ctx.db
      .query("staff_sessions")
      .withIndex("by_staff_active", (q) => q.eq("staff_id", staffId).eq("ended_at", null))
      .first();
    return s !== null;
  },
});
```

Uses the **existing** `by_staff_active` index (`["staff_id","ended_at"]`, `auth/schema.ts:49`) — a
point query, no new index. `by_staff_active` leads with `staff_id` (an auth index, not
outlet-scoped); it is a pre-existing definition that already passes the `index-leads-with-outlet_id`
fence, and this spec adds **no** new index, so the fence is not re-triggered.

### B3 — `loginContext` gains `holderLocked`
`convex/shifts/shifts.ts:261` `loginContext(deviceId)` currently returns
`{outletOpen, holderStaffId, holderName}`. Add **`holderLocked: boolean`** = a holder exists AND
`_hasActiveSession_internal({staffId: holder.staff_id}) === false`. When no holder,
`holderLocked = false`. Resolve concurrently with the existing `Promise.all`.

### B4 — New public mutation `takeOverLockedBooth`
In `convex/shifts/shifts.ts`. Args `{idempotencyKey, sessionId, steps, openCount?}` (mirror
`startShift`). Public mutation → `withIdempotency` + `authCheck` re-calling `requireSession`
(rule #20, dual-call pattern). **Single-writer, atomic** — ends the locked holder AND starts the
incoming holder in one mutation transaction, so no intermediate stranded state:

1. `requireSession(ctx, sessionId)` → incoming `{staffId, deviceId, outlet_id: outletId}` (PIN
   already verified at login).
2. Guard outlet open (`_getOutletStatus_internal`; else throw `BOOTH_NOT_OPEN`).
3. Resolve holder via `_getActiveShift_internal({outletId})`:
   - **no holder** → throw `NO_HOLDER` (FE falls back to normal `startShift`; see F3 — the FE only
     routes here when it saw a locked holder, so `NO_HOLDER` means the hold cleared mid-flow / race).
   - **`holder.staff_id === staffId`** → throw `SELF_NOT_PEER` (that's resume, not takeover — the
     FE routes self to `/`).
4. **SAFETY GATE (the hijack guard — server-side, not just FE):** re-check holder liveness via
   `_hasActiveSession_internal({staffId: holder.staff_id})`. If **true** → throw **`HOLDER_ACTIVE`**
   (holder came back / never really left; FE falls back to manager override). Must be inside the
   mutation.
5. Build displaced holder's summary via `_buildSignoffSummary_internal({shiftStartMs:
   holder.started_at, endMs: now, outletId})`.
6. End the locked holder's shift via `_endShift_internal`: `endedVia="peer_takeover"`,
   `outgoingUncounted=true`, `closeCount=null`, `steps=[]`, `summary=…`.
7. **Signoff (decision #1 = keep):** `ctx.scheduler.runAfter(0,
   internal.shifts.actions._sendSignoffSummary, {eventId: holder._id, staffId: holder.staff_id,
   shiftStartMs: holder.started_at, shiftEndMs: now, …summary, idempotencyKeySuffix: holder._id,
   outletId})` — mirror the `manager_override` callsite (note `staffId` is the *displaced* holder).
8. Start the incoming shift via `_startShift_internal`: `startedVia="handover"`,
   `prevShiftId = holder._id`, `openCount = args.openCount ?? null`, `steps = args.steps`.
9. Audit **`shift.peer_takeover`** (new verb; `audit_log.action` is a free `v.string()` — no enum),
   `source: "booth_inline"`, `entity_id: holder._id`, metadata
   `{displaced_staff_id: holder.staff_id, prev_shift_id: holder._id, incoming_staff_id: staffId,
   new_shift_id}`. Document the verb in `docs/SCHEMA.md`.

Return `{ ok: true, shiftId }` (the new incoming shift id, mirroring `startShift`/`openBooth`).

---

## Frontend

### F1 — `useLoginContext` type
`src/hooks/useLoginContext.ts` — add `holderLocked: boolean` to `LoginContext`.

### F2 — `src/routes/login.tsx` (login journey)
Two block sites currently branch on "holder ≠ me → blocked". Both must additionally check
`holderLocked`:

- **`handleStaffTap` (~284):** holder ≠ me **AND `holderLocked`** → allow PIN entry (stage `pin`),
  do **not** block. holder ≠ me AND **active** → `blocked` stage (unchanged).
- **`onPinSubmit` re-check (~224–233):** same predicate — only block when holder ≠ me **AND
  active** (`!holderLocked`). A locked holder must fall through to login.
- **Pre-stage guard (~122–126):** the "don't pre-stage a would-be-blocked staffer" check should
  also allow pre-stage when `holderLocked` (they *can* now log in).
- **Post-login nav target (~247–253):** add a branch — outlet open + holder ≠ me + `holderLocked`
  → target `/shift/begin` (takeover mode). Existing branches unchanged (closed → `/shift/start`;
  open + no holder → `/shift/begin`; open + holder === me → `/`).
- **Copy:** locked-holder framing differs from the block copy. Add i18n keys (EN + ID) in
  `src/lib/i18n/dictionaries/{en,id}.ts` under the `login.*` namespace, e.g.
  `login.boothLeftOpenBy` = *"Booth left open by {name} — log in to take over."* Brand-name JSX
  rule per ADR-049 where applicable. (Exact placement of the copy — a hint on the PIN screen — is a
  plan detail.)

### F3 — `src/routes/shift/begin.tsx` (count wizard → takeover)
Currently redirects home when `ctx.holderStaffId !== null` (line 79). Extend to the takeover case:

- **Render** the count wizard when `ctx.outletOpen` AND (`holderStaffId === null` **[normal
  handover]** OR (`holderLocked` && `holderStaffId !== me` **[peer takeover]**)).
- **Redirect `/`** when holder is **active** (not locked) and ≠ me (login owns the block), or when
  `holderStaffId === me` (resume — ADR-053, unchanged).
- **`onComplete`** dispatches by context: `holderStaffId === null` → `startShift` (unchanged path,
  keeps the v1.4.7 self-handover Resume prompt intact); locked holder ≠ me → **`takeOverLockedBooth`**.
  Same `ShiftWizard` / count-step UI, same `onComplete(confirmed, countChanged)` signature.
- Need `me` (own staffId) — available from `useSession()` (`session.staff._id` when active).
- Add a distinct idempotency intent for the takeover mutation (scoped to the incoming sessionId,
  mirror `shift:begin:${sessionId}` with a `:takeover` suffix so it never collides with the
  `startShift` key — ADR-013 / idempotency shared-key collision memory).

---

## Edge cases (cover in tests)
- **Original holder returns after takeover** → new holder now ACTIVE → returning holder is blocked →
  manager override (correct — same as any active-holder block).
- **Holder resuming their OWN locked shift** (`holderStaffId === me`) → normal resume to `/`
  (ADR-053, unchanged; never routes to takeover).
- **Two peers race** → both saw `holderLocked`; the first commits (ends holder, mints incoming);
  the second's server re-check finds a *different* live holder → `HOLDER_ACTIVE` (or `SELF_NOT_PEER`
  if it's now them) → FE falls back / re-routes. Idempotent replay of the same key is safe
  (`withIdempotency`).
- **Hold cleared mid-flow** (holder logged back in and locked again, or a manager released) → server
  `NO_HOLDER` / `HOLDER_ACTIVE` → FE handles gracefully (route to `/` or block).
- **Manager override path** (inline + Telegram `shift_override`) stays intact for ACTIVE holders +
  close-outlet.

---

## Rule / ADR impact
Amends **rule #23** / **ADR-053**: peer takeover of a *locked* holder is staff-allowed (own PIN);
manager override remains for *active* holders and close. **Decision for the plan:** amend ADR-053
in place (this is a refinement of its lock/handover model, not a new architectural axis) vs. a short
new ADR — lean amend-in-place. Update the CLAUDE.md rule #23 wording at execution/merge time.

---

## Testing
**Server (`convex/shifts/__tests__/`):**
- takeover ends locked holder (`ended_via="peer_takeover"`, `outgoing_uncounted=true`) + mints
  incoming holder (`prev_shift_id` links, `started_via="handover"`).
- `HOLDER_ACTIVE` thrown when the holder has a live session.
- `SELF_NOT_PEER` thrown when `holder.staff_id === me`.
- `NO_HOLDER` thrown when no active holder.
- `BOOTH_NOT_OPEN` thrown when outlet closed.
- idempotent replay (same key → no second shift).
- signoff scheduled for the *displaced* holder.
- `loginContext.holderLocked` true (holder, no live session) / false (holder with live session /
  no holder).

**FE (`src/routes/**/__tests__/`):**
- login routes locked-holder → PIN/takeover vs active-holder → blocked (both `handleStaffTap` and
  the `onPinSubmit` re-check).
- post-login nav target = `/shift/begin` for the takeover case.
- `begin.tsx` takeover terminal calls `takeOverLockedBooth`; normal-handover terminal still calls
  `startShift`; self-handover Resume prompt still works.

---

## Versioning
New user-facing capability → **v1.5.0** (minor bump). Record in `docs/ROADMAP.md` at plan-merge
time; CHANGELOG + `package.json.version` bump together at execution/merge (version-sync gate).
