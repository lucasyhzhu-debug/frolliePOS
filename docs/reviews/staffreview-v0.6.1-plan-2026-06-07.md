# Staff Review: v0.6.1 — Admin-action auth hardening + e2e un-skip (PLAN)

**Date:** 2026-06-07
**Plan:** `docs/superpowers/plans/2026-06-07-v0.6.1-auth-hardening-e2e.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, File Structure, Waves/Tasks, Testing, Success Criteria, Rollback/Deploy, Agents all present).

---

## 1. Summary

**Overall Assessment: Approve** (one Improvement found + fixed inline; no Critical issues).

The plan is tightly grounded in verified code — real signatures for `withActionCache`,
`assertManagerSessionInAction`, and exact insertion points at all 7 call sites. TDD
ordering is correct. Wave B is per-cluster evidence-gated with verify-on-main-first
steps and cited run IDs. The one finding was a convex-test API misuse in the A1 test.

## 2. Critical Issues (Must Fix)

None.

## 3. Improvements (Recommended) — addressed inline

| # | Improvement | Impact | Status |
|---|-------------|--------|--------|
| 1 | A1's standalone test used `t.action(inlineFn)` — unsupported by `convex-test@0.0.34` (every `t.action` in the suite takes a FunctionReference). The helper is also redundantly covered by A2/A3 through `createVoucher`'s authCheck. | M | ✅ A1 reduced to implement-only; coverage moved to A2 (staff-session reject) + A3 (ended-session reject); File Structure + Testing table updated. |

### Issue detail — Improvement 1
Verified against `convex/**/__tests__/*.ts`: 100% of `t.action(...)` calls pass
`internal.X`/`api.X`. `convex-test@0.0.34` exposes no inline-`ActionCtx` runner, and
`t.run(ctx)` yields a mutation-style ctx (no `runQuery`). Testing the action-context
helper directly would require a production-tree internalAction fixture — not worth it
when A2/A3 already drive the exact rejection paths through a real action.

## 4. Refinements (Optional)

- A2 Step 4 changes a breaking signature + 7 call sites in one commit. Correct (the
  required param can't land incrementally and stay green); the per-site edits are
  identical and typecheck-guarded. No action needed.

## 5. Duplication Analysis

| Code | Location | How to use |
|------|----------|------------|
| `withIdempotency` authCheck | `convex/idempotency/internal.ts:57` | Pattern mirrored — not duplicated. |
| `_resolveSessionRole_internal` | `convex/auth/internal.ts:340` | Reused by the new helper (no new resolver). |
| `seedManagerSession` | `convex/staff/__tests__/_helpers.ts` | Reused by all A-tests. |
| `docs/xendit-reference/` | repo | Consulted by B1 before re-researching the simulate id. |

No duplication introduced.

## 6. Phase / Wave Accuracy

| Wave/Task | Assessment | Notes |
|-----------|------------|-------|
| A1 helper | Good (post-fix) | Implement-only; verified via A2/A3. |
| A2 signature + 7 sites | Good | Atomic, typecheck-gated, exact edits shown. |
| A3 regression tests | Good | Proves auth-before-cache AND PIN-skip-on-hit. |
| A4 ADR/docs | Good | ADR-046, CLAUDE.md #20, CHANGELOG. |
| B1 C1 verify | Good | Evidence-gated; consults xendit-reference. |
| B2/B3 C1 fix + un-skip | Good | Single-source id fix; green-gated, one spec at a time. |
| B4 C2 seed IDs | Good | Dev-scoped; no false-green. |
| B5 C3 spoilage | Good | Headed repro before fix. |
| B6 CI/board | Good | Verifies CI auto-picks un-skipped specs. |

**Ordering:** sound (A before B; within B, C1→C2→C3 by leverage). **Missing phases:** none.

## 7. Specialist Agent Recommendations

| Wave | Agent | Rationale |
|------|-------|-----------|
| A | `convex-expert` | action/idempotency/auth internals. |
| B | `general-purpose` | Playwright + Xendit + seed. |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch | ✅ worktree branch (pipeline lands via squash PR) |
| Commit boundaries | ✅ one per task/sub-step, templated |
| Pre-push verification | ✅ typecheck + `npm test` + Playwright green |
| Rollback | ✅ Wave A = revert A2 commit; Wave B = re-skip |
| Deployment order | ✅ `npx convex deploy`; FE deploy only if C1 routes into charge.tsx |
| Migration safety | ✅ N/A — no schema change |

## 9. Documentation Checkpoints

ADR-046 (A4) · CLAUDE.md rule #20 (A4) · CHANGELOG (A4) · PROGRESS coverage note
(B6) · issue-#43 triage postmortem (B1). **No SCHEMA.md** (no schema change).

## 10. Testing Plan Assessment

**Verdict: Adequate.** Wave A: auth-before-lookup (replay rejected), cache-hit-skips-PIN,
resolution-parity, + all 7 existing action suites stay green. Wave B: each cluster
gated on its spec going green; residuals must be surfaced (no false-green un-skip).
Full `npm test` + typecheck before landing.

### Regression risk
- A2 touches 4 action files; existing action tests are the guard (public signatures
  unchanged → they must stay green).
- B fixes touch `charge.tsx`/`seed/actions.ts`/`spoilage.tsx` — the already-passing
  `auth` spec + the un-skipped specs are the guard.

## 11. Edge Cases to Address

- [x] Ended/staff session rejected pre-cache (A2/A3).
- [x] Cache-hit skips PIN (A3).
- [x] Wave B residual surfaced, not false-greened (§4.4 / B-tasks).
- [ ] (Executor) If B1 shows the Xendit fix needs an endpoint/contract change (not just
  id source), re-scope B2 and surface — don't force the un-skip.

## 12. Approval Conditions

**To approve:** none outstanding (no Criticals).
**Addressed inline before landing:** Improvement 1 (A1 test pattern).

### Evidence-Before-Mitigation Gate: ✅ PASS
Wave B cites concrete artefacts (PR-#52 runs `27054044763`/`27055135440`/`27055267328`,
`.claude/pw-report/...` paths) per cluster, includes a verify-on-current-`main` step
before each fix, and the fixes are scoped to proven causes — not invasive changes on
an unverified hypothesis. The plan itself *corrected* the #43 single-cause assumption.

---

*Generated by /staffreview*
