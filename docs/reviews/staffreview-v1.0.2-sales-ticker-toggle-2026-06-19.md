# Staff Review: v1.0.2 In-App Sales-Ticker Toggle

**Date:** 2026-06-19
**Plan:** `docs/superpowers/specs/2026-06-19-v1.0.2-sales-ticker-toggle-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (spec, not full plan — File Changes / Tests / Acceptance / Out-of-scope all present)

---

## 1. Summary

**Overall Assessment:** Revise (one Critical, then Approve)

The spec is well-grounded — it cites real files/lines, reuses an already-reviewed sibling pattern
(`setFoundersSummaryEnabled` / `FoundersSummaryToggle`), and correctly notes no schema migration is
needed. Backend design is correct and tested-by-mirror. **One Critical gap:** the frontend test harness
is call-order-indexed, and adding a second toggle that calls `useQuery`+`useMutation` renumbers every
downstream mock stub — silently breaking the existing founders-toggle and chat-card tests. The spec
says "mirror the FoundersSummaryToggle test" but omits the required re-indexing. Fix that and it's
approvable.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Frontend test harness is call-order-indexed; new toggle's hooks shift all downstream stubs | Testing | §3 Frontend / §3 Tests |

### Issue 1: Adding `TxnTickerToggle` renumbers the call-order-indexed mocks

`src/routes/mgr/telegram-chats.test.tsx` mocks `useQuery`/`useMutation` **by depth-first call order**,
documented in its own header (lines 12-20) and `setupMutationMock` (lines 127-131):

```
useQuery:    0 = settings (FoundersSummaryToggle)   1 = chats (MgrTelegramChatsInner)
useMutation: 0 = setFoundersSummaryEnabled          1 = assignRole (ChatCard)   2 = archiveChat
```

Rendering `<TxnTickerToggle>` immediately after `<FoundersSummaryToggle>` adds one `useQuery` and one
`useMutation` call **in the middle of that order**, shifting everything after it:

```
useQuery:    0 = settings (Founders)   1 = settings (Ticker)   2 = chats
useMutation: 0 = setFoundersSummaryEnabled   1 = setTxnTickerEnabled   2 = assignRole   3 = archiveChat
```

Unaddressed, the existing chat-card tests (which assert `assignRole`/`archiveChat` at indices 1/2) and
the founders-toggle tests break. The spec's runtime claim that Convex "dedupes the two `useQuery` calls
to one subscription" is true in the app but **irrelevant to the mock**, which counts literal hook calls —
there are now two `getSettings` query slots to satisfy.

**Recommendation:** The spec/plan must explicitly require:
1. Update `setupQueryMock` to return `settings` for BOTH query slots 0 and 1, and `chats` at slot 2.
2. Update `setupMutationMock` to insert `setTxnTickerEnabled` at mutation slot 1 and shift
   `assignRole`→2, `archiveChat`→3.
3. Update the two header comment blocks (lines 12-20, 127-131) to the new ordering.
4. Then add the new `TxnTickerToggle` render/flip tests mirroring the founders cases.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Add a Deployment & Rollback line | M | L |

### Improvement 1: State deployment + rollback explicitly

The spec has Acceptance but no Deployment/Rollback note. Add one: this is an **additive** new public
mutation (no mutation↔action rename → no deploy-skew hazard per CLAUDE.md "deploy skew"), so it ships
atomically via the normal `npm run build` Convex+FE deploy. Rollback = revert the PR; the existing
dashboard edit of `txn_ticker_enabled` remains a break-glass kill-switch even if the FE toggle is
reverted. No data migration, no backfill.

## 4. Refinements (Optional)

- `getSettings` is an unauthenticated public query (no session arg — by design, the founders toggle reads
  it the same way). Adding a second non-sensitive boolean is consistent; no change needed. Noted so the
  implementer doesn't "fix" it by adding a session gate (that would break the existing read).
- Rapid double-click flips two writes with two fresh UUID keys (last-write-wins). Acceptable for a
  boolean toggle; the `disabled={busy}` guard already debounces the common case.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `setFoundersSummaryEnabled` | `convex/settings/public.ts:21` | Clone verbatim; change field + audit verb + insert shape |
| `ToggleResult` type | `convex/settings/public.ts:19` | Reuse as-is (already `{ ok: true }`) |
| `FoundersSummaryToggle` | `src/routes/mgr/telegram-chats.tsx:73` | Clone verbatim; change field/label/mutation/toast |
| founders test cases | `convex/settings/__tests__/settings.test.ts:12,82` | Mirror seed shape, MANAGER_ONLY reject, replay+audit-count |

### Potential duplication risks
- Two near-identical toggle components on one page. Acceptable at N=2 (rule-of-three not yet triggered);
  a shared `<SettingToggle>` abstraction would be premature. Leave as two components.

## 6. Phase / Wave Accuracy

Single-slice spec; phasing deferred to the plan. Natural order: backend (query+mutation+tests) →
frontend (component+test-harness-reindex+tests) → docs. Backend-before-frontend is correct.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Backend mutation | `convex-expert` (optional) | Trivial clone; default agent is fine |
| (whole phase) | default | Scope too small to warrant fan-out |

## 8. Git Workflow Assessment

Feature branch via the pipeline worktree (`worktree-v1.0.2-ticker-toggle`). Natural commits: (1) backend
mutation+query+tests, (2) frontend component+test re-index, (3) docs. Squash-PR per repo convention.
Pre-push: `npm run typecheck` + targeted `vitest` on the two suites. ✅

## 9. Documentation Checkpoints

Spec already lists SCHEMA.md (audit verb + field note), RUNBOOK.md (kill-switch path), CLAUDE.md rule #22,
API_REFERENCE.md, CHANGELOG.md. Complete. ✅

## 10. Testing Plan Assessment

**Verdict:** Adequate once Critical #1 is folded in.

Backend coverage (flip, insert-default-founders, auth reject, idempotent replay, audit row) mirrors
existing reviewed cases — strong. Frontend coverage adequate **only after** the call-order re-index is
specified; otherwise the suite regresses.

### Regression risk
- **HIGH without the fix:** all order-indexed mocks in `telegram-chats.test.tsx`. **LOW with it.**
- Backend `_getSettings_internal` read tests already cover the disabled path — untouched.

## 11. Edge Cases to Address

- [x] No row exists → insert sets `founders_summary_enabled: true` (don't clobber founders) — in spec.
- [x] Field-level `ctx.db.patch` merges, so toggling ticker never clears founders — Convex patch semantics.
- [x] Default-ON read when field absent — `?? true`, in spec.
- [ ] Concurrent founders+ticker flip: both `patch` distinct fields → no lost update (note in plan for the reviewer's confidence).

## 12. Approval Conditions

**To approve, address:**
1. Critical #1 — specify the frontend test-harness call-order re-index (query slots, mutation slots,
   comment blocks) before the new toggle tests.

**Recommended:**
1. Improvement #1 — add the Deployment & Rollback line.

---

*Generated by /staffreview*
