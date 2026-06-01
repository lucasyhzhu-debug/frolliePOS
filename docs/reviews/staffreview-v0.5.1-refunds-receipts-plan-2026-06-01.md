# Staff Review: v0.5.1 Refunds + Customer Receipts (implementation plan)

**Date:** 2026-06-01
**Plan:** `docs/superpowers/plans/2026-06-01-v0.5.1-refunds-receipts.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Mostly validated; 1 minor section added (Success Criteria — see §0)

---

## 0. Plan Structure Additions

**Added retroactively to this review (the plan itself doesn't include them):**

- **Success Criteria** (rolled up per PR): each PR's Task A10 / Task B28 already implies the criteria (lint + typecheck + tests + code-review + ship-it) but the plan never names them as a coherent gate. Recommend adding a "Success criteria" callout per PR.
- **PARALLEL/SEQUENTIAL marking:** the plan is sequential by nature (schema → backend → frontend → tests → docs). The few items that *could* parallelise (test files B14-B20) are documented as separate commits. Add a one-line note per PR clarifying sequential-by-default.

These are minor — the workflow's actual gates are present, just not labelled as a section.

## 1. Summary

**Overall Assessment:** **Revise** (3 Critical + 5 Improvements + 3 Refinements).

Plan is comprehensive and the brainstorm + spec staffreview work pays off — most of the design decisions are unambiguous and the task ordering is right. But three Critical issues would block execution: (C1) `_confirmPaid_internal` is a Convex mutation and CANNOT import `node:crypto` (`mintUrlSafeToken`); the token must be minted in the calling action layer. (C2) the plan calls `internal.audit.internal._logAudit_internal` via `runMutation` throughout, but `logAudit` is actually a plain async helper imported directly (per `convex/audit/internal.ts:24`). (C3) Task B10's retroactive correction of Task B2's `RefundContext` shape (adding `line_id`) is workflow-confusing — fix B2 cleanly up front.

Fix the three Criticals (mostly mechanical edits to the plan) and the plan is ready to execute.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | `mintUrlSafeToken` (uses `node:crypto`) cannot run inside `_confirmPaid_internal` (a mutation, V8 runtime) | Logic / runtime | Plan Task A6 |
| C2 | Plan calls `internal.audit.internal._logAudit_internal` via `runMutation`; actual helper is `logAudit(ctx, ...)` direct import | Implementation | Plan Tasks A5, B5, B7, B9, B11 |
| C3 | Task B10 contains an inline "go back and edit Task B2" correction — workflow-confusing, error-prone | Task ordering | Plan Tasks B2 + B10 |

### Issue C1: Token mint runtime mismatch in Task A6

Plan Task A6 says:
> Add this import at the top: `import { mintUrlSafeToken } from "../lib/tokens";`
> Locate the point in `_confirmPaid`'s handler where `ctx.db.patch(...)` finalises the txn... Mint and include the token in the same patch.

`mintUrlSafeToken` is defined in Task A3 as:
```ts
import { randomBytes } from "node:crypto";
export function mintUrlSafeToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
```

Verified: `_confirmPaid_internal` is an `internalMutation` (convex/transactions/internal.ts:137). Convex mutations run in the **V8 runtime**, NOT Node — `node:crypto` is unavailable. The mutation will fail at runtime (or fail to deploy if the V8 bundler rejects the import).

**Recommendation:** mint the token in the calling layer (which IS an action with `"use node"`) and pass it as an arg to `_confirmPaid_internal`. The calling layer is the webhook httpAction (`convex/payments/...`) and the manual-confirm action.

Concrete plan edit for A6:

1. Add an `receipt_token: v.string()` arg to `_confirmPaid_internal`'s args validator.
2. In `_confirmPaid_internal`'s handler, set `receipt_token` from `args.receipt_token` instead of minting inline.
3. Update **every caller** of `_confirmPaid_internal` (find via `grep -n "_confirmPaid_internal" convex/`) to mint via `mintUrlSafeToken()` in the action layer and pass.

Likely 2 callers per the grep above: `convex/payments/internal.ts` (webhook path) and `convex/payments/__tests__/actions.test.ts` (test seed). Verify with a fresh grep at execution time.

### Issue C2: Audit helper signature mismatch (5+ task touchpoints)

`convex/audit/internal.ts:24` exports `async function logAudit(ctx, args)` — a plain helper, called directly inside any mutation/action with `await logAudit(ctx, {...})`. The plan instead calls `await ctx.runMutation(internal.audit.internal._logAudit_internal, {...})` at:

- Task A5 (`_lazyMintReceiptToken_internal`)
- Task B5 (`_commitRefund_internal` step 7)
- Task B7 (skip — only adds verbs to the enum)
- Task B9 (`requestRefundApproval` audit row)
- Task B11 (`markRefundSettled` audit row)

This is consistent with the project's actual convention per `CLAUDE.md`: `logAudit is a plain helper called from every state-changing mutation`.

**Recommendation:** find-replace across the plan body:

- `await ctx.runMutation(internal.audit.internal._logAudit_internal, {` → `await logAudit(ctx, {`
- Add `import { logAudit } from "../audit/internal";` to each file's import section in the plan (refunds/internal.ts, refunds/public.ts, refunds/actions.ts, receipts/internal.ts).

### Issue C3: Task B10 retroactive correction of Task B2

Task B10's `approveRefund` action code body contains a multi-line comment:

> ```
> // CORRECTION: the spec stored only product_name + qty in context for the preview. To commit, we need line_id. Fix: store line_id in context too.
> // **This implies a context-shape revision in B2 + B9. Apply the fix:**
> //   - In RefundContext (kinds.ts): add `lines: Array<{ line_id: Id<"pos_transaction_lines">; product_name; refund_qty; refund_amount }>`
> //   - In requestRefundApproval (B9 _computeRefundPreview_internal): include line._id in the preview lines.
> //   - In validateContext: validate line_id present.
> ```

Followed by **Step 2** which does the retro-fit. This means the subagent executing Task B2 won't include `line_id` (because B2's text doesn't say to); then B10 fails typecheck; then B10's step 2 retro-edits B2's already-committed code.

For an executor with TDD discipline, this is wasted effort and a real risk of incomplete fix-up (if B10's "retro-fit" instruction is ignored because the executor's main focus is approveRefund).

**Recommendation:** edit Task B2 directly to include `line_id` in `RefundContext` from the start. Update `validateContext` to validate `line_id`. Update `_computeRefundPreview_internal` (defined in Task B9) to populate `line_id`. Remove the "CORRECTION" comment and Step 2 from Task B10. The B10 code body should read the line_ids directly from `(reqRow.context as any).lines[i].line_id` with no fix-up.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | Task B8/B10 reference `internal.staff.internal._listActiveManagers_internal` — actual path is `internal.auth.internal._listActiveManagers_internal` | M | L |
| I2 | Tasks B14-B20 + B23-B26 are scope-only summaries — explicitly point executor to B13 + B22 as the templates | M | L |
| I3 | Convex-test `t.fetch` usage in Task A7 is unverified — pre-flight check + fallback | L | L |
| I4 | Add "Success criteria" callout per PR (lint clean, typecheck clean, tests pass, code-review, ship-it) | L | L |
| I5 | Plan doesn't mark PARALLEL/SEQUENTIAL — most tasks are sequential by data dependency; mark explicitly per the skill's plan-validation checklist | L | L |

### I1: Manager-listing helper namespace

The plan says `internal.staff.internal._listActiveManagers_internal` in Tasks B8 and B10. Verified at execution time (grep result above): the actual path is `internal.auth.internal._listActiveManagers_internal`. The public function `staff.public.listActiveManagers` delegates into auth/internal.

**Recommendation:** find-replace `internal.staff.internal._listActiveManagers_internal` → `internal.auth.internal._listActiveManagers_internal` in Tasks B8 and B10.

Also: Task B8 mentions a `_findManagerByPin_internal` that doesn't exist (and shouldn't — PIN verify is in the action layer per CLAUDE.md). Delete that reference; the argon2-verify loop already in the plan body is the canonical pattern.

### I2: Compressed test/route tasks need template pointers

Tasks B14-B20 (test files) and B23-B26 (frontend routes) are written as "scope only" because they pattern-match B13 and B22. For a fresh subagent executing one of these in isolation, the cross-task reference may be unclear.

**Recommendation:** add to each compressed task a one-line explicit pointer: "Use Task B13's `seedPaidTxn` helper for test setup" / "Use Task B22's route+test pattern as the template". Allows a subagent dispatched to "execute B17" alone to find its anchor without re-reading the entire plan.

### I3: Convex-test `t.fetch` verification

Task A7's httpAction tests use `await t.fetch("/r/<token>", { method: "GET" })`. This is a real convex-test API (added in 0.0.30+) but the project pins `convex-test ^0.0.34` (per package.json) so it should be available. Worth a 30-second verification before writing the test body.

**Recommendation:** A7 Step 4 (before writing the test) — run `grep -n "t.fetch\|convexTest.*fetch" node_modules/convex-test/dist/*.d.ts 2>/dev/null || cat node_modules/convex-test/dist/index.d.ts | head -100` to confirm `fetch` signature. If absent, fall back to invoking `handleReceiptRoute` directly via `t.action(...)` adapter or via `t.run(async (ctx) => handleReceiptRoute(ctx, new Request(...)))`.

### I4: Success criteria callout

The plan implicitly defines success per task (each task has its own verification command). What's missing: a roll-up that says "PR A is complete when ALL of: (1) `npm run lint` zero errors, (2) `npm run typecheck` clean, (3) `npx vitest run` all pass, (4) `/code-review max` returns no Criticals, (5) `/ship-it` succeeds and the squash commit appears on main."

**Recommendation:** add a brief "## Success Criteria" section near the end (or under each Task A10 / B28) that names the five gates explicitly. Helps the executor know "am I done?" without inferring.

### I5: PARALLEL/SEQUENTIAL markers

Per the skill's plan-validation checklist: "Ordered steps with PARALLEL / SEQUENTIAL marked, Dependencies between steps clear." The plan is sequential by data dependency (Task A1 schema must land before Task A2 test that reads it; B1 before B5 commits to it; etc.), but tasks like B14-B20 (different test files) could run in any order once B5 + B6 + B7 + B8 + B9 + B10 + B11 are done.

**Recommendation:** add a "## Dependency notes" section per PR. For PR A: "all tasks sequential; A2 depends on A1, A4-A7 depend on A3 (helper), etc.". For PR B: "B1-B12 sequential (the build); B13-B20 can parallelise once B12 is done; B21-B26 frontend can parallelise once B11 is done; B27-B28 sequential at the end."

## 4. Refinements (Optional)

- **R1: Dependency graph visual.** A small Mermaid graph in each PR section showing task dependencies would help an executor scan parallelism opportunities. Optional.
- **R2: Plan length.** 3672 lines is large. Splitting into two files (`v0.5.1a-receipts.md` + `v0.5.1b-refunds.md`) would make each easier to scan. User explicitly asked for one plan, so keep — but acknowledge size.
- **R3: `_findPendingRefundForTxn_internal` query efficiency.** Currently fans out all `pos_approval_requests where kind=refund AND status=pending` rows then post-filters in JS for `entity_type === "pos_transactions" && entity_id === txnId`. At single-stall volume this is fine. For v1.1+ scale, consider a compound index `(kind, status, entity_id)`. Document but don't act.

## 5. Duplication Analysis

### Existing code to leverage (the plan handles most of these well)

| Code | Location | How to use | Status in plan |
|------|----------|------------|----------------|
| `randomBytes(32).toString("base64url")` | `convex/approvals/actions.ts:71` | Extract to `convex/lib/tokens.ts` `mintUrlSafeToken()` | ✅ Task A3 |
| `logAudit(ctx, args)` | `convex/audit/internal.ts:24` | Direct import + await | ❌ Plan uses wrong shape (C2) |
| `_listActiveManagers_internal` | `convex/auth/internal.ts` | `internal.auth.internal._listActiveManagers_internal` | ❌ Plan says `staff` (I1) |
| `formatIdr`, `escapeHtml` | `convex/lib/telegramHtml.ts` | Used by `renderRefund` | ✅ Task B3 |
| `wibDayWindow` + add `formatWibDateTime` | `convex/lib/time.ts` | Receipt template | ✅ Task A4 |
| `rp()` | `src/lib/format.ts` | Refund preview UI | ✅ Task B26 |
| `withIdempotency` / `authCheck` | per CLAUDE.md rule 21 | Every public mutation/action | ✅ Throughout |
| `requireSession`, `requireManagerSession` | `convex/auth/sessions.ts` | public.ts auth checks | ✅ Task B11 |
| `_createRequest_internal`, `_markNotified_internal`, `_markResolved_internal`, `_deleteRequest_internal`, `_incrementPinAttempts_internal`, `_findByTokenHash_internal` | `convex/approvals/internal.ts` | Refund approval lifecycle | ✅ Tasks B9 + B10 |
| `denyRequest` (kind-agnostic since v0.4) | `convex/approvals/actions.ts` | Refund denial — no new code needed | ✅ Mentioned in spec, no plan task needed |
| `NumericKeypad`, `PinSheet` | `src/components/pos/...` | Refund form PIN input | ✅ Task B23 (compressed) |
| `ApprovalPending`, `useApproval` | `src/components/pos/...`, `src/hooks/...` | Refund variant + status subscription | ✅ Task B25 |
| `lineRefundedQty` helper | NEW in `convex/refunds/lib.ts` | Treat `undefined` as 0 | ✅ Task B4 |

### Potential duplication risks

- **`rp()` formatter exists in two places** after PR A: `convex/receipts/template.ts` has a private server-side `rp()`, and `src/lib/format.ts` has the frontend `rp()` (extended in B26). These cannot share code (server can't import from `src/`, frontend doesn't import from `convex/lib/`). This is acceptable — runtime boundary forces the duplication. No fix needed.
- **`sha256Hex` is duplicated in approvals/actions.ts and the plan's refunds/actions.ts (Task B9).** Both are 5-liners using `node:crypto.createHash`. Could extract to `convex/lib/tokens.ts` as `sha256Hex(s)` alongside `mintUrlSafeToken`. Worth doing in Task A3 (PR A) since both refunds and approvals will use it.

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| Task 0 (ADR pre-work) | Good | Clean single commit on main, before any branch cut |
| PR A Tasks A1-A8 | Good after fixing C1 | A6 needs the token-mint-in-action-layer correction |
| PR A Task A9 (docs) | Good | All five doc surfaces covered |
| PR A Task A10 (ship) | Good | Workflow gates explicit |
| PR B Tasks B1-B12 (the build) | Good after fixing C2, C3, I1 | Most issues are find-replace edits |
| PR B Tasks B13-B20 (tests) | Good — but I2 applies | Compressed format works if executor knows to look at B13 |
| PR B Tasks B21-B26 (frontend) | Good — but I2 applies | Same compression concern |
| PR B Tasks B27-B28 (docs + ship) | Good | Roll-up section is correct |

**Ordering issues:** None at the task-graph level after C1-C3 fixes. The C3 fix in particular cleans up an out-of-order edit.

**Missing phases:** None. All spec sections map to plan tasks.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Task 0 (ADR commit) | general-purpose (cheap model) | Mechanical ADR write |
| Tasks A1-A8 (PR A backend) | convex-expert | Schema + Convex httpAction + cache pattern |
| Task A4 (template) | general-purpose | Pure HTML string-builder — minimal Convex knowledge needed |
| Task A9 (PR A docs) | general-purpose | Mechanical doc edits |
| Task A10 (ship) | controller invokes /code-review + /ship-it inline | No subagent — workflow skill |
| Tasks B1-B12 (PR B backend) | convex-expert | Module composition + cross-module via internal + approval kind 4-touchpoint |
| Tasks B13-B20 (tests) | general-purpose (model = sonnet for the math test B4 verification; haiku elsewhere) | TDD-disciplined test writing |
| Tasks B21-B26 (frontend) | frontend-integrator + ui-component-builder | Hook + RTL tests + shadcn component (RefundLineSelector) |
| Tasks B27-B28 (docs + ship) | general-purpose + workflow | Same as A9-A10 |
| Reviews between tasks | spec-reviewer + code-quality-reviewer subagents | Per subagent-driven-development pattern |

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branches specified | ✅ `feat/v0.5.1a-receipts`, `feat/v0.5.1b-refunds` |
| Branch naming convention matches v0.5.0 / v0.5.0.1 precedent | ✅ |
| Merge strategy | ✅ squash (implicit per project convention + /ship-it default) |

### Commit checkpoints

Plan defines commits per task — atomic, reviewable. Examples:
- Task 0: `docs(adr): ADR-040 voucher attribution on partial refunds (proportional, floor-rounded)`
- Task A1: `feat(schema): add pos_receipt_html_cache table + pos_transactions.receipt_token field (v0.5.1 PR A)`
- Task B5: `feat(refunds): internal module — _commitRefund + _listForTransaction + dedup guard`

All follow conventional-commits + project precedent. ✅

### Pre-push verification

| Check | Status |
|-------|--------|
| `npm run lint` in plan | ✅ (Task A10 + B28 + per-task subset) |
| `npm run typecheck` in plan | ✅ |
| `npx vitest run` in plan | ✅ |
| Local PR /code-review max | ✅ |

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ CHANGELOG note in Task A9 (per spec R2) |
| Deployment order | ✅ ADR-040 → PR A → PR B sequential |
| Data backup needed | No (additive schema changes; refunded_qty optional per C1 fix; receipt_token optional) |
| Migration safety | ✅ all schema changes are forward-compatible (optional fields, new tables) |

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Task 0 | ADR-040 (new), ADR/README.md (index) |
| Task A9 | CHANGELOG (v0.5.1 PR A section), SCHEMA.md (new table + field + audit verb), CLAUDE.md (receipts module), API_REFERENCE.md, PROGRESS.md (PR A task IDs) |
| Task B27 | CHANGELOG (v0.5.1 PR B section), SCHEMA.md (pos_refunds, refunded_qty, refund.* verbs), CLAUDE.md (refunds module + new rule #22 for ADR-038), API_REFERENCE.md, PROGRESS.md (v0.5.1 done) |

### CHANGELOG draft (already in plan)

The plan's Task A9 + B27 include full CHANGELOG entry drafts. ✅

## 10. Testing Plan Assessment

**Verdict:** **Adequate** (after I2 clarification).

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend (PR A) | template render, httpAction integration, cache, lazy-mint | convex-test + vitest | ✅ planned (Tasks A2, A4, A5, A7 = 4 files) |
| Backend (PR B) | voucher-math, commit, dedup, send-failure, audit, settlement, recent-list-cutoff, refund-kind, refund-projection | convex-test + vitest | ✅ planned (Tasks B4, B13-B20 = 9 files) |
| Frontend (PR B) | /refund list, /refund form, /mgr/refunds-pending | RTL + vitest | ✅ planned (Tasks B22, B23, B24 = 3 files) |
| Helper (PR A) | `mintUrlSafeToken` shared helper | vitest | ✅ planned (Task A3) |
| Helper (PR B) | `lineRefundedQty`, `lineRefundable` | vitest | ✅ planned (Task B4) |
| Frontend (PR B) | `rp()` negative-amount handling | vitest | ✅ planned (Task B26) |
| Manual (PR B) | refund flow E2E on PWA device | manual | ⚠️ not in plan; flagged as v0.5.1-end smoke |

**Total: ~17 new test files. ~80 new test cases (rough count).**

### Missing test coverage (small)

| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | Manual smoke on PWA device | UI on the actual booth Android (touch targets, scrolling) | Add to Task B28 Step 4: "Open the PWA on a phone, run a refund through the inline-PIN path and the Telegram path, verify the receipt URL renders correctly on a different device." |
| 2 | Cross-module ESLint rule fires on a fresh violation (regression test) | The OWNERSHIP map entries are added but a deliberate-violation test would catch a regression | Out of scope — the existing `eslint-rules/__tests__/` covers the rule machinery; OWNERSHIP map additions don't need their own regression test |

### Test execution checkpoints

Per task: each task's Step N runs that task's test. Per PR: A8 (after backend, before docs) + A10 (full suite before ship). Per PR B: full suite after each B-block of tasks (B13-B20 batch). ✅

### Regression risk

- v0.5.0.1 baseline = 558 tests. PR A adds ~10 tests (likely 568). PR B adds ~70 (likely 638). Regression risk = none (all changes additive).
- Telegram approval kind tests (v0.4) — adding `refund` to KIND_AUDIT/TEMPLATE/validateContext shouldn't break existing kinds. ✅ Task B2 + B19 cover the new wiring.
- Receipt rendering depends on `pos_settings` — no existing tests on settings + the plan hardcodes settings in Task A5 anyway. Low risk.

## 11. Edge Cases to Address

- [x] `_confirmPaid` token mint runtime → C1
- [x] `_logAudit` shape → C2
- [x] RefundContext line_id → C3
- [x] Manager-listing namespace → I1
- [ ] Pre-v0.5.1 txn cannot reach refund flow (Q1=B recent list) — spec edge case, no plan-level fix needed
- [ ] Cache purge for missing token → already throws PURGE_NO_TOKEN per Task B6 ✅
- [ ] Lazy-mint caller auth-gate → Task A5 docstring notes the contract ✅
- [ ] Multiple partial refunds compose → Task B13 test ✅
- [ ] Concurrent refund races → Convex OCC ✅
- [ ] Receipt for cancelled txn → status guard in Task A5 + A7 ✅
- [ ] PR A revert leaves orphan tokens → CHANGELOG note in Task A9 ✅

## 12. Approval Conditions

**To approve, address (Critical):**

1. **C1** — In Task A6: drop the `mintUrlSafeToken` import from `_confirmPaid_internal`; add `receipt_token: v.string()` to its args; update **all callers** (likely `convex/payments/internal.ts` webhook + `convex/payments/__tests__/actions.test.ts` test seed) to mint in the action layer and pass.
2. **C2** — Throughout the plan, find-replace `await ctx.runMutation(internal.audit.internal._logAudit_internal, {` → `await logAudit(ctx, {`. Add `import { logAudit } from "../audit/internal";` to each affected file's import section.
3. **C3** — Edit Task B2's `RefundContext` to include `line_id` from the start. Update `validateContext` to validate it. Update Task B9's `_computeRefundPreview_internal` to populate `line.line_id`. Remove the "CORRECTION" comment + Step 2 from Task B10.

**Recommended before execution (Improvements):**

1. **I1** — Find-replace `internal.staff.internal._listActiveManagers_internal` → `internal.auth.internal._listActiveManagers_internal` in Tasks B8 + B10. Drop the `_findManagerByPin_internal` red herring in B8.
2. **I2** — Add to Tasks B14-B20 + B23-B26 a one-liner: "Use Task B13's `seedPaidTxn` helper as the template" / "Use Task B22's pattern as the template".
3. **I3** — Pre-flight check the convex-test `t.fetch` API in Task A7 before writing the body; provide fallback.
4. **I4** — Add a "Success criteria" callout at the end of Task A10 and Task B28 (5 gates).
5. **I5** — Add a "Dependency notes" section per PR (sequential vs parallelism opportunities for the test/route tasks).

---

*Generated by /staffreview*
