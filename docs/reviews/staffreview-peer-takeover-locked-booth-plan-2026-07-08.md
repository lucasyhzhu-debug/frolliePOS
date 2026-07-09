# Staff Review: Peer takeover of a locked booth (PLAN)

**Date:** 2026-07-08
**Plan:** `docs/superpowers/plans/2026-07-08-peer-takeover-locked-booth.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, File Changes, waves w/ deps, Testing, Success Criteria,
Rollback all present).

---

## 1. Summary

**Overall Assessment:** Revise (one Critical, then Approve)

Assumptions verified against real code — all internal-fn signatures the plan calls
(`_getActiveShift_internal`, `_startShift_internal`, `_endShift_internal`,
`_buildSignoffSummary_internal`, `_sendSignoffSummary`, `_getOutletStatus_internal`,
`_getStaffNameCode_internal`, `_getDeviceOutletIdOrNull_internal`, `OpenBoothResult`,
`stepValidator`) exist with the exact shapes used, and `loginWithPin` is confirmed **auth-only** (no
shift/holder guard), so the "log in first, take over second" flow is viable. **One Critical gap:**
the plan updates `login.tsx` and `begin.tsx` but **misses `RootLayout.tsx`'s Level-2 gate**
(`RootLayout.tsx:177`), which only forces the count wizard when `holderStaffId === null`. In a
takeover the holder is non-null, so nothing forces the incoming staffer through
`takeOverLockedBooth` — they can navigate to `/` and operate the booth while the *old locked holder
still holds the shift*, producing a shift/sales attribution mismatch. Add the RootLayout gate (the
real server-of-record guarantee behind this feature) and the plan is ready.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | RootLayout Level-2 gate not extended → takeover person can bypass the count wizard and operate under the OLD holder's shift | Logic / Architecture | Missing task (RootLayout.tsx:177) |

### Issue 1: RootLayout must force the count wizard for the takeover case

`RootLayout.tsx:177-186` (the "Level-2 gate"):

```ts
  if (
    session.status === "active" &&
    ctx !== undefined &&
    deviceIsOutlet &&
    ctx.outletOpen === true &&
    ctx.holderStaffId === null &&          // ← only the NO-HOLDER case
    location.pathname !== "/shift/begin"
  ) {
    return <Navigate to="/shift/begin" replace />;
  }
```

This is the *global* guarantee that an incoming staffer completes the count before operating. It only
fires when `holderStaffId === null`. In a peer takeover the locked holder row still exists
(`holderStaffId !== null`), so the gate does **not** fire. Consequence: the incoming staffer (who now
has a valid session — `loginWithPin` doesn't block on a foreign holder, verified) can navigate to `/`
without ever calling `takeOverLockedBooth`. They'd transact under their own session while the
`pos_shifts` holder is still the *old locked person* — sales attributed to a session whose shift
holder never changed. The `begin.tsx` guard alone (T7) doesn't cover this: it only governs what
`/shift/begin` renders, not the other routes.

This is new surface: today an incoming staffer can *never* hold a session while a foreign holder
exists (they're blocked at login), so RootLayout never encounters "active session + foreign holder."
This feature deliberately creates that state, so RootLayout must handle it.

**Recommendation:** extend the Level-2 gate to also force `/shift/begin` for the takeover case, and
add it as an explicit task (fold into **T6** — same agent, same wave, and RootLayout.tsx is disjoint
from T7's begin.tsx so T6‖T7 parallelism is preserved):

```ts
  const me = session.status === "active" ? session.staff._id : null;
  if (
    session.status === "active" &&
    ctx !== undefined &&
    deviceIsOutlet &&
    ctx.outletOpen === true &&
    (ctx.holderStaffId === null ||
      (ctx.holderLocked === true && ctx.holderStaffId !== me)) &&
    location.pathname !== "/shift/begin"
  ) {
    return <Navigate to="/shift/begin" replace />;
  }
```

After `takeOverLockedBooth` commits, `holderStaffId === me` → the gate lifts naturally (same as
normal handover). The old locked holder has no session, so the gate never applies to them. Add a
RootLayout test: active session + `holderLocked && holderStaffId !== me` → redirect to `/shift/begin`;
`holderStaffId === me` → no redirect.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Make `takeoverKey` hook placement explicit (before early returns) in T7 | M | L |
| 2 | Flesh out T4 happy-path test assertions vs. skeleton comments | M | M |
| 3 | Note login.tsx nav-target (T6 3d) is belt-and-braces once RootLayout enforces | L | L |

### Improvement 1: `takeoverKey` must precede the early returns (Rules-of-Hooks)

`begin.tsx` early-returns (`if (session.status === "loading") return null;`) come *after* the existing
`useIdempotency` calls. T7's new `useIdempotency(takeoverKey)` is a hook and MUST be added alongside
the other hooks (before any early return), or React throws "rendered fewer hooks than expected." The
plan says "near the existing hooks" — make it explicit: place `takeoverKey` + `takeOverLockedBooth`
`useMutation` with the other top-of-component hooks, and `me` can be a plain const anywhere before its
use.

### Improvement 2: Concretise the T4 happy-path test

T4's test bodies are structured comments + an executor note pointing at sibling tests. That's
acceptable for the error-path cases (seed-heavy), but the happy-path assertions are the crux — spell
out the concrete field checks (`ended_via === "peer_takeover"`, `outgoing_uncounted === true`,
`prev_shift_id === H._id`, `started_via === "handover"`, return `shiftId` is the new active shift)
so the executor can't under-assert. The other skeletons can stay (they name exact throws + the seed
pattern to copy).

### Improvement 3: Redundancy note

Once RootLayout enforces the takeover redirect (Critical 1), the login.tsx nav-target branch (T6 step
3d) is a fast-path optimisation, not the guarantee. Keep both (login nav avoids a flash), but note it
so a future reader doesn't "simplify" the RootLayout gate away thinking login handles it.

## 4. Refinements (Optional)

- T7 step 6 (takeover note in the wizard) is already correctly marked optional/YAGNI-guarded — good.
- Audit metadata carries `incoming_staff_id` + `new_shift_id` — self-contained trail, keep.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `_managerOverrideCommit_internal` end+signoff+audit shape | `shiftsInternal.ts:147` | `takeOverLockedBooth` mirrors it (T4 does) |
| Level-2 SOP gate | `RootLayout.tsx:177` | **Extend** (Critical 1), don't add a parallel gate |
| `startShift` self-handover catch | `begin.tsx:100` | T7's `startNormally` extracts it — correct, no dup |

### Potential duplication risks
- None. The plan reuses the one liveness helper (T2) in both callsites and extends existing gates
  rather than forking them.

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| Wave 1 (T1–T4) | Good | T3→T4 serialization on shifts.ts correct; T2 spine gate correct |
| Wave 2 (T5–T7 + RootLayout) | Good w/ Critical 1 folded into T6 | RootLayout.tsx disjoint from begin.tsx → T6‖T7 preserved |
| Wave 3 (T8 docs) | Good | — |

**Ordering issues:** none. **Missing phases:** RootLayout gate (Critical 1) — fold into T6.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| T1–T4 | `convex-expert` | matches plan |
| T5–T7 (+RootLayout) | `frontend-integrator` | matches plan; RootLayout gate is FE routing |
| T8 | `general-purpose` | docs-only |

All agents exist in the roster. No new agent needed (plan's assessment is correct).

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ (worktree off synced main, per pipeline) |
| Commit per task | ✅ (each task ends in a scoped commit) |
| Merge strategy | ✅ squash-merge (repo convention) |

### Pre-push verification
- [x] `npm run typecheck` in plan (per-wave barriers + close-out)
- [x] `npx vitest run` in plan
- [x] Local test before push (TDD steps)

### CI/CD & rollback
| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ additive-only, straight revert |
| Deployment order | ✅ atomic build; skew safe both ways (documented) |
| Data backup needed | No (additive) |
| Migration safety | ✅ no migration |

## 9. Documentation Checkpoints

T8 covers SCHEMA.md (verb + `ended_via`), ADR-053 amendment, CLAUDE.md rule #23. CHANGELOG +
version bump correctly deferred to merge (version-sync gate). ✅

## 10. Testing Plan Assessment

**Verdict:** Adequate (with Improvement 2 + the RootLayout test from Critical 1)

### Missing test coverage (must add)
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | RootLayout forces `/shift/begin` for takeover (holderLocked && holder≠me) | Critical 1 guarantee | RootLayout test w/ mocked ctx+session |
| 2 | T4 happy-path concrete field assertions | crux of the feature | flesh out per Improvement 2 |

### Regression risk
- Normal handover + v1.4.7 self-handover Resume (T7 asserts).
- Active-holder block (T6 asserts).
- RootLayout normal-handover redirect (holderStaffId===null) must still fire after the gate edit —
  add to the RootLayout test.

## 11. Edge Cases to Address

- [ ] **Incoming staffer bails out of /shift/begin before takeover** → RootLayout re-forces it
  (Critical 1). Without the gate, they operate under the old holder.
- [x] Hold cleared mid-count → NO_HOLDER → startNormally (T7)
- [x] Holder returns → HOLDER_ACTIVE → navigate `/` (T7) / block (login)
- [x] Cockpit-only session holder → holderLocked true (T2/T3)
- [x] Idempotent replay (T4)

## 12. Approval Conditions

**To approve, address:**
1. Critical 1 — extend RootLayout Level-2 gate for the takeover case + its test (fold into T6).

**Recommended before implementation:**
1. Improvement 1 — explicit hook placement for `takeoverKey`.
2. Improvement 2 — concrete T4 happy-path assertions.
3. Improvement 3 — redundancy note on the login nav-target.

---

*Generated by /staffreview*
