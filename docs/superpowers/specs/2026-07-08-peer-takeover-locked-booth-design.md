# Spec — Peer takeover of a locked booth (v1.5.0)

**Status:** design — staffreview gate passed (Critical + all Improvements addressed inline, see
`docs/reviews/staffreview-peer-takeover-locked-booth-spec-2026-07-08.md`). Ready for planning.
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

### B2 — Holder booth-session-liveness internal query (auth-owned)
`staff_sessions` is auth-owned (ADR-034). Add an internal query in `convex/auth/internal.ts`:

```ts
// _hasActiveBoothSession_internal({ staffId }) → boolean
// True iff staff has any live BOOTH session (ended_at == null, kind booth/legacy).
export const _hasActiveBoothSession_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, { staffId }): Promise<boolean> => {
    const rows = await ctx.db
      .query("staff_sessions")
      .withIndex("by_staff_active", (q) => q.eq("staff_id", staffId).eq("ended_at", null))
      .collect();
    // CRITICAL (staffreview #1): cockpit sessions (ADR-052/rule #26) are a
    // different auth plane and do NOT mean "present at the booth." An owner/manager
    // can hold a booth shift AND have a cockpit tab open on another device; counting
    // that would wrongly block a legit peer takeover of their locked booth. Legacy
    // rows carry no `kind` ⇒ treat as booth.
    return rows.some((r) => (r.kind ?? "booth") === "booth");
  },
});
```

Uses the **existing** `by_staff_active` index (`["staff_id","ended_at"]`, `auth/schema.ts:49`).
`.collect()` (not `.first()`) so the `kind` filter is applied — a booth staffer has at most one live
booth session, so N is tiny. No new index. `by_staff_active` leads with `staff_id` (an auth index,
not outlet-scoped); it is a pre-existing definition that already passes the
`index-leads-with-outlet_id` fence, and this spec adds **no** new index, so the fence is not
re-triggered. Both callsites (B3 + B4) MUST use this one helper so the FE gate and the server gate
agree on "present."

### B3 — `loginContext` gains `holderLocked`
`convex/shifts/shifts.ts:261` `loginContext(deviceId)` currently returns
`{outletOpen, holderStaffId, holderName}`. Add **`holderLocked: boolean`** = a holder exists AND
`_hasActiveBoothSession_internal({staffId: holder.staff_id}) === false`. When no holder,
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
   `_hasActiveBoothSession_internal({staffId: holder.staff_id})` (the SAME helper as B3). If **true**
   → throw **`HOLDER_ACTIVE`** (holder came back / never really left; FE falls back to manager
   override). Must be inside the mutation.
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
   **Note (staffreview #2):** the incoming row's `started_via="handover"` does NOT self-identify a
   peer takeover — the `_startShift_internal` union is `sop | manager_skip | handover` (no schema
   change here, by design). The peer-takeover nature is captured on the **outgoing** row
   (`ended_via="peer_takeover"`) + the `shift.peer_takeover` audit verb, linked by `prev_shift_id`.
   Any reporting that needs to isolate peer takeovers joins outgoing→incoming via
   `prev_shift_id`/audit, not the incoming `started_via`.
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
- **`onComplete`** dispatches from **live `ctx` at call time** (not the render-time snapshot, which
  can go stale during the count): `ctx.holderStaffId === null` → `startShift` (unchanged path, keeps
  the v1.4.7 self-handover Resume prompt intact); locked holder ≠ me → **`takeOverLockedBooth`**.
  Same `ShiftWizard` / count-step UI, same `onComplete(confirmed, countChanged)` signature.
- **Race handling (staffreview #1):** the hold can change between count-start and submit. Catch the
  two expected server throws and DON'T dead-end the operator with a raw error toast:
  - `NO_HOLDER` (hold cleared mid-count — holder logged back in and out, or a manager released) →
    fall back to a `startShift` retry, or route to `/` and let login re-decide.
  - `HOLDER_ACTIVE` (holder came back and is working) → route to `/` (login owns the block screen).
  Cover the "hold cleared mid-count" path with an FE test (cf. `countstep-handover-dead-button`,
  `handover-no-session-deadlock`). The server throws remain the correctness backstop; this is purely
  about not stranding the operator.
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
- signoff scheduled for the *displaced* holder (assert the scheduler arg `staffId ===
  holder.staff_id`, NOT the incoming caller's id).
- `loginContext.holderLocked` true (holder, no live booth session) / false (holder with live booth
  session / no holder).
- **`holderLocked` true when the holder's ONLY live session is `kind:"cockpit"`** (staffreview #1
  regression guard) — a cockpit session must not count as booth presence.

**FE (`src/routes/**/__tests__/`):**
- login routes locked-holder → PIN/takeover vs active-holder → blocked (both `handleStaffTap` and
  the `onPinSubmit` re-check).
- post-login nav target = `/shift/begin` for the takeover case.
- `begin.tsx` takeover terminal calls `takeOverLockedBooth`; normal-handover terminal still calls
  `startShift`; self-handover Resume prompt still works.
- `begin.tsx` "hold cleared mid-count" — `takeOverLockedBooth` throws `NO_HOLDER` → FE falls back
  gracefully (no dead-end / raw error), per F3 race handling.

---

## Rollback / deploy notes
- **All schema changes are additive** (a new `ended_via` literal, a new field on the `loginContext`
  return, a new mutation, a new internal query). No field removal, no required-flip, no migration —
  so a straight revert is safe and there is nothing to backfill.
- **Deploy skew is safe both directions (staffreview #3)** — this is NOT a mutation↔action rename, so
  not deploy-skew-fatal. FE-first: reads `holderLocked` from an old backend → `undefined` → falsy →
  degrades to *current* block-and-manager-override behavior (no takeover offered). Backend-first: the
  extra field is ignored and the new mutation is simply unused. The atomic Vercel build
  (`scripts/build.mjs`) ships both sides together anyway. Note this in the plan so a reviewer doesn't
  flag the added field as a skew risk.

## Versioning
New user-facing capability → **v1.5.0** (minor bump). Record in `docs/ROADMAP.md` at plan-merge
time; CHANGELOG + `package.json.version` bump together at execution/merge (version-sync gate).
