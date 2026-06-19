# Staff Review: v1.2 Shift SOP Flow (spec)

**Date:** 2026-06-19
**Plan:** `docs/superpowers/specs/2026-06-19-v1.2-shift-sop-flow-design.md` (design spec, pre-plan)
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Design spec — implementation-plan sections (waves, commit checkpoints, full test matrix) are deferred to the `writing-plans` step by design; spec carries goal/scope/state-machine/data-model/files/decisions/constraints. Validated for a spec.

---

## 1. Summary

**Overall Assessment:** Revise (then approve)

Strong, well-grounded design — the state-machine framing is right and most cross-module reuse claims check out against real code. Three findings block a clean plan: the **hours anchor** is wrong under the current lock-ends-session model, the **LOCKED state** contradicts ADR-003 + `lock.tsx` as written, and the **Telegram template name collides** with the existing `shift_summary` kind. All are fixable inline in the spec.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Hours anchored to `staff_sessions.started_at`, but lock ends the session → a shift fragments across N sessions | Logic | §4 |
| 2 | LOCKED modeled as a held/resumable session; `lock.tsx` fully ends the session (ADR-003) | Architecture | §2, §3E |
| 3 | New Telegram kind `shift_signoff` collides conceptually with the existing `shift_summary` kind | Implementation | §5 |

### Issue 1: Hours anchor breaks under lock=end-session
`lock.tsx:18-23` calls `logout` (ends the `staff_sessions` row) and routes to `/login`; resuming creates a **new** session via `loginWithPin`. So a staffer who locks for lunch produces **two+ sessions in one shift**. The spec's §4 "`shift_started_at` comes from `staff_sessions.started_at`" therefore measures only the *last* session segment, not the shift.

**Recommendation:** Anchor hours to the **shift-start `pos_shift_events` row** (`start_of_day` / `handover_in` / `manager_takeover`), ending at the sign-off event. `staff_sessions` is the wrong anchor. Update §4 + locked-decision #6.

### Issue 2: LOCKED state contradicts ADR-003 + current lock
The spec's LOCKED = "resume as yourself, session held". Real behavior (`lock.tsx`, ADR-003 "session ends on explicit Lock") = session is destroyed server-side. Keeping the session alive during lock would re-open the unattended-device security hole ADR-003 closed (a persisted session token is replayable).

**Recommendation:** Honor ADR-003 — lock **ends the session**. Model LOCKED as a **booth-state layer**: a new `lock` `pos_shift_events` type names the locked staff; the **login gate** enforces same-staff-resume (fresh login, same staff) and offers manager-unlock. Resume = a fresh same-staff login that returns booth state to OPEN (log a `resume` event or clear on next activity). Manager-unlock = a fresh manager login flagged `takeover`. No held session. Update §2 (add `lock` type, state-derivation rule) + §3E.

### Issue 3: `shift_summary` kind already exists
`send.ts:37` kind union + `foundersSummary.ts:127` already ship a `shift_summary` template — the **daily founders rollup** (`{dateLabel, totalSalesIdr, txnCount, flaggedCount, manualBca}`), and `telegramHtml.ts` already renders the `manualBca` itemization.

**Recommendation:** Use a clearly distinct kind for the **per-shift** message (e.g. `shift_signoff`) and **reuse the existing `manualBca` payload shape + its `telegramHtml` renderer fragment** rather than writing a new one. Note the existing kind in §5 so the plan doesn't overload the daily payload.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | State manager-unlock + sign-off PIN paths are **actions** (argon2 long-running), not mutations | H | L |
| 2 | Clarify booth-state derives from latest `pos_shift_events` row, NOT `staff_sessions` active-ness | M | L |
| 3 | Spell the single-active-session invariant via `by_device_active` for the atomic handover swap | M | L |

### Improvement 1: PIN paths are actions
`verifyManagerPinOrThrow` (verifyPin.ts:98) is `ActionCtx`. The manager-unlock takeover and any PIN re-entry must funnel through an **action** (mirror `loginWithPin`), then commit booth/shift state in a mutation. The Convex throw-rolls-back-writes rule means the "force-end A + start M" sequence needs the loginWithPin action→committed-mutation shape, not one mutation. Name this in the spec so the plan doesn't model it as a mutation.

### Improvement 2: state source
`staff_sessions.by_device_active` [`device_id`, `ended_at`] gives "current staff" but goes **stale across a lunch-lock** (no active session, booth still operating). Booth STATE must come from the latest `pos_shift_events` row; `staff_sessions` only answers "who is signed in right now." Make this explicit in §2/§8.

### Improvement 3: atomic handover
Handover ends outgoing + starts incoming. Rely on `by_device_active` to enforce exactly one active session; the end-A and start-B must not interleave to leave two active or zero. Flag for the plan's concurrency section.

## 4. Refinements (Optional)
- Mockup `shift-flow-mockup.html` frame order: the lock screen (frame 5) isn't part of the linear end-shift journey — place it after the handover frames or as its own track (already noted by Lucas).
- Spec is a design doc: the full test matrix + commit waves are correctly deferred to `writing-plans`; the plan must define them (see §10).

## 5. Duplication Analysis
### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `_manualBcaReconciliation_internal` | `convex/transactions/internal.ts:825` | per-shift manual-BCA tally for the founders message (pass shift window) |
| `recordRecount` | `convex/inventory/public.ts` (via `routes/stock/recount.tsx`) | the count step's write — `{idempotencyKey, sessionId, counts:[{skuId,entered}]}` |
| recount row UI | `routes/stock/recount.tsx:50-91` | extract the SKU-row+input+delta list into a shared count component |
| `shift_summary` template + `manualBca` renderer | `send.ts:37`, `telegramHtml.ts`, `foundersSummary.ts` | reuse payload shape + renderer fragment for the per-shift kind |
| `verifyManagerPinOrThrow` | `convex/auth/verifyPin.ts:98` | manager-unlock takeover (action) |
| `logout` | `api.auth.public.logout` | end-session on close/handover/lock |

### Duplication risks
- Re-implementing a count UI instead of extracting from `recount.tsx`.
- Writing a second manual-BCA renderer instead of reusing the `shift_summary` one.

## 6. Phase / Wave Accuracy
Deferred to plan. Spec's §10 file map is a sound wave seed (schema → shifts module → telegram → FE routes → docs).

## 7. Specialist Agent Recommendations
| Area | Agent | Rationale |
|------|-------|-----------|
| Backend (shifts module, state machine, telegram) | `convex-expert` | Convex schema/index/action patterns |
| FE wizard + login-gate fork | `frontend-integrator` | React+Convex wiring, hook boundaries |
| Shared wizard/StepRail/count components | `ui-component-builder` | shadcn + phthalo tokens + motion |

## 8. Git Workflow Assessment
Pipeline-managed (worktree off synced main → squash PR). Spec itself committed `a226195`. Plan must add commit checkpoints per wave.

## 9. Documentation Checkpoints
Spec §10 names the doc set: new ADR (shift lifecycle + state machine + manager-takeover-as-handover + **ADR-003 amendment for the LOCKED booth-state layer**), `SCHEMA.md` (`pos_shift_events` + audit verbs), `API_REFERENCE.md` (shifts module), `CHANGELOG.md`, CLAUDE.md (module row + business rule). Add the ADR-003 amendment explicitly (Issue 2).

## 10. Testing Plan Assessment
**Verdict:** Deferred to plan (spec stage). The plan MUST cover:
- `pos_shift_events` schema round-trip + state-derivation (CLOSED/OPEN/LOCKED, stale-autoclose).
- Each wizard-completion mutation: valid, auth-reject, idempotent replay.
- Hours computation anchored to shift-start event across a lock/resume cycle (the Issue-1 regression).
- Manager-takeover action: non-manager rejected, displaced-staff force-end, `outgoing_uncounted` flag, founders summary fires flagged.
- Handover two-write count; incoming with no accept screen.
- Telegram `shift_signoff` render (per-shift), distinct from daily `shift_summary`.
- FE: login-gate fork per state; same-staff lock resume; wizard step-rail render; count-step submit (mock `useIdempotency`→string, the #12 jsdom trap).

## 11. Edge Cases to Address
- [ ] Forgot-to-close: stale OPEN/LOCKED from a prior WIB day → next sign-in = start-of-day + `stale_autoclose` (in spec ✓).
- [ ] Lock → resume same staff: hours must not double-count or reset (Issue 1).
- [ ] Manager-takeover when the displaced staff's session already ended by lock.
- [ ] Handover incoming = a manager (manager can take over then later hand back).
- [ ] Offline during a wizard step (count writes need the offline queue or a clear block — confirm in plan).

## 12. Approval Conditions
**To approve, address:** Issues 1, 2, 3 (inline spec edits).
**Recommended before plan:** Improvements 1–3.

### Evidence-Before-Mitigation Gate
N/A — this is a feature spec, not a flake/race fix. No symptom-masking mitigation proposed.

---
*Generated by /staffreview*
