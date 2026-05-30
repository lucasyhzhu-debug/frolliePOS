# Staff Review (Reviewer #3 — Senior Eng / Deep-Module Discipline): v0.4 Telegram Approval Graduation

**Date:** 2026-05-30
**Branch:** `feat/v0.4-telegram-approval` (head `8a0e747`, base `1dbe5bf`)
**Lens:** ADR-034 deep-module / surface-API discipline + graft integrity + plan-fidelity.
**Diff:** ~73 files, +7431/-987.

---

## Summary

**One-line verdict on module depth:** This change leaves overall module depth **net-positive — slightly deeper** (approvals + telegram both grew real, hidden complexity behind narrow public surfaces), but it introduces **one concrete ADR-034 boundary violation** (`approvals/public.listActiveManagers` reads the `staff` table directly — `convex/approvals/public.ts:291`) and **one business-rule #15 violation** (`settings.public.setFoundersSummaryEnabled` is missing `idempotencyKey`). Neither is a re-architecture; both are local, file-scoped fixes. Everything else lands cleanly: `APPROVAL_KINDS` is a true deep-module win (one switch hides per-kind divergence; the registry has zero external importers), `chatRegistry.ts` correctly hides its `…Impl` cores as module-private, and the POC `/dev/telegram` callback playground is fully retired with no orphan imports.

The plan-to-implementation fidelity is high: all three P1 corrections from the engineering review (R1 `_writeCache_internal` name, R2 source threading, R3 `total` vs `total_idr`) shipped correctly, the W2b sequencing chain landed in the intended order (verified by commit timestamps), and the staffreview's C3 (`_markResolved_internal` source half-change) was resolved by parameterizing the source argument so both kinds explicitly thread `telegram_approval` end-to-end. Two plan items did NOT ship as designed: (i) the planned separate `mgrAdmin.ts` module was correctly consolidated into `chatRegistry.ts` (better — earned the ADR-037 amend), and (ii) the staffreview I3 boundary-test for `wibDayWindow` was implemented but the test only covers happy-path UTC midpoints, not the 17:00-UTC = WIB-next-day boundary itself (test verified at `convex/lib/time.test.ts`).

Three speculative ports are present but unused at v0.4 (`chunkItems`, `makeNonce`, `callback_data` on the `InlineKeyboardButton` type). Each is small and acceptable as scaffolding for v0.5+ kinds, but they should be acknowledged as dead-code-by-design with a v0.5 retirement gate.

**Counts: Critical 0 · Important 2 · Refinements 6 · Nits 3.**

---

## Critical Issues

**None.** No data-loss, security-hole, schema-corruption, or architecture-irreversibility issues. The two Important findings below are correctness/architecture-rule violations that should be fixed before v0.5 wires more kinds onto the same surface, but neither blocks v0.4 shipping or makes the Frollie Pro graft harder.

---

## Important Issues

### IMP-1 — ADR-034 boundary violation: `approvals/public.listActiveManagers` reads the `staff` table directly

**File:** `convex/approvals/public.ts:291`
**Rule violated:** ADR-034 §"Layer 1 — Internal module boundaries", rule 3: *"Modules talk to other modules only through their `public.ts` or `internal.ts` exports. Direct table access (`ctx.db.query('other_module_table')`) across module boundaries is a CI lint block."*

```ts
// convex/approvals/public.ts:285-296
const req = await ctx.db.query("pos_approval_requests")...      // own module, fine
const all = await ctx.db.query("staff").collect();              // ← AUTH MODULE
return all.filter((s) => s.active && s.role === "manager")...
```

This is the only ADR-034 violation introduced in v0.4. Every other approvals→auth read in this branch correctly routes through `internal.auth.internal._getStaffNameCode_internal` (see `approvals/public.ts:110`, `:152`, `:248`; `approvals/actions.ts:51`, `:249`; `approvals/internal.ts` references). `listActiveManagers` shipped after the original plan was written — it's the v0.4 manager-picker UX addition (commit `7f86084` "manager-identity dropdown") — and the cross-boundary read slipped past because there's no CI lint yet (ADR-034 §"Verification" lists the lint as scheduled for the v0.6 architecture-restructure phase, not yet built).

**Why it matters past code-style:** if/when Frollie POS gets the v1.1 Frollie Pro graft, the `staff` table is one of the most likely to have shape drift (role enum extensions, soft-delete columns, etc.). A cross-deployment shape change here ripples into approvals; a `_listActiveManagers_internal` query in `auth/internal.ts` would absorb that drift behind a stable boundary.

**Fix (~10 minutes):** Add a thin `_listActiveManagers_internal` internalQuery in `convex/auth/internal.ts` returning `Array<{ _id, name, code }>`. Replace the inline `ctx.db.query("staff")` with `ctx.runQuery(internal.auth.internal._listActiveManagers_internal, {})`. Mirror the pattern at `approvals/public.ts:110`. Token-gating stays in `approvals/public.ts` (the new internal is callable from anywhere — ADR-029 token-VIEW gating lives at the caller).

### IMP-2 — Business rule #15 violation: `settings.public.setFoundersSummaryEnabled` lacks `idempotencyKey`

**File:** `convex/settings/public.ts:14-41`
**Rule violated:** CLAUDE.md business rule #15 — *"Every public mutation accepts `idempotencyKey`. Server dedupes for 24h via `pos_idempotency`."* (ADR-013)

```ts
// convex/settings/public.ts
export const setFoundersSummaryEnabled = mutation({
  args: { sessionId: v.id("staff_sessions"), enabled: v.boolean() },  // ← no idempotencyKey
  ...
});
```

The plan's Task 19 example code (lines 1108-1118) omitted the key, and the implementation matches the plan. The `mgr*` chat-registry mutations got their idempotency keys added during the v0.4 spike (Task 12 step 2c — the "SPIKE CORRECTION" note), but the symmetric fix didn't propagate to `setFoundersSummaryEnabled`.

**Why it matters:** the realistic failure mode is a network retry on the toggle. Today this just produces two redundant writes + two `settings.founders_summary_toggled` audit rows for the same logical action — not catastrophic, but inconsistent with how every other v0.4 mutation behaves and an inconsistency that v0.5 will need to either fix or formally exempt. The toggle is also exactly the kind of mutation a manager double-taps when they want to make sure the change "took."

**Fix (~10 minutes):** Add `idempotencyKey: v.string()` and wrap the handler in `withIdempotency` (mirroring `chatRegistry.ts:322-353`). Update `docs/API_REFERENCE.md:175` and the React caller at `src/routes/mgr/telegram-chats.tsx:90-93` to pass `crypto.randomUUID()`. Update the test at `convex/settings/__tests__/settings.test.ts:44` to pass the key.

---

## Refinements (Optional)

### REF-1 — `approvals/public.ts` is shading toward a shallow read-aggregator

`approvals/public.ts` now exports four queries: `getByToken`, `getRequestStatus`, `getRecentPinResetForStaff`, `listActiveManagers` (916 line span across the file). Three of the four reach into `auth.internal._getStaffNameCode_internal` for display fields; one reaches across boundary (IMP-1). The module is still deep — the lifecycle/token-mint/argon2-verify logic lives in `internal.ts` and `actions.ts` — but `public.ts` is starting to function as a "read aggregator with auth-side joins." If v0.5 adds another two display-bearing queries (refund approval, void approval), `getByToken`'s discriminated-union return type will need to span 4-5 variants, and the cross-module joins will need a dedicated `*_display_internal` helper per kind in `auth/`. Not a v0.4 problem; flagging so the v0.5 plan budgets the refactor.

### REF-2 — `APPROVAL_KINDS` registry: passing-grade win, but the `as ApprovalKind` cast in `_listPendingByKind_internal` is a typed-validator escape hatch

`convex/approvals/internal.ts:274-287` declares the arg validator as `kind: v.string()` and does `q.eq("kind", args.kind as ApprovalKind)`. The plan's staff-review I2 flagged this; the implementation kept `v.string()`. An internal caller passing a typo (`"manual_payment_overide"`) gets `[]` back instead of a thrown error. Low risk (one caller — `requestManualPaymentApproval`), but tightening to `v.union(v.literal("staff_pin_reset"), v.literal("manual_payment_override"))` is two lines and aligns with the discipline the schema enforces elsewhere. Same applies to `_createRequest_internal`'s `args.kind as ApprovalKind` casts at `internal.ts:37`, `:57` — though there the arg validator IS a union, so the casts are just stripping the `ApprovalKind` brand and are safe.

### REF-3 — `KIND_AUDIT` map is currently identical for all kinds — earning its complexity?

`convex/approvals/kinds.ts:36-39`:
```ts
export const KIND_AUDIT: Record<ApprovalKind, { requested; resolved; denied }> = {
  staff_pin_reset:         { requested: "approval.created", resolved: "approval.resolved", denied: "approval.denied" },
  manual_payment_override: { requested: "approval.created", resolved: "approval.resolved", denied: "approval.denied" },
};
```

Both rows are identical. Today this maps cost one indirection per audit-row write. The justification — "different kinds may eventually emit different audit action strings" — is plausible for refund (probably wants `refund.requested`/`refund.resolved`/`refund.denied` not the generic `approval.*`) but unproven at v0.4. Keep as-is; just acknowledge in v0.5 that if refund gets the same generic action strings, this map can collapse to a constant. The same reasoning applies to `KIND_TEMPLATE` which maps each kind to a string identical to its own name.

### REF-4 — `lib/chunking.ts`, `lib/telegramHtml.makeNonce`, `InlineKeyboardButton.callback_data?` are dead code

Verified:
- `chunkItems` (`convex/lib/chunking.ts:35`) — only its own tests use it. No call site exists in the v0.4 send paths; founders summary, manual_payment_override, and staff_pin_reset messages are all well under Telegram's 4096-char limit.
- `makeNonce` (`convex/lib/telegramHtml.ts:138`) — only its own test uses it. It exists for `callback_data` button identifiers, which are no longer emitted by any renderer.
- `callback_data?: string` on `InlineKeyboardButton` (`telegramHtml.ts:46`) — no production renderer fills it. The POC `renderApproval` and `renderCustom` that used it were deleted as planned.

All three are ports/legacy kept "for v0.5" — defensible scaffolding, but they need a retirement gate: if v0.5 doesn't introduce a kind that uses chunked messages or `callback_data` flows, delete them in v0.5's hardening phase. Otherwise this is the third v0 in a row that drags forward unused ported helpers.

### REF-5 — `telegram_log` table is still in `telegram/schema.ts`, written by `logOutbound` on every send

The spec/plan called for demoting `telegram_log` to a debug-trail; the implementation kept it AND keeps writing to it on every `sendTemplate` success (`telegram/send.ts:141-145` → `telegram/internal.ts:60-75`). The audit row (`telegram.send_failed`) is the source of truth for failures; `telegram_log` is parallel. The previous plan-staffreview (I6) explicitly raised this; the implementation answer is "keep both." Acceptable, but if it stays, every reader needs to know which one to trust. Document the contract in `docs/SCHEMA.md` ("telegram_log is debug-trail only; audit_log is authoritative") rather than leaving the question open for the next person who looks. The CLAUDE.md description does already say this; the schema comment in `telegram/schema.ts:236-237` does too. Good — just verify the cron's failure audit path doesn't write both.

### REF-6 — Real-time subscription load: `useApproval` → `getRequestStatus` is one query per pending approval per stall, fine at v0.4, watch at v1.1+

The charge screen subscribes to `getRequestStatus` while waiting for off-booth approval (`src/components/pos/ApprovalPending.tsx:20` → `useApproval` → `useQuery(getRequestStatus)`). One subscription per pending request per active stall. v0.4 = single booth, single device = 1 subscription. v1.1 multi-stall = N stalls × M pending approvals. Still tiny. The only nuance: when v0.5 adds refund approval, a manager might have 3-4 pending approvals open at once → 3-4 subscriptions on the manager dashboard. Convex handles this trivially; flagging only because the design pattern (one query per request) doesn't scale to "queue of 100 pending approvals" by itself. A `getMyPendingApprovalsForStaff` paginated query is the right shape when that surface lands.

---

## Nitpicks

### NIT-1 — `chatRegistry.ts` `assertKnownRole` is called twice in `mgrAssignRole`

`mgrAssignRole` (`chatRegistry.ts:340`) inlines an `isKnownTelegramRole` check and then calls `assignRoleImpl` which also calls `assertKnownRole` (`chatRegistry.ts:218`). Defensible defense-in-depth (the `mgr*` surface checks before any state mutation; the impl checks regardless of caller), but a one-line comment at the inline check would clarify intent. PROGRESS.md actually notes this: "redundant `isKnownTelegramRole` check in `mgrAssignRole` (defensible defense-in-depth since `assignRoleImpl` also checks)." Good — keep but document.

### NIT-2 — `src/routes/mgr/telegram-chats.tsx:17` imports from `convex/telegram/config`

```ts
import { KNOWN_TELEGRAM_ROLES } from "../../../convex/telegram/config";
```

This is a frontend route reaching directly into a backend module's config file. It works (the file is pure TS, no Convex runtime), and `KNOWN_TELEGRAM_ROLES` is genuinely a shared compile-time constant — but it bypasses the implicit "frontend talks to backend through `_generated/api`" convention. Either acceptable (config is constants, not runtime) or move the constant to a shared `src/lib/telegram-roles.ts` and have backend `config.ts` import from there. Same risk as `convex/_generated/dataModel` imports the frontend already makes — low.

### NIT-3 — `wibDayWindow` test coverage misses the 17:00-UTC boundary

`convex/lib/time.test.ts` tests `wibDayWindow` with mid-day UTC timestamps but doesn't probe the boundary explicitly (the I3 nit from plan-staffreview). The classic bug — a sale at 16:59 UTC = 23:59 WIB day N rolling into 17:00 UTC = 00:00 WIB day N+1 — would only show up on a paid txn timestamp that happens to land near boundary. Add a single test asserting `wibDayWindow(Date.UTC(2026, 4, 30, 16, 59, 59))` returns `dateLabel: "2026-05-30"` and `wibDayWindow(Date.UTC(2026, 4, 30, 17, 0, 0))` returns `dateLabel: "2026-05-31"`. 10 minutes.

---

## Module Depth Assessment

Per ADR-034, a module is "deep" when its public surface is narrow relative to the implementation it hides. Here is the v0.4 delta per touched module.

| Module | Pre-v0.4 surface | Post-v0.4 surface | Implementation hidden | Verdict |
|---|---|---|---|---|
| **`approvals/`** | 1 kind (`staff_pin_reset`); `public.getByToken`, `actions.approveStaffPinReset`, `actions.notifyStaffLockout` | 2 kinds; +`public.getRequestStatus`, `+public.getRecentPinResetForStaff`, `+public.listActiveManagers`, `+actions.requestManualPaymentApproval`, `+actions.approveManualPayment`, `+actions.denyRequest` | `APPROVAL_KINDS` registry + per-kind context validator + 5 new internals (`_markDenied`, `_listPendingByKind`, `_linkTelegramMessage`) + denied lifecycle + token-on-row generalization | **Deeper.** Public surface grew ~3× but implementation grew ~5×. `APPROVAL_KINDS` is the canonical add-a-kind mechanism with zero external importers (verified via grep) — it's a textbook deep-module pattern. One leak: `listActiveManagers` reaches into `staff` directly (IMP-1). |
| **`telegram/`** | POC: hardcoded `TELEGRAM_CHAT_ID`, callback handler at `/dev/telegram`, `sendTemplate(payload: v.any())` | Role-routed (`getChatIdByRole`), `telegramChats` registry with `mgr*` admin twins, command-registry webhook, typed `sendTemplate` per-kind, audited failures, `foundersSummary` cron | Self-registration, `chatRegistry` impl cores private, `commands.ts`/`registryCommands.ts` ported infrastructure, `cronRetry` policy, dedupe via `telegramUpdates`, `lastError` per-chat, env-var migration shim | **Significantly deeper.** No external importer of `internal.ts`, `chatRegistry.ts`, `commands.ts`, `webhook.ts`, `foundersSummary.ts` outside `convex/` (verified via grep). One nit: `src/routes/mgr/telegram-chats.tsx` imports `KNOWN_TELEGRAM_ROLES` from `telegram/config.ts` (NIT-2) — a compile-time constant cross, acceptable but worth noting. |
| **`settings/`** | n/a (new) | `public.getSettings`, `public.setFoundersSummaryEnabled`, `internal._getSettings_internal` | `pos_settings` singleton + read-time default + audit-on-toggle | **Born deep (and small).** 14-line schema, 9-line internal, 41-line public. The default-when-absent pattern (returns `true` when row missing) means callers never see "no settings yet" as an error state. Pre-empts the entire row-not-found class. The IMP-2 idempotency gap is the only blemish. |
| **`audit/`** | Closed source-enum union | Same shape; one additive literal (`telegram_approval`) | none | **Depth unchanged.** Additive union extension was the right call — the plan-staffreview's Improvement #1 paid off: 288 existing tests stayed green, no test had to flip `wa_approval` → `telegram_approval` assertions. |
| **`transactions/`** | Owns `pos_transactions`, `pos_transaction_lines`, `pos_receipt_counters` | + `_getTxnSummary_internal` (used by approvals), + `_dailySalesSummary_internal` (used by founders cron) | aggregate logic stays in module; cross-module reads route through these internals | **Deeper.** Two new internal queries that absorb cross-module reads from approvals and telegram. ADR-034 §"Cross-module" pattern executed correctly. |
| **`payments/`** | `_onPaidManual_internal({ idempotencyKey, txnId, reason, mgr_approver_id })` | + optional `source` arg threaded to `_confirmPaid_internal.approvalSource` | source-threading parameterization | **Depth unchanged.** Parameter widening, no new surface. The R2 source-threading fix from plan-eng-review landed correctly and is now testable. |
| **`auth/`** | `_getStaffNameCode_internal`, `_getByCode_internal`, `_resolveSession_internal`, `_recordFailedAttempt_internal`, `_changePinCommit_internal` | + `_requireManagerSession_internal` (action-callable session gate) | wraps existing `requireManagerSession` from `auth/sessions.ts` | **Depth unchanged.** Adding an internalQuery wrapper around a pure helper so actions can call it is correct (actions can't `ctx.db.get` directly). The spike-correction note in the plan flagged this need; it shipped clean. |

**Aggregate:** approvals and telegram are the two modules with substantial new implementation in v0.4, and both are deeper than they were. settings is born deep. transactions, payments, auth gained narrow internals to absorb cross-module reads — exactly what ADR-034 prescribes. The one ADR-034 violation (IMP-1) is local, fixable in ~10 minutes, and doesn't represent a pattern — it's an outlier that slipped past because no lint enforces the rule yet.

---

## Graft Integrity (Frollie Pro v1.1+)

ADR-034 commits POS to keep internal schema independent of Frollie Pro and to integrate via versioned `convex/api/v1/` HTTP actions. The v0.4 changes either help or are neutral on this:

- **`pos_approval_requests` multi-kind:** the generic `entity_type`/`entity_id` + `context: v.any()` (validated by writer-time switch) is **graft-friendly.** Frollie Pro never reads approval requests across deployment boundaries; even if v1.1 added a `refund_approval` kind that needed Frollie Pro to know about it, the kind name is a stable string ID, not a `_id`. The token-on-row pattern (no separate `pos_approval_tokens` table) is also graft-neutral.
- **`telegramChats` registry + role indirection:** **graft-irrelevant.** This is pure POS-internal operational state; Frollie Pro neither reads nor cares. Role names (`managers`/`founders`) are POS-owned strings.
- **`pos_settings` singleton with read-time default:** **graft-friendly.** Singleton-with-default tolerates v1.1's first cron firing before any settings row is seeded. Future fields slot in trivially.
- **`telegram_approval` source literal (additive):** **graft-friendly.** Historical `wa_approval` rows survive untouched. Any future v1.0 source consolidation is a localized rename, not a cross-deployment migration.
- **The `staff` direct read at `approvals/public.listActiveManagers` (IMP-1):** the one v0.4 graft risk. If v1.1+ ever syncs Frollie Pro staff metadata into POS (currently out of scope per CLAUDE.md), the direct table read becomes a tighter coupling than the `auth/internal` boundary would be. Fix per IMP-1.

---

## Plan Fidelity

Verified against `docs/superpowers/plans/2026-05-29-v0.4-telegram-approval.md` and the two prior staffreviews.

**Promised, shipped, correct:**
- ✅ Generalized `pos_approval_requests` with `kind` union + denied lifecycle + `by_kind_status` index (Task 1)
- ✅ `telegramChats` + `telegramUpdates` ported verbatim (Task 2)
- ✅ `pos_settings` singleton + composition (Task 3)
- ✅ Additive `telegram_approval` source (Task 4) — kept `wa_approval` per plan-staffreview Improvement #1
- ✅ `APPROVAL_KINDS` registry with `validateContext` single-writer invariant (Task 6)
- ✅ `_createRequest_internal` generalized + context-validates (Task 7)
- ✅ `_markDenied_/_listPendingByKind_/_linkTelegramMessage_` lifecycle internals (Task 8)
- ✅ `getByToken` discriminated union + `getRequestStatus` reactive (Task 9)
- ✅ Lib helpers ported (Task 11)
- ✅ `chatRegistry.ts` ported with `admin*` → `mgr*` adaptation IN-FILE (Task 12) — confirmed no separate `mgrAdmin.ts`, matches the spike's recommendation in ADR-037
- ✅ `mgr*` mutations idempotent (the SPIKE CORRECTION 2c landed)
- ✅ `mgrSendTest` as action with `_requireManagerSession_internal` gate (the SPIKE CORRECTION 2b landed)
- ✅ Telegram webhook rewrite + `/dev/telegram` retirement (Task 14)
- ✅ `config.ts` roles (Task 15)
- ✅ `http.ts` rewired (Task 17)
- ✅ `sendTemplate` typed payload union, role-routed, idempotent, audited failures (Task 18)
- ✅ Settings module (Task 19) — except IMP-2
- ✅ `requestManualPaymentApproval` request path (Task 20)
- ✅ `approveManualPayment` — `source: "telegram_approval"` threaded end-to-end through `_onPaidManual_internal` → `_confirmPaid_internal` (Task 21) — this resolves both R2 from plan-eng-review AND C3 from plan-staffreview by parameterizing `_markResolved_internal.source` rather than hardcoding
- ✅ `denyRequest` kind-agnostic (Task 22)
- ✅ Founders aggregate + renderer (Task 23)
- ✅ `sendFoundersSummary` + resilient wrapper (Task 24)
- ✅ `crons.ts` (Task 25)
- ✅ `useApproval` + `ApprovalPending` + charge inline + `/mgr/telegram-chats` (Tasks 26-30)
- ✅ ADRs + docs (Tasks 32-33)
- ✅ PROGRESS.md retrofit (Task 34)

**Promised, shipped differently (defensibly):**
- ⚠️ Plan promised `mgrAdmin.ts` (Task 16) — implementation correctly consolidated into `chatRegistry.ts`. ADR-037 was amended to document the consolidation as a deliberate decision. Win.
- ⚠️ Plan-staffreview I3 promised a 17:00-UTC boundary test for `wibDayWindow` — implementation has the helper + tests but the boundary-flip case is not explicit (NIT-3).
- ⚠️ Plan-staffreview C3 was resolved by parameterizing `_markResolved_internal.source` (correct fix per C3 option (b)) AND flipping `approveStaffPinReset` to pass `"telegram_approval"` (consistent move). Both kinds now consistently audit `telegram_approval` for off-booth resolves. The `auth/internal.ts:304-310` `changePinSourceValidator` widened to accept `telegram_approval` too — exactly the widening R10 in plan-eng-review predicted would be necessary if pin-reset re-pointed.

**Drifted from plan (the new findings):**
- ❌ IMP-1: `listActiveManagers` was added post-plan (manager-identity dropdown UX) and reaches into `staff` directly.
- ❌ IMP-2: `setFoundersSummaryEnabled` matches plan-as-written but the plan itself omitted `idempotencyKey`. The `mgr*` mutations got the idempotency-key treatment during the spike; settings did not.

**Scope creep (defensible):**
- Post-plan commits 7e16e8c (login toast on deny), 4187bab (differentiate denied vs resolved), 2efe33e (Decline option on `staff_pin_reset`), 7f86084 (manager dropdown picker) — all are UX hardening discovered during the v0.4 walk. They are documented in PROGRESS.md as the v0.4 SHIPPED block. None expand backend surface; all are within `/approve` and `/login` routes.

---

## Top recommendations

1. **Fix IMP-1 (~10 min):** add `auth/internal._listActiveManagers_internal`, route `approvals/public.listActiveManagers` through it.
2. **Fix IMP-2 (~10 min):** add `idempotencyKey` to `settings.setFoundersSummaryEnabled` + wrap with `withIdempotency`. Update API_REFERENCE, the React caller, and the test.
3. **Pick one of the dead-code helpers (REF-4) to retire now** (`makeNonce` is the cleanest delete — no v0.5 caller plan), and add a v0.5 hardening-phase TODO to revisit `chunkItems` and `callback_data?`.
4. **Add the 17:00-UTC boundary test (NIT-3)** for `wibDayWindow` — one assertion, prevents the off-by-one that the `pos_receipt_counters` comment specifically warns about.
5. **Defer the bigger refactor:** REF-1 (`approvals/public.ts` aggregator drift) should be picked up in the v0.5 plan, not now — the right time to introduce `*_display_internal` per kind is when refund/void approval kinds arrive.

---

*Generated by reviewer #3 — senior-eng architecture lens (deep-module discipline)*
