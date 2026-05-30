# Engineering-Manager Plan Review — Frollie POS v0.4 (Telegram Approval Graduation)

**Date:** 2026-05-29
**Plan:** `docs/superpowers/plans/2026-05-29-v0.4-telegram-approval.md`
**Spec:** `docs/superpowers/specs/2026-05-29-v0.4-telegram-approval-design.md`
**Prior review absorbed:** `docs/reviews/staffreview-v0.4-telegram-approval-design-2026-05-29.md`
**Reviewer mode:** gstack `/plan-eng-review` (SKILL.md loaded and applied). Run **non-interactively / batch** per invocation: the skill is normally interactive (one AskUserQuestion per finding); here every finding is written to this report and, where the skill would prompt, a reasonable assumption is stated inline and the review continues. No source code was modified (read-only review).

---

## Verdict

**SHIP AS SCOPED — with mandatory pre-execution corrections (CONDITIONAL GO). Confidence: HIGH (8/10).**

This is a strong, unusually well-grounded plan. It reads the *shipped* v0.3 reality correctly (lean `staff_pin_reset` row, token-on-row, `_onPaidManual_internal` funnel), picks the one end-to-end-testable kind to graduate (`manual_payment_override`), keeps all schema additive (clean per-wave revert), and faithfully absorbs the five staffreview improvements (additive `source`, no `audit_log_id`, best-effort message link ordering, `requireManagerSession` over `ADMIN_KEY`, retire the POC callback demo). The wave DAG is essentially correct.

It is **not** shippable exactly as written: there are **3 concrete plan errors against the real codebase** (a wrong internal-function name+signature, a wrong field name used in two tasks, and a mislabeled audit `source` on the money path) plus several porting-task signature mismatches the plan waves off as "verify at execution." None require re-architecture. All are local fixes. They are the difference between "execution flows" and "execution stalls mid-wave on a typecheck/test failure with an unobvious cause." Fix the P1 items below before W3 and this ships.

~34 tasks is **at the top end** of one phase but defensible: ~20 are verbatim ports or doc tasks (low cognitive load), the additive-schema-everywhere discipline makes any wave revertible, and the TDD-per-task structure gives natural checkpoints. I would not split it, but I would de-risk the two riskiest tasks first (see sequencing).

---

## Risk Register (prioritized)

| # | Risk | Likelihood | Impact | Severity | Mitigation |
|---|------|-----------|--------|----------|------------|
| R1 | **`_recordResponse_internal` does not exist.** Plan calls `internal.idempotency.internal._recordResponse_internal({ key, response })` in Tasks 20/21/22. Real fn is `_writeCache_internal({ key, mutationName, response })` (`idempotency/internal.ts:113`). Wrong name AND missing required `mutationName` arg. | Certain | Typecheck fails / action-level idempotency cache silently not written | **P1** | Replace all 3 call sites with `_writeCache_internal`, pass a `mutationName` label (e.g. `"approvals.requestManualPaymentApproval"`). Fix the self-review note that miscites ":105". |
| R2 | **Off-booth payment confirm is audited as `booth_inline`, not `telegram_approval`.** `_onPaidManual_internal → _confirmPaid_internal` hardcodes `source: args.source === "manual" ? "booth_inline" : "system"` (`transactions/internal.ts:276`). The code comment at :273-275 explicitly says v0.4 must thread the real source. The plan threads `telegram_approval` only onto `_markResolved_internal`, never into the payment funnel. | Certain | The `payment.confirmed` audit row for every off-booth approval is mislabeled as a booth action — defeats the whole point of the additive source literal for the money path | **P1** | Add an optional `source` arg to `_onPaidManual_internal` + `_confirmPaid_internal`, thread `telegram_approval` from `approveManualPayment`. This is a transactions/payments module change the plan does not list under "Modify" — add it to W3 Task 21 scope. |
| R3 | **Wrong field name `total_idr`.** `pos_transactions` has `total` (`transactions/schema.ts:21`), not `total_idr`. Task 20 builds context `{ amount_idr: txn.total_idr }` and `_getTxnSummary_internal → { total_idr }`; Task 23 aggregate uses `x.total_idr`. Task 23 is flagged "verify field names"; Task 20 is **not** flagged. | Certain | Typecheck fails or (worse, if typed loosely) `amount_idr` is `undefined` → Telegram card shows "Rp NaN", founders summary shows wrong total | **P1** | Use `txn.total` everywhere; have `_getTxnSummary_internal` return `{ status, total }`. Remove the false-confidence "verify at execution" framing — this is a known-wrong reference, not an unknown. |
| R4 | **Starter `…Impl` cores are NOT exported and have different signatures than Task 16 assumes.** In the starter `chatRegistry.ts`, `listChatsImpl(ctx, includeArchived)`, `assignRoleImpl(ctx, {...})`, `archiveChatImpl(ctx, chatId)`, `restoreChatImpl(ctx, chatId)` are module-private; `archive/restore` take a **positional string**, and `listChatsImpl` **requires `includeArchived: boolean`**. Task 16 imports them as named exports and calls `archiveChatImpl(ctx, { chatId })` (object) and `listChatsImpl(ctx)` (no 2nd arg). | High | W2b stalls: typecheck failures on the manager-admin twins; the agent must reverse-engineer the starter signatures mid-wave | **P2** | In Task 12, when porting `chatRegistry.ts`: `export` the four `…Impl` functions AND normalize their signatures (object args, `listChatsImpl(ctx, includeArchived = false)`). Spell this out — the plan's "export them if not" note misses the signature delta entirely. |
| R5 | **Intra-wave ordering trap in W2b: `chatRegistry.ts` (Task 12) imports `sendTelegramHtml` + `escapeHtml` from `lib/telegramHtml`, but `sendTelegramHtml` is only added in Task 18.** The starter `chatRegistry.ts:37` does `import { sendTelegramHtml, escapeHtml } from "../lib/telegramHtml"`. Frollie's current `lib/telegramHtml.ts` has `escapeHtml` but NO `sendTelegramHtml`. | High | Task 12 typecheck fails because Task 18 hasn't run yet; W2b is presented as a loose task list, not an ordered chain | **P2** | Move `sendTelegramHtml` port (currently buried in Task 18) into Task 11 (the lib-ports task) so the registry compiles when ported. Or add an explicit W2b ordering note: 11 → (18-partial: add sendTelegramHtml) → 12 → 13 → 14/15/16/17. |
| R6 | **`lib/telegramHtml.ts` type reconciliation under-specified.** Frollie's `RenderedMessage.inline_keyboard` uses `InlineKeyboardButton = { text; callback_data: string }` (required `callback_data`, no `url`). Starter ships its own `telegramHtml.ts` with its own types + `sendTelegramHtml`. Plan says "reconcile to ONE escapeHtml/formatIdr (keep Frollie's)" and "add `url` to the button type" — but two files defining `RenderedMessage`/button types will collide. | Medium | A messy merge; URL-button approvals won't typecheck until `callback_data` is made optional and `url` added | **P2** | Task 18 must explicitly: (a) make `callback_data` optional, add `url?`, (b) decide one canonical `telegramHtml.ts` and delete the starter's duplicate types, (c) keep Frollie's `escapeHtml`/`formatIdr`. Already partially noted; promote to a checklist in-task. |
| R7 | **Webhook rewrite + POC retirement is bigger than "copy verbatim."** Task 14 replaces a 130-line POC `httpAction` (`callback_query` + `answerCallbackQuery` + `editMessageText` + `recordCallback`) with the starter's command-registry handler, AND retires the `/dev/telegram` playground's callback round-trip. The `setWebhook` path also changes (`/telegram/webhook` POC vs `/telegram-webhook` starter). | Medium | A working POC surface breaks; if the deployed `setWebhook` URL isn't re-pointed, ALL inbound Telegram (incl. `/register`) silently stops | **P2** | Keep as one task but add explicit sub-steps: confirm the deployed POC route path, re-point `setWebhook`, grep `src/routes/dev/telegram*` for callback refs, decide retire-vs-keep before deleting. RUNBOOK update (Task 33) must include the re-point. |
| R8 | **Founders aggregate is a full-table `.collect()` + JS filter** (Task 23 `_dailySalesSummary_internal`). No index on `(status, paid_at)`. | Low (dev volumes tiny) | Fine now; a latent O(n) scan that bites at v1.0 prod volume | **P3** | Acceptable for v0.4 (negligible rows). Add a TODO to use a `by_status_paid_at` index when prod data lands. Do NOT add the index speculatively now (boring-by-default; volumes don't justify it). |
| R9 | **Cron time (22:00 WIB / 15:00 UTC) is an unconfirmed assumption.** Flagged in-plan as "confirm with Lucas at execution," but Lucas is unreachable in batch mode. | Certain (the assumption stands) | Low — wrong send hour, trivially re-tunable; not a correctness bug | **P3** | **Batch-mode assumption: keep 15:00 UTC as planned.** It is a one-line `crons.ts` change to re-tune post-confirmation. Does not block. |
| R10 | **288 existing tests + foundational audit module touched (Task 4).** Additive `telegram_approval` literal touches `audit/schema.ts` + `audit/internal.ts` (sourceValidator + `logAudit` type + `__test_log`). | Low | If done as a rename instead of additive, breaks the `wa_approval` assertions across the suite | **P2 (mitigated)** | The plan correctly makes it **additive** (staffreview Improvement #1). Verified: real union is `booth_inline\|wa_approval\|system\|reaper` (`audit/internal.ts:6`). Keep additive. Also update the `changePinSourceValidator` in `auth/internal.ts:304` if any pin-reset path is re-pointed to `telegram_approval` — currently it only allows `wa_approval`; **the plan does NOT mention this and `approveStaffPinReset` still passes `source: "wa_approval"` (`approvals/actions.ts:192`), so it stays valid. No change needed for pin-reset, but if a future task re-points it, the auth validator must widen too.** |

---

## Critical-Path & Sequencing Assessment

The wave DAG is correct:

```
            ┌─────────────────────────────────────────────┐
   W1 ──────┤  schema foundation (SEQUENTIAL, lands first) │
 (T1-5)     └─────────────────────────────────────────────┘
                 │            │             │
       ┌─────────┘            │             └──────────┐
       ▼                      ▼                        ▼
   W2a (T6-10)            W2b (T11-18)             W2c (T19)
   approval framework     telegram self-reg         settings
   [touches approvals/]    [touches telegram/+lib/]  [touches settings/]
       │                      │                        │
       └──────────┬───────────┘                        │
                  ▼                                     │
            W3 (T20-25)  manual_payment + founders cron◄┘ (founders needs 2c)
                  │
                  ▼
            W4 (T26-30)  frontend (needs W3 contracts)
                  │
                  ▼
            W5 (T31-34)  hardening finalize + docs/ADRs
```

**Is the W2a / W2b / W2c parallel split safe?** Mostly yes, with two caveats:

- **Shared `convex/schema.ts`:** All of W1 writes it (additively), but W2a/b/c only *read* generated types — they don't re-edit `schema.ts`. W1 is sequential and lands first, so no collision. **Safe.**
- **Shared `convex/lib/telegramHtml.ts`:** W2b (Task 18) heavily rewrites it; W3 (Task 23) adds `renderFoundersSummary` to the same file. These are different waves (W2b before W3), so no parallel collision. **Safe**, but see R5/R6 for the *intra-W2b* ordering trap.
- **`convex/audit/*` (Task 4, W1) vs everything that calls `logAudit`:** additive only; W1 lands first. **Safe.**

**Where execution can STALL mid-flight:**
1. **W2b, Task 12** — the `sendTelegramHtml` import (R5) and the `…Impl` export/signature mismatch (R4). This is the single most likely stall point. The agent copies `chatRegistry.ts` "verbatim," it doesn't compile, and the fix is non-obvious (two separate issues compounding).
2. **W3, Task 20/21** — the `_recordResponse_internal` ghost function (R1) and `total_idr` (R3) surface as typecheck failures. Task 21 also silently mis-audits the source (R2) — that one does NOT fail typecheck, so it ships wrong unless caught in review.
3. **W3, Task 23** — founders aggregate against unverified field names; the plan's own example uses the wrong `total_idr`.

**Riskiest task — de-risk first:** **Task 12 (port `chatRegistry.ts`)**. It is the keystone of W2b: webhook (14), http wiring (17), mgrAdmin (16), and the founders role lookup (W3) all depend on its exports. Its "verbatim copy" framing hides the most signature drift. **Recommendation: do a 20-minute spike on Task 12 first** — port the file, get it to typecheck against Frollie's generated server types and `lib/`, settle the `…Impl` export/signature shape, THEN parallelize the rest of W2b. Everything downstream inherits its contract.

**Second-riskiest:** **Task 14 (webhook rewrite + POC retirement + setWebhook re-point)** — see R7. It's the one task that can silently take down ALL inbound Telegram in the dev deployment if the route path / `setWebhook` step is missed.

---

## Scope & Effort Realism

**~34 tasks in one phase: at the ceiling, but coherent. Do not split.**

Breakdown of cognitive load (this matters more than raw count):
- **Verbatim/near-verbatim ports (low risk once R4/R5 fixed):** T2, T11, T12, T13, T14, T15 — 6 tasks.
- **Doc/ADR/progress (mechanical):** T5, T32, T33, T34 — 4 tasks.
- **Genuinely new logic (where bugs live):** T6-9 (registry + generalization), T16 (mgrAdmin), T18 (send hardening), T19 (settings), T20-24 (manual_payment + founders), T26-30 (frontend) — the real ~18 tasks.

The "boil the lake" completeness instinct is well-served: TDD-per-task, full edge-case coverage in the spec's testing strategy (happy/deny/expired/wrong-PIN/superseded/idempotent-replay/concurrent), regression-guard on `staff_pin_reset`. This is the *complete* version, not a shortcut — correct call given AI makes completeness cheap.

**Tasks secretly bigger than they look:**
- **Task 14** (webhook rewrite) — "copy verbatim" undersells the POC retirement + setWebhook re-point (R7).
- **Task 18** (send.ts hardening) — discriminated union payloads + idempotency + audited failures + URL-button render + type reconciliation (R6) is the densest single task in the plan. It's really 4 sub-changes.
- **Task 21** (approveManualPayment) — the source-threading gap (R2) means it also touches `payments/` + `transactions/`, which the plan's "Modify" list omits.
- **Task 12** (chatRegistry) — see R4 (keystone, hidden signature drift).

**Conway's-law note:** this is solo/agent-driven, not a multi-team split. The "specialist agent" assignment in the staffreview (convex-expert / frontend-integrator / ui-component-builder) is fine as a labeling convention but doesn't change the critical path. The DAG, not the org chart, governs.

---

## Top Execution Hazards (stack-specific)

1. **Convex codegen ordering.** The plan correctly flags LESSON 5 (`npx convex codegen` after new exported functions before `internal.*`/`api.*` refs resolve) at T1/T2/T4/T8/T16/T19/T24. This is handled well. The remaining trap: within a single parallel wave, if two tasks both add functions and only one runs codegen, the other's `internal.*` ref is stale. **Run codegen after each function-adding commit, not once per wave.**
2. **Ghost internal function (R1)** — `_recordResponse_internal` is the single highest-confidence plan error. It will fail typecheck in 3 places.
3. **Hardcoded-source money-path audit (R2)** — the only hazard that does NOT fail typecheck and will ship silently wrong. This is exactly the class the "see something say something" instinct exists for.
4. **`withIdempotency` key namespacing** — verified the plan's `${args.idempotencyKey}:onpaid` / `:resolve` / `:deny` / `:failed` / `:send` suffixing is correct: the cache key is the runtime `idempotencyKey` arg, NOT the hardcoded `mutationName` label (`idempotency/internal.ts:66-82`). So `_onPaidManual_internal` (label `"payments.manuallyConfirmPayment"`) and `_markResolved_internal` (label `"approvals.approveStaffPinReset"`) sharing labels across kinds is **fine** — labels are debug metadata, keys are what dedupe. Good. **No collision risk here.**
5. **Port "verify-at-execution" gaps** — the plan lists 4 (txn field names, idempotency helper name, `_resolveSession_internal` returning `name`, `…Impl` exports). Three of these are actually *known-wrong* against the codebase (R1, R3, R4), not unknowns — the "verify at execution" framing launders concrete errors into vibes. Verified: `_resolveSession_internal` returns `{ staffId, deviceId }` with **no `name`** (`auth/internal.ts:284`), so Task 20 DOES need to extend it (the plan flags this one correctly).
6. **No prod deployment yet** — manual dev-E2E is the only integration gate. Acceptable for v0.4 (dev-only, additive schema, clean revert). Prod cutover is correctly deferred to v1.0.

---

## Verification-Gate Adequacy

**Adequate, with one gap.**

Present and good:
- TDD red→green per task (every backend task writes the failing test first).
- Pre-merge gate: `typecheck` + `build` + `vitest run` (288 + new) + `convex codegen` no-diff + manual dev-E2E covering register → role-assign → booth-request → Telegram-link → PIN → paid → deny → founders-cron-test-send → opt-out-skip. This is a genuine end-to-end gate.
- Regression guard: Task 10 explicitly re-runs `convex/approvals` to prove `staff_pin_reset` survives generalization.
- The staffreview's 5 "must add" tests (additive-source non-breaking, best-effort-link-doesn't-fail-request, unbound-founders-role-no-retry-storm, settings-default-ON, webhook-secret-constant-time) are all folded into task tests.

**Gap:** there is **no test asserting the off-booth `payment.confirmed` audit row carries the correct `source`** (R2). Because R2 doesn't fail typecheck, only a targeted assertion catches it. **Add to Task 21:** after `approveManualPayment`, assert the `payment.confirmed` audit row has `source: "telegram_approval"` (will currently be `booth_inline` → fails → forces the R2 fix). This is the single most valuable test to add.

**Second gap:** Task 25 (cron registration) has "no unit test — validated by deploy." Fine, but the manual-E2E test-send (`npx convex run telegram/foundersSummary:sendFoundersSummary`) exercises the action, not the cron *registration*. Acceptable — cron schema is validated at `convex deploy`.

---

## What Already Exists (reuse audit)

The plan reuses well and rebuilds nothing it shouldn't:

| Existing | Location | Plan reuses correctly? |
|----------|----------|------------------------|
| `_onPaidManual_internal` funnel | `payments/internal.ts:249` | ✅ Yes (verbatim, takes `mgr_approver_id` directly) — but must thread `source` (R2) |
| Approval lifecycle internals | `approvals/internal.ts` | ✅ Generalizes args, doesn't rewrite |
| `requireManagerSession` | `auth/sessions.ts:24` | ✅ Returns `{ staffId, deviceId }` — matches `mgrAdmin`/`settings` usage exactly |
| `withIdempotency` HOF + `_lookup_internal` | `idempotency/internal.ts` | ✅ Action-level pattern reused; key suffixing correct |
| `_getByCode_internal`, `_recordFailedAttempt_internal`, `_changePinCommit_internal` | `auth/internal.ts` | ✅ Signatures match Task 21/22 usage |
| `NumericKeypad` / `PinSheet`, `useIdempotency`/`clearIntent` | `src/components/pos/`, `src/hooks/` | ✅ Reused for `/approve` manual_payment variant |
| Starter registry + lib + webhook | `convex-telegram-bot-starter` | ✅ Ported ~verbatim — but `…Impl` export/signature drift (R4) + `sendTelegramHtml` ordering (R5) not fully accounted for |
| `_recordResponse_internal` | — | ❌ **Does not exist** (R1) — real fn is `_writeCache_internal` |

---

## NOT in Scope (deferred — confirmed reasonable)

- Refund / void / discount / stock / spoilage / settings approval **kinds** → v0.5+. Correct: no booth-side action exists yet, so an approval would approve nothing. The kind-registry scaffold is the whole point.
- `/mgr/home` mobile manager dashboard → v0.5. Correct — only the Telegram-chats admin route is needed for v0.4.
- Full `pos_settings` module → v0.5 (v0.4 ships a one-field singleton). Correct — boring-by-default, extend later.
- Production Telegram cutover (prod bot/group/env on `savory-zebra-800`, prod `setWebhook`) → v1.0. Correct.
- Single-name `source` consolidation (`wa_approval` → `telegram_approval` everywhere) → v1.0 migration, not an in-flight rename. Correct (staffreview Improvement #1).
- `(status, paid_at)` index for the founders aggregate → deferred to prod volumes (R8). Correct — don't add speculatively.

---

## Failure-Mode Table (new codepaths)

| Codepath | Realistic prod failure | Test? | Error handling? | User sees? | Critical gap? |
|----------|------------------------|-------|-----------------|-----------|---------------|
| `requestManualPaymentApproval` send | Telegram 5xx after request row created | ✅ (delete-on-fail recovery, mirrors `notifyStaffLockout`) | ✅ `_deleteRequest_internal` + rethrow | Charge screen error toast | No |
| `_linkTelegramMessage_internal` | Link patch throws after notify | ✅ (best-effort test) | ✅ try/catch swallow | Nothing (notification already sent) | No |
| `approveManualPayment` audit source | Audited as `booth_inline` not `telegram_approval` | ❌ **no test** | N/A (silent) | Nothing visible; wrong audit trail | **YES (R2)** — no test AND silent AND wrong |
| Founders cron, unbound role | `getChatIdByRole` throws (non-transient) | ✅ (no-retry-storm test) | ✅ audited skip, single attempt | Nothing (founders just don't get a summary) | No |
| Founders cron, transient overload | "no available workers" at runQuery | ✅ (resilient-retry test) | ✅ 60s/120s backoff ≤3 | Nothing (self-heals) | No |
| Webhook after rewrite | `setWebhook` not re-pointed → all inbound Telegram dies | ⚠️ manual-E2E only | N/A (config) | `/register` silently does nothing | Medium (R7) — ops gap, not code |
| `getRequestStatus` reactive | Token expires mid-PIN-entry | ✅ (expired-token test) | ✅ `TOKEN_EXPIRED` | "Request expired, try again" | No |

**One critical gap: R2** (off-booth `payment.confirmed` source) — no test, silent, ships wrong. The added Task-21 assertion closes it.

---

## "If I Were Running This, I'd Change X"

1. **Fix R1/R2/R3 before W3 starts — these are not "verify at execution," they are known-wrong.** Re-label the plan's "known verify-at-execution gaps" honestly: `_recordResponse_internal` (wrong name), `total_idr` (wrong field), and the source-threading gap are *defects*, not unknowns. Patch the plan text now so the executing agent doesn't burn a cycle rediscovering them.
2. **Spike Task 12 (`chatRegistry.ts` port) first, before parallelizing W2b.** Settle the `…Impl` export + signature shape and the `sendTelegramHtml` import ordering (R4/R5) as a 20-min de-risk. Everything in W2b inherits this contract.
3. **Add the R2 audit-source assertion to Task 21.** Single highest-value new test; it's the only thing that catches the silent money-path mislabel.
4. **Promote Task 21's scope to include `payments/internal.ts` + `transactions/internal.ts`** in the "Modify" list (source threading). The plan currently hides a cross-module change behind a single-line "update that literal" note.
5. **Reorder W2b explicitly: 11 (+sendTelegramHtml) → 12 → 13 → 14/15/16/17 → 18.** Present W2b as an ordered chain, not a flat list, because the imports chain.
6. **Keep the 22:00 WIB / 15:00 UTC cron as-is (batch-mode assumption).** One-line re-tune later; don't block on Lucas confirmation.
7. **Make Task 14 a checklist:** confirm deployed POC route path → re-point `setWebhook` (in RUNBOOK Task 33) → grep `src/routes/dev/telegram*` → retire callback demo. Don't let "ALL inbound Telegram" depend on a buried sub-note.
8. **Don't split the phase.** 34 tasks is at the ceiling but the additive-schema + TDD-per-task structure keeps it revertible and checkpointed. Splitting would add merge overhead for no risk reduction.

---

## Implementation Tasks (synthesized from findings)

- [ ] **T1 (P1, human: ~20min / CC: ~5min)** — approvals/transactions — Replace `_recordResponse_internal` with `_writeCache_internal` (add `mutationName`) in Tasks 20/21/22 actions.
  - Surfaced by: R1 — `idempotency/internal.ts:113` is `_writeCache_internal({ key, mutationName, response })`.
  - Files: `convex/approvals/actions.ts`, plan tasks 20/21/22.
  - Verify: `npm run typecheck`.
- [ ] **T2 (P1, human: ~30min / CC: ~10min)** — transactions/payments — Thread `source: "telegram_approval"` through `_onPaidManual_internal` + `_confirmPaid_internal` for the off-booth path; add audit-row assertion to Task 21.
  - Surfaced by: R2 — `transactions/internal.ts:276` hardcodes `booth_inline`; comment at :273-275 demands the fix.
  - Files: `convex/transactions/internal.ts`, `convex/payments/internal.ts`, `convex/approvals/actions.ts`, `convex/approvals/__tests__/manualPayment.test.ts`.
  - Verify: assert `payment.confirmed` audit row `source === "telegram_approval"`.
- [ ] **T3 (P1, human: ~15min / CC: ~5min)** — approvals/transactions — Use `txn.total` not `txn.total_idr` in Task 20 context + `_getTxnSummary_internal` + Task 23 aggregate.
  - Surfaced by: R3 — `transactions/schema.ts:21` field is `total`.
  - Files: plan tasks 20, 23; `convex/transactions/internal.ts`.
  - Verify: `npm run typecheck`; Telegram card shows real rupiah.
- [ ] **T4 (P2, human: ~30min / CC: ~10min)** — telegram — In Task 12, export + normalize `…Impl` signatures (object args; `listChatsImpl(ctx, includeArchived=false)`).
  - Surfaced by: R4 — starter `chatRegistry.ts` cores are private + positional-arg.
  - Files: `convex/telegram/chatRegistry.ts`, `convex/telegram/mgrAdmin.ts`.
  - Verify: `npm run typecheck`; mgrAdmin tests pass.
- [ ] **T5 (P2, human: ~10min / CC: ~3min)** — telegram/lib — Move `sendTelegramHtml` port into Task 11; reorder W2b as a chain.
  - Surfaced by: R5 — `chatRegistry.ts:37` imports `sendTelegramHtml` from `lib/telegramHtml`.
  - Files: `convex/lib/telegramHtml.ts`, plan W2b ordering.
  - Verify: Task 12 typechecks standalone.
- [ ] **T6 (P2, human: ~20min / CC: ~10min)** — lib — Reconcile `RenderedMessage`/`InlineKeyboardButton` to one canonical type (`callback_data?`, add `url?`); delete the starter's duplicate.
  - Surfaced by: R6 — Frollie's button type requires `callback_data`, no `url`.
  - Files: `convex/lib/telegramHtml.ts`.
  - Verify: URL-button approval renders + typechecks.
- [ ] **T7 (P2, human: ~20min / CC: ~10min)** — telegram/ops — Make Task 14 a checklist: confirm POC route path, re-point `setWebhook`, grep `dev/telegram*`, retire callback demo.
  - Surfaced by: R7 — webhook rewrite can silently kill all inbound Telegram.
  - Files: `convex/http.ts`, `convex/telegram/webhook.ts`, `docs/RUNBOOK-telegram.md`, `src/routes/dev/telegram*`.
  - Verify: manual-E2E `/register` round-trip on dev.
- [ ] **T8 (P3, human: ~10min / CC: ~3min)** — transactions — Add a TODO for a `(status, paid_at)` index on the founders aggregate at prod volume.
  - Surfaced by: R8.
  - Files: `TODOS.md` / `docs/PROGRESS.md`.
  - Verify: n/a (deferral).

---

## Completion Summary

- Step 0 — Scope Challenge: **scope accepted as-is** (34 tasks at ceiling, coherent, do not split; additive schema keeps it revertible).
- Architecture Review: **2 issues** (R2 source-threading touches undeclared modules; R7 webhook-rewrite blast radius).
- Code Quality Review: **3 issues** (R1 ghost function, R3 wrong field, R4 port-signature drift).
- Test Review: **1 critical gap** (R2 — no off-booth-source audit assertion); otherwise the spec's coverage is thorough.
- Performance Review: **1 issue** (R8 — full-table scan on founders aggregate, P3, acceptable at dev volume).
- NOT in scope: written.
- What already exists: written (strong reuse; one ghost-function false reuse).
- Failure modes: **1 critical gap flagged** (R2).
- Parallelization: 3 parallel lanes (W2a / W2b / W2c) after W1, then sequential W3 → W4 → W5. Safe given additive schema + sequenced lib edits; intra-W2b ordering needs the R5 fix.
- Batch-mode assumptions stated: cron at 15:00 UTC kept (R9); `_resolveSession_internal` extended for `name` (plan-flagged, confirmed needed).
- Outside voice: skipped (non-interactive batch mode; no Codex/subagent dispatch).
- Lake Score: plan chose the complete option throughout (TDD per task, full edge-case coverage, additive-safe). 8/8 on completeness.

**STATUS: DONE_WITH_CONCERNS** — plan is fundamentally sound and ships as scoped, conditional on the 3 P1 corrections (R1/R2/R3) landing before W3 and the 4 P2 porting/ops clarifications (R4/R5/R6/R7) folded into W2b/W3 task text.
