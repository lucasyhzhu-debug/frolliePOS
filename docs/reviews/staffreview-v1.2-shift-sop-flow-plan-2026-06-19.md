# Staff Review: v1.2 Shift SOP Flow (plan)

**Date:** 2026-06-19
**Plan:** `docs/superpowers/plans/2026-06-19-v1.2-shift-sop-flow.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — Goal, Architecture, Global Constraints, File Structure, Interfaces, 18 tasks across 6 waves (SEQUENTIAL by dependency), Success Criteria, Rollback/Deployment, Testing Summary all present.

---

## 1. Summary

**Overall Assessment:** Revise (then approve) — three Critical issues, all from assumption-verification against real code; none architectural. The wave structure, TDD shape, reuse, and signatures are sound. Most flagged assumptions verified TRUE; three were wrong and are fixed inline.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `staff_sessions.end_reason` is a **literal union** (`manual_lock`/`timeout`/`force_logout`/null), not a free string — the plan's `"signoff"`/`"handover"`/`"lock"` values fail schema validation | Schema | Tasks 5,6,7; Rollback |
| 2 | `_listStaffNames_internal` takes `{}` and returns **all** staff `{_id,name}` — the plan calls it with `{ staffIds: [...] }` | Logic | Task 3; Task 9 |
| 3 | Tests use `convexTest(schema)` (single arg) — the plan imports a non-existent `modules` from `test.setup` and seeds `staff` without `created_at` | Testing | all test snippets |

### Issue 1: `end_reason` is a closed literal union
`convex/auth/schema.ts:27-32` — `end_reason: v.union(v.literal("manual_lock"), v.literal("timeout"), v.literal("force_logout"), v.null())`. Patching `end_reason: "signoff"` (Task 5), `"handover"` (Task 6), `"lock"` (Task 7) throws a schema validation error.
**Recommendation:** Reuse existing literals — **`"manual_lock"`** for lock; **`"force_logout"`** for signoff / handover / takeover session-ends. This keeps the plan's "no `staff_sessions` schema change" promise true. The precise intent is already captured by `pos_shift_events.type`; `end_reason` only needs to be valid. (Fixed inline.)

### Issue 2: `_listStaffNames_internal` signature
`convex/auth/__tests__/list-staff-names.test.ts:15` + `convex/audit/public.ts:46-48` — it's `_listStaffNames_internal({})` returning **all** staff projected to `{ _id, name }`; callers map by id (`new Map(rows.map(s => [String(s._id), s.name]))`). The plan's `boothState` calls it with `{ staffIds: [derived.staffId] }` and indexes `[0]` — both wrong.
**Recommendation:** Call `{}`, then `rows.find(s => String(s._id) === String(staffId))?.name`. Same fix in Task 9's payload assembly. (Fixed inline.)

### Issue 3: convex-test harness shape
`convex/auth/__tests__/list-staff-names.test.ts:8` — `const t = convexTest(schema);` (single arg; no `modules`/`test.setup`). Staff seeds use `as any` and include `created_at`. The plan's `convexTest(schema, modules)` + `import { modules } from "../../test.setup"` won't resolve, and `staff` inserts omit `created_at`.
**Recommendation:** Added a **Test conventions** note to the plan (after Global Constraints): all snippets use `convexTest(schema)`, drop the `modules` import, seed `staff` via the `as any`-cast shape incl. `created_at`. (Fixed inline.)

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Two-call window in handover-in / resume (FE calls `loginWithPin` then the shift mutation) — booth shows `handover_pending` until the second call lands | M | L |
| 2 | `boothState` may read `pos_shift_events` via `ctx.db` directly (same module) instead of the `_latestShiftEvent_internal` hop | L | L |

### Improvement 1: handover-in / resume two-call atomicity
`loginWithPin` (action) creates the session; `completeHandoverIn`/`recordResume` (mutation) records the event. Between them the booth is briefly `handover_pending`/`locked`. Acceptable (the FE chains them and a reload re-derives correctly), but note it in the route so a mid-call reload routes back into the same stage. No code change required; document the window.

### Improvement 2: same-module read
`ctx.runQuery(internal.shifts.internal._latestShiftEvent_internal,…)` from the `boothState` query works (the codebase uses `ctx.runQuery` in queries — `audit/public.ts:46`), but reading `pos_shift_events` directly via `ctx.db` in `boothState` is one less hop. The internalQuery is still needed by the takeover action. Optional.

## 4. Refinements (Optional)
- Task 8's takeover test body is abbreviated ("full body in implementation") — acceptable given it mirrors `convex/auth/__tests__` hashing, but spell the non-manager-reject + `outgoing_uncounted` assertions when implementing.
- Tasks 7/8 say "mirror Task 6" for some code — the executor should repeat, not cross-reference, when building out of order.

## 5. Duplication Analysis
### Verified reuse (all confirmed present)
| Code | Location | Status |
|------|----------|--------|
| `wibDayWindow(now) → {dayStartMs,dayEndMs,dateLabel}` | `convex/lib/time.ts:77` | ✅ shape matches plan |
| `_dailySalesSummary_internal({dayStartMs,dayEndMs}) → {totalSalesIdr,txnCount,flaggedCount}` | `convex/transactions/internal.ts:337` | ✅ name + shape correct |
| `_manualBcaReconciliation_internal` | `convex/transactions/internal.ts:825` | ✅ `{items,count,totalIdr}` |
| `logAudit(ctx,{actor_id,action,entity_type,entity_id?,…})` | `convex/audit/internal.ts:24` | ✅ |
| `requireSession`/`requireManagerSession` | `convex/auth/sessions.ts` | ✅ `{staffId,deviceId,role}` |
| `withIdempotency` / `withActionCache` / `verifyPinOrThrow` / `_getStaffPinHash_internal` | per reference | ✅ signatures match |
| `recordRecount` / `CountStep` source | `convex/inventory/public.ts`, `routes/stock/recount.tsx` | ✅ |
| `ManualBcaTally` + `renderFoundersSummary` fragment | `convex/lib/telegramHtml.ts` | ✅ reuse for `renderStaffShiftSignoff` |

### Duplication risk
- None beyond those the plan already routes to reuse.

## 6. Phase / Wave Accuracy
| Wave | Assessment | Notes |
|------|------------|-------|
| 1 Foundation (T1-3) | Good | schema → pure lib → writer/query; correct order |
| 2 Lifecycle (T4-8) | Good | depends on W1; T8 takeover depends on T3 writer |
| 3 Telegram (T9) | Good | wires schedule into T5/6/8 |
| 4 FE shared (T10-12) | Good | parallelizable with W1-3 (different files) |
| 5 FE routes/gate (T13-17) | Good | depends on W2 (mutations) + W4 (components) |
| 6 Docs (T18) | Good | last |

**Ordering issues:** none. **Missing phases:** none.

## 7. Specialist Agent Recommendations
| Wave | Agent | Rationale |
|------|-------|-----------|
| 1-3, 9 backend | `convex-expert` | schema/index/action/idempotency patterns |
| 10-12 components | `ui-component-builder` | shadcn + phthalo tokens + motion |
| 13-17 routes/gate | `frontend-integrator` | React+Convex wiring, login-gate fork |

## 8. Git Workflow Assessment
| Check | Status |
|-------|--------|
| Feature branch specified | ✅ (pipeline worktree `worktree-shift-sop-flow`) |
| Merge strategy | ✅ squash PR (pipeline) |
| Commit per task | ✅ each task ends in a commit |
| Pre-push verification | ✅ Task 18 runs `typecheck && lint && vitest && build:fe` |

## 9. Documentation Checkpoints
| Phase | Docs |
|-------|------|
| T1 | `SCHEMA.md` (`pos_shift_events` + audit verbs) |
| T18 | ADR-050, `CLAUDE.md` (module row + rule), `API_REFERENCE.md`, `CHANGELOG.md` |

## 10. Testing Plan Assessment
**Verdict:** Adequate (after Issue 3 fix). Each backend fn has valid + auth-reject + idempotent-replay; pure lib fully unit-tested; FE components + routes + login-gate fork covered; the #12 jsdom `useIdempotency`→string trap is called out. Hours-across-lock regression test present (Task 7).

### Missing coverage to add
| # | Test | Why | Approach |
|---|------|-----|----------|
| 1 | `boothState` stale-autoclose path (prior-WIB-day open) | the forgot-to-close edge | seed an event with `created_at` < day start; assert `closed` + `staleAutoclose` |
| 2 | handover excludes outgoing staff from the incoming picker | core invariant | Task 15 test — assert outgoing id absent from the list |

## 11. Edge Cases to Address
- [x] Stale shift (prior WIB day) — Task 2 lib test + add the boothState integration test above.
- [ ] Offline mid-wizard — count writes use the existing idempotency/queue; confirm the wizard blocks or queues (note in Task 13/14).
- [ ] Manager-takeover when the displaced session already ended by lock — `_commitManagerTakeover_internal` must no-op the force-end gracefully.

## 12. Approval Conditions
**To approve, address:** Issues 1, 2, 3 (fixed inline this pass).
**Recommended:** Improvements 1-2 (documented; no blocking code change).

### Evidence-Before-Mitigation Gate
N/A — feature plan, not a flake/race fix.

---
*Generated by /staffreview*
