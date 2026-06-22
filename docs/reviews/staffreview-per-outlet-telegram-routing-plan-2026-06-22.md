# Staff Review: Per-outlet Telegram routing — PLAN

**Date:** 2026-06-22
**Plan:** `docs/superpowers/plans/2026-06-22-v2.0-telegram-per-outlet-routing.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, Architecture, Global Constraints, File Structure, 13 tasks with TDD steps, deploy ordering, rollback, docs, self-review all present)

---

## 1. Summary

**Overall Assessment:** Approve.

The plan is grounded in real code (exact file:line targets for every modified function) and resolves the spec-gate decisions task-by-task. The load-bearing architectural call — keeping the resolver a pure `telegramChats` query and lifting the single-outlet fallback into an action-layer `resolveOutletChatId` helper — correctly respects both Convex's queries-have-no-runQuery constraint and the `no-cross-module-db-access` fence. The whole slice is correctly gated on Spec-1 execution with the two required Spec-1 amendments called out. Two self-review catches fixed inline (dead idempotency line in Task 12; managers-feed double-post confirmed "keep both" by the user).

## 2. Critical Issues
None blocking. (The chatIdOverride-no-safety-net risk is already elevated in the plan with per-callsite tests in T6/T7 — the correct mitigation.)

## 3. Improvements (applied / confirmed)
| # | Improvement | Resolution |
|---|-------------|-----------|
| 1 | Task 12 backfill had a dead idempotency guard (`if c.role === "owners"` inside the `founders` branch) | Fixed inline — branch is naturally idempotent post-rebind |
| 2 | Managers feed now gets per-shift signoffs + daily rollup (decisions 1+2 combine) | Confirmed with user → keep both (different granularities) |
| 3 | `mgrListChats` can't resolve `outlet_label` in a query (no runQuery + cross-module fence) | Plan resolves: return raw `outlet_id`, FE joins `listOutlets` for labels (T9 Step 5, T10) |

## 4. Refinements
- T7: consider a shared `_dailyOutletAggregate(ctx, outletId, window)` to avoid repeating the per-outlet aggregate between the owners rollup and the managers summary loops.
- If managers-feed volume becomes noisy in practice, a per-outlet `managers_daily_summary` toggle already exists (its outlet's `founders_summary_enabled`) — operators can silence it per outlet.

## 5. Duplication Analysis
- **Reuse confirmed:** `getChatIdByRole` JS-filter → `_resolveBareRoleChatId` shared impl (T3); `assignRoleArgs`/`assignRoleImpl` extended not forked (T9); `dispatchRoleAlert` extended with `outletId` (T6); `renderFoundersSummary` formatting reused by `renderManagersDailySummary` (T4) + `renderOwnersSummary` (T7).
- **One helper across 5 callsites:** `resolveOutletChatId` (T4) is the single two-tier+fallback path for sendTemplate, dispatch, ticker, drift cron, owners cron — avoids 5 copies (rule-of-three honored).

## 6. Phase / Wave Accuracy
13 tasks, correctly ordered: schema (T1) → config (T2) → resolver (T3) → sendTemplate (T4) → callsite sweeps (T5 class-a, T6 class-b) → summaries (T7) → system_error (T8) → admin (T9) → FE (T10) → activatepos (T11) → backfill (T12) → docs (T13). T1–T11 ship atomically (FE+backend, deploy-skew rule); T12 backfill after. ✅

## 7. Specialist Agent Recommendations
| Area | Agent | Rationale |
|------|-------|-----------|
| T3/T4/T6/T7 resolver + sends | `convex-expert` | index discipline + optional-field-filter + action/query split |
| T10 FE outlet picker | `frontend-integrator` | React+Convex+i18n fence |

## 8. Git Workflow Assessment
Squash-PR. One commit per task (templates given). Pre-push: `npm run typecheck && npm run lint && npx vitest run`. Rollback: additive/optional column tolerates absent values; `founders` alias kept through the window so a resolver/FE rollback doesn't orphan the chat. Deploy ordering documented + load-bearing.

## 9. Documentation Checkpoints
T13 covers SCHEMA / RUNBOOK (incl. the recount→managers clarification + cron rename) / CLAUDE / CHANGELOG. ✅

## 10. Testing Plan Assessment
**Verdict:** Adequate. Each task is TDD (failing test first). The highest-risk paths (chatIdOverride callsites, single-outlet fallback fence, founders→owners backfill, per-outlet vs business send) each have explicit tests. The one implementer-choice is the action-test harness shape in T4 — pointed at the repo's existing `convex/telegram/__tests__/` action-test pattern.

### Regression risk
- `renderFoundersSummary` rename + `shift_summary` payload `perOutlet` addition → sweep test files asserting on the old name / shape.
- `foundersSummary` → `ownersSummary` symbol rename → `grep -rn foundersSummary convex` sweep (incl. CLAUDE.md on-demand command).
- `staff_shift_signoff` role flip (founders→managers) → any test asserting it routes to founders.

## 11. Edge Cases (covered in plan)
- [x] Transitional window (Step 1 deployed, backfill not run) → single-outlet fallback keeps routing live.
- [x] One outlet's managers/inventory chat unbound during daily cron → skip that outlet only.
- [x] `owner_otp` (`role:"owner"`, chatIdOverride) never hits ROLE_SCOPE.
- [x] Backfill idempotent (re-run no-ops; founders→owners branch naturally idempotent post-fix).
- [x] `/activatepos` from non-managers chat → silent no-op.

## 12. Approval Conditions
**Verify-first at execution (the plan's own list is authoritative):**
1. Spec 1 is EXECUTED in code (whole slice blocked on it).
2. Two Spec-1 amendments present (`telegramChats` fence-excluded; `_listActiveOutlets_internal`).
3. `_dailySalesSummary_internal`/`_manualBcaReconciliation_internal`/`_getSettings_internal` accept an explicit `outletId` under Spec 1 (cron has no session).
4. The chatIdOverride callsites each get their own per-outlet test (no safety net).

**Ready for execution** after Spec 1 lands.

---

*Generated by /staffreview*
