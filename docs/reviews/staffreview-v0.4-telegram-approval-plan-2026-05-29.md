# Staff Review: v0.4 — Telegram Approval Graduation + Self-Registration + Founders Share (IMPLEMENTATION PLAN)

**Date:** 2026-05-29
**Plan:** `docs/superpowers/plans/2026-05-29-v0.4-telegram-approval.md`
**Reviewers:** 10x Staff Developer (Implementation) + 10x Principal Developer (Architecture)
**Scope:** Reviewing the *executable plan* (not the spec). Spec + its staffreview read for continuity; not re-litigated.

---

## 0. Plan Structure Additions

The plan is **structurally complete** as an executable artifact:

- **Waves:** 5 dependency-ordered waves (W1 SEQUENTIAL schema → W2a/W2b/W2c PARALLEL → W3 SEQUENTIAL → W4 PARALLEL → W5 SEQUENTIAL). Each wave's PARALLEL/SEQUENTIAL marker is present and (mostly) correct — see §6.
- **File Structure:** explicit Create/Modify/Delete manifest up front. Good.
- **Rollback notes:** present ("all schema additive → clean per-wave revert"; deploy backend-before-frontend; keep `TELEGRAM_CHAT_ID` as fallback). Accurate.
- **Pre-merge verification:** present (typecheck/build/vitest/codegen/manual E2E).
- **Self-review notes:** present, including a "known verify-at-execution gaps" list. This list is honest but **understates two of the gaps to Critical severity** (see §2).
- **TDD shape:** every backend task is write-test → fail → implement → pass → commit. Good discipline.

Verdict on structure: complete. The problems are in *internal consistency*, not missing sections.

## 1. Summary

**Overall Verdict: REVISE** (no major rework; the architecture and wave ordering are sound, but there are **3 Critical internal-consistency defects** that will cause compile/runtime failures if implemented as literally written, plus several real gaps the plan defers as "verify-at-execution" that are actually known-wrong).

The plan is well-grounded: it correctly reuses the shipped `_onPaidManual_internal` funnel, the token+constant-time pattern from `approveStaffPinReset`, the additive-source decision from the spec staffreview, and the starter's webhook/registry. The kind-registry (`APPROVAL_KINDS`) is the right abstraction and the four-touchpoint discipline (CLAUDE.md "How to add a feature" #8) is honoured. Where it slips is in **naming/signature drift against the actual shipped code**: a non-existent idempotency helper invoked in three tasks, starter `…Impl` cores that aren't exported and have different signatures than the plan's call sites assume, and a `dateAnchors` helper that doesn't exist. These are fixable in-task but must be corrected before execution, because the plan's TDD steps will fail at "implement" with type errors the plan doesn't anticipate.

Counts: **Critical 3 · Improvement 6 · Refinement 5.**

## 2. Critical Issues (Must Fix)

### C1 — `_recordResponse_internal` does not exist; the real helper is `_writeCache_internal` with a different arg shape (Tasks 20, 21, 22)
The plan calls `ctx.runMutation(internal.idempotency.internal._recordResponse_internal, { key, response })` in **three** actions (`requestManualPaymentApproval` line ~1195, `approveManualPayment` ~1265, `denyRequest` ~1320). That function **does not exist**. The shipped idempotency module (`convex/idempotency/internal.ts:113`) exports `_writeCache_internal({ key, mutationName, response })` — note the **required `mutationName` arg** the plan omits. Confirmed by grep: only `_writeCache_internal` exists; `_recordResponse_internal` appears nowhere in `convex/`. Existing callers (`convex/auth/actions.ts:208,293`) use `_writeCache_internal`.
**Impact:** every one of the three actions fails `npx convex codegen` / `typecheck` — `internal.idempotency.internal._recordResponse_internal` is `undefined`. The plan flags "confirm the name at implementation" (line 1201), which downgrades a definite bug to a maybe. Fix: rename to `_writeCache_internal` and add `mutationName` (e.g. `"approvals.requestManualPaymentApproval"`). The test stubs that assert idempotent replay will silently pass without it because the `_lookup_internal` pre-check returns null forever — so a network retry **re-sends the Telegram message and re-creates work**, defeating the whole idempotency story (ADR-013 / business rule #15).

### C2 — Starter `…Impl` cores are NOT exported and have DIFFERENT signatures than Task 16's call sites (Tasks 12, 16)
`mgrAdmin.ts` (Task 16) imports `{ listChatsImpl, assignRoleImpl, archiveChatImpl, restoreChatImpl }` from `./chatRegistry` and calls them as:
- `listChatsImpl(ctx)` — **one arg**
- `archiveChatImpl(ctx, { chatId })` — **object arg**
- `restoreChatImpl(ctx, { chatId })` — **object arg**

But in the actual starter (`C:\Users\Irfan\AppData\Local\Temp\cvtg-starter\convex\telegram\chatRegistry.ts`):
- All four `…Impl` functions are **module-private `async function` declarations with NO `export`** (lines 250, 261, 317, 327). Importing them as written = compile error.
- `listChatsImpl(ctx, includeArchived: boolean)` takes **two args** (line 250) — Task 16 passes one, so `includeArchived` is `undefined` and the `includeArchived ? all : all.filter(...)` returns archived rows (wrong — admin list would show archived chats).
- `archiveChatImpl(ctx, chatId: string)` / `restoreChatImpl(ctx, chatId: string)` take a **bare string** (lines 317, 327) — Task 16 passes `{ chatId }`, so the lookup `q.eq("chatId", chatId)` receives an object and matches nothing.

The plan's note "If the ported `chatRegistry.ts` doesn't export the `…Impl` cores by these exact names, export them" (line 920) covers the export gap but **completely misses the signature mismatches**. `assignRoleImpl(ctx, {...})` is the one that happens to match (it takes an object, line 261).
**Impact:** Task 16 will not compile, and even after adding `export`, `mgrListChats`/`mgrArchiveChat`/`mgrRestoreChat` are logically wrong. Fix: when porting, normalize the four cores to object-args + export them, and pass `listChatsImpl(ctx, false)` (or add `includeArchived` to the mgr query args).

### C3 — `_markResolved_internal` is SHARED across kinds; flipping its source to `telegram_approval` silently changes the pin-reset path's audit, and creates an intra-path source inconsistency (Task 21)
Task 21 says: "update `_markResolved_internal`'s single `wa_approval` literal to `telegram_approval` … this is the one intentional behavior change, isolated to the off-booth source label." This is **not isolated**. `_markResolved_internal` (`convex/approvals/internal.ts:111-152`, source literal at `:145`) is the shared resolve funnel for **both** `staff_pin_reset` (called by the shipped `approveStaffPinReset`, actions.ts:195) **and** the new `manual_payment_override`. Changing `:145` flips the `approval.resolved` audit `source` for the **pin-reset path too**.

The plan claims the regression is caught by `approvePinReset.test.ts` and tells you to "update the assertion". But that test (`:77`) asserts `source: "wa_approval"` on the **`staff.pin_reset`** row (emitted by `_changePinCommit_internal` via `approveStaffPinReset` actions.ts:192) — a DIFFERENT row from the `approval.resolved` row `_markResolved_internal` writes. So:
- The existing test **stays green without the suggested edit** (it doesn't assert the `approval.resolved` row's source), masking the silent change.
- After the change, the pin-reset path emits a `staff.pin_reset` row with `source: "wa_approval"` **and** an `approval.resolved` row with `source: "telegram_approval"` — two rows for one logical action with **inconsistent source labels**. That's an audit-coherence defect (ADR-030 "approval audit captures full context").

**Impact:** correctness/audit-integrity, not a crash. Fix options: (a) leave `_markResolved_internal` on `wa_approval` and accept both off-booth kinds keep the legacy label (simplest, zero-risk, defensible since `wa_approval` is the historical off-booth source); or (b) parameterize `source` on `_markResolved_internal` (add an arg, default `wa_approval`, pin-reset passes `wa_approval`, manual-payment passes `telegram_approval`) so each path is internally consistent. Either way, **also flip actions.ts:192** (`_changePinCommit_internal` source) if you want the pin-reset path consistently `telegram_approval`, or leave both `wa_approval`. Do not ship the half-change as written.

## 3. Improvements (Recommended)

### I1 — `_resolveSession_internal` and `_getByCode_internal` do NOT return `name`; the requester/approver name path is unbacked (Tasks 20, 21)
Task 20 reads `requester.name` (line ~1182, into the Telegram payload `requester_name`) from `internal.auth.internal._resolveSession_internal`. But `_resolveSession_internal` returns `{ staffId, deviceId }` only (`convex/auth/internal.ts:284-294`) — **no `name`**. The plan flags "extend it to include name if needed" (line 1201), but extending `_resolveSession_internal`'s return shape is a foundational-module change used by `transactions` too; verify no caller breaks, or (cleaner) call the existing `_getStaffNameCode_internal` (auth/internal.ts:14) which already returns `{ name, code }` — the same call `getByToken`/`notifyStaffLockout` use. Recommend: resolve session → `staffId`, then `_getStaffNameCode_internal(staffId)` for the display name. Avoids widening the session resolver.

### I2 — `_listPendingByKind_internal` arg validator is `v.string()` but the index `.eq("kind", …)` is typed; the JS cast hides a footgun (Task 8)
`_listPendingByKind_internal` declares `kind: v.string()` then does `q.eq("kind", args.kind as ApprovalKind)`. A caller passing an unknown kind string would silently return `[]` (no index match) rather than throwing. Low risk (only internal callers), but tighten to `v.union(v.literal("staff_pin_reset"), v.literal("manual_payment_override"))` for parity with the schema, matching the v0.3 precedent where kinds are unions everywhere else.

### I3 — `computeWibDay` is invented; `dateAnchors.ts` only exports `noonLocalTodayMs` (Task 24)
Task 24 calls `computeWibDay(Date.now())` "from lib/dateAnchors helpers" and says "wrap them for Asia/Jakarta + a dateLabel". But the starter's `dateAnchors.ts` exports **only** `noonLocalTodayMs(timeZone)` — there is no day-window helper, no `dayStartMs`/`dayEndMs`, no `dateLabel`. `computeWibDay` must be **written from scratch** (compute WIB midnight boundaries + a `id-ID` date label). This is a real chunk of date-math (the existing `pos_receipt_counters` comment, transactions/schema.ts:62-65, documents the WIB-day subtlety: 17:00 UTC = next WIB day). The plan presents it as a trivial wrap; budget it as net-new code with its own unit test (off-by-one on the UTC↔WIB boundary is the classic bug). The repo already has `convex/lib/time.ts` (WIB-calendar helpers per CLAUDE.md) — check there first for an existing day-window function before writing a new one.

### I4 — `denyRequest`/`approveManualPayment` double-cache the response (Tasks 21, 22)
Both actions call a `withIdempotency`-wrapped internal (`_markDenied_internal` / `_markResolved_internal`, which write their own `pos_idempotency` row under keys `${key}:deny` / `${key}` ) **and then** call `_writeCache_internal` under the bare `key` again (the C1 fix). For `approveManualPayment` the bare `key` is *also* the key `_markResolved_internal` uses (actions.ts:195 passes `idempotencyKey: args.idempotencyKey` — the bare key, not suffixed). So the action would `_writeCache_internal(key, ...)` for a key that `_markResolved_internal` **already inserted** → `_writeCache_internal` is a no-op-if-exists (idempotency/internal.ts:120), so it's harmless but redundant. For `denyRequest`, `_markDenied_internal` uses `${key}:deny` while the action caches under `key` — that's fine. Recommend: pick ONE caching layer per action. Since the terminal commit mutation already caches atomically, the action-level `_writeCache_internal` is only needed when the commit's key differs from the action's lookup key. Document which key the `_lookup_internal` pre-check reads vs which the commit writes, so a replay actually hits. As written, `approveManualPayment`'s pre-check reads bare `key`, and `_markResolved_internal` writes bare `key` → replay works; the extra `_writeCache_internal` is dead. Simplify.

### I5 — `_onPaidManual_internal` return value is discarded; receipt number lost from the approve response (Task 21)
`_onPaidManual_internal` returns `{ confirmed, receiptNumber }` (payments/internal.ts:282) and can throw `RECEIPT_UNCONFIRMED` (the C4 superseded-txn guard, :279-281). Task 21 calls it, ignores its return, then returns `_markResolved_internal`'s `{ resolved: true }`. Two notes: (1) the C4 throw is correctly leveraged — if the txn was cancelled/expired before approval, `_onPaidManual_internal` throws and `_markResolved_internal` never runs, leaving the request `pending` (recoverable). Good. (2) The receipt number is dropped from the off-booth response; the requester's charge screen relies on the reactive `getRequestStatus` → `resolved` + the txn subscription flipping to `paid` (Task 29) to navigate. That's fine, but note it explicitly so no one "fixes" it by threading the receipt through. Confirm the order: `_onPaidManual_internal` MUST run before `_markResolved_internal` (it does, :1261-1264) so a C4 throw doesn't leave a resolved-but-unpaid request.

### I6 — Webhook path: POC `recordCallback`/`telegram_log`-dedupe is replaced by `telegramUpdates`; verify no orphan reference (Task 14)
The POC `webhook.ts` dedupes on `telegram_log.by_update_id` (webhook.ts:113-117) and the POC `sendTemplate` writes `telegram_log` via `logOutbound` (send.ts:78,94). Task 18 rewrites `sendTemplate`; Task 14 replaces the webhook. Ensure the rewritten `sendTemplate` either drops `logOutbound` or keeps `telegram_log` purely as the demoted debug-trail (Task 2 keeps the table). The plan keeps `telegram_log` (good) but doesn't say whether the new `sendTemplate` still writes to it. Decide: if you keep the audited-failure path writing `telegram.send_failed` to `audit_log` (Task 18 step 3), `telegram_log` outbound logging is redundant — drop `logOutbound` to avoid two parallel logs. Minor, but the plan is silent.

## 4. Refinements (Optional)

- **R1 — `getRequestStatus` and `getByToken` both compute effective-expiry; extract a helper.** `getByToken` (public.ts:67) and the new `getRequestStatus` (plan line 743) duplicate the `pending && expires <= now → expired` rule. A 3-line shared `effectiveStatus(req)` avoids drift. Tiny.
- **R2 — `chatId` env-fallback (`getChatIdByRole`) interacts with the migration shim.** The starter's `getChatIdByRole` (chatRegistry.ts:103-123) falls back to `TELEGRAM_CHAT_ID` only when `TELEGRAM_FALLBACK_ROLE === role`. The rollback note (plan line 1645) says "keep `TELEGRAM_CHAT_ID` as fallback until `managers` bound" — but that only works if `TELEGRAM_FALLBACK_ROLE=managers` is also set. Document both env vars in the RUNBOOK (Task 33), not just `TELEGRAM_CHAT_ID`.
- **R3 — Task 4 `__test_log` only accepts 5 fields.** The Task 4 test uses `internal.audit.internal.__test_log` with `{actor_id, action, entity_type, entity_id, source}` — matches the shipped signature (audit/internal.ts:88-95). Good, no change. But note `__test_log` does NOT accept `metadata`/`mgr_approver_id`, so the `_markDenied_internal` test (Task 8) must seed/assert via the real mutation, not `__test_log`. The Task 8 test does call the real `_markDenied_internal` — fine.
- **R4 — `InlineKeyboardButton` type widening (Task 18).** Adding `url?` and making `callback_data?` optional is correct, but the POC `renderApproval`/`renderCustom` (the ones being deleted) are the only `callback_data` producers. After deletion, every remaining renderer uses `url`. Consider dropping `callback_data` entirely from the type once the POC renderers are gone — but only after Task 31's playground cleanup confirms no caller remains.
- **R5 — Commit granularity vs the spec staffreview's 7 checkpoints.** The plan has ~34 per-task commits; the prior staffreview proposed 7 logical checkpoints. The fine-grained commits are fine for a feature branch (squash-on-merge), but the PR will be large. Consider noting squash intent in the eventual `gsd-ship`/PR.

## 5. Duplication Analysis

**Reuse is strong and correct:**
- `_onPaidManual_internal` (payments/internal.ts:249) reused verbatim by `approveManualPayment` — arg shape `{idempotencyKey, txnId, reason, mgr_approver_id}` matches exactly (self-review note confirms; verified against :250-255). ✅
- Token + constant-time compare pattern copied from `approveStaffPinReset` (actions.ts:146-180) into Tasks 21/22 — identical, correct (uses `node:crypto timingSafeEqual`, `sha256Hex`). ✅
- `withIdempotency` HOF reused for `_markDenied_internal`. ✅
- `useIdempotency`/`clearIntent`/`mapError` reused for the `/approve` manual_payment variant (Task 28). ✅
- `NumericKeypad` reused for manager-PIN entry (Task 28). ✅
- Starter lib (`chunking/constantTimeEqual/cronRetry/dateAnchors`) + registry ported. ✅

**Residual duplication risks (the plan mostly handles, verify):**
- **Two `escapeHtml`/`formatIdr`:** starter `lib/telegramHtml.ts` has its own `escapeHtml` + `sendTelegramHtml`; Frollie `lib/telegramHtml.ts` has `escapeHtml`+`formatIdr`. Task 18 step 3 says "reconcile to ONE `escapeHtml`/`formatIdr` (keep Frollie's)" — but the **starter's `chatRegistry.ts` imports `escapeHtml` from `../lib/telegramHtml`** (chatRegistry.ts:37). Since you're merging into Frollie's `lib/telegramHtml.ts`, the import resolves — just confirm Frollie's `escapeHtml` is behavior-equivalent (it is: both escape `&<>` only; Frollie's uses a lookup map, starter uses chained replace — same output). Also add `sendTelegramHtml` to Frollie's file (Task 18 says so). ✅ if executed.
- **`telegram_log` outbound vs `audit_log` send-failure** — see I6.
- **Two dedupe sources:** `telegram_log.by_update_id` (POC, retired) vs `telegramUpdates.by_update_id` (new). Task 14 switches to `telegramUpdates`; `telegram_log` keeps its index but is debug-only. Acceptable; note the dead index.

## 6. Phase / Wave Accuracy

| Wave | Mode | Correct? | Notes |
|------|------|----------|-------|
| W1 | SEQUENTIAL | ✅ | Schema must land before everything. Task 3 composes `settingsTables` into root schema — Task 2's `telegramTables` and Task 1's `approvalsTables` edits are in separate files, so W1's internal tasks (1,2,3,4) touch disjoint files **except** all bump `convex/schema.ts` indirectly via codegen. Run sequentially as planned. |
| W2a | PARALLEL after W1 | ⚠️ | Tasks 6→7→8→9 are NOT fully parallel: Task 7 imports `kinds.ts` (Task 6); Task 8 + Task 9 both modify `convex/approvals/internal.ts`/`public.ts` and depend on Task 6/7. Within W2a, 6→7→8/9 is sequential; 8 and 9 can parallelize (different files). The "PARALLEL after W1" header is about W2a-vs-W2b-vs-W2c, which is correct. Intra-wave ordering should be called out. Task 10 (regression) must run last in W2a. |
| W2b | PARALLEL after W1 | ⚠️ | **Dependency error in the plan's own note:** Task 12 (chatRegistry) "Depends on: Task 15 (config)" — correct, config must exist for the role-validation import. But Task 12 is listed BEFORE Task 15 in the document. Reorder: 11 → 15 (config) → 12 → 13 → 14 → 16 → 17 → 18. The plan acknowledges "do Task 15 first or stub" (line 790) — make it hard ordering. Also Task 16 (mgrAdmin) depends on Task 12's exported `…Impl` (see C2). |
| W2c | PARALLEL after W1 | ✅ | Independent. Task 19 depends on Task 3 (schema). Fine. |
| W3 | SEQUENTIAL after 2a+2b(+2c) | ✅ | Task 20→21→22 share `actions.ts`, sequential correct. Task 23→24→25 (founders) depend on W2c (settings, Task 19), W2b (dateAnchors Task 11, role resolution Task 18). Task 24 depends on Task 23 (`_dailySalesSummary_internal`) + Task 19 (`_getSettings_internal`) + Task 18 (`sendTemplate` role routing). Correct. |
| W4 | PARALLEL after W3 contracts | ✅ | Task 26→27→28/29/30. 26 (hook) → 27 (component uses hook) → 29 (charge uses component). 28, 30 independent. Reasonable. |
| W5 | SEQUENTIAL | ✅ | Docs/ADRs/hardening last. |

**Net:** wave-level parallelism is correct; **intra-wave ordering in W2b is mis-sequenced** (Task 15 must precede Task 12) and **W2a intra-ordering** (6→7 before 8/9) should be explicit. Neither breaks correctness if a single agent executes top-to-bottom, but a parallel dispatch would hit the Task 12←15 dependency.

## 7. Specialist Agent Recommendations

(Only agents that exist in the roster.)

| Wave / Task | Agent | Rationale |
|-------------|-------|-----------|
| W1, W2a, W2c, W3 backend (Tasks 1-10, 19-25) | `convex-expert` | schema generalization, kind-registry, funnel reuse, cron resilience, the C1/C3 idempotency+audit fixes |
| W2b port (Tasks 11-18) | `convex-expert` | the C2 `…Impl` export+signature normalization and the webhook/registry port need Convex-runtime fluency |
| W4 hooks + charge wiring (Tasks 26, 29) | `frontend-integrator` | reactive `useApproval`, charge-screen inline approval state, idempotency plumbing |
| W4 UI surfaces (Tasks 27, 28, 30) | `ui-component-builder` | `ApprovalPending`, `/approve` variant, `mgr/telegram-chats` admin |
| Pre-merge (after W4) | `code-reviewer` | review the graduated approval + webhook rewrite + the C1-C3 fixes before PR |
| If date-math (I3 `computeWibDay`) proves fiddly | `general-purpose` | isolated WIB day-window helper + boundary tests |

## 8. Git Workflow

- **Branch:** `feat/v0.4-telegram-approval`, created in W1 (line 56). ✅ matches `feat/v0.x-*` convention.
- **Commits:** per-task conventional-commit messages, scoped (`feat(approvals)`, `feat(telegram)`, `docs(...)`). ✅ Good hygiene. ~34 commits — fine for a squash-merge PR.
- **No destructive ops.** `git rm src/routes/approve/pin.tsx` (Task 28) is the only deletion — safe (unused Stub, confirmed it's not the active `/approve` page which is `index.tsx`).
- **Codegen discipline:** the plan correctly inserts `npx convex codegen` after every new union literal / new exported function (Tasks 1,2,4,6→ implied,16,19,24) per starter LESSON 5. ✅
- **Pre-merge verification** (lines 1636-1640): typecheck/build/vitest/codegen-clean/manual-E2E. The "288 existing tests" baseline should be re-counted at execution (it's an estimate). The note about the `wa_approval`→`telegram_approval` assertion change (line 1638) is where **C3** bites — that line is wrong about it being "the one intentional change with its assertion updated in Task 21"; see C3.
- **Recommendation:** add a step to run `npx vitest run convex/approvals convex/payments` specifically after Task 21 (the highest-coupling change), before proceeding to W4.

## 9. Documentation Checkpoints

The plan's W5 (Tasks 32-34) covers: ADR-037 (new) + amend ADR-030/035; CLAUDE.md/RUNBOOK/CHANGELOG/API_REFERENCE; PROGRESS.md retrofit + `build-progress-html.mjs`. Coverage matches the prior staffreview §9. Specific checks:
- **SCHEMA.md (Task 5, W1):** must document new audit *actions* too, not just tables — `approval.denied`, `telegram.send_failed`, `founders.summary_skipped`, `settings.founders_summary_toggled`. The plan's Task 5 lists fields/states/source but not the new action strings. Add them (the prior staffreview §9 W3 row flagged this).
- **CLAUDE.md business rule (Task 33):** add the `APPROVAL_KINDS` registry as the canonical "add-a-kind" mechanism and update "How to add a feature" #8 to point at `kinds.ts`. Plan says so (line 1621). ✅
- **CLAUDE.md File locations:** add `convex/settings/`, `convex/crons.ts`, the new `convex/telegram/*` files, `src/hooks/useApproval.ts`, `src/components/pos/ApprovalPending.tsx`, `src/routes/mgr/telegram-chats.tsx`. Plan covers (line 1621). ✅
- **MEMORY note:** `convex-telegram-bot-starter` is the canonical source (user MEMORY); the RUNBOOK should reference it for future ports. Minor.
- **Missing:** no doc checkpoint for the **two env vars** (`TELEGRAM_FALLBACK_ROLE` + `TELEGRAM_CHAT_ID`) the migration shim needs (R2). Add to RUNBOOK Task 33.

## 10. Testing Plan Assessment

**Verdict: ADEQUATE** (with required additions tied to the Critical/Improvement findings).

The plan is genuinely TDD-shaped: every backend task writes a failing test first, names the exact failure, then implements. Coverage spans: schema acceptance (Tasks 1,2,4), context validation incl. integer-rupiah rejection (Task 6 — `amount_idr: 1.5` → throws, good ADR-015 coverage), lifecycle deny/dedup/link (Task 8), per-kind `getByToken` (Task 9), regression (Task 10), role-routing + malformed-payload + replay (Task 18), settings default-ON + manager-gate (Task 19), request/approve/deny happy paths + wrong-PIN failed-attempt (Tasks 20-22), founders skip-on-disabled + no-retry-on-unbound (Task 24), hook/component/route (Tasks 26-30). The starter's own ported tests (Tasks 11-14) carry the security surface (constant-time secret, always-200-after-dedupe, command matcher).

**Test gaps that MUST be added (each tied to a finding):**
1. **C1 verification:** a test that proves a same-key *replay* of `requestManualPaymentApproval` returns the cached `requestId` and does NOT re-send Telegram (mock `sendTemplate`, assert called once across two action invocations). The plan's Task 20 test only checks one call — it would pass even with the broken `_recordResponse_internal` because `_lookup_internal` always misses. This test is what catches C1.
2. **C3 verification:** assert the `approval.resolved` audit `source` for BOTH the pin-reset path and the manual-payment path explicitly, so the shared-funnel coupling is visible and the chosen behavior (per C3 fix) is locked.
3. **I5 / C4 interaction:** a test where the txn is `cancelled` before `approveManualPayment` → `_onPaidManual_internal` throws `RECEIPT_UNCONFIRMED` → request stays `pending` (NOT resolved). The plan's edge-case list (prior staffreview §11) mentions the webhook-wins case but not the cancelled-txn case.
4. **Two-manager race:** the prior staffreview flagged it; the plan's Task 21/22 rely on `_markResolved_/_markDenied_`'s `status !== "pending"` guard. Add an explicit test: two concurrent `approveManualPayment` with DIFFERENT idempotency keys → second throws `REQUEST_RESOLVED`, txn paid exactly once (one receipt).
5. **`computeWibDay` boundary (I3):** if written net-new, needs a unit test at the 17:00-UTC WIB-day boundary (the `pos_receipt_counters` trap).

**Test smells in the plan (minor):**
- Task 26's `useApproval` test is a stub (`renderHook(() => undefined)` with a TODO comment) — flesh it out or it's not a real test.
- Task 20's test seeds "reuse payments test seed helpers for the txn" without confirming those helpers exist/are importable across module test dirs. Verify at execution.

## 11. Edge Cases

Covered by the plan / prior staffreview, verified against code:
- ✅ Webhook confirms txn before manager approves → C4 guard (`_onPaidManual_internal` :279) returns existing receipt; request resolves. (Add the *cancelled*-before-approve case — see Testing #3.)
- ✅ Token expiry mid-PIN-entry → `TOKEN_EXPIRED` (Tasks 21/22 check `token_expires_at <= now`).
- ✅ Two managers, same link → `_markResolved_`/`_markDenied_` `status !== pending` guard (internal.ts:133 pattern). Add explicit test (Testing #4).
- ✅ Founders role unbound → `getChatIdByRole` throws (chatRegistry.ts:121), `isTransientError` returns false (cronRetry.ts:50-55, only matches "no available workers") → audited skip, NO retry storm. **Verified correct.**
- ✅ `pos_settings` absent → read-time default ON (settings/public.ts + internal.ts both `?? true`).
- ⚠️ **Locked-out manager approving manual_payment off-booth:** the shipped pin-reset path intentionally does NOT consult lockout for the approving manager (actions.ts:170-180 comment). Task 21 copies that pattern but the plan doesn't restate the intent for manual_payment. Confirm this is desired (it should be — same authority model: token VIEW + correct PIN = ACT, ADR-029). Document it in the Task 21 header comment as the pin-reset path does.
- ⚠️ **Cart edited after request minted (superseded txn):** dedup is `(kind, entity_id)` on `txnId`. If a cart edit creates a NEW txn id, the old request points at a stale txn; `_onPaidManual_internal`'s C4 guard catches it (cancelled/expired old txn → throws). But the manager sees a stale amount in the Telegram message. Acceptable for v0.4 (manager can deny), but note it. The prior staffreview §11 lists this; the plan doesn't explicitly handle the amount-staleness, only the C4 funnel guard.
- ❓ **`requestManualPaymentApproval` requires `txn.status === "awaiting_payment"`** (plan line 1153) — but a txn in `draft` (no invoice yet) can't be manually approved. Confirm the charge screen (Task 29) only surfaces the "Request manager approval" affordance once the txn is `awaiting_payment`, else the action throws `TXN_NOT_AWAITING` and the UI must map it (Task 28 adds `TXN_NOT_AWAITING` to `mapError` — but that's the `/approve` page, not the charge page; add it to charge's error handling too).

## 12. Approval Conditions

**Verdict: REVISE.** Fold in before execution:

**Must-fix (Critical):**
1. **C1** — replace `_recordResponse_internal` with `_writeCache_internal({ key, mutationName, response })` in Tasks 20, 21, 22.
2. **C2** — when porting `chatRegistry.ts` (Task 12): `export` the four `…Impl` cores AND normalize their signatures to object-args (or fix Task 16's call sites to match the actual `(ctx, includeArchived)` / `(ctx, chatId: string)` shapes). Pass `includeArchived: false` from `mgrListChats`.
3. **C3** — do not ship the half-`telegram_approval` change. Either keep `_markResolved_internal` on `wa_approval` for both kinds, or parameterize `source` per call site; add explicit audit-source assertions for both paths.

**Should-fix before execution (Improvements):**
4. **I1** — back the requester/approver `name` via `_getStaffNameCode_internal`, not by widening `_resolveSession_internal`.
5. **I3** — treat `computeWibDay` as net-new code (check `convex/lib/time.ts` first) with a boundary test, not a trivial wrap.
6. **I4** — collapse the double idempotency caching in the approve/deny actions to one layer.
7. Reorder W2b so Task 15 (config) precedes Task 12 (chatRegistry); make W2a's 6→7→8/9 ordering explicit.

**Add to the testing plan:** the 5 tests in §10 (replay-no-resend, dual-path audit source, cancelled-before-approve, two-manager race, WIB boundary).

Once C1-C3 and the W2b reordering land, this plan is execution-ready. The architecture, reuse, and rollback story are sound; the defects are mechanical naming/signature drift against shipped code, all fixable in-task.

---

*Generated by /staffreview — two-persona (Staff Developer + Principal Developer)*
