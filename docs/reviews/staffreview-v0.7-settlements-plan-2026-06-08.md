# Staff Review: v0.7 — Xendit settlement reconciliation (PLAN gate)

**Date:** 2026-06-08
**Plan:** `docs/superpowers/plans/2026-06-08-v0.7-settlement-reconciliation.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal/Architecture, per-task Files + TDD steps, Testing summary, Success Criteria, Rollback/Deployment all present)

---

## 1. Summary

**Overall Assessment: Approve** (resolve 3 Improvements inline — all are flagged-assumption confirmations, not redesigns).

The plan is concrete and TDD-structured, with every backend task built on a verified in-repo template (`createVoucher` for the PIN action, `_createVoucher_internal` for the writer+audit, `stock-recon` for the resilient cron, the schema-fragment + `convex-test` harness). I verified the plan's three flagged assumptions against current `main`:

- **A Convex `query` CAN call `ctx.runQuery`** — `convex/transactions/public.ts:93` (`listDayTransactions`, a `query`) calls `ctx.runQuery(internal.auth.internal._resolveSessionRole_internal, …)`. Task 7's approach is valid; the hedge can be removed.
- **`convex-test` runs `"use node"` PIN-gated actions end-to-end** — `convex/vouchers/__tests__/createVoucher.test.ts:11` does `t.action(api.vouchers.actions.createVoucher, …)` with a real argon2 PIN verify. Tasks 5 & 6's `t.action(...)` approach is proven.
- **`logAudit({ entity_id?: string })` is optional** (`convex/audit/internal.ts:30`) — the skip-audit can omit it.

One concrete test-data bug surfaced: the plan's Task 5 uses `managerPin: "1111"`, but `seedManagerSession` seeds PIN **`"9999"`** (`convex/staff/__tests__/_helpers.ts:24`; mirrored by `createVoucher.test.ts:17`). Left unfixed, every Task 5 happy/replay/net test fails on `INVALID_PIN` and the wrong-PIN test passes the gate. Resolve inline.

No Critical architecture issues. No schema/logic/security blockers.

## 2. Critical Issues (Must Fix)

None. (The PIN-mismatch below would guarantee red tests, but the plan already flagged the assumption with the exact remedy — resolving it inline clears it; tracked as Improvement 1.)

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Task 5 tests use wrong PIN — `seedManagerSession` seeds `"9999"`, not `"1111"` | H | L |
| 2 | Task 7 — confirm `query`→`ctx.runQuery` is valid; remove the hedge | M | L |
| 3 | Task 6 — `logAudit.entity_id` is optional; omit it, drop the sentinel hedge | L | L |

### Improvement 1: Correct the manager PIN in Task 5 (and Task 6 reuse) tests

`seedManagerSession` (`convex/staff/__tests__/_helpers.ts:24`) seeds `{ name: "Lucas", pin: "9999", role: "manager" }`. The canonical PIN-action test (`convex/vouchers/__tests__/createVoucher.test.ts:10,17`) calls `seedManagerSession(t)` → `{ sessionId, managerId }` and passes `managerPin: "9999"`.

The plan's `manualEntry.test.ts` `base()` helper hardcodes `managerPin: "1111"`. Result: the happy-path, idempotent-replay, and `net<0` tests would throw `INVALID_PIN` before reaching the logic they assert; conversely the "wrong PIN rejected" test passes `"9999"` (the *correct* PIN), so it would NOT reject.

**Recommendation:** In `base()`, use `managerPin: "9999"`. In the wrong-PIN test, override to a genuinely wrong value (`managerPin: "1111"`). Also use the returned `managerId` to assert `entered_by` attribution (mirrors `createVoucher.test.ts:21`). Remove the "If `seedManagerSession` doesn't seed PIN 1111…" hedge note — it's resolved.

### Improvement 2: Task 7 — `query` calling `ctx.runQuery` is the established pattern; state it definitively

The plan hedges: "If `_resolveSessionRole_internal` is not callable from a `query` ctx, resolve inline…". It **is** callable — `transactions/public.ts:93` (`listDayTransactions`, a `query`) does exactly `ctx.runQuery(internal.auth.internal._resolveSessionRole_internal, { sessionId })`, and is covered by tests. Keeping the hedge invites the implementer to invent a divergent inline session-resolution path (an ADR-034 boundary smell — `settlements/` must not read `staff_sessions` directly).

**Recommendation:** Remove the hedge; state that `listSettlements` resolves via `ctx.runQuery(internal.auth.internal._resolveSessionRole_internal, { sessionId })` exactly as `listDayTransactions` does, throwing `SESSION_INVALID` on `null`. (Role-agnostic: any non-null resolution is allowed — ADR-012.)

### Improvement 3: Task 6 skip-audit — omit the optional `entity_id`, drop the sentinel

`logAudit`'s `entity_id?` is optional (`audit/internal.ts:30`). The plan's `_auditSyncSkip_internal` passes `entity_id: "none"` with a "check if it requires a real Id" hedge. It doesn't — it's `string | undefined`.

**Recommendation:** Omit `entity_id` entirely in `_auditSyncSkip_internal` (a sync-skip has no entity). Remove the hedge. (Optional: confirm the precedent — `inventory/internal.ts::_auditStockReconSkip_internal` — and match its exact field set.)

## 4. Refinements (Optional)

- Task 7 `listSettlements` does `.withIndex("by_settlement_date").collect()` then JS-filters/sorts. Fine — `pos_settlements` holds one row per day (tiny). If a long date range is ever passed, an index range read would be tidier, but YAGNI today.
- Task 6 `syncSettlements` calls `parseListTransactions(body)` twice (once for `days`, once for `payload`). Minor; parse once into a `const rows` and reuse.
- Confirm `convex/lib/cronRetry.ts` `isTransientError` classification covers a Xendit `fetch` 5xx/network throw the way `syncSettlements` expects (the inventory cron relies on the same helper — parity is fine).

## 5. Duplication Analysis

### Existing code to leverage (all verified)
| Code | Location | How to use |
|------|----------|------------|
| `createVoucher` PIN-action shape | `convex/vouchers/actions.ts` | Template for `enterSettlementManually` (Task 5) |
| `createVoucher.test.ts` | `convex/vouchers/__tests__/` | Template for `manualEntry.test.ts` (seed + `t.action` + PIN 9999) |
| `_createVoucher_internal` writer+audit | `convex/vouchers/internal.ts:122` | Template for `_upsertSettlementDay_internal` (Task 4) |
| `inventory/cronActions.ts` | — | Template for `settlements/cronActions.ts` (Task 6) |
| `listDayTransactions` query session-resolve | `convex/transactions/public.ts:93` | Pattern for `listSettlements` (Task 7) |
| `xendit.ts` `authHeader()` + `fetch` guard | `convex/payments/xendit.ts` | `listTransactions` adapter (Task 3) |

### Potential duplication risks
- Inventing a second session-resolver in Task 7 instead of reusing `_resolveSessionRole_internal` (Improvement 2).

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|------|------------|-------|
| 0 (R1 confirm) | Good | Correctly gates the parser/adapter; no-commit investigation |
| 1 schema → 7 query | Good | Dependency order correct: schema → lib → adapter → writer → action → cron → query |
| 8 FE | Good | Extends existing stub; no re-register (spec-gate fix carried through) |
| 9 docs / 10 verify | Good | Docs + full-suite + KYB follow-up |

**Ordering issues:** none. Tasks 2/3/4 are independent of each other (all depend only on Task 1); could be parallelized but sequential is fine. **Missing phases:** none.

## 7. Specialist Agent Recommendations

| Work | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Tasks 0-7 (BE) | `convex-expert` | Convex module/action/cron + convex-test |
| Task 8 (FE) | `ui-component-builder` → `frontend-integrator` | Build list + manual-entry, then wire the action |
| Task 9 (docs) | `—` | Cross-cutting |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch | ✅ pipeline worktree off `main` |
| Commit boundaries | ✅ one per task, `feat:`/`docs:` templated |
| Merge strategy | ✅ squash PR |
| Pre-push typecheck/lint/test/build | ✅ Task 10 |
| Rollback | ✅ additive module + table; revert = drop module + cron + fragment import |
| Deployment order | ✅ BE deploy first; FE degrades to empty list if BE absent |
| Migration safety | ✅ no migration (all new fields optional except always-written core) |

## 9. Documentation Checkpoints

| Task | Docs to update |
|------|----------------|
| 9 | `SCHEMA.md` (corrected `pos_settlements` + audit verbs), ADR-012 amendment, `API_REFERENCE.md`, `CLAUDE.md` (module + rule #22 + crons), `CHANGELOG.md`, `xendit-reference/settlement-reconciliation.md` |

CHANGELOG draft is present in the plan (Task 9 Step 6). ✅

## 10. Testing Plan Assessment

**Verdict: Adequate.** Pure golden tests (parse throws-on-bad-shape, aggregate filters PENDING/null, fee sum, net math), adapter URL test, upsert (no-dupe + poll-supersedes-manual + audit), manual-entry (happy/auth-reject/wrong-PIN/net<0/idempotent — once PIN fixed), sync (per-day upsert + zero-row audited skip), query (newest-first + session reject). Money paths have known-value assertions (ADR-015). Auth rejection covered (ADR-046 pre-cache). Live verification correctly deferred (R2/N3) and not falsely claimed.

### Missing test coverage (must add)
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | (after Improvement 1) assert `entered_by == managerId` on the happy-path manual row | Attribution is auditable; cheap | Use `managerId` from `seedManagerSession` |

### Regression risk
- Adding `listTransactions`/`buildListTransactionsUrl` to `payments/xendit.ts` — confirm existing `payments/__tests__/actions.test.ts` still green (additive exports; low risk).
- Schema fragment add — `npx convex codegen` then full `vitest run` (Task 10) catches any schema break.

## 11. Edge Cases to Address

- [x] Zero settled rows → audited skip (Task 6) — covered
- [x] Poll supersedes manual same day → audit + preserve created_at (Task 4) — covered
- [x] `net < 0` rejected (Task 5) — covered
- [ ] (Improvement 1) PIN correctness so the above tests actually execute their assertions
- [ ] WIB/UTC `settlement_date` boundary — plan locks the R3 decision (use Xendit date verbatim, WIB lookback); a fixture row dated at the window edge in `sync.test.ts` would pin it (optional)

## 12. Approval Conditions

**To approve:** none blocking — Approve.

**Resolve inline before execution (Improvements 1-3):**
1. Task 5 test PIN `"1111"` → `"9999"`; wrong-PIN test → `"1111"`; assert `entered_by`.
2. Task 7 — state `ctx.runQuery(_resolveSessionRole_internal)` definitively; drop the hedge.
3. Task 6 — omit `entity_id` in the skip-audit; drop the sentinel hedge.

---

*Generated by /staffreview*
