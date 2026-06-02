# Staff Review: v0.6 implementation plan

**Date:** 2026-06-02
**Plan:** `docs/superpowers/plans/2026-06-02-v0.6.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — header, manifest, project-wide guardrails, 41 tasks across 5 waves, self-review, execution handoff. Strict TDD shape per task. Pre-staffreviewed spec at `docs/superpowers/specs/2026-06-02-v0.6-design.md`.

---

## 1. Summary

**Overall Assessment:** **Revise** *(5 Critical, 4 Improvement, 3 Refinement — all crisp, mechanical fixes against verified real-code references; no architectural rework)*

The plan is comprehensive and the TDD per-task shape is right. But it has **5 Critical field-name and validator-extension errors** against the existing code that would cause the implementation to **compile-fail** at multiple call sites the first time the executor runs `npm run typecheck`: (1) `_writeCache_internal` real arg name is `mutationName`, not `label`; (2) `_markResolved_internal` real field is `resolved_by_manager_id`, not `resolved_by`; (3) extending `APPROVAL_KINDS` to "spoilage" also requires updating two literal unions in `convex/approvals/internal.ts` that the plan does not enumerate; (4) `hashTokenSha256` is not in `convex/lib/constantTimeEqual.ts` — the file only exports `constantTimeEqual`; the helper has to be located or written; (5) `_auditSkip_internal` does not exist — the real pattern is a per-cron helper (`_auditFoundersSkip_internal`), so the plan needs to spec a new `_auditStockReconSkip_internal` mirroring it. Once these five corrections land inline, the plan is execution-ready.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `_writeCache_internal` real arg name is `mutationName`, not `label` | Implementation / Logic | V4 §createVoucher action; S4 §recordSpoilage action; S5 §requestSpoilageApproval + approveSpoilage |
| 2 | `_markResolved_internal` real arg name is `resolved_by_manager_id`, not `resolved_by`; `kind` is NOT an arg | Implementation / Logic | S5 §approveSpoilage |
| 3 | Adding `"spoilage"` to APPROVAL_KINDS also requires updating the literal-union arg validators in `_createRequest_internal` AND `_listPendingByKind_internal` | Schema / Validation | S2 (not enumerated); causes runtime arg-validation failure at S5 |
| 4 | `hashTokenSha256` is NOT exported from `convex/lib/constantTimeEqual.ts` | Implementation / Imports | S5 import statement |
| 5 | `_auditSkip_internal` does not exist; the real pattern is a per-cron mutation in the owning module's `internal.ts` | Architecture / Audit | R5 §sendStockReconResilient |

### Issue 1: `_writeCache_internal` field-name mismatch

Real signature at `convex/idempotency/internal.ts:113-114`:

```ts
export const _writeCache_internal = internalMutation({
  args: { key: v.string(), mutationName: v.string(), response: v.string() },
```

The plan calls it in three places (V4, S4, S5) with `label` instead of `mutationName`:

```ts
// V4 plan code:
await ctx.runMutation(internal.idempotency.internal._writeCache_internal, {
  key: args.idempotencyKey,
  label: "vouchers.createVoucher",   // ❌ should be `mutationName`
  response: JSON.stringify(id),
});
```

**Recommendation:** Inline-edit V4, S4, S5 to use `mutationName`. Mechanical; ≤5 lines per task.

### Issue 2: `_markResolved_internal` field-name mismatch

Real signature at `convex/approvals/internal.ts:142-160`:

```ts
export const _markResolved_internal = internalMutation({
  args: {
    idempotencyKey: v.string(),
    requestId: v.id("pos_approval_requests"),
    resolved_by_manager_id: v.id("staff"),
    // ... no `kind` arg
  },
  handler: withIdempotency<...>(
    "approvals._markResolved_internal",
    async (ctx, args) => { /* single-use enforcement + audit + cache */ },
  ),
});
```

The plan's S5 approveSpoilage call:

```ts
// S5 plan code:
await ctx.runMutation(internal.approvals.internal._markResolved_internal, {
  requestId: req._id,
  resolved_by: managerId,             // ❌ should be `resolved_by_manager_id`
  idempotencyKey: args.idempotencyKey,
  kind: "spoilage",                    // ❌ no such arg
});
```

**Recommendation:** Update S5 call: `resolved_by_manager_id: managerId`, remove `kind` arg. Also confirm the source-thread shape — the wrapper resolves the `KIND_AUDIT[kind]` audit verb itself via the row's stored `kind` field (verify by reading `_markResolved_internal`'s full handler at plan-execution time). The audit verb for spoilage-approval-resolved (`spoilage.approval_resolved`) is set by `KIND_AUDIT` lookup, not by passing `kind` into the resolve.

### Issue 3: APPROVAL_KINDS extension requires three union-validator updates, not one

The plan Task S2 says "Update the union: `ApprovalKind = staff_pin_reset | manual_payment_override | refund | spoilage`" — that updates only the TypeScript union in `convex/approvals/kinds.ts`. But the **Convex runtime validators** for `_createRequest_internal` and `_listPendingByKind_internal` are *separately* literal unions:

```ts
// convex/approvals/internal.ts:22 — _createRequest_internal args:
kind: v.union(
  v.literal("staff_pin_reset"),
  v.literal("manual_payment_override"),
  v.literal("refund"),
)

// convex/approvals/internal.ts:309 — _listPendingByKind_internal args:
kind: v.union(
  v.literal("staff_pin_reset"),
  v.literal("manual_payment_override"),
  v.literal("refund"),
)
```

These are Convex `v.union(v.literal(...))` validators that run at request time. Without extension, S5's `_createRequest_internal({kind: "spoilage", ...})` call throws `ArgumentValidationError` at runtime, even though TypeScript types check.

**Recommendation:** Add explicit steps to Task S2 enumerating BOTH internal-validator updates. Three places need `v.literal("spoilage")`:
- `convex/approvals/kinds.ts` — `ApprovalKind` TypeScript union ✅ (already in plan)
- `convex/approvals/internal.ts:22` — `_createRequest_internal.args.kind` Convex validator union ❌ (missing from plan)
- `convex/approvals/internal.ts:309` — `_listPendingByKind_internal.args.kind` Convex validator union ❌ (missing from plan)

Also potentially needed: any `pos_approval_requests` schema literal union if `kind` is constrained in `approvals/schema.ts`. Verify at plan-edit time — if `schema.ts` also uses `v.union(v.literal(...))` for the `kind` column, add it to the list.

### Issue 4: `hashTokenSha256` not in `convex/lib/constantTimeEqual.ts`

`convex/lib/constantTimeEqual.ts` exports only `constantTimeEqual(a, b): boolean` (15 lines total). The plan's S5 imports:

```ts
import { hashTokenSha256, constantTimeEqual } from "../lib/constantTimeEqual";
```

`hashTokenSha256` is not in that file. The helper exists somewhere (refunds + manual-payment + staff-pin-reset approve actions all do SHA-256 + constant-time compare), most likely:
- inline in each approveX action (no shared helper),
- in `convex/approvals/actions.ts` as a local function,
- or in another `convex/lib/` file I have not checked.

**Recommendation:** Before writing-plans is re-executed, grep:

```bash
grep -rn "hashTokenSha256\|crypto.subtle\|sha-256" convex/
```

Then either: (a) import from the real location once found, OR (b) add it to `convex/lib/constantTimeEqual.ts` as a sibling helper if no existing one is used (the v0.4 plumbing for approval tokens lives in `convex/approvals/actions.ts:approveManualPayment` — copy the pattern verbatim). Update S5's import statement to reflect the real location. **Don't invent imports.**

### Issue 5: `_auditSkip_internal` is not a real helper; the pattern is per-cron

Plan R5 references:

```ts
await ctx.runMutation(internal.audit.internal._auditSkip_internal /* or inline logAudit via internal mutation */, {
  action: "stock.recon_skip", reason: "no_drift", metadata: { scanned: result.scanned },
});
```

No such helper exists. The real precedent in `convex/telegram/foundersSummary.ts:65-67` is:

```ts
await ctx.runMutation(internal.telegram.internal._auditFoundersSkip_internal, {
  reason: "disabled",
});
```

— a **module-specific** skip helper, not a generic one. The internalMutation lives in `convex/telegram/internal.ts` because foundersSummary is `"use node"`-free (so it could be there too in principle), but the foundersSummary precedent isolates the audit-skip primitive in the same module that owns the data context.

**Recommendation:** Add to Task R4 (the `_runStockRecon_internal` task) a sibling internalMutation:

```ts
// convex/inventory/internal.ts
export const _auditStockReconSkip_internal = internalMutation({
  args: {
    reason: v.union(v.literal("no_drift"), v.literal("send_failed"), v.literal("transient_retry")),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await logAudit(ctx, {
      actor_id: "system",
      action: "stock.recon_skip",
      entity_type: "pos_stock_drift_log",
      entity_id: "system",
      source: "system",
      metadata: { reason: args.reason, ...(args.metadata ?? {}) },
    });
  },
});
```

Update R5's audit-skip call sites to use `internal.inventory.internal._auditStockReconSkip_internal`. The plan also wires this into the `stock.recon_skip` audit verb list — already documented in the spec's verb table (good).

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | `sendFoundersSummaryResilient`'s `attempt` arg is `v.optional(v.number())`; plan R5 uses `v.number()` non-optional | M | L |
| 2 | Plan R5 misses the `chatIdOverride` race-close pattern from `sendFoundersSummary` | M | L |
| 3 | R5 return type should be a narrow literal union, mirroring foundersSummary | L | L |
| 4 | Plan R2 says "create file if not exist" but `convex/catalog/internal.ts` already exists — just append | L | L |

### Improvement 1: Mirror `attempt: v.optional(v.number())` from existing resilient action

`convex/telegram/foundersSummary.ts:158-160`:

```ts
export const sendFoundersSummaryResilient = internalAction({
  args: {
    attempt: v.optional(v.number()),
```

Plan R5 declares `attempt: v.number()`. Functionally fine (cron registration in R7 passes `{attempt: 0}` explicitly), but mirror the existing precedent for symmetry — and an admin running it ad-hoc shouldn't need to pass `{attempt: 0}` redundantly.

### Improvement 2: `chatIdOverride` race-close

`sendFoundersSummary` (lines 88-103) resolves the role-bound chat id ONCE upfront and threads it via `chatIdOverride` to `sendTemplate`. This closes a real race: "pre-check passes → admin unbinds role → sendTemplate's internal resolve throws → caught as send_failed, conflating a config change with a real Telegram error" (per the in-file comment).

Plan R5's send call passes only `role: "inventory"`, leaving `sendTemplate` to resolve internally. If a manager unbinds the inventory role mid-recon, the same race occurs.

**Recommendation:** Mirror foundersSummary exactly — resolve `inventory` chat id once via `internal.telegram.chatRegistry.internal.getChatIdByRole({role:"inventory"})`, catch `"No Telegram chat assigned to role"` specifically (skip with `reason: "role_unbound"`), thread `chatIdOverride` to `sendTemplate`. Adds ~15 lines, closes a known race.

### Improvement 3: Narrow R5 return type

foundersSummary returns `{ ok: true } | { skipped: "disabled" } | { skipped: "role_unbound" }`. Plan R5 returns `{ ok: true } | { skipped: string }`. For typecheck-time exhaustiveness:

```ts
Promise<
  | { ok: true }
  | { skipped: "no_drift" }
  | { skipped: "role_unbound" }
  | { skipped: "retrying" }
>
```

### Improvement 4: R2 file-already-exists

Plan R2 says: *"Modify: `convex/catalog/internal.ts` (create the file if it doesn't exist — verify at task time; if not, create with the standard `internalQuery` import header)"*. The file **does exist** today (`Glob convex/catalog/internal.ts` returns it). Drop the conditional; just append.

## 4. Refinements (Optional)

- **R1.** S5's `_resolveApprovingManager_internal` is invented in the plan with a "verify at task time" caveat. Confirmed: no such helper exists. The plan already flags "inline the pattern from approveRefund directly." Make this a hard decision: **inline the pattern, do not invent the helper** (rule-of-three holds — staff_pin_reset, manual_payment, refund each inline their staff-by-code resolve + argon2 verify; spoilage is the 4th instance, which is the trigger to extract — but extraction is its own design task, not in scope for this plan). Update S5 inline-edit to say "inline."
- **R2.** Test seeding duplication: V4, V5, V6, V7, S4 each redefine local `seedMgr` / `seedManagerSession` / `seedVoucher` helpers. By the rule-of-three, on the third occurrence, lift to `convex/test/helpers.ts` (new file) with `seedManager(t, {pin:"1111"})` returning `{mgrId, sessionId}` + `seedActiveSku(t, {code})`. The plan currently bakes this into each test file — acceptable but suboptimal. At plan-execution time, lift after the 3rd duplicate appears (v0.5.3c plan applied the same lesson at task time).
- **R3.** The Playwright `voucher-offline.spec.ts` shells out to `npx convex run vouchers/internal:_archiveByCode_internal` — that helper does not exist. Use one of: (a) call `archiveVoucher` via the Convex client with a known seeded mgr-session-id, (b) shell `npx convex run vouchers/public:archiveVoucher` if it's exposed (it is — manager-session-gated), passing a session id seeded via the reset action's known-shape. Update the spec to use the **real** public mutation. Mark this as **must-edit in P7** before execution; otherwise the spec will fail to drive a voucher into INACTIVE state mid-test.

## 5. Duplication Analysis

### Existing code to leverage (and the plan does)

| Code | Location | How plan uses it |
|------|----------|------------------|
| `_lookup_internal` | `convex/idempotency/internal.ts:92` | V4, S4, S5 action-level cache pre-check ✅ |
| `_writeCache_internal` (real arg names) | `convex/idempotency/internal.ts:113` | V4, S4, S5 — see Critical #1 |
| `withIdempotency` | `convex/idempotency/internal.ts:52` | V5, V6, V7, R8 + `_markResolved_internal` etc. ✅ |
| `requireManagerSession` → `{staffId, deviceId}` | `convex/auth/sessions.ts:24` | V5, V6, V7, R8 destructure ✅ |
| `requireSession` (also exported) | `convex/auth/sessions.ts:13` | S5 could use this instead of `getSession` + role-check ⚠️ (style) |
| `verifyManagerPinOrThrow` | `convex/auth/verifyPin.ts:67` | V4, S4 — spec already corrected the signature ✅ |
| `mintUrlSafeToken` | `convex/lib/tokens.ts:53` | S4 (spoilage_event_id), S5 (rawToken + event_id) ✅ |
| `constantTimeEqual` | `convex/lib/constantTimeEqual.ts:10` | S5 ✅ (just not `hashTokenSha256` — Critical #4) |
| `_getByTokenHash_internal` | `convex/approvals/internal.ts:229` | S5 ✅ |
| `_deleteRequest_internal` | `convex/approvals/internal.ts:88` | S5 on-send-fail path ✅ |
| `cronRetry` exports (real names) | `convex/lib/cronRetry.ts` | R5 ✅ |
| `sendFoundersSummaryResilient` shape | `convex/telegram/foundersSummary.ts:158` | R5 mirrors (with improvements 1-3 above) |
| `seed/internal.ts` pre-registers `dev-booth-device` | `convex/seed/internal.ts:67` | Playwright fixtures (P2) ✅ |
| `useCart` `setVoucher`/`clearVoucher` | `src/hooks/useCart.ts:105-111` | V10 ✅ |

### Potential duplication risks

- **S5's `_resolveApprovingManager_internal`** was a speculative shared helper that does not exist. The plan correctly flags inline-instead. Per Refinement R1, lock that decision; do not invent.
- **Test seed helpers** (Refinement R2 above) — duplicated 5x across V4, V5, V6, V7, S4. Rule-of-three to refactor at execution time.

## 6. Phase / Wave Accuracy

| Wave | Assessment | Notes |
|------|-----------|-------|
| Wave 1 (Vouchers, 11 tasks) | Good | Sequence constraint inside: V1+V2 before V4/V7; V3 before V4; V8 independent. Plan calls this out in manifest. |
| Wave 2 (Spoilage, 7 tasks) | **Needs adjustment** | Schema S1 must land before everything else in W2 (good). S2 must enumerate the validator-extensions explicitly (Critical #3). S3+S4 sequential (S4 calls S3). S5 sequential after S2+S3. S6+S7 last. |
| Wave 3 (Stock-recon, 9 tasks) | Good | R1+R2+R3 parallel; R4 needs R1+R2+R3; R5 needs R4; R6 needs R5's payload shape; R7 needs R5 deployed; R8 needs R4; R9 needs R8. Independent of W1+W2. |
| Wave 4 (Playwright, 10 tasks) | **Needs adjustment** | P7's `_archiveByCode_internal` shell-out fictional (Refinement R3). Switch to `archiveVoucher` public via session-id. |
| Wave 5 (Docs, 4 tasks) | Good | Runs after Wave 4. |

**Ordering issues:** beyond W2's S2 validator-extension issue and W4's P7 fictional-helper issue, ordering is sound.

**Missing phases:** none. All spec sections map to tasks (per the plan's self-review §Spec coverage check).

## 7. Specialist Agent Recommendations

Unchanged from the spec staffreview §7 — same agent assignments per wave.

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branch | ✅ worktree `plan-v0.6a-vouchers` (legacy name; PR title carries v0.6) |
| Branch naming | ✅ |
| Merge strategy | ✅ squash-PR per repo convention |

### Commit checkpoints (the plan's manifest)

✅ All 41 tasks have explicit commit-message prefixes. Order is sane.

### Pre-push verification

✅ Plan's project-wide guardrails section names `npm run typecheck`, `npm run lint`, vitest as the pre-commit gate per task.

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ additive-only across W1-W3; W4 is greenfield tooling; W5 is docs |
| Deployment order | ✅ BE → FE → Playwright CI; explicit in plan's Execution handoff |
| Data backup | No (additive only) |
| Migration safety | ✅ optional fields on `pos_stock_movements`; new `pos_stock_drift_log` greenfield |

## 9. Documentation Checkpoints

| Wave | Docs to update |
|------|----------------|
| W5 D1 | ADR-044 (recon report-only) |
| W5 D2 | SCHEMA.md (new optional fields, new table, new verbs) |
| W5 D3 | CLAUDE.md rule #22 v0.6 additions + Telegram template additions |
| W5 D4 | CHANGELOG.md |

**Verify at D2:** the SCHEMA.md verb-list preview already has `voucher.created`/`voucher.edited`/`voucher.deactivated`/`stock.spoilage` (lines 609-622) — D2 must add `stock.recon_drift`, `stock.recon_drift_resolved`, `stock.recon_skip` + the new `pos_stock_movements.spoilage_reason?`/`spoilage_event_id?` fields + the `pos_stock_drift_log` table.

## 10. Testing Plan Assessment

**Verdict:** **Adequate** with one gap.

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| BE unit | `voucher-validate` reason paths + boundary | vitest | ✅ |
| BE unit | `inventory/lib` reconstruct + drift | vitest | ✅ |
| BE unit | `validateContext("spoilage")` | vitest | ✅ |
| BE integration | Vouchers CRUD + replay + auth-reject | convex-test | ✅ |
| BE integration | `commitCart` 3 reject reason paths + happy | convex-test | ✅ |
| BE integration | `_recordSpoilage_internal` multi-line + audit | convex-test | ✅ |
| BE integration | `recordSpoilage` action PIN gate + replay | convex-test | ✅ |
| BE integration | `requestSpoilageApproval` create + Telegram (mocked) | convex-test | ✅ |
| BE integration | `_runStockRecon_internal` no-drift + drift + skip-on-empty | convex-test | ✅ |
| FE | `mgr/vouchers.tsx` smoke + manager-redirect | vitest + RTL | ✅ |
| FE | `sale/voucher.tsx` cached fallback | vitest + RTL | ✅ |
| FE | `voucher-reject-banner` humanization | vitest + RTL | ✅ |
| E2E | 7 specs (auth, sale-qris, sale-bca-va, voucher-online, voucher-offline, refund, spoilage) | Playwright | ✅ |

### Missing test coverage (must add)

| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | `approveSpoilage` happy path + wrong-PIN + replay | The off-booth path needs symmetric coverage with `recordSpoilage` (which has it) | Mirror Task S4's test shape; test seeds an approval row + asserts `_recordSpoilage_internal` called with `source:"telegram_approval"` |
| 2 | `sendStockReconResilient` transient-retry + non-transient-skip | Per staffreview §10 Missing Test 4 (carried from spec review) | Mock `cronRetry`; assert `runAfter` invoked once on transient, not on non-transient |
| 3 | `renderStockDriftAlert` HTML snapshot | Per staffreview §10 Missing Test 5 (Telegram template stability) | Snapshot the rendered text given a fixture drifted-array |
| 4 | `validateContext("spoilage")` cross-check for forged `total_qty` | Already in plan S2 test — verify it's present ✅ | (no action needed if S2 tests include the mismatch case — they do) |

### Test execution checkpoints

✅ Plan's per-task TDD shape (Step 1: failing test → Step 4: pass → Step 5: typecheck/lint → Step 6: commit) is the gate.

### Regression risk

- **`convex/transactions/__tests__/commitCart.test.ts`** — the additive `voucher_rejected?` return shape is back-compat for destructuring callers, but any structural-equality fixture comparison will need update. Plan V8 calls this out ✅.
- **`convex/refunds/__tests__/voucher-math.test.ts`** — ADR-040 math unchanged; smoke-run as a sanity check. Not in plan; add to W5 verification step.
- **All inventory tests** — adding optional fields to `pos_stock_movements` (S1) must not break existing tests that destructure movement rows. Run `npx vitest run convex/inventory/__tests__/` after S1.

## 11. Edge Cases to Address

- [ ] **APPROVAL_KINDS extension propagation** (Critical #3): grep also for `KIND_AUDIT` map exhaustiveness — TypeScript may catch this via `Record<ApprovalKind, ...>`, but `KIND_TEMPLATE` and the `send.ts` payload union must also extend.
- [ ] **`pos_approval_requests.kind`** schema field — if it's a literal union in `approvals/schema.ts`, S2 must extend it. Verify at task time (likely yes — every existing kind is a literal).
- [ ] **`approvals/schema.ts` `entity_type` union** — `_createRequest_internal` accepts `entity_type` which is likely a literal union; "pos_stock_movements" must be in that union for spoilage requests to write. Verify.
- [ ] **Test fixture for argon2 hash in `convex/staff/`** — V4 + S4 test fixtures call `argon2id(...)` from `hash-wasm` directly. Convex-test runs in edge-runtime — verify `hash-wasm` works there OR seed pre-hashed PIN via a known-fixture string. (The existing `convex/auth/__tests__/loginWithPin.test.ts` is the precedent — copy from there.)
- [ ] **Convex action `runAction` and `runMutation` from `"use node"` source** — S4's recordSpoilage action calls `runMutation(_recordSpoilage_internal)` which is a V8 internalMutation. Confirmed allowed pattern (founders does it). No edge case.
- [ ] **R5 `chatIdOverride` race** (Improvement #2): the inventory role might be unbound (no inventory Telegram chat configured). Plan must skip-on-unbound with `reason: "role_unbound"`.

## 12. Approval Conditions

**To approve (must fix before execution starts):**
1. **Critical #1:** rename `label` → `mutationName` at V4 / S4 / S5 `_writeCache_internal` calls (5 occurrences).
2. **Critical #2:** rename `resolved_by` → `resolved_by_manager_id` + drop `kind` arg at S5's `_markResolved_internal` call.
3. **Critical #3:** add explicit step in S2 to extend `_createRequest_internal.args.kind` and `_listPendingByKind_internal.args.kind` literal unions, AND verify `approvals/schema.ts` `kind` field.
4. **Critical #4:** grep `hashTokenSha256` to find its real location; update S5 import. If not found, inline SHA-256 + constant-time compare per the v0.4 approveManualPayment precedent.
5. **Critical #5:** add `_auditStockReconSkip_internal` to Task R4 (or split into a new task), and update R5 to call it.

**Recommended (do at plan-edit time, low cost):**
6. **Improvement #1:** make `attempt: v.optional(v.number())` in R5.
7. **Improvement #2:** mirror `chatIdOverride` race-close pattern.
8. **Improvement #3:** narrow R5 return-type to a literal union.
9. **Improvement #4:** R2 drop the "create if not exists" conditional (file exists).

**Recommended at execution time:**
10. **Refinement R1:** lock S5 to "inline staff-by-code resolve + argon2 verify; no invented helper."
11. **Refinement R2:** lift `seedManager` / `seedActiveSku` test helpers after the 3rd duplicate.
12. **Refinement R3:** P7 swap fictional `_archiveByCode_internal` for the real `archiveVoucher` public mutation called via the Convex client with a seeded mgr session.

---

*Generated by /staffreview*
