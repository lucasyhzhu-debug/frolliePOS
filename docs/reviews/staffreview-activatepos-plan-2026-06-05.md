# Staff Review: `/activatepos` Implementation Plan

**Date:** 2026-06-05
**Plan:** `docs/superpowers/plans/2026-06-05-telegram-activatepos-command.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, File Structure, 7 tasks w/ TDD steps, Success Criteria, Rollback/Deployment, Edge cases all present)

---

## 1. Summary

**Overall Assessment:** Revise (no Critical; 3 Improvements — all small, all verified against real code)

The plan is grounded and accurate: every API path (`internal.staff.internal._issueDeviceSetupCodeFromTelegram_internal`, `internal.telegram.chatRegistry.internal.getChatIdByRole`, `internal.telegram.activatePos.handleActivatePos`), helper shape (`requireManagerSession` → `{ staffId, deviceId }`), and test mechanic (`t.mutation/t.action(internal.…)`, `vi.stubGlobal("fetch")`) was confirmed in the codebase. Three improvements bring it in line with an existing pattern (`dispatch.ts`) and tighten audit semantics. None block planning approval once addressed.

## 2. Critical Issues (Must Fix)

None. The schema change is additive/back-compatible, the single-writer extraction is correct, and the TDD steps are concrete and runnable.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Narrow the chat-gate catch to "role unbound" only; rethrow other errors | H | L |
| 2 | Keep `device.activated` audit `source: "booth_inline"`; channel only in metadata | M | L |
| 3 | Document Telegram group privacy-mode (`@Bot` / `/setprivacy`) — feature won't fire otherwise | H | L |

### Improvement 1: Don't blanket-catch the chat-gate query

Task 4's `handleActivatePos` wraps `getChatIdByRole` in `try { … } catch { return; }`. That silently swallows **any** error — a transient DB hiccup becomes an indistinguishable "no managers chat" no-op, and the manager assumes an auth rejection. The codebase already has the right pattern in `convex/telegram/dispatch.ts:42-51` (`dispatchRoleAlert`): match the specific unbound-role message, skip on that, **rethrow everything else** so it surfaces in the Convex dashboard.

`getChatIdByRole` throws `Error("No Telegram chat assigned to role '<role>'")` (`chatRegistry/internal.ts:184`).

**Recommendation:** Replace the gate catch with:
```typescript
    let managersChatId: string;
    try {
      managersChatId = await ctx.runQuery(
        internal.telegram.chatRegistry.internal.getChatIdByRole,
        { role: "managers" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("No Telegram chat assigned to role")) return; // unbound — silent
      throw err; // unexpected — surface it
    }
    if (managersChatId !== args.chatId) return;
```

### Improvement 2: `device.activated` source should stay `booth_inline`

Task 3 sets the activation audit `source: activatedVia === "telegram" ? "telegram_approval" : "booth_inline"`. But **activation is always a physical booth act** — someone types the code into the new device at the counter, with no session and no Telegram involvement at that moment. Only the *issuance* came from Telegram. Labeling the activation row `telegram_approval` pollutes audit queries that filter on that source for the actual approval/token flow (CLAUDE.md rule #10: `telegram_approval` is the approval-flow source). The issuance channel is already preserved in `metadata.activated_via`.

**Recommendation:** Keep `source: "booth_inline"` unconditionally in `device.activated`; drop the source ternary. Retain `actor_id: pending.issued_by ?? "system"` and `metadata.activated_via`. (Issuance audit keeps `source: "telegram_approval"` — see refinement below.)

### Improvement 3: Telegram group privacy mode — the command won't reach the bot otherwise

In a supergroup (which the managers chat is — `chatType: "supergroup"`), Telegram's default bot **privacy mode ON** means the bot only receives commands explicitly addressed to it (`/activatepos@FrolliePOS_Bot`) or replies to its messages — **not** a bare `/activatepos`. The matcher already accepts the `@Bot` suffix (`buildCommandMatcher`), so the mechanism works, but a manager typing bare `/activatepos` in the group will get silence and assume a bug.

**Recommendation:** In Task 6 Step 3 (RUNBOOK) and the Deployment section, document: either disable privacy via BotFather `/setprivacy` → Disable (then re-add the bot to the group), **or** instruct managers to use `/activatepos@<bot_username>`. Register the command via BotFather `/setcommands` as `activatepos - mint a device setup code` so it autocompletes with the `@Bot` form in groups.

## 4. Refinements (Optional)

- **Issuance `source: "telegram_approval"` is slightly overloaded.** The issuance isn't an approval/token flow — it's a direct command. But `telegram_approval` is the *only* Telegram-origin value in the audit source union (`audit/internal.ts:6-12`), and CLAUDE.md treats it as "telegram-originated." Adding a `telegram_command` enum value is scope creep for v1. Keep `telegram_approval`; note the overload in SCHEMA.md so a future reader isn't misled.
- **Optionally audit an unbound-managers-chat skip.** `dispatchRoleAlert` writes `telegram.skipped` when the role is unbound. `/activatepos` silently returns. Low value (managers chat is bound for approvals anyway); skip unless cheap.
- **No-idempotency on the wrapper is correct** — scheduled actions don't auto-retry and the action issues exactly one `runMutation`; the plan's "webhook dedupes by update_id" note is sufficient. No change needed.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| Narrow unbound-role catch | `convex/telegram/dispatch.ts:42-51` | Pattern for Improvement 1 |
| `getChatIdByRole` | `chatRegistry/internal.ts:161` | Inbound chat gate (confirmed path) |
| `requireManagerSession` → `{staffId, deviceId}` | `auth/sessions.ts:24-31` | Booth refactor destructure (confirmed) |
| `_setStaffRoleCommit_internal` shape | `staff/internal.ts:30` | Template for the wrapper internalMutation |

### Potential duplication risks
- None new. The plan correctly *consolidates* the previously-inlined code-gen into one writer rather than duplicating it.

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|------|------------|-------|
| 1 Schema | Good | Additive, back-compat; legacy-row test included |
| 2 Shared helper + booth refactor | Good | Correct plain-fn/wrapper split; no circular import (internal doesn't import public) |
| 3 activateDevice | Good (apply Imp-2) | Source semantics is the only tweak |
| 4 Command + action | Good (apply Imp-1) | Gate catch tightening |
| 5 Wiring | Good | http.ts spread is correct |
| 6 Docs | Good (apply Imp-3) | Add privacy-mode note |
| 7 Verify | Good | Full suite + typecheck + build + lint |

**Ordering:** Correct — schema → helper → consumer → command → wiring → docs → verify. Task 1 typecheck may transiently flag `activateDevice` until Task 3; the plan already calls this out.

## 7. Specialist Agent Recommendations

| Work | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Tasks 1-5 (backend) | `convex-expert` | Schema + internal action/mutation + audit + convex-test |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch / worktree | ✅ (pipeline: worktree off synced main) |
| Atomic commits per task | ✅ one commit per task with `<type>:` messages |
| Pre-push verification | ✅ Task 7: typecheck + build + lint + full vitest |
| Merge strategy | ✅ squash-PR (repo convention) |

## 9. Documentation Checkpoints

✅ Task 6 covers SCHEMA.md, API_REFERENCE.md, RUNBOOK-telegram.md, CLAUDE.md, CHANGELOG.md. Add: privacy-mode operational note (Imp-3) + `telegram_approval` overload note (refinement).

## 10. Testing Plan Assessment

**Verdict:** Adequate

### Planned tests (all confirmed runnable against the harness)
| Layer | What | Type | Status |
|-------|------|------|--------|
| Schema | telegram/legacy/optional-activated_by rows accepted | convex-test `t.run` insert | planned |
| Backend | issuance via wrapper: issued_via, issued_by_telegram, audit system+telegram_approval | convex-test | planned |
| Backend | fromId undefined still issues | convex-test | planned |
| Backend | activateDevice w/ telegram code: activated_by absent, actor system | convex-test | planned |
| Action | managers chat → code + reply (fetch asserted) | convex-test + fetch stub | planned |
| Action | non-managers chat → no write, no send | convex-test | planned |
| Action | no managers chat bound → silent no-op | convex-test | planned |
| Unit | matcher matches `/activatepos`, `@Bot`, rejects trailing args | vitest | planned |

### Missing coverage (add)
| # | Missing test | Why | Approach |
|---|--------------|-----|----------|
| 1 | gate rethrows on unexpected error (Imp-1) | proves narrow-catch, not blanket | mock `getChatIdByRole` to throw a non-"unbound" error and assert `handleActivatePos` rejects — OR accept as covered by code review since convex-test can't easily inject a query throw; document as a manual reasoning check |

(Note: #1 is hard to unit-test without injecting a query failure; the narrow-catch is verified by code inspection against `dispatch.ts`. Acceptable to skip the automated test and rely on the shared pattern.)

### Regression risk
- `generateDeviceSetupCode` booth path now routes through `issueDeviceSetupCode` — existing `staff.test.ts` device-registration test must still pass (it asserts code shape + TTL + pending row). Confirmed the helper preserves behavior (`issued_via: "booth_inline"`, `issued_by` set).

## 11. Edge Cases to Address

- [x] `fromId` undefined → issues (Task 2 test)
- [x] non-managers chat → rejected (Task 4 test)
- [x] unbound managers chat → silent (Task 4 test) — tighten to unbound-only (Imp-1)
- [x] `POS_BASE_URL` unset → code-only reply (Task 4 code)
- [x] collision/send failure → "try again" reply (Task 4 code)
- [ ] supergroup privacy mode → `@Bot` form (Imp-3, operational)

## 12. Approval Conditions

**To approve, address:**
- (No Criticals.)

**Recommended before implementation:**
1. Imp-1: narrow the gate catch (mirror `dispatch.ts`).
2. Imp-2: `device.activated` source stays `booth_inline`.
3. Imp-3: document Telegram group privacy mode in RUNBOOK + deployment.

---

*Generated by /staffreview*
