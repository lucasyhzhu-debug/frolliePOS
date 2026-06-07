# Staff Review: v0.6.1 — Admin-action auth hardening + e2e un-skip (SPEC)

**Date:** 2026-06-07
**Plan:** `docs/superpowers/specs/2026-06-07-v0.6.1-admin-auth-hardening-e2e-unskip-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Spec-stage doc — structural sections (file paths, commit boundaries, rollback, deployment) deferred to the plan; recorded in spec §7a.

---

## 1. Summary

**Overall Assessment: Approve** (improvements folded into the spec inline; no Critical issues).

The spec is architecturally sound and well-grounded in real code. Wave A correctly
mirrors the proven mutation-side `withIdempotency` authCheck pattern and closes the
hole *by construction* via a required param. Wave B is the standout: it is
explicitly evidence-gated (B1 investigation → proven cause → fix), directly honours
the §4.9 Evidence-Before-Mitigation gate, and cites the #44 misdiagnosis postmortem
as the reason not to plan a fix on the #43 hypothesis.

## 2. Critical Issues (Must Fix)

None. The change *removes* a security gap and introduces no schema/data risk.

## 3. Improvements (Recommended) — all addressed inline

| # | Improvement | Impact | Status |
|---|-------------|--------|--------|
| 1 | Session-resolution parity: `assertManagerSessionInAction` (`_resolveSessionRole_internal`) vs `verifyManagerPinOrThrow` (`getSession`+`_getStaffPinHash_internal`) are two resolvers for the same question → drift risk | M | ✅ §3.2 parity invariant + parity test added; OQ3 records unify-vs-test decision |
| 2 | Test must prove the "cache hit skips PIN" optimisation survives (no argon2 on retry), not just that bad sessions are rejected | M | ✅ §3.5 added explicit no-PIN-on-cache-hit spy test |
| 3 | ADR-046 should note the expired-session-can't-replay consequence (parity with mutations) | L | ✅ §3.4 updated |
| 4 | Spec defers structure (paths/commits/rollback/deploy) — name them for the plan | M | ✅ §7a added |

### Issue detail — Improvement 1 (the load-bearing one)
`verifyManagerPinOrThrow` at `convex/auth/verifyPin.ts:68` resolves via
`api.auth.public.getSession` then `internal.auth.internal._getStaffPinHash_internal`
(`!manager || !manager.active || manager.role !== "manager"` → `NOT_MANAGER`). The
spec's pre-cache gate uses `internal.auth.internal._resolveSessionRole_internal`
(`convex/auth/internal.ts:340`, returns `{staffId,deviceId,role}|null`, null on
ended/inactive). Both require *active manager, not-ended* today, so they agree — but
nothing enforces they stay aligned. If the pre-cache gate ever becomes laxer than
the inner check, the hole partially reopens; if stricter, legit calls break. The
spec now mandates a parity test and flags the optional single-resolver refactor.

## 4. Refinements (Optional)

- On a cache **miss**, the session is resolved twice (pre-cache `assert` + inside
  `verifyManagerPinOrThrow`). One extra `runQuery` on the cold path — acceptable
  (fail-cheap); noted, not worth optimising.

## 5. Duplication Analysis

| Code | Location | How to use |
|------|----------|------------|
| `withIdempotency` authCheck-before-cache | `convex/idempotency/internal.ts:57,61` | The exact pattern Wave A ports to the action layer — mirror it. |
| `_resolveSessionRole_internal` | `convex/auth/internal.ts:340` | Reuse for the pre-cache manager assert (don't write a new resolver). |
| `verifyManagerPinOrThrow` | `convex/auth/verifyPin.ts:68` | Keep inside `fn` unchanged for the PIN verify. |
| `idempotency-dual-call-authcheck.md` + ESLint `idempotency-required` | `docs/PATTERNS/`, `tools/eslint-rules/` | Precedent + (optional) enforcement model for the action side. |

## 6. Phase / Wave Accuracy

| Wave | Assessment | Notes |
|------|------------|-------|
| A — auth hardening | Good | Atomic, mechanical, well-bounded. |
| B — e2e un-skip | Good (evidence-gated) | B1 gate is correct; B-final allows surfaced-partial, never silent cap. |

## 7. Specialist Agent Recommendations

| Wave | Agent | Rationale |
|------|-------|-----------|
| A | `convex-expert` | Convex action/idempotency/auth internals. |
| B1/B2 | `general-purpose` | Playwright instrumentation + targeted fix. |

## 8. Git Workflow Assessment

Spec-stage: detailed commit/branch plan deferred to the plan (§7a). Rollback is
clean (Wave A = one revertable commit; no migration). ✅

## 9. Documentation Checkpoints

ADR-046 (new) · CLAUDE.md (rule #20 action-layer note + file locations) ·
CHANGELOG.md · PROGRESS.md (board). **No SCHEMA.md** (no schema change).

## 10. Testing Plan Assessment

**Verdict: Adequate (for a spec).** §3.5 now specifies the three Wave A tests
(cached-replay rejected / no-PIN-on-cache-hit / resolution parity) + green-suite
regression. Wave B testing is correctly evidence-then-CI. The plan must enumerate
per-action coverage.

## 11. Edge Cases to Address

- [x] Expired session on retry (ADR-046 consequence documented).
- [x] Cache-hit path skips PIN (test added).
- [x] staff-role session rejected pre-cache (test added).
- [ ] (Plan) Each of the 7 actions individually covered or via shared parametrised test.

## 12. Approval Conditions

**To approve:** none outstanding (no Criticals).
**Folded in before the plan gate:** Improvements 1–4 (all ✅ inline).

---

*Generated by /staffreview*
