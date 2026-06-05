# Staff Review: `/activatepos` Telegram device-activation command (SPEC)

**Date:** 2026-06-05
**Plan:** `docs/superpowers/specs/2026-06-05-telegram-activatepos-command-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** Reviewed as a SPEC — implementation-plan sections (commit boundaries, wave ordering) are deferred to the writing-plans gate, not dinged here.

---

## 1. Summary

**Overall Assessment:** Revise (one Critical, three Improvements — all small)

The spec is architecturally sound and grounded in real code: `getChatIdByRole("managers")`, the `"system"` audit sentinel, `POS_BASE_URL`, `formatWibDateTime`, and `sendTelegramHtml` all exist as described. The auth model (chat-role gate) and the optional-field schema cascade are correct and back-compatible. One correctness bug must be fixed before planning: `MessageContext.fromId` is optional, but the spec records it as a required `v.number()`. Three improvements sharpen the helper shape, failure UX, and the time formatter reference.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `fromId` is `number \| undefined`; stored as required `v.number()` | Logic/Schema | §Attribution, §Telegram flow |

### Issue 1: `MessageContext.fromId` is optional — required `from_id` will throw

`MessageContext.fromId` is typed `number | undefined` (`convex/telegram/commands.ts:17`; the webhook sets it from `msg.from?.id`, `webhook.ts:74`). Telegram omits `from` for channel posts and for anonymous group admins (the "send as channel/admin" feature in supergroups — exactly the kind of managers chat this targets). The spec stores:

```
issued_by_telegram: v.optional(v.object({ from_id: v.number(), chat_title: v.string() }))
```

When `fromId` is `undefined`, constructing that object yields `{ from_id: undefined, chat_title: ... }`, which **fails Convex validation** on insert → the issuance mutation throws → the webhook dispatch swallows it (`webhook.ts:107`) → the manager gets **no code and no error**. Silent failure on the happy path for anonymous admins.

**Recommendation:** Make `from_id` optional inside the object: `v.object({ from_id: v.optional(v.number()), chat_title: v.string() })`. Still issue the code when `fromId` is absent (chat-role membership is the actual gate; `from_id` is attribution-only). Record `chat_title` regardless, and put `telegram_from_id` in audit metadata only when present. Add a test for the `fromId === undefined` path.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Pin the shared helper shape (plain fn + internalMutation wrapper) | H | L |
| 2 | Reply on issuance failure (collision / missing POS_BASE_URL) | M | L |
| 3 | Name `formatWibDateTime` + accept its full date·time stamp | M | L |

### Improvement 1: Specify the shared helper as a plain async fn, not a callable mutation

The spec says "extract into a shared internal helper `_issueDeviceSetupCode_internal`" but a Convex **mutation cannot call another mutation**. The booth path (`generateDeviceSetupCode`) is a mutation; it must call the shared logic as a **plain exported async function** running in its own transaction — the same pattern as `logAudit` (`convex/audit/internal.ts`, ADR-034: "plain async TypeScript function, NOT an internalMutation"). The Telegram path is an `internalAction`, which calls a thin `internalMutation` wrapper via `ctx.runMutation`; that wrapper calls the same plain fn.

**Recommendation:** Define two things: (a) `issueDeviceSetupCode(ctx: MutationCtx, opts)` — plain async fn (collision loop + insert + audit); (b) `_issueDeviceSetupCodeFromTelegram_internal` — `internalMutation` wrapper that calls (a). Booth mutation calls (a) directly. State this in the spec so the implementer doesn't author an uncallable mutation.

### Improvement 2: Reply to the chat when issuance fails

The spec says "on send failure record nothing — the manager can re-issue," but covers only the *send* failure. If the collision loop exhausts (`CODE_COLLISION` after 5 retries) or `POS_BASE_URL` is unset (the reply build throws like `approvals/actions.ts:61`), the mutation/action throws and the manager sees **nothing**. For a one-shot command this is a dead end.

**Recommendation:** In `handleActivatePos`, wrap issuance + send in try/catch; on error, best-effort `sendTelegramHtml` a short "⚠️ Couldn't generate a setup code — try again." to the same chat. Read `POS_BASE_URL` once up front and fall back to a code-only reply (no link) if it's absent rather than throwing.

### Improvement 3: Reference the real formatter and accept its format

`convex/lib/time.ts` exports `formatWibDateTime(epochMs)` returning `"05 Jun 2026 · 14:32 WIB"` (full date + time), not a bare `HH:MM`. The spec's mock reply shows `Valid until 14:32 WIB`.

**Recommendation:** Reuse `formatWibDateTime` as-is (don't mint a time-only helper). Update the reply mock to `Valid until 05 Jun 2026 · 14:32 WIB (1 hour)`. Cheaper and consistent with receipts/approvals.

## 4. Refinements (Optional)

- **No rate-limiting on issuance.** Anyone in the managers chat can mint many codes. Each is single-use, 1h TTL, and audited, so blast radius is small — acceptable for v1; note it in the plan's non-goals so it's a conscious choice.
- **Symmetry of `activated_via`.** Spec adds `metadata.activated_via: "telegram"` for Telegram codes. Either also set `"booth_inline"` for booth codes, or document "absent = booth" — don't leave it implicit.
- **`getChatIdByRole` env fallback.** It falls back to `TELEGRAM_FALLBACK_ROLE` + `TELEGRAM_CHAT_ID` (`chatRegistry/internal.ts:177`). In dev with those set, the gate resolves to the fallback chat. Harmless, but call it out so it's not mistaken for a gate bypass.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| Code-gen + collision loop | `convex/staff/public.ts:113` | Extract to shared plain fn (Improvement 1) |
| `getChatIdByRole` | `convex/telegram/chatRegistry/internal.ts:161` | The managers-chat gate (catch throw → silent) |
| `sendTelegramHtml`, `escapeHtml` | `convex/lib/telegramHtml.ts:20,63` | Reply send + escaping |
| `formatWibDateTime` | `convex/lib/time.ts:100` | Expiry formatting |
| `logAudit` (`"system"` actor) | `convex/audit/internal.ts:24` | Issuance audit without staff id |
| `buildRegistryCommands` factory | `convex/telegram/registryCommands.ts` | Pattern for `buildActivatePosCommand` |

### Potential duplication risks
- Re-implementing the collision loop in the Telegram path instead of sharing it (the multi-writer drift the v0.5.5 canonical-insert lesson warns about). Improvement 1 closes this.

## 6. Phase / Wave Accuracy

Spec-level — wave breakdown is the writing-plans gate's job. The natural ordering is sound: schema → shared helper extraction (+ booth refactor) → Telegram command/action → wiring in `http.ts` → tests → docs.

## 7. Specialist Agent Recommendations

| Work | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Backend impl | `convex-expert` | Schema change + internal action/mutation + audit |

## 8. Git Workflow Assessment

Deferred to the plan. The pipeline already mandates: worktree off synced `main`, atomic commits, squash-PR.

## 9. Documentation Checkpoints

Spec's §"Docs to update" is complete: `SCHEMA.md`, `API_REFERENCE.md`, `RUNBOOK-telegram.md`, `CLAUDE.md` (Telegram section), `CHANGELOG.md`. Add: `CLAUDE.md` business-rule note that device-setup codes now have two issuance paths (booth-session + managers-Telegram).

## 10. Testing Plan Assessment

**Verdict:** Adequate (with Critical-1's added case)

### Planned tests
| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend | issuance from managers chat → `issued_via: "telegram"` | convex-test | planned |
| Backend | non-managers chat → no code, no send | convex-test | planned |
| Backend | no managers chat bound → silent no-op | convex-test | planned |
| Backend | E2E: telegram code → `activateDevice` → `activated_by` absent, audit `"system"` | convex-test | planned |
| Backend | audit `source: "telegram_approval"` + `telegram_from_id` (parse JSON metadata) | convex-test | planned |
| Unit | matcher matches `/activatepos`, `/activatepos@Bot`; rejects `/activatepos extra` | vitest | planned |

### Missing test coverage (must add)
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | `fromId === undefined` still issues a code | Critical-1 silent-failure path | call issuance mutation with no `from_id`; assert row created, `issued_by_telegram.from_id` absent |
| 2 | action send mocked, not real fetch | action calls `sendTelegramHtml` (real fetch) | `vi.stubEnv("TELEGRAM_BOT_TOKEN",…)` + `vi.stubGlobal("fetch", vi.fn(...))` per `send.test.ts:7-10` |

### Regression risk
- `generateDeviceSetupCode` booth path refactored to call the shared fn — existing device-setup tests must still pass (the v0.5.3b suite covered this; some route tests were removed in current WIP, so rely on the backend `staff` tests).

## 11. Edge Cases to Address

- [ ] `fromId` undefined (anonymous admin / channel post) — Critical-1
- [ ] No chat bound to `managers` → `getChatIdByRole` throws → catch, silent
- [ ] `POS_BASE_URL` unset → code-only reply, don't throw (Improvement 2)
- [ ] Collision-loop exhaustion → reply "try again" (Improvement 2)
- [ ] Existing `pending_device_setups` rows (issued_by populated) still valid after optional-ing the field

## 12. Approval Conditions

**To approve, address:**
1. Critical-1: `from_id` optional + issue-when-absent + test.

**Recommended before planning:**
1. Improvement 1: pin shared-helper shape (plain fn + internalMutation wrapper).
2. Improvement 2: failure-path reply.
3. Improvement 3: reference `formatWibDateTime`, accept its full stamp.

---

*Generated by /staffreview*
