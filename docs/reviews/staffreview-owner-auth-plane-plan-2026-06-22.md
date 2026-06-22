# Staff Review: Owner auth plane (Spec 2) — Implementation Plan

**Date:** 2026-06-22
**Plan:** `docs/superpowers/plans/2026-06-22-v2.0-owner-auth-plane.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, Architecture, Global Constraints, File Structure, 8 TDD tasks with file paths + interfaces + per-step commands, Self-Review with verify-first list).

---

## 1. Summary

**Overall Assessment: Approve** (after 2 inline fixes, both applied this pass).

The plan is execution-ready: every task is TDD-shaped with real Convex signatures, the `loginWithPin` action→commit-mutation pattern is correctly reused for OTP verify, idempotency distinct-key discipline is explicit, and all 5 Critical + 5 Improvement findings from the spec gate map cleanly to tasks. The verify-first list correctly front-loads the two highest-risk catches (C1 matcher, C2 required-flip). Two assumptions the plan flagged were checked against real code and **one was wrong** — fixed inline.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| PL-1 | Plan uses the `"use node"` `sha256Hex` (node:crypto) — breaks edge-runtime tests AND V8 callers | Logic / Runtime | T3, T5 |

### Issue PL-1: Wrong `sha256Hex` — node-only helper used in V8 + test contexts

The plan references `convex/lib/tokenHash.ts::sha256Hex` for bind/remember-device token hashing. Verified against code: that file is **`"use node"`** (`convex/lib/tokenHash.ts:1`, `import { createHash } from "node:crypto"`), **synchronous**. It is unusable in two places the plan puts it:
- **Edge-runtime tests** (`startBinding.test.ts`, `remembered-device.test.ts`) import it directly — `convex-test` runs in edge-runtime (no `node:crypto`), so the import throws at load.
- **V8 contexts** — `handleStartWithToken` (a Telegram webhook action, V8 by default) and any internal that needs to hash a raw token cannot import a `"use node"` module.

The codebase has the right tool: `convex/lib/sha256.ts::sha256Hex` — **V8-safe, async** (Web Crypto, `convex/lib/sha256.ts:5`), explicitly *"Safe in the Convex default runtime AND 'use node' actions."* It is the one api/v1 uses (`api/v1/_auth.ts:23`, `await sha256Hex(...)`).

**Recommendation (applied):** Switch all owner-auth token hashing to `convex/lib/sha256.ts::sha256Hex` and **`await`** it everywhere (it's async). Update the Task-3/Task-5 test imports, `handleStartWithToken`, `issueOwnerTelegramBindLink`, `registerRememberedDevice`, and `quickPinLogin`. (The `_redeemBinding_internal` mutation still receives a pre-hashed `tokenHash` arg — unchanged, correct.)

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| PL-2 | `setStaffRole` "owner" extension must also patch the commit internal's validator | M | L |

### Improvement PL-2: Extend BOTH `setStaffRole` and its commit internal

Verified: `setStaffRole` (`convex/staff/actions.ts:19`) is a `withActionCache` action that commits via `_setStaffRoleCommit_internal` (`convex/staff/internal.ts:403`). Adding `"owner"` to the action's `role` arg union alone is insufficient — the inner commit mutation's `role` validator must accept it too, or the commit throws a validator error. **Recommendation (applied):** Task 6 Step 3 now names both edit sites.

## 4. Refinements (Optional)

- T3 Step 9 (`http.ts` command composition) is the right place for a `[verify at execution]` — `buildRegistryCommands` returns both `register` and `start`; the binding factory must replace the `start` entry, not duplicate it. The plan already flags this; keep the verify marker.
- Consider a tiny test asserting `getSession` still returns a valid booth shape after the `kind` addition (regression guard for the most-consumed query). Low effort.

## 5. Duplication Analysis

### Existing code to leverage (plan already cites — all confirmed present)
| Code | Location | Status |
|------|----------|--------|
| `loginWithPin` action→commit pattern | `convex/auth/actions.ts:56` | ✅ correct template for OTP verify |
| `_hashPin_internal` argon2id + `ARGON2_PARAMS` | `convex/auth/actions.ts:11,23` | ✅ template for `_hashOtpCode_internal` |
| `sha256Hex` (V8-safe) | `convex/lib/sha256.ts:5` | ✅ (PL-1 — use THIS one) |
| `withIdempotency<Args, R>` | `convex/idempotency/internal.ts:52` | ✅ signature matches plan usage |
| `sendTemplate` `chatIdOverride` | `convex/telegram/send.ts:166` | ✅ DM routing |
| `mintUrlSafeToken(32)` | `convex/lib/tokens.ts:53` | ✅ |

### Potential duplication risks
- None new. Owner internals are deliberately separate from booth internals to keep the plane split (the point of the feature).

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|------|------------|-------|
| T1 Schema | Good | C2/C4/I2 folded in |
| T2 Cockpit helpers | Good | C5 guard order explicit |
| T3 Binding | Good after PL-1 | matcher fix + sha256 helper swap |
| T4 OTP | Good | C3 redaction + isolated throttle |
| T5 Quick-PIN | Good after PL-1 | sha256 helper swap |
| T6 Promotion + cron | Good after PL-2 | both edit sites |
| T7 FE | Good | e2e deferred to Spec-3 harness (reasonable) |
| T8 Docs | Good | |

**Ordering:** T1→T2→T3→T4→T5→T6→T7→T8 is sound (schema → session helpers → binding → OTP → quick-PIN → promotion/cron → FE → docs). **Blocked-on-Spec-1** is correctly the #1 verify-first item.

## 7. Specialist Agent Recommendations

| Task | Agent | Rationale |
|------|-------|-----------|
| T1–T6 backend | `convex-expert` | schema, action/mutation split, argon2-in-action, webhook matcher |
| T7 FE | `frontend-integrator` / `ui-component-builder` | route + session gate |
| Close-out | `/triple-review` → `/simplify xhigh` | repo standard |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch | ✅ `feat/v2.0-owner-auth-plane` |
| Commit-per-task | ✅ each task ends with a scoped commit |
| Pre-push gate | ✅ `npm run typecheck && npm run lint && npx vitest run` (Global Constraints) |
| Rollback | ✅ all additive/optional (spec §Rollback) |
| Deployment order | ✅ after Spec-1; inert until cockpit routes ship |
| Migration safety | ✅ no destructive migration |

## 9. Documentation Checkpoints

T8 covers SCHEMA.md, CLAUDE.md, ADR-052 status, RUNBOOK (env var + cutover), CHANGELOG. ✅ Complete.

## 10. Testing Plan Assessment

**Verdict: Adequate.** Every backend task is TDD (failing test first, real assertions). The 5 spec-gate must-add tests are present (matcher reachability, no-code-in-logs, no-pos_auth_attempts-touch, NOT_BOOTH_SESSION order, outlet-less cockpit insert). FE e2e deferred to the Spec-3 cockpit harness is the right call (no cockpit screens exist yet); unit phase-machine tests cover what's buildable now.

### Must-fix test detail (PL-1)
| # | Test | Fix |
|---|------|-----|
| 1 | `startBinding.test.ts` / `remembered-device.test.ts` import `sha256Hex` | Import from `../../lib/sha256` (async, `await`), not `tokenHash` |

### Regression risk
- `getSession` is the most-consumed query; the `kind` addition is additive but smoke-test a booth session still resolves (refinement above).
- `buildCommandMatcher` change is opt-in (`acceptsArgs`) — existing strict tests must stay green (the plan's matcher test asserts this).

## 11. Edge Cases to Address

- [x] Group-chat bind rejected (`BIND_PRIVATE_ONLY`) — T3.
- [x] Duplicate `telegram_user_id` rejected — T3.
- [x] OTP fail-cap consumes challenge — T4.
- [x] Rate-limit isolated from `pos_auth_attempts` — T4.
- [x] Cockpit insert with no `outlet_id` — T1.
- [ ] `handleStartWithToken` error → user-facing "❌ Link expired or already used." reply (T3 Step 8 — ensure the reply fires on every thrown path, since dispatch "must not throw").

## 12. Approval Conditions

**To approve (both applied inline this pass):**
1. PL-1 — swap to V8-safe async `convex/lib/sha256.ts::sha256Hex`.
2. PL-2 — extend `_setStaffRoleCommit_internal` validator alongside `setStaffRole`.

**Verify-first at execution (unchanged from plan):** Spec-1 executed; `staff_sessions.outlet_id` optional; strict matcher premise; `sendTemplate` switch + `logOutbound` site; `setStaffRole` funnel.

---

*Generated by /staffreview*
