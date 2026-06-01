# Staff Review: v0.5.3b In-app Admin (PLAN)

**Date:** 2026-06-01
**Plan:** `docs/superpowers/plans/2026-06-01-v0.5.3b-in-app-admin.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, Architecture, File structure, Waves with ∥ marked, per-task TDD steps, Success criteria, Rollback, Assumptions-to-verify all present).

---

## 1. Summary

**Overall Assessment: Approve (after Critical fixes applied inline).**

The plan is thorough, TDD-structured, and grounded — every backend function mirrors a real, verified call site. The review's job was to verify the 7 flagged assumptions against code: **5 confirmed, 2 wrong.** The two wrong ones (frontend `useSession`/`useIdempotency` APIs; test session-seed schema) would fail at compile/validation time if followed literally. Both fixed inline. No architectural defects; tiered gating, audit, idempotency, and rollback are sound.

## 2. Critical Issues (Must Fix) — applied inline

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Frontend `useSession()` / `useIdempotency()` APIs mis-stated | Logic/Integration | Tasks 14–16 |
| 2 | Test `staff_sessions` seed omits required `ended_at`/`end_reason`; bogus `registered_devices` insert | Testing/Schema | Task 3 `_helpers.ts` |

### Issue 1: Frontend hook APIs don't match the codebase
- `useSession()` returns a **discriminated union** `SessionState` (`src/hooks/useSession.ts:15`): `{status:"loading"|"none"|"active", sessionId, staff}` — `sessionId` is `null` unless `status==="active"`. The plan's `const { sessionId } = useSession()` yields `null`-typed `sessionId` and won't typecheck against mutation args requiring `Id<"staff_sessions">`.
- `useIdempotency(intent)` returns **`string | undefined`** directly (`src/hooks/useIdempotency.ts:16` — *"now returns `string | undefined`… guard `if (!key) return;`"*), with `clearIntent(intent)` to rotate the key. There is **no** `nextKey()` and no object return. The plan's `const { nextKey } = useIdempotency(); nextKey()` is a non-existent API.

**Recommendation:** Use the union guard (`if (session.status !== "active") return <Loading/>`) and `useIdempotency("<intent>")` → guard `undefined` → `clearIntent` after success. *(Applied: Task 14 skeleton rewritten; Tasks 15–16 wiring note updated.)*

### Issue 2: Test session seed is schema-invalid
`staff_sessions` (`auth/schema.ts:21`) requires `ended_at: v.union(v.number(), v.null())` **and** `end_reason: v.union(…, v.null())` — both must be present (as `null`), not omitted; convex-test enforces the validator. The plan's `_helpers.ts` insert omits them and also inserts a `registered_devices` row with non-existent columns (`created_at`) — and `requireSession` (`auth/sessions.ts:17-20`) only reads the session + staff rows, never `registered_devices`, so that insert is both wrong and unnecessary.

**Recommendation:** Match the canonical seed in `approvals/__tests__/cancelPendingRequest.test.ts:18` — `{staff_id, device_id, started_at, ended_at: null, end_reason: null}`; drop the `registered_devices` insert. *(Applied.)*

## 3. Improvements (Recommended) — applied inline

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Task 9: use the confirmed `by_product` index, not `.filter()` | M | L |
| 2 | Task 13: name the concrete receipt-seed model tests | L | L |

### Improvement 1: `by_product` index is confirmed — use it
`pos_product_components` has `.index("by_product", ["product_id"])` (`catalog/schema.ts:45`). Task 9's replace-set delete should `.withIndex("by_product", q => q.eq("product_id", args.productId))` rather than `.filter(...)` (a full scan). *(Applied — removed the "verify" hedge, made it definitive.)*

### Improvement 2: Concrete seed models for Task 13
`convex/receipts/__tests__/lazy-mint.test.ts` and `refund-projection.test.ts` already seed paid `pos_transactions` + lines + invoice and render. Task 13's branding assertion should copy one of those seed blocks. *(Applied — named them.)*

## 4. Refinements (Optional)
- `setStaffRole`/`catalog` actions import `{ internal, api }` but use only `internal` — drop the unused `api` import to keep lint clean. (Executor's lint pass will catch it; noted.)
- `staff/internal.ts` already imports `internalMutation` at the top; the new tasks' "add `import { internalMutation }`" steps are no-ops if merged into the existing import. (Executor merges; harmless.)

## 5. Duplication Analysis
No duplication. Every PIN-gated action reuses `verifyManagerPinOrThrow` → `verifyPinOrThrow`; every public mutation reuses `withIdempotency`+`authCheck`; the last-manager guard correctly uses a direct `by_role` scan (the `_listActiveManagers_internal` helper can't exclude-by-id — verified, projection is `{name,code}`). Receipt branding injects at the single shared `buildVmFromTxnWithLines`.

## 6. Phase / Wave Accuracy
| Wave | Assessment | Notes |
|------|------------|-------|
| 0 (schema + helper) | Good | Correctly sequential — all waves depend on `verifyManagerPinOrThrow` + settings fields. |
| 1/2/3 (staff/product/receipt) | Good | Genuinely independent post-Wave-0; parallel-safe. |
| 4 (frontend) | Good | Each route depends only on its backend wave. |
| 5 (docs) | Good | Last. |

**Ordering issues:** none. Task 2's `verifyManagerPinOrThrow` ships before its first consumer (Task 4) — correct.

## 8. Git Workflow Assessment
| Check | Status |
|-------|--------|
| Feature branch | ✅ worktree `worktree-spec+v0.5.3b` off `main` |
| Merge strategy | ✅ squash-PR (repo convention) |
| Commit checkpoints | ✅ one per task, typed messages |
| Pre-push build/typecheck | ✅ Task 17 final gate runs typecheck+lint+build+vitest |
| Rollback | ✅ additive schema, default-fallback |
| Deploy order | ✅ backend before frontend |

## 10. Testing Plan Assessment
**Verdict: Adequate.** Every backend callable has happy + reject + edge tests (gate rejection, last-manager, self-deactivate, qty/SKU validation, cache purge, default fallback, branding render). Frontend is manual-smoke (consistent with project convention for UI). After the Issue-2 fix the test helper is schema-valid. One regression guard present: existing receipt tests must stay green (defaults == old hardcoded values).

### Regression risk
- `resetStaffPin` refactor (Task 2) — mitigated: existing `auth` tests must pass before commit (Step 5).
- `_getSettings_internal` return shape change — additive; `founders_summary_enabled` consumers unaffected (Task 1 Step 3 typecheck gate).

## 11. Edge Cases to Address
- [x] Last active manager (deactivate + demote) — covered
- [x] Self-deactivate — covered
- [x] Wrong/locked manager PIN — covered (verifyPinOrThrow lockout)
- [x] Absent settings row → defaults — covered
- [x] Inactive SKU / qty<=0 in components — covered
- [ ] Logo upload non-image/oversized — client guard in Task 16 (present); no server-side type check (acceptable — manager-only, low risk)
- [ ] Product with zero components — allowed (decrements nothing); flagged as a product-design choice, not blocked

## 12. Approval Conditions
**To approve:** Issues 1–2 (applied). 
**Recommended:** Improvements 1–2 (applied).
**Verified against code:** A2 (PinSheet props), A3 (`_lookup_internal`/`_writeCache_internal`), A4 (`by_product` index), A7 (`"use node"` — and use-node files export only actions ✓) all CONFIRMED correct as written.

---

*Generated by /staffreview*
