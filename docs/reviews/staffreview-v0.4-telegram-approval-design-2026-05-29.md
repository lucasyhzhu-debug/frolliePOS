# Staff Review: v0.4 — Telegram approval graduation + self-registration + founders share

**Date:** 2026-05-29
**Plan:** `docs/superpowers/specs/2026-05-29-v0.4-telegram-approval-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Sections auto-added — see §0 (it's a design spec; execution-plan sections were filled in)

---

## 0. Plan Structure Additions

The artifact is a *design spec*, not yet an executable plan. Three execution sections were missing and are supplied below (Step 0 mandate — fill, don't block):

- **Implementation Phases / Waves** — added in §6 with PARALLEL/SEQUENTIAL markings + dependencies.
- **Success Criteria** — added in §12.
- **Rollback / Deployment ordering** — added in §8.

The spec's own "Open questions / staffreview seeds" already pre-empted several findings; those are addressed by number below rather than re-raised.

## 1. Summary

**Overall Assessment:** **Revise** (minor — no major rework, no Critical blockers).

The design is sound and unusually well-grounded: it correctly reconciles the *shipped* v0.3 reality (lean staff-pin-reset row, token-on-row, URL-button approval, existing `_onPaidManual_internal` funnel) against the stale board, and it picks the one end-to-end-testable graduated kind. The kind-registry scaffold is the right shape. Five Improvements tighten it before planning — the highest-leverage being that the `source` "rename" actually touches a **closed union on the foundational append-only audit module** and would break shipped tests, so it should be **additive**, not a rename. Once §0's structural sections and the §3 Improvements are folded in, this is plan-ready.

## 2. Critical Issues (Must Fix)

**None.** No data-loss, security-hole, or correctness-failure issues in the design. (The structural gaps in §0 are auto-filled, not Critical; the testing strategy is Adequate — see §10.) The items in §3 are real and recommended before planning, but none block.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Make the audit `source` change **additive** (`telegram_approval` as a new literal), not a rename | H | L |
| 2 | Drop the `audit_log_id` column; satisfy ADR-030 linkage via `metadata.approval_request_id` + existing `by_entity` index | M | L |
| 3 | Specify the Telegram **message→request link ordering** (best-effort patch after `_markNotified_internal`) | M | L |
| 4 | Make explicit: reuse existing `requireManagerSession`, do NOT port the starter's `ADMIN_KEY` | M | L |
| 5 | Decide the webhook-rewrite callback regression (retire `/dev/telegram` callback demo vs keep a callback branch) | M | M |

### Improvement 1: `source` change must be additive, not a rename
`audit_log.source` is a **closed union** declared in three load-bearing places — `convex/audit/schema.ts:14-19`, the `sourceValidator` in `convex/audit/internal.ts:6-11`, and the `logAudit` TS arg type at `convex/audit/internal.ts:34` — plus `__test_log` at `:94`. It is currently `"booth_inline" | "wa_approval" | "system" | "reaper"`. The spec's §E #6 ("rename `wa_approval` → `telegram_approval` everywhere … safe, dev-only") understates the blast radius: a rename rewrites the meaning of every historical row and breaks every shipped test that asserts `source: "wa_approval"` (e.g. `approvals/internal.ts:146` `_markResolved_internal`, `approvals/actions.ts:192`, and their `__tests__`).

**Recommendation:** ADD `v.literal("telegram_approval")` to the union (schema + validator + type), use it for all NEW off-booth approvals going forward, and leave `wa_approval` in the union for historical rows. This is additive and non-breaking. Update ADR-030's source-enum list to include both. If a clean single-name is wanted, that's a v1.0-cutover migration, not a v0.4 in-flight rename.

### Improvement 2: `audit_log_id` back-ref vs `logAudit` returning void
§A.1 and §E #3 add `pos_approval_requests.audit_log_id: v.id("audit_log")` for the ADR-030 back-ref. But `logAudit` returns `Promise<void>` (`convex/audit/internal.ts:38`) — it does not surface the inserted row id — so the approval row cannot capture it without changing the foundational append-only helper's signature.

**Recommendation:** Don't touch `logAudit`. ADR-030's "linked back" is already satisfiable two ways the shipped code supports: (a) **approval → audit** via the `by_entity` index (`entity_type` + `entity_id`) — exactly why §A.1 adds `entity_type`/`entity_id`; (b) **audit → approval** via `metadata.approval_request_id` (ADR-030 already specifies `metadata: { approval_request_id, … }`, and `logAudit` accepts a `metadata` object — `:36/:50`). Drop the `audit_log_id` column from the generalized schema. *(Alternative if a hard FK is truly wanted: change `logAudit` to return `Id<"audit_log">` — additive, but it edits the one function ADR-007 says owns all audit writes; prefer the metadata path.)*

### Improvement 3: Telegram message→request link ordering
`sendTemplate` returns `{ message_id }` (`convex/telegram/send.ts:90`) but writes it into a *separate* `telegram_log` row via `logOutbound` (`:78`), decoupled from any approval request. §E #3 wants `telegram_message_id` on the request row. The action that creates the request (`requestManualPaymentApproval`, and the existing `notifyStaffLockout`) must thread the returned `message_id` back onto the row.

**Recommendation:** Add `_linkTelegramMessage_internal(requestId, message_id, chat_id)` and call it AFTER `_markNotified_internal` succeeds. Make it best-effort (a failed link patch must not fail the approval — the notification already went out). Specify this ordering in §B.2 so the planner doesn't put the link before the send.

### Improvement 4: Reuse `requireManagerSession` (don't port ADMIN_KEY)
Confirmed present at `convex/auth/sessions.ts:24` and already used by `staff/public.ts:32`, `staff/internal.ts:28`, `audit/public.ts:14`. The starter's `requireAdminKey`/`ADMIN_KEY` shim exists *only because the starter has no user system* (its LESSON 14 explicitly says replace it when embedding). The spec §C.2 says this, but make it a hard instruction in the plan: the `mgr*` registry-admin twins call `requireManagerSession(ctx, sessionId)`; `ADMIN_KEY` is never introduced to this repo.

### Improvement 5: Webhook-rewrite callback regression
Replacing the POC `telegramWebhook` (which handles `callback_query` + `answerCallbackQuery` + `editMessageText`, `convex/telegram/webhook.ts`) with the starter's message-command registry (`/register`, `/start`) changes what update types are handled. The `/dev/telegram` playground's "custom template + buttons" demo relies on `callback_query` handling. Seed #5 flags this; elevate it to an explicit pre-plan decision so a working POC surface isn't silently broken.

**Recommendation:** Retire the `/dev/telegram` callback demo as part of the graduation (it was POC scaffolding) OR keep a thin `callback_query` branch in the rewritten webhook for the answerCallbackQuery UX. Recommended: retire — real approvals use URL buttons, so callback handling has no production consumer.

## 4. Refinements (Optional)

- **Dedup index granularity:** `by_kind_status` is `(kind, status)`; the `manual_payment_override` dedup needs `(kind, entity_id)`. Follow the v0.3 precedent (`_listPendingForStaff_internal` collects then filters in JS — `approvals/internal.ts:159`) rather than adding a third index; volumes are tiny. Note this so the planner doesn't add an unused index.
- **`pos_settings` singleton invariant:** document "exactly one row" + a read-time default (return `founders_summary_enabled: true` when the row is absent) rather than a seeded-row requirement — avoids a missing-row throw on the first cron run.
- **Cron hour (seed #6):** pick a concrete WIB close hour; booth hours aren't in the repo. Placeholder 22:00 WIB is fine to plan against, flag for confirmation.
- **`lib/telegramHtml.ts` reconciliation:** the starter's `sendTelegramHtml` + the existing Frollie pure-renderers + `escapeHtml`/`formatIdr` will co-locate. Reconcile to ONE `escapeHtml`/format helper; don't ship two.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `requireManagerSession` | `convex/auth/sessions.ts:24` | gate the `mgr*` registry-admin twins + `settings.setFoundersSummaryEnabled` |
| `_onPaidManual_internal` | `convex/payments/internal.ts:249` | the manual_payment commit funnel — takes `mgr_approver_id` directly, so the off-booth approve path reuses it verbatim (no session needed) |
| Approval lifecycle internals | `convex/approvals/internal.ts` | `_createRequest_/_markNotified_/_markResolved_/_deleteRequest_/_getByTokenHash_/_listPendingForStaff_` — generalize args, don't rewrite |
| `withIdempotency` HOF | `convex/idempotency/internal.ts` | wrap `sendTemplate` (§E #1) + the approve funnels (already used at `approvals/internal.ts:117`) |
| `useIdempotency` + `clearIntent` | `src/hooks/useIdempotency.ts` | the `/approve` manual_payment variant reuses the exact pattern from `src/routes/approve/index.tsx:73` |
| `NumericKeypad` / `PinSheet` | `src/components/pos/` | manager-PIN entry on the manual_payment `/approve` variant |
| Starter registry + lib | `convex-telegram-bot-starter` | port `chatRegistry/registryCommands/commands/webhook` + `lib/{chunking,constantTimeEqual,cronRetry,dateAnchors}` + `sendTelegramHtml` ~verbatim |

### Potential duplication risks
- **Two `escapeHtml`/format helpers** if the starter's `lib/telegramHtml.ts` is dropped beside Frollie's — reconcile (Refinement above).
- **`telegram_log` vs the request-row linkage** — don't keep `telegram_log` as a parallel source of truth; demote to debug-trail only (§E #3) or retire.
- **The POC `renderApproval` callback card** (`lib/telegramHtml.ts:44`) is superseded by URL-button approvals — delete it rather than leaving a second, dead approval-render path.

## 6. Phase / Wave Accuracy (auto-added)

| Wave | Mode | Contents | Depends on |
|------|------|----------|------------|
| 1 — Schema foundation | SEQUENTIAL | Generalized `pos_approval_requests` (+ `by_kind_status`); `telegramChats` table; `pos_settings` singleton; additive `telegram_approval` source literal; SCHEMA.md update | — |
| 2a — Approval framework | PARALLEL | `kinds.ts` registry; generalize `_createRequest_internal` (context validation) + `getByToken`; add `_markDenied_internal`/`_listPendingByKind_internal`; migrate `staff_pin_reset` behind the registry (regression-guarded) | W1 |
| 2b — Telegram self-registration | PARALLEL | port `chatRegistry/registryCommands/commands/webhook` + lib ports; `config.ts` roles; `mgrAdmin.ts` (session-gated); rewire `http.ts`; migration shim | W1 |
| 2c — Settings | PARALLEL | `settings/` module (read-time default ON) | W1 |
| 3 — Graduated kind + founders | SEQUENTIAL | `manual_payment_override` (request/approve/deny actions + funnel reuse + message link); founders resilient cron + aggregate | W2a + W2b (+ W2c for founders) |
| 4 — Frontend | PARALLEL | `/approve` manual_payment variant; `useApproval` + `ApprovalPending` + charge-screen inline; `mgr/telegram-chats` admin route | W3 (backend contracts) |
| 5 — Hardening + docs | SEQUENTIAL | idempotency/typed-payload/audited-failures finalize; ADR-037 + amend 030/035; CLAUDE.md, RUNBOOK-telegram, CHANGELOG, API_REFERENCE | W2–W4 |

**Ordering issues:** the founders cron (W3) depends on `dateAnchors.ts` (ported in W2b) + `pos_settings` (W2c) + role `"founders"` resolution (W2b) — keep it after all three. **Missing phase the spec implied but didn't sequence:** the `staff_pin_reset` regression migration (folding the existing kind behind the new registry without behavior change) — called out as W2a, must ship with its regression tests in the same commit.

## 7. Specialist Agent Recommendations

| Wave | Recommended Agent | Rationale |
|------|-------------------|-----------|
| 1, 2a, 2b, 2c, 3 (backend) | `convex-expert` | schema generalization, registry port, funnels, cron resilience |
| 4 (hooks + charge wiring) | `frontend-integrator` | `useApproval`, charge-screen inline state, admin route data wiring |
| 4 (UI surfaces) | `ui-component-builder` | `/approve` variant, `ApprovalPending`, `mgr/telegram-chats` |
| post-impl | `code-reviewer` | review the graduated approval + webhook rewrite before merge |

(All four exist in the project roster per PROGRESS.md §"Agent values".)

## 8. Git Workflow Assessment (rollback/deploy auto-added)

### Branch & merge strategy
| Check | Status |
|-------|--------|
| Feature branch specified | ⚠️ add `feat/v0.4-telegram-approval` to the plan |
| Branch naming follows convention | ✅ matches `feat/v0.x-*` (cf. v0.2.1, v0.3 PRs) |
| Merge strategy | ✅ PR → main (project norm) |

### Commit checkpoints (natural boundaries)
1. Schema foundation (W1) → `feat(approvals): generalize approval request schema + telegramChats + pos_settings`
2. Approval framework (W2a) → `feat(approvals): kind-registry + generalized createRequest/getByToken`
3. Telegram registry (W2b) → `feat(telegram): port self-registration registry + command webhook`
4. manual_payment kind (W3) → `feat(approvals): manual_payment_override off-booth path`
5. founders cron (W3) → `feat(telegram): resilient founders shift-summary cron`
6. frontend (W4) → `feat(approve): manual_payment variant + ApprovalPending + mgr admin`
7. hardening/docs (W5) → `chore: idempotency + typed payloads + ADR-037 + docs`

### Pre-push verification
- [ ] `npm run typecheck` — REQUIRED (note the starter LESSON 5: new exported functions need `npx convex codegen` before `internal.*` refs resolve)
- [ ] `npm run build`
- [ ] `npx vitest run` (288 existing tests must stay green — esp. the `wa_approval` audit assertions, which the additive-source approach preserves)

### CI/CD & rollback
| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ schema is **additive** (new optional fields + widened unions + new tables) → no migration, `git revert` per wave is clean |
| Deployment order | ✅ deploy Convex backend before Vercel frontend; `setWebhook` re-point happens with the W2b/W5 backend deploy |
| Migration shim | ✅ keep `TELEGRAM_CHAT_ID` env as `getChatIdByRole` fallback until role `"managers"` is bound → zero-downtime PIN-reset during cutover |
| Data backup | No — additive, dev-only deployment; no destructive writes |

## 9. Documentation Checkpoints

| Wave | Docs to update |
|------|----------------|
| W1 | `docs/SCHEMA.md` — generalized `pos_approval_requests`, `telegramChats`, `pos_settings`, new `telegram_approval` source literal |
| W2 | `docs/RUNBOOK-telegram.md` — self-registration operator flow, privacy-mode `/setcommands` (LESSON 6), supergroup migration (LESSON 9), `env set key=value` (LESSON 8) |
| W3 | new audit actions in SCHEMA.md (`approval.denied`, `payment.manual_override`, `telegram.send_failed`, founders `summary.*`) |
| W5 | `CLAUDE.md` (telegram registry + settings module file locations, kind-registry business rule, founders cron, additive-source note), `ADR-037` + amend `ADR-030`/`ADR-035`, `docs/CHANGELOG.md`, `docs/API_REFERENCE.md` |

### CHANGELOG draft
~~~markdown
## v0.4 - Telegram approval graduation + self-registration + founders share
- Generalized the approval framework (kind-registry); added manual_payment_override off-booth approval
- Telegram self-registration: role-routed sends (managers/founders), /register webhook, manager-gated admin
- Founders end-of-shift summary on a resilient daily cron with a manager opt-out toggle
- Hardened the Telegram send path: idempotency, typed payloads, message↔request linking, audited failures
- ADR-037 (self-registration & role-indirection); amended ADR-030/035
~~~

## 10. Testing Plan Assessment

**Verdict:** **Adequate** — the spec ships a real, layered strategy (backend convex-test, frontend vitest, pure units), covers happy/deny/expired/wrong-PIN/superseded/idempotent-replay/concurrent paths, and names regression coverage. The additions below close the gaps the §3 Improvements introduce.

### Missing test coverage (must add)
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | Existing `wa_approval` audit assertions still pass; new `telegram_approval` literal accepted by the union | Improvement 1 must be non-breaking | run the 288 suite green + one new union-acceptance test |
| 2 | Message→request link is best-effort: a failed `_linkTelegramMessage_internal` does NOT fail the request | Improvement 3 ordering | mock send returns id; mock link patch throws → request still `pending`/notified |
| 3 | Founders cron with NO chat bound to `"founders"` → non-transient → audited skip, NOT a 3× retry | `getChatIdByRole` throws on unbound role; cronRetry must not treat it as transient | assert single attempt + `summary.skipped`/misconfig audit row |
| 4 | `pos_settings` absent → read-time default ON (no throw on first run) | Refinement invariant | query with empty table returns `{ founders_summary_enabled: true }` |
| 5 | Webhook secret constant-time compare (accept / 401) + always-200-after-dedupe | ported security surface | starter `webhook.test.ts` parity |

### Regression risk
- `staff_pin_reset` flow after folding behind the kind-registry (W2a) — full path test must stay green.
- Any test asserting the exact `source` string — preserved by the additive approach (Improvement 1).

## 11. Edge Cases to Address

- [ ] manual_payment request pending → webhook confirms the txn first → manager later approves: C4 guard returns the existing receipt (already-paid), request marked resolved, requester screen shows paid (not stale pending).
- [ ] Token expires while the manager is mid-PIN-entry → `TOKEN_EXPIRED` surfaced cleanly on the variant.
- [ ] Two managers open the same link → single-resolve guard (`_markResolved_internal` status check, `approvals/internal.ts:133`) holds for the new kind too.
- [ ] Founders role unbound / archived at cron time → audited skip, no retry storm.
- [ ] `pos_settings` row missing → default ON.
- [ ] Supergroup migration changes `managers` chat_id → registry re-`/register` + reassign (RUNBOOK), no redeploy.
- [ ] Cart edited after request minted → dedup on `(kind, entity_id)`; superseded txn → C4 guard.

## 12. Approval Conditions (success criteria auto-added)

**To approve the spec for planning, fold in:**
1. §0 structural sections (waves §6, rollback §8, success criteria here) — done in this report; mirror into the spec.
2. Improvement 1 — additive `telegram_approval` source (not a rename).
3. Improvement 2 — drop `audit_log_id`; use `metadata.approval_request_id` + `by_entity`.
4. Improvement 3 — specify best-effort message→request link ordering.

**Success criteria for the eventual implementation:**
- `npm run typecheck` + `npm run build` clean; `npx vitest run` green (288 existing + new).
- A booth request → Telegram link → manager PIN → `paid` completes end-to-end on dev; deny path flips the requester screen to "declined".
- `/register` registers a chat; a manager assigns role `managers`/`founders` from the admin route; sends route correctly.
- Founders summary posts once on the cron to the founders group; opt-out toggle suppresses it (audited skip).

**Recommended before implementation:** Improvements 4–5 (explicit `requireManagerSession` reuse; webhook callback-regression decision).

---

*Generated by /staffreview*
