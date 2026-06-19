# Staff Review — v1.2 #6 Shift SOP Flow (`worktree-v1.2-shift-sop-flow`)

**Reviewer:** senior-engineer architectural review (ADR-034 deep-module lens)
**Date:** 2026-06-19
**Range:** `34cb17d..feb62a5` (merge-base → HEAD)
**Scope:** new `convex/shifts/` module, FE wizard components + 3 routes, login/lock/home gate fork, `staff_shift_signoff` Telegram kind, docs.

---

## Summary

**Verdict on module depth: DEEP.** `convex/shifts/` is a genuine deep module in the ADR-034 sense. The public surface is narrow — one read query (`boothState`) returning a 4-field projection, six lifecycle mutations with uniform `{ idempotencyKey, sessionId, steps?, countChanged? }` shapes, and one PIN-gated action — while the substance (event-sourced state derivation, the anchor-walk that makes hours survive lock/resume, the takeover atomic commit, the summary aggregation) is hidden behind `internal.ts` / `lib.ts`. Callers never learn that booth state is event-sourced; they get a derived enum. The one place shifts needs another module's table (`staff_sessions`) it goes through `auth._managerTakeoverSession_internal` rather than reaching in directly, which is exactly the right boundary discipline. The pure `deriveBoothState` / `computeShiftHoursMs` split keeps the state machine testable in isolation.

The implementation is high-fidelity to the plan and ADR-050, with strong test coverage (10 backend + 6 FE test files) and disciplined reuse of the idempotency/audit/recount harnesses. The notable miss is **one ADR-stated requirement that was specced but not wired** (stale-autoclose surfacing), plus documentation drift in the CHANGELOG/SCHEMA that contradicts the shipped code. No critical correctness or security defects. Graft integrity is preserved — `pos_shift_events` is POS-local, device-keyed, and introduces nothing that complicates the v1.1+ cross-deployment integration.

Recommended: address the one Important finding (stale-autoclose) before or shortly after merge; fix the doc-drift items; the rest are refinements.

---

## Critical Issues

None.

The state machine is sound: `deriveBoothState` is pure and total (explicit fallback to `closed`), every mutation re-calls `requireSession` inside the handler so `authCheck`-before-cache holds (rule #20), the takeover action keeps argon2 inside `fn` (ADR-046), and the displaced-staff window in `_commitManagerTakeover_internal` is read *before* the new event is inserted with a documented rationale for why (avoids the `[now, now]` zero-sales window). Concurrency: this is a single-device booth, and the event-sourced design means even a hypothetical double-fire produces two appended rows rather than a lost update — the worst case is a duplicate Founders message, which the `idempotencyKey: signoff:<eventId>` on `sendTemplate` dedupes anyway.

---

## Important

### I1. `staleAutoclose` is computed and exposed but never consumed — a specced ADR requirement was dropped

`deriveBoothState` returns `staleAutoclose: true` when the latest non-closed event is from a prior WIB day, `boothState` plumbs it through, `useBoothState` types it, the FE tests assert on it — but **no route or component reads it**. A grep of `src/` for `staleAutoclose` finds only the hook type and test fixtures; no branch acts on it.

ADR-050 Consequences states this explicitly:
> "Staff who forget to close at night will trigger `staleAutoclose: true` on the next day's login — **the FE should surface this clearly so they complete a belated close** before starting the new day."

What actually happens: on a forgotten-close morning, `boothState.state` is `closed` (correct), and `login.tsx` forks `closed → /shift/start` like any normal day. The prior day's shift silently never produces a `signoff_close` event, so **that day's Founders financial summary is never sent** and the prior shift's hours/stock count are lost. The flag that was designed to catch exactly this is inert.

This is the gap between "the data layer is correct" and "the feature behaves as designed." `deriveBoothState` correctly classifies the stale day as closed, but the product requirement (surface it, prompt a belated close) is unimplemented. At minimum `login.tsx` / `/shift/start` should branch on `staleAutoclose` to show a "you didn't close yesterday" notice; ideally it routes through a lightweight belated-close so the Founders summary still fires. If the team consciously deferred the belated-close flow, that decision should be recorded (ADR-050 amendment or a follow-up issue referenced in the plan) rather than leaving a documented promise unkept and a dead field shipped — per the "mitigation needs a follow-up issue" memory and the lessons.md pattern of avoiding dead writes / unconsumed fields.

---

## Improvements

### M1. CHANGELOG describes routes and a gate location that do not exist

`docs/CHANGELOG.md` for this entry lists:
- Routes: `/shift/start`, `/shift/close`, `/shift/handover-out`, `/shift/handover-in`
- "Login-gate fork in `RootLayout` (or equivalent) branches on `boothState`…"

The shipped code has `/shift/start`, **`/shift/end`** (a choice screen hosting both close and handover-out wizards), and **`/shift/handover`** (incoming). There is no `/shift/close`, `/shift/handover-out`, or `/shift/handover-in`. The fork lives in **`login.tsx`** (and a `handover_pending` redirect there), not in `RootLayout` — `RootLayout` was not touched for shift state at all. The "(or equivalent)" hedge reads like the changelog was drafted from the plan before the routes were finalized and not reconciled against the implementation. `API_REFERENCE.md` and `SCHEMA.md` are accurate; the CHANGELOG should be brought in line so the historical record matches what shipped. (Recurring "plan §-numbers go stale vs living docs" pattern from v1.0 lessons.)

### M2. `takeover` schema field is documented with the wrong semantics

`docs/SCHEMA.md` documents `takeover` as: *"True when this handover was from an active outgoing shift (non-zero-delta handover)."* That is not what the code does. The field is only ever set to `true` on the `manager_takeover` event (in `_commitManagerTakeover_internal`); every other writer passes `null`. ADR-050 agrees with the code ("`takeover: true`" on the takeover path). The SCHEMA prose appears to describe an earlier design. Fix the description to "True on `manager_takeover` events (manager displaced the locked staff); null otherwise." Wrong field docs on an event-sourced audit table are the kind of thing a future Frollie-Pro integrator will trust and be misled by.

### M3. `_shiftStartAnchor_internal` 50-row cap is an undocumented silent ceiling

The anchor walk does `.take(50)` then `.find(...)` for the start event. In normal operation the anchor is within the last few events, so this is fine and avoids an unbounded scan. But if a shift accrued >50 `lock`/`resume`/sale-unrelated events before its start anchor (pathological, but the table is append-only and per-device, so it grows forever), the anchor would not be found and `shift_started_at` would silently fall back to `now`, zeroing the duration and sales window. This is extremely unlikely for a 2–3 staff booth, but the cap is a magic number with no comment explaining why 50 is safe or what happens past it. Either add a comment justifying the bound (e.g. "a single shift cannot realistically produce >50 events before its start anchor") or use a `by_device_created` walk that's explicitly bounded by `created_at >= wibDayStart`. Low likelihood, but it's a silent-corruption-on-overflow shape, which the lessons.md repeatedly flags.

---

## Refinements (nitpicks)

### N1. `endOfDaySignOff` and `handoverOut` are near-identical — extraction is now earned

The two mutations differ only in the event `type` string, the audit verb, and one comment. Both do: requireSession → anchor → `_buildSignoffSummary_internal` → `_recordShiftEvent_internal` (with the same summary object) → session patch → audit → `scheduler.runAfter(_sendSignoffSummary)`. That's ~60 lines duplicated. With two consumers it was a judgment call; the rule-of-three says hold. But the divergent-cancel-mutation parity lesson (v0.5.0) applies: two copies of a self-signoff pipeline will drift. Consider a private `_recordSelfSignoff(ctx, args, { type, auditAction })` helper inside `public.ts`. Not blocking.

### N2. `ShiftWizard.bankCurrentStep` has a misleading comment / dead intent

`bankCurrentStep()` builds and returns a `ConfirmedStep` but its body comment says "Functional updater form avoids closing over stale confirmed" — yet it doesn't touch state; the functional update happens in `handleNext`. The helper is just a constructor. Either inline it or drop the stale comment. Minor.

### N3. `terminalLabel` prop is justified but lightly documented

The `terminalLabel` override on `ShiftWizard` exists so the final button can read "Sign off — selesai hari ini" instead of the rail's step label ("Kunci loker"). That's a real need (the rail label and the action verb genuinely differ) and the fallback `terminalLabel ?? steps[currentIndex].label` is clean. It's earned, not over-engineering. Worth one line in the prop's doc explaining *why* the final step's button text must diverge from its rail label, so a future maintainer doesn't "simplify" it away.

### N4. `count_changed` semantics slightly fuzzy across event types

`count_changed` is the delta returned by `recordRecount` for the most recent count step in the wizard. For multi-count wizards (none today) only the last count's delta is captured (`lastCountChanged` in `ShiftWizard`). Today every wizard has exactly one count step so this is correct, but the field name suggests "the count change for this event" while the mechanism is "the last count step's change." A comment on the wizard's `lastCountChanged` noting the single-count-step assumption would prevent a subtle bug if a two-count wizard is ever added.

### N5. `renderManualBcaBlock` extraction is a clean, correct DRY win

Pulling the manual-BCA line rendering out of `renderFoundersSummary` and sharing it with `renderStaffShiftSignoff` is exactly right — V8-safe, no behavior change, and the test diff covers both callers. Noting it as a positive: this is the kind of helper-extraction-on-third-consumer the simplify lessons endorse.

---

## Graft Integrity (Frollie Pro)

No concern. `pos_shift_events` is `device_id`-keyed (a POS-local concept — Frollie Pro has no notion of the booth Android), references `staff` and `staff_sessions` which are already POS-owned, and stores a denormalized `summary` snapshot rather than coupling to any cross-deployment shape. The shift module reads sales via `transactions/internal` (POS-local) and never touches the `api/v1/` surface. Nothing here widens the public HTTP API or locks in a data shape the eventual cross-deployment `products` sync would have to mirror. The audit verbs are free strings (no enum to graft). Clean.

---

## Plan Fidelity (Phase 5 task board)

| Task | Built? | Notes |
|---|---|---|
| `v12-be-shift-schema` (T1-2) | ✅ | Table + both indexes + pure lib exactly as specced. |
| `v12-be-shift-events` (T3) | ✅ | `_latestShiftEvent` / `_recordShiftEvent` / `_shiftStartAnchor` + `boothState`. |
| `v12-be-shift-lifecycle` (T4-7) | ✅ | All six mutations, ADR-013 wrapped, dual-call authCheck. |
| `v12-be-shift-takeover` (T8) | ✅ | `managerTakeover` action; auth boundary respected via `_managerTakeoverSession_internal`. |
| `v12-be-shift-telegram` (T9) | ✅ | `staff_shift_signoff` kind + render + scheduled from signoff/handover/takeover. |
| `v12-fe-shift-components` (T10-12) | ✅ | CountStep / StepRail / ShiftWizard + `useBoothState`; recount route refactored to reuse CountStep. |
| `v12-fe-shift-routes` (T13-15) | ✅ | start / end(choice+close+handover-out) / handover-in. |
| `v12-fe-shift-gate` (T16-17) | ⚠️ | Login fork + same-staff resume + manager takeover + home End-shift button all present. **`staleAutoclose` surfacing (ADR consequence) not wired** — see I1. |
| `v12-xc-shift-docs` (T18) | ⚠️ | ADR-050 + API_REFERENCE + SCHEMA + module row done; CHANGELOG route names and SCHEMA `takeover` prose are wrong — see M1, M2. |

No scope creep. The recount-route refactor to reuse `CountStep` was in-plan (T10 "extract count UI from recount route") and is a genuine consolidation, not gold-plating.

---

## STAFFREVIEW COMPLETE
