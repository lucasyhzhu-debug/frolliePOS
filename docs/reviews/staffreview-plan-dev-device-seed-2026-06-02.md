# Staff Review: Dev Device Pre-registration (plan)

**Date:** 2026-06-02
**Plan:** `docs/superpowers/plans/2026-06-02-dev-device-seed.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, File Structure, Tasks, Success Criteria, Rollback all present)

---

## 1. Summary

**Overall Assessment:** Approve (0 Critical, 1 Improvement, 2 Refinements)

The plan is precise, TDD-structured, and grounded — every flagged assumption verified
against the codebase below. The only gap worth fixing before execution: `npm run lint`
is not in the verification path, and the repo's CI runs strict ESLint plus an idempotency
assertion script. Low effort to add.

## 2. Critical Issues (Must Fix)

None. All load-bearing assumptions verified:

| Assumption | Verification |
|---|---|
| `dev` script has no `--mode` override → MODE="development" | ✅ `package.json` `"dev": "vite"` |
| prod build → MODE="production" | ✅ `"build": "tsc -b && vite build"` |
| `npm run typecheck` is the real command | ✅ `"typecheck": "tsc -b && tsc -p convex"` |
| `registered_devices.activated_by` is required `v.id("staff")` | ✅ `convex/auth/schema.ts:46` |
| `registered_devices` already in wipe list | ✅ `convex/seed/internal.ts:28` |
| `_reset_internal` discards manager id | ✅ `convex/seed/internal.ts:55` (plan fixes it) |
| `import.meta.env.DEV` true under vitest | ✅ probed `{"DEV":true,...,"MODE":"test"}` |
| only `bootstrap.test.ts` exists in seed tests | ✅ confirmed; plan creates `reset.test.ts` |
| `internal.seed.internal._reset_internal` callable in convex-test | ✅ matches `bootstrap.test.ts` import pattern |

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Add `npm run lint` to verification (CI runs strict ESLint + idempotency assert) | M | L |

### Improvement 1: Lint is not in the verification path

`package.json` `"lint": "eslint . && bash tools/ci/assert-strict-idempotency-rule.sh"`.
The hook edit in Task 1 (state initializer + effect early-return with `[]` deps) is the
most likely place to trip `react-hooks/exhaustive-deps` or similar. Although `DEV_SERVER`
is a module-scope constant (so exhaustive-deps should not flag it), CI will run lint
regardless — catching it locally is cheaper than a failed PR check. The idempotency
assertion is irrelevant here (no public mutation added — `_reset_internal` is an
`internalMutation`), but `eslint .` still runs.

**Recommendation:** add `npm run lint` to Success Criteria and to the pre-commit checks
in Task 1 (Step 7) and Task 2 (Step 6), alongside `npm run typecheck`.

## 4. Refinements (Optional)

- **CHANGELOG insertion precision.** Lines verified: L1 `# Changelog`, L3 "All notable
  changes…", L5 `## v0.5.3b … (unreleased)`. The plan's "after the title block, before
  `## v0.5.3b`" is unambiguous; inserting the new `## Dev tooling (unreleased)` at L4 (the
  blank line) is correct. No change needed — noting for the implementer.
- **Literal-pin `it` placement.** Adding it inside the existing `describe` means it inherits
  `beforeEach(clearAll)` (opens IDB needlessly). Harmless; leave as-is or place it in a
  separate `describe` block. Implementer's discretion.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `registered_devices` table | `convex/auth/schema.ts:43` | reuse — no schema change |
| existing wipe loop | `convex/seed/internal.ts:25-39` | already wipes the table |
| `storage-keys.ts` | `src/lib/storage-keys.ts` | hook already imports from here |
| `_devMintSetupCode_internal` | `convex/seed/internal.ts:191` | retained escape hatch — not duplicated |

### Potential duplication risks
- The `"dev-booth-device"` literal lives in two runtimes (frontend `storage-keys.ts` +
  backend `seed/internal.ts`). Unavoidable (no shared module across `src`/`convex`). The
  plan pins both sides via tests (literal-pin test + `reset.test.ts`), turning the suite
  into the cross-check. Acceptable and documented.

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|-------|------------|-------|
| Task 1 (frontend) | Good | Independent; TDD order correct |
| Task 2 (backend) | Good | Independent of Task 1 |
| Task 3 (docs) | Good | Pure docs |

**Ordering issues:** None. Tasks 1 and 2 are independent (could be parallel); Task 3 last.
**Missing phases:** None.

## 7. Specialist Agent Recommendations

None — small, self-contained. Default subagent per task is fine.

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ `dev-device-seed` worktree off main |
| Branch naming follows convention | ✅ |
| Merge strategy documented | ✅ squash-PR (spec/pipeline) |

### Pre-push verification
- [ ] `npm run build` — not strictly needed (typecheck covers tsc; vite build is prod-only)
- [x] `npm run typecheck` — in plan ✅
- [ ] `npm run lint` — **add** (Improvement 1)
- [x] `npx vitest run convex/seed src/hooks/useDeviceId.test.ts` — in plan ✅

### CI/CD & rollback
| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ documented (independent commits, revert-safe) |
| Deployment order | ✅ no ordering concern (dev-only behavior) |
| Data backup needed | No |
| Migration safety | ✅ no schema change |

## 9. Documentation Checkpoints

| Task | Docs |
|-------|------|
| Task 3 | `docs/CHANGELOG.md` ✅, `CLAUDE.md` ✅ |

No `SCHEMA.md` change (reuses `registered_devices`) — correct.

## 10. Testing Plan Assessment

**Verdict:** Adequate.

### Planned tests
| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend | `_reset_internal` seeds device row + no-dupe on re-run | convex-test | planned ✅ |
| Backend | `activated_by` references seeded manager | convex-test | planned ✅ |
| Frontend | `useDeviceId` UUID/null/IDB paths unchanged | vitest | existing, stays green ✅ |
| Frontend | `DEV_DEVICE_ID` literal pinned | vitest | planned ✅ |

### Deliberately untested
- The `DEV_SERVER` return branch of `useDeviceId` (module-const captures MODE at import;
  `vi.stubEnv` can't flip it; not worth per-render env reads in prod code). Justified in
  the plan's "Notes on a deliberately untested branch". Regression covered by the existing
  suite (MODE="test" path) + the two literal pins. Acceptable.

### Regression risk
- `useDeviceId.test.ts` is the only live regression — directly mitigated by the MODE gate.

## 11. Edge Cases to Address

- [x] Re-run reset → no duplicate device rows (test covers it).
- [x] Empty IDB / fresh MCP profile → constant returned before any IDB read.
- [x] Prod build → MODE "production", gate off.
- [x] `activated_by` FK validity → test asserts it resolves to Lucas.

## 12. Approval Conditions

**To approve:** none blocking.

**Recommended before implementation:**
1. Improvement 1 — add `npm run lint` to Task 1 Step 7, Task 2 Step 6, and Success Criteria.

---

*Generated by /staffreview*
