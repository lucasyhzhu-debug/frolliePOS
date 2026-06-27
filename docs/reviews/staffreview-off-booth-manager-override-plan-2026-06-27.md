# Staff Review: Off-booth manager override — PLAN

**Date:** 2026-06-27
**Plan:** `docs/superpowers/plans/2026-06-27-off-booth-manager-override.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — Task List, Execution Strategy, File Structure, per-task TDD, Testing, Success Criteria, Rollback all present.

## 1. Summary

**Overall Assessment:** Revise (small, mechanical) — then execute.

The plan is well-structured and the architecture is sound (it already absorbed the spec-gate
corrections). The plan-gate's job was to verify the flagged assumptions against real code; four were
checked and three need a fix. All are reference/precedent corrections, not design changes.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| P1 | Existing `managerOverride.test.ts` breaks when `resultingState` becomes required | Testing | T2 |
| P2 | `_getOutletById_internal` does not exist | Logic | T4 |

### P1 — T2 must UPDATE the existing override tests, not just add new ones
`convex/shifts/__tests__/managerOverride.test.ts` already exists (Task 8 of the shift-lifecycle work)
and has 5 tests that call `api.shifts.actions.managerOverride` **without** `resultingState`. T2 makes
`resultingState` a **required** arg, so all 5 calls fail typecheck/runtime. It also already has an
inline seed helper (`t.run(async (ctx) => …)` at line ~67) — there is **no** `_helpers.ts` and no
`seedOutletAndOpenShift`.

**Recommendation:** T2 (a) updates the 5 existing calls to pass `resultingState:"release"` (preserves
their current "outlet stays open" assertions), (b) adds two new tests for `closeOutlet`-via-`"close"`
and the no-hold-but-close path, reusing the **inline `t.run` seed pattern already in the file**.
Delete the plan's invented `_helpers.ts` / `seedOutletAndOpenShift` import everywhere (T2/T4/T5);
seed inline like the existing tests.

### P2 — Outlet reader is `_getOutlet_internal`
`convex/outlets/internal.ts` exports `_getOutlet_internal({ outletId })` → `ctx.db.get(outletId)`
(returns the outlet doc with `.name`). There is no `_getOutletById_internal`.

**Recommendation:** In T4, replace `internal.outlets.internal._getOutletById_internal` with
`internal.outlets.internal._getOutlet_internal`. No new reader needed.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| P3 | T3 render must return `RenderedMessage`, model on `renderSpoilageApproval` | M | L |
| P4 | Drop the `_listStaffNames_internal` fallback caveat — confirmed `{_id,name}` | L | L |

### P3 — Match the telegram render contract
Every renderer in `convex/lib/telegramHtml.ts` returns the shared `RenderedMessage` type and is named
`render<Kind>Approval` / `render<Kind>`. The ad-hoc `{ text, reply_markup }` in the plan is wrong.
Model `renderShiftOverride` on **`renderSpoilageApproval`** (closest: an approval card with a URL
button routed to `managers`), define a `ShiftOverridePayload` type beside the other payload types, and
return `RenderedMessage`. Wire it into `sendTemplate`'s payload union + dispatch exactly like
`spoilage`.

### P4 — Resolve the staff-name caveat
`_listStaffNames_internal` returns `Array<{ _id: Id<"staff">; name: string }>` — the plan's
`staffNames.find((s) => s._id === hold.staff_id)?.name` works as written. Remove the verify-first
fallback note in T4; keep `_listStaffNames_internal`.

## 4. Refinements (Optional)
- Consider extracting the inline `pos_shifts` seed into a shared `convex/shifts/__tests__/_seed.ts`
  used by both the shifts and approvals override tests — only if it reduces duplication meaningfully;
  otherwise inline is consistent with the existing file. (Rule-of-three; not yet.)

## 5. Duplication Analysis
- T3: reuse `renderSpoilageApproval` shape. T5: copy `approveSpoilage` verbatim. T4: model on
  `requestManualPaymentApproval` (minus session). T6: copy the `ManualPaymentOverride` component.
  All correctly identified; the only misses were the render return type (P3) and the outlet reader (P2).

## 6. Phase / Wave Accuracy
Waves are correct. One note: T2's test-file edit means T2 also touches an **existing** test that other
shift tests don't import, so no cross-task collision — still Wave-1 safe.

## 7. Specialist Agent Recommendations
| Wave | Agent |
|------|-------|
| 1–2 backend | `convex-expert` |
| 3 FE | `frontend-integrator` + `/frontend-design` for the `/approve` card |

## 8. Git Workflow
Commit-per-task, squash-merge. Build/typecheck before push. ✅

## 9. Documentation Checkpoints
T8 covers SCHEMA/API_REFERENCE/CLAUDE/CHANGELOG/ROADMAP. ✅

## 10. Testing Plan Assessment
**Verdict:** Adequate after P1 (update existing tests + inline seed). Coverage spans validation,
both commit branches, session-less request + dedup + no-hold, approve happy/NOT_MANAGER/cap/reuse,
render, and both FE surfaces. Live Telegram round-trip correctly deferred to persona-UAT.

## 11. Edge Cases
- [x] No-hold + close → close still applies (folded into T2).
- [x] Dedup per shift (T4).
- [x] Wrong PIN cap isolation (T5).
- [ ] Confirm `_getOutlet_internal` returns null-safe (`ctx.db.get` can be null) → plan already uses `outlet?.name ?? "Booth"`. ✓

## 12. Approval Conditions
**To approve:** P1, P2 (fix T2 tests + outlet reader). **Recommended:** P3, P4.

*Generated by /staffreview*
