# Staff Review: Peer takeover of a locked booth (SPEC)

**Date:** 2026-07-08
**Plan:** `docs/superpowers/specs/2026-07-08-peer-takeover-locked-booth-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ This is a SPEC (design contract), not the executable plan — plan-structure
items (Task List, waves, git checkpoints, success criteria, rollback) are intentionally deferred to
the `writing-plans` stage per the spec-plan-pipeline. Reviewed for **architecture correctness**.

---

## 1. Summary

**Overall Assessment:** Revise (one Critical, then Approve)

The design is sound, well-grounded against real code (correct index names, correct signatures,
correct module boundaries), and correctly reuses the `manager_override` end-shift + signoff
machinery. The single-writer atomic mutation with a server-side liveness re-check is the right shape
and closes the hijack hole. **One Critical correctness bug:** the holder-liveness check as specified
counts *any* active session — including a **cockpit** session on another device — as "present at the
booth," which would wrongly block a legitimate peer takeover whenever an owner/manager holds the
shift and has the cockpit open. Fix the liveness query to count booth sessions only, and the spec is
ready to plan.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Liveness check counts cockpit sessions → blocks legit takeover of an owner/manager-held booth | Logic | B2 / B3 |

### Issue 1: `_hasActiveSession_internal` must exclude cockpit sessions

`staff_sessions` now carries `kind: "booth" | "cockpit"` (ADR-052; `auth/schema.ts:42`). An **owner**
or **manager** can be the booth holder *and* simultaneously have a cockpit session open on a
different device (the cockpit is a separate auth plane, outlet-unscoped — ADR-052/rule #26). The spec
computes `holderLocked` as "holder exists AND no session with `ended_at == null`." That predicate
returns **false** (→ holder treated as *active* → peer blocked → manager override) for a holder who
locked the booth and walked away but left a cockpit tab open.

Concrete failure: Lucas (`S-0001`, owner) opens the booth, taps **Lock**, and goes to his laptop
cockpit. Sisca arrives → `holderLocked` is false because Lucas has a live *cockpit* session → she's
blocked → she must send a Telegram override. **The feature silently doesn't work for any
owner/manager-held shift** — exactly the people most likely to also use the cockpit.

The `by_staff_active` index (`["staff_id","ended_at"]`) doesn't carry `kind`, and a booth staffer has
at most one active booth session, so collect-and-filter is cheap:

```ts
export const _hasActiveBoothSession_internal = internalQuery({
  args: { staffId: v.id("staff") },
  handler: async (ctx, { staffId }): Promise<boolean> => {
    const rows = await ctx.db
      .query("staff_sessions")
      .withIndex("by_staff_active", (q) => q.eq("staff_id", staffId).eq("ended_at", null))
      .collect();
    // Cockpit sessions (ADR-052) are a different plane and do NOT mean "present at
    // the booth." Legacy rows have no kind ⇒ treat as booth.
    return rows.some((r) => (r.kind ?? "booth") === "booth");
  },
});
```

**Recommendation:** rename to `_hasActiveBoothSession_internal`, filter to booth-kind sessions, and
use it in **both** B3 (`loginContext.holderLocked`) and B4 step 4 (the server safety gate) so the FE
gate and the server gate agree. Update the spec's B2/B3/B4 wording accordingly. Add a test:
`holderLocked` is true when the holder's only live session is `kind: "cockpit"`.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | `begin.tsx onComplete` must dispatch from LIVE ctx + handle server cross-throw gracefully | H | M |
| 2 | Document that incoming `started_via="handover"` doesn't self-identify peer-takeover | M | L |
| 3 | Spell out the (safe) deploy-skew degradation so it isn't mistaken for a bug | L | L |

### Improvement 1: `begin.tsx` dispatch + race handling

The takeover-vs-startShift decision in `onComplete` must read **live** `ctx` at call time, not the
render-time snapshot, and must handle the case where the hold changed between count-start and submit:
- `ctx.holderStaffId === null` → `startShift` (existing path; keep the v1.4.7 self-handover Resume
  prompt).
- locked holder ≠ me → `takeOverLockedBooth`.
- If `takeOverLockedBooth` throws **`NO_HOLDER`** (hold cleared mid-count) → fall back to a
  `startShift` retry (or route to `/` and let login re-decide). If it throws **`HOLDER_ACTIVE`**
  (holder came back) → route to `/`/login so the block screen shows. Don't surface a raw error toast
  for these two expected races. Make this explicit in the plan's `begin.tsx` task + a FE test for the
  "hold cleared mid-count" path. (The server throws are the correctness backstop; this is about not
  dead-ending the operator — cf. `countstep-handover-dead-button`, `handover-no-session-deadlock`.)

### Improvement 2: Incoming shift `started_via` does not self-identify a peer takeover

The incoming shift is minted with `started_via="handover"` (correct — `_startShift_internal`'s union
is `sop | manager_skip | handover`, no schema change). But that means the *incoming* row looks
identical to a normal handover-in; only the **outgoing** row's `ended_via="peer_takeover"` + the
`shift.peer_takeover` audit verb (linked via `prev_shift_id`) distinguish it. That's an acceptable
trade (decision #2 scoped `ended_via` only; adding a `started_via` literal is a larger change), but
the plan should **state it explicitly** so any future reporting query joins outgoing→incoming via
`prev_shift_id`/audit rather than expecting the incoming `started_via` to say "peer_takeover."

### Improvement 3: Note the deploy-skew degradation

`loginContext` gains a field and a new mutation is added — not a mutation↔action rename, so **not**
deploy-skew-fatal. Both skew directions degrade safely: FE-first (reads `holderLocked` from old
backend → `undefined` → falsy → current block-and-override behavior); backend-first (extra field
ignored, new mutation unused). The atomic build ships them together anyway. State this in the plan's
rollback/deploy notes so a reviewer doesn't flag it.

---

## 4. Refinements (Optional)

- Takeover count wizard could show a "Taking over from {name}" hint (extra i18n key) so the incoming
  staffer knows whose booth they're assuming. UX nicety, not required.
- Audit metadata already includes `incoming_staff_id` + `new_shift_id` — good, keep it (makes the
  peer-takeover trail self-contained without a session join).

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| End-shift + signoff + audit pattern | `_managerOverrideCommit_internal` (`shiftsInternal.ts:147`) | `takeOverLockedBooth` mirrors it (end holder `outgoing_uncounted=true`, schedule `_sendSignoffSummary` with the **displaced** holder's `staffId`) |
| `_buildSignoffSummary_internal` | `shifts/internal.ts` | Build displaced holder's summary |
| `_getActiveShift_internal` / `_startShift_internal` / `_endShift_internal` | `shiftsInternal.ts` | Holder resolve + atomic end/start |
| `withIdempotency` dual-call `authCheck` | `openBooth`/`startShift` (`shifts.ts`) | Copy the exact wrapper shape |
| `by_staff_active` index | `auth/schema.ts:49` | Liveness point/collect query — **no new index** |

### Potential duplication risks
- The liveness query is new but genuinely absent (grep of `auth/internal.ts` found no existing
  active-session helper). Add it once in `auth/internal.ts` and reuse in both callsites — do not
  inline the same query in `loginContext` and `takeOverLockedBooth`.

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| Backend (B1–B4) before FE (F1–F3) | Good | Schema → internal query → loginContext → mutation → FE consumes. Correct order. |
| Tests alongside each layer | Good | Server tests gate the FE work. |

**Ordering issues:** none. **Missing phases:** the ADR-053 amendment + CLAUDE.md rule #23 + SCHEMA.md
verb doc should be an explicit task in the plan (spec mentions them but they need a task row).

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| B1–B4 (schema, internal query, loginContext, mutation) | `convex-expert` (or project `convex-backend` if present) | Convex mutation/index/idempotency + cross-module `_internal` boundaries |
| Server tests | `tdd-test-architect` | convex-test mutation/edge/idempotency coverage |
| F1–F3 (login + begin routes) | `frontend-integrator` | Wiring `useLoginContext` ↔ routes, dispatch logic, i18n |
| FE tests | `tdd-test-architect` | Route/branch tests |
| Between-wave gate | `code-reviewer` | Type + pattern compliance before the FE wave consumes the new field |

## 8. Git Workflow Assessment

Deferred to the plan stage (this is a spec). Plan must specify: feature branch off synced `main`,
atomic commits per task (schema / internal-query / mutation / FE / docs), `npm run typecheck` +
`npm run test` before push, squash-merge, `package.json.version` + CHANGELOG bump together
(version-sync gate).

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| B1 | `docs/SCHEMA.md` — `ended_via` gains `peer_takeover`; new audit verb `shift.peer_takeover` |
| B4 | ADR-053 amendment (peer takeover of a *locked* holder is staff-allowed) |
| Merge | `docs/CHANGELOG.md` (v1.5.0), CLAUDE.md rule #23 wording, remove slice from `docs/ROADMAP.md` |

### CHANGELOG draft
~~~markdown
## v1.5.0 — Peer takeover of a locked booth
- A staffer can now take over a booth left LOCKED by another holder using their own PIN — no
  manager override needed. An actively-working (live-session) holder still requires a manager
  override, so a live shift can't be hijacked. Ends the displaced holder's shift
  (`ended_via=peer_takeover`, uncounted) and sends them their signoff summary.
~~~

## 10. Testing Plan Assessment

**Verdict:** Adequate (spec-level; plan must enumerate as TDD steps)

### Missing test coverage (must add to the plan)
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | `holderLocked` true when holder's only live session is `kind:"cockpit"` | Critical Issue 1 regression guard | convex-test: seed cockpit session, assert holderLocked |
| 2 | `begin.tsx` "hold cleared mid-count" → NO_HOLDER handled (no dead-end) | Improvement 1 | FE test: mock takeOverLockedBooth throw → assert fallback |
| 3 | Signoff scheduled with the **displaced** holder's staffId (not the incoming caller's) | Correctness of decision #1 | convex-test: assert scheduler arg staffId === holder.staff_id |

### Regression risk
- Normal handover (holderStaffId===null → startShift) must be unaffected — assert begin.tsx still
  calls `startShift` and the v1.4.7 self-handover Resume prompt still fires.
- The `blocked` stage for *active* holders must be unchanged (both `handleStaffTap` and the
  `onPinSubmit` re-check).

## 11. Edge Cases to Address

- [x] Original holder returns after takeover → now active → blocked (spec covers)
- [x] Holder resuming own locked shift → resume to `/` (spec covers)
- [x] Two peers race → server HOLDER_ACTIVE/SELF_NOT_PEER + idempotency (spec covers)
- [ ] **Holder with only a cockpit session** → must be `holderLocked` (Critical 1)
- [ ] **Hold cleared between count-start and submit** → begin.tsx handles NO_HOLDER (Improvement 1)
- [x] Outlet closed → no holder → holderLocked false → /shift/start (mutation guards BOOTH_NOT_OPEN)

## 12. Approval Conditions

**To approve, address:**
1. Critical Issue 1 — liveness query filters to booth-kind sessions (used in both callsites).

**Recommended before implementation (fold into the plan):**
1. Improvement 1 — begin.tsx dispatch from live ctx + graceful NO_HOLDER/HOLDER_ACTIVE handling.
2. Improvement 2 — document the incoming `started_via` limitation.
3. Improvement 3 — deploy-skew degradation note in rollback.

---

*Generated by /staffreview*
