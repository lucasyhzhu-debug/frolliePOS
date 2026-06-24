# Staff Review: Per-outlet Telegram routing (Spec 4) implementation
**Date:** 2026-06-24
**Branch:** feat+v2.0-telegram-per-outlet-routing
**Diff range:** a6d9b3e..08d51df (15 commits, 44 files, +3009/−689 lines)
**Reviewer:** Staff review agent
**Test gate:** 266 files / 1527 tests — full suite green, typecheck + lint clean (per brief)

---

## Summary

**Modules got deeper, not shallower — with one deliberate exception that is correctly handled.** The Telegram module gained a principled two-tier resolver (`resolveOutletChatId`) that hides cross-module outlet reads behind an action-layer helper, keeping all six sending callsites free of direct `ctx.db.query("outlets")` access. The `sendTemplate` interface widened — one new `outletId` arg and one new `managers_daily_summary` kind — but both are earned: the arg is structurally required by the two-tier dispatch, and the kind is a genuine new message contract that could not be folded into an existing kind without losing type safety. The `resolveOutletChatId` helper correctly passes the rule-of-three test (five callsites at the time of extraction: `send.ts`, `dispatch.ts`, `txnTicker.ts`, `cronActions.ts`, `ownersSummary.ts`). ADR-034 module-boundary discipline is intact throughout — the three new `outlets.internal.*` queries (`_listActiveOutlets_internal`, `_getDefaultOutlet_internal`, `_getOutlet_internal`) are all proper internalQuery surface additions, not cross-module `ctx.db` reaches. The two mid-stream revert/recovery incidents (commit 1145023 restoring Task-6 work and fafd095 restoring Task-3 functions) are fully recovered in the final tree — `getChatIdByRoleAndOutlet`, `getChatIdByRoleBareOrNull`, the per-outlet drift cron, and per-outlet idempotency keys all exist and are correct. One critical issue exists (lockout routing), two improvements, and several refinements.

---

## Critical Issues

### C1: `notifyStaffLockout` routes PIN-reset to the DEFAULT outlet's managers chat, not the locked-out staff's device outlet

**File:** `convex/approvals/actions.ts`, lines 72–103

`notifyStaffLockout` is a system-triggered action (no session, no device context). The comment at line 68–71 acknowledges this and deliberately falls back to `_getDefaultOutlet_internal`. The consequence in a multi-outlet deployment: a staff member locked out at outlet B (Block M) triggers a PIN-reset notification that is silently routed to outlet A's (Pakuwon's) managers chat — and the `/approve/:token` link in that message, if actioned, resets the PIN and stamps `outlet_id = defaultOutlet._id` on the `pos_approval_requests` row, even though the staff member's real home outlet is B.

This is not an immediate prod problem (single outlet today), but it is a correctness bug that will bite the moment the second outlet opens and will be invisible — the wrong managers chat gets the link, they act on it, and the approval audit row has the wrong outlet.

**The approved-by-comment reasoning is sound for the approval row's outlet stamp** (PIN-reset is staff-identity-scoped, not outlet-scoped — there is genuinely no "correct" outlet). The routing, however, should use the staff member's outlet access rather than the deployment default. The `staff_outlet_access` join table exists precisely for this. The fix: query `_listOutletsForStaff_internal` (or equivalent from the outlets module) and send to each outlet's managers chat — or, simpler for v2.0 single-outlet reality, send to ALL active outlets' managers chats so no outlet is silently excluded. One message per bound outlet, idempotency-keyed per `(requestId, outlet_id)`.

**Why Critical:** this is a silent misroute — no throw, no audit warning, no observable symptom until the second outlet opens. The fix is small (loop or fallback logic change) and must not be left for a follow-up without a PROGRESS task and a code comment explaining the known gap.

---

## Improvements

### I1: The `ownersSummary` per-outlet managers send exits the loop on a non-transient send failure, abandoning remaining outlets

**File:** `convex/telegram/ownersSummary.ts`, lines 253–261

```ts
} catch (err) {
  if (!isTransientError(err)) {
    await ctx.runMutation(internal.telegram.internal._auditFoundersSkip_internal, {
      reason: `send_failed:outlet:${o.code}`,
    });
    throw err;  // ← EXITS the whole loop
  }
  throw err;
}
```

The plan (Task 7) specifies: "Unbound/disabled for one outlet → audited skip for that outlet only; never abort the loop." The unbound path (lines 217–230) correctly `continue`s the loop. But a non-transient Telegram send failure for outlet B's `managers_daily_summary` throws after auditing, which exits the outer `for` loop, so outlet C's summary is never sent. With two outlets this loses at most one summary; with N outlets it silently drops N−1 after the first non-transient failure.

**Fix:** wrap the send-failure branch in `continue` (not `throw`) for non-transient per-outlet errors, after auditing. Reserve the `throw` for transient errors (the resilient wrapper handles retries). The owners rollup (step 5, lines 174–197) is correctly outside the per-outlet loop and has its own independent throw, which is fine.

### I2: `resolveOutletChatId` makes up to three sequential cross-module queries in the "bare-row fallback" path

**File:** `convex/telegram/resolveOutletChat.ts`, lines 32–53

```
getChatIdByRoleAndOutlet  →  (miss)
_listActiveOutlets_internal  →  (length === 1)
getChatIdByRoleBareOrNull
```

Three sequential `ctx.runQuery` round-trips in the fallback path. In the steady-state post-backfill world (every outlet-scoped chat has an `outlet_id`) the first query hits and the other two never run — so this is only a transitional window cost. The concern is not performance but correctness: the three queries run in separate transactions (action-layer, not a single mutation). A chat could be archived between the `getChatIdByRoleAndOutlet` miss and the `getChatIdByRoleBareOrNull` return, causing the fallback to return a chatId for a now-archived chat and the subsequent send to fail at the Telegram API level. This is a narrow race window (the transitional period only, and the failure mode is a Telegram 403 that is audited rather than silent). No code change required for this review cycle — but add a `// TRANSITIONAL: three-query race window — safe to delete after backfill runs on prod` comment at line 38 so future reviewers know this is a known, bounded gap, not an oversight.

---

## Refinements

### R1: `ROLE_SCOPE[args.role as keyof typeof ROLE_SCOPE]` lookup in `sendTemplate` returns `undefined` for the `"founders"` legacy alias — silently falls through to the business path

**File:** `convex/telegram/send.ts`, line 219

The `sendTemplate` scope dispatch:
```ts
ROLE_SCOPE[args.role as keyof typeof ROLE_SCOPE] === "outlet"
```
`ROLE_SCOPE` has keys `managers`, `owners`, `inventory`, `ops`. The `founders` legacy alias is accepted by `isKnownTelegramRole` but absent from `ROLE_SCOPE`. The lookup returns `undefined`, which is `!== "outlet"`, so it falls through to `getChatIdByRole("founders")`. During the migration window this is correct behavior (the founders chat is still alive until the backfill runs). However, if a callsite mistakenly passes `role: "founders"` WITH an `outletId`, the `outletId` is silently ignored rather than throwing `OUTLET_NOT_ALLOWED_FOR_ROLE`. Add a guard at the scope-dispatch entry: if `args.role === "founders"` and `args.outletId` is set, throw `OUTLET_NOT_ALLOWED_FOR_ROLE` (or assert it is not set). This matches how `assignRoleImpl` already handles the alias at line 98 (`?? "business"`), but `sendTemplate` currently skips this validation.

### R2: `seedChatFromEnv` / `seedFromEnvWrite` in `chatRegistry/internal.ts` do not set `outlet_id` on the seeded row

**File:** `convex/telegram/chatRegistry/internal.ts`, lines 499–520

`seedChatFromEnv` is a bootstrap helper used to migrate the pre-Spec-4 single-chat environment to the new registry. It inserts a `telegramChats` row with no `outlet_id`. For a business-scoped role (`owners`, `ops`) this is correct. For an outlet-scoped role (`managers`, `inventory`) the seeded row will not be found by `getChatIdByRoleAndOutlet` — only by the bare-row fallback path — until the `bindTelegramChatsToDefaultOutlet` migration is run. This is documented behavior (the backfill handles it), but `seedChatFromEnv` should enforce `ROLE_SCOPE` validation and warn if the caller seeds an outlet-scoped role without running the backfill: add a post-seed log line `"Seeded outlet-scoped role '${role}' without outlet_id. Run bindTelegramChatsToDefaultOutlet to complete the bind."` so operators are not surprised when the single-outlet fallback is the active path.

### R3: `isKnownTelegramRole` accepts `"founders"` and is shared with the FE dropdown via `config.ts`

**File:** `convex/telegram/config.ts`, lines 13–17

`isKnownTelegramRole("founders")` returns `true`, which means the FE `/mgr/telegram-chats` dropdown (Task 10) will accept `founders` as a valid role in type-checked code. In practice the dropdown is built from `KNOWN_TELEGRAM_ROLES` (not from `isKnownTelegramRole`), so `founders` does not appear as a selectable option — correct. But if someone passes `"founders"` programmatically to `mgrAssignRole`, it succeeds and the row gets `role: "founders"` with no `outlet_id` (business-scope treatment), which is valid but confusing. Add a comment on `LEGACY_ROLE_ALIASES` clarifying the expected cleanup timeline ("remove after prod backfill has run and all `founders`-role rows are rebound; tracked in PROGRESS.md").

### R4: `managers_daily_summary` uses `chatIdOverride` in `ownersSummary.ts` but also passes `outletId` — causing `sendTemplate` to skip the safety-net scope check

**File:** `convex/telegram/ownersSummary.ts`, line 239; `convex/telegram/send.ts`, line 217

When `chatIdOverride` is set, `sendTemplate`'s scope dispatch short-circuits before the `OUTLET_REQUIRED_FOR_ROLE` check. This is intentional (the plan says "chatIdOverride callsites bypass that safety net — each resolves per-outlet itself"). The `outletId` arg is still threaded through to `_auditSendFailed_internal` (line 354 in `send.ts`) for observability, which is the right reason to pass it. The code is correct — but the comment at line 196–200 in `send.ts` says `chatIdOverride` callers "ignore" the `outletId`, which is stale: `outletId` is forwarded to the failure audit path. Update the comment to read: `chatIdOverride callers skip the scope-resolve safety net, but outletId is still threaded to the failure audit for observability.`

### R5: The `by_active` index on `outlets` is hit by every `_listActiveOutlets_internal` call, which does a full `.collect()` — no pagination

**File:** `convex/outlets/internal.ts`, line 53

`_listActiveOutlets_internal` collects all active outlets into memory. For the current 1-outlet and near-term 2–3 outlet world this is correct (no need to paginate). For the long-term multi-outlet scenario it could accumulate. This is not a bug today; add a comment `// Collects all active outlets — safe for current scale (expected: <10 outlets in this deployment).` to document the known assumption and make it easy to find when scale increases.

### R6: `ownersSummary.ts` calls `resolveOutletChatId` directly (imported as a plain function) from a V8-safe file that imports from `resolveOutletChat.ts`

**File:** `convex/telegram/ownersSummary.ts`, line 42; `convex/telegram/resolveOutletChat.ts`, header comment

`resolveOutletChat.ts` is V8-safe (confirmed: no `"use node"`). `ownersSummary.ts` is also V8-safe (no `"use node"`). The import is correct — V8 files may import plain TypeScript functions from other V8 files. `send.ts` is `"use node"` and also imports `resolveOutletChatId` — this is also correct since `"use node"` files have a superset of V8 capabilities. The final fix commit (08d51df) changed `ownersSummary.ts` to use a static import rather than a dynamic one, resolving a module-resolution issue caught in final review. This is correct. No action needed; noted for completeness.

### R7: `dispatchRoleAlert` narrow-catch string-matches on the error message

**File:** `convex/telegram/dispatch.ts`, lines 48–50; `convex/telegram/txnTicker.ts`, lines 68–72; `convex/telegram/ownersSummary.ts`, lines 221–225

The narrow-catch pattern (`msg.includes("No Telegram chat assigned to role")`) is consistent with the pattern used by the old `foundersSummary.ts` and is documented in the plan. The risk is a renamed error string silently switching from narrow-catch (skip) to broad-catch (rethrow), losing the audited-skip guarantee. This is low-risk given the string is defined in one place (`chatRegistry/internal.ts`) and all callers are in the same codebase. Consider extracting the string to a shared constant (`ROLE_UNBOUND_ERROR` in `config.ts` or a new `convex/telegram/errors.ts`) so the compiler catches drift. Not blocking.

---

## Plan Fidelity

All 13 tasks are implemented. The two mid-stream revert incidents noted in the brief are confirmed recovered:

- **Task-6 revert (1145023):** `getChatIdByRoleAndOutlet` and `getChatIdByRoleBareOrNull` are present in `convex/telegram/chatRegistry/internal.ts` (lines 237–248 and 232–234). The per-outlet drift cron in `convex/inventory/cronActions.ts` iterates active outlets and uses `resolveOutletChatId`. Per-outlet idempotency key `stock-recon:<outlet.code>:<dateKey>` is confirmed at line 138.
- **Task-3 revert (fafd095):** `getChatIdByRoleAndOutlet` and `getChatIdByRoleBareOrNull` are confirmed present in the final tree (verified above). These are the two functions the plan says Task 9's implementer accidentally reverted and Task fafd095 recovered.

One scope drift from the plan: Task 9 step 5 planned for `mgrListChats` to return raw `outlet_id` and let the FE resolve labels via `listOutlets`. The implementation follows this exactly — `mgrListChats` returns `outlet_id` unchanged and the FE joins against `listOutlets` (correct resolution of the plan's noted fence-violation alternative). This is plan-compliant, not scope drift.

---

## Graft Integrity (Frollie Pro Cross-Deployment Future)

Nothing in this branch locks in a Frollie Pro integration assumption. The two-tier routing is internal POS logic — `(role, outlet_id)` pairs are never exposed via `convex/api/v1/`. The `telegramChats` table and all resolver functions remain internal/private surface. The `resolveOutletChatId` helper's three-query fallback is a migration-window artifact that disappears post-backfill; it does not create a persistent pattern that could complicate graft integration. The `outlets` module's `_listActiveOutlets_internal` / `_getOutlet_internal` additions are standard internalQuery surface — they would be called by Frollie Pro integration code through the sanctioned `ctx.runQuery` path anyway.

---

## Over/Under-Engineering Assessment

**No over-engineering found.** `resolveOutletChatId` extraction is justified (five callsites at extraction time). `ROLE_SCOPE` as a config constant is the minimal single-source-of-truth for a two-way decision (scope dispatch in `sendTemplate` + validation in `assignRoleImpl`). The `_resolveOutletChatId_test_internal` internalAction wrapper for testability is the repo's existing pattern, not new ceremony.

**One under-engineering flag:** the `notifyStaffLockout` default-outlet routing (C1 above) is under-specified — a comment explains the choice but does not open a follow-up task or note the known misroute risk for multi-outlet. This must be tracked in PROGRESS.md before merge.

---

## Findings Grouped by Severity

### Critical

- **C1** `convex/approvals/actions.ts:72–103` — `notifyStaffLockout` routes PIN-reset to the default outlet's managers chat regardless of the locked staff's actual outlet. Silent misroute in multi-outlet deployments. Needs either a loop-over-staff-outlets fix or a PROGRESS.md task + code comment acknowledging the gap before this branch reaches prod with a second outlet.

### Important

- **I1** `convex/telegram/ownersSummary.ts:253–261` — Non-transient send failure in the per-outlet `managers_daily_summary` loop `throw`s after auditing, aborting remaining outlets. Fix: `continue` after audit on non-transient per-outlet errors.
- **I2** `convex/telegram/resolveOutletChat.ts:38–48` — Three sequential cross-module queries in fallback path; narrow race window during transitional period. Add `// TRANSITIONAL` comment; no code change required.

### Minor

- **R1** `convex/telegram/send.ts:219` — `ROLE_SCOPE["founders"]` is `undefined`, silently ignoring `outletId` if passed with the legacy role. Add validation guard matching `assignRoleImpl` line 98.
- **R2** `convex/telegram/chatRegistry/internal.ts:499–520` — `seedChatFromEnv` does not warn when seeding an outlet-scoped role without running the backfill. Add post-seed log line.
- **R3** `convex/telegram/config.ts:13` — `LEGACY_ROLE_ALIASES` lacks cleanup-timeline comment. Add one.
- **R4** `convex/telegram/send.ts:196–200` — Stale comment says `chatIdOverride` callers "ignore" `outletId`; they actually thread it to the failure audit. Update comment.

### Nitpick

- **N1** `convex/outlets/internal.ts:53` — `_listActiveOutlets_internal` collects without pagination; fine for current scale, missing scale-assumption comment.
- **N2** `convex/telegram/dispatch.ts:48`, `txnTicker.ts:68`, `ownersSummary.ts:221` — Narrow-catch on error message string; consider a shared error constant to prevent silent drift.

---

## STAFFREVIEW COMPLETE
