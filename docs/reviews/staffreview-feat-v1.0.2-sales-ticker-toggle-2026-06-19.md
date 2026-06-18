# Staff Review — feat/v1.0.2-sales-ticker-toggle

**Date:** 2026-06-19
**Reviewer:** Senior Eng (architectural review)
**Branch:** `feat/v1.0.2-sales-ticker-toggle`
**Diff range:** `1eb6dc6..8d92a9b`
**Changed files (code):** `convex/settings/public.ts`, `convex/settings/__tests__/settings.test.ts`, `src/routes/mgr/telegram-chats.tsx`, `src/routes/mgr/telegram-chats.test.tsx`
**Changed files (docs):** `CLAUDE.md`, `docs/API_REFERENCE.md`, `docs/CHANGELOG.md`, `docs/RUNBOOK-telegram.md`, `docs/SCHEMA.md`

---

## Summary

**Module depth: unchanged — this is a correct, minimal surface widening.**

`setTxnTickerEnabled` is a genuine new manager capability (surfacing a previously dashboard-only kill-switch) backed by a non-trivial toggle. The public interface widening is fully earned. No information leakage, no cross-module internal.ts reach, no schema migration risk. The idempotency + audit harness is fully reused. The deliberate clone-over-abstract decision for two toggles is the right call at this scale. Plan fidelity is exact. No architectural risks identified.

---

## Critical Issues

None.

---

## Improvements

### 1. `setFoundersSummaryEnabled` insert branch has a latent cross-toggle default gap — not introduced by this PR, but exposed by it

**Severity:** Important (pre-existing bug exposed by the new clone)

**Finding:** `setFoundersSummaryEnabled`'s insert branch (`else` path, `public.ts` lines 52–56) does NOT default `txn_ticker_enabled`:

```ts
// setFoundersSummaryEnabled — insert branch (lines 52-56)
await ctx.db.insert("pos_settings", {
  founders_summary_enabled: args.enabled,   // ← only field set
  updated_at: Date.now(),
  updated_by: staffId,
});
// txn_ticker_enabled is absent — row reads back as undefined → default true at read time
```

By contrast, `setTxnTickerEnabled`'s insert branch correctly defaults the sibling:

```ts
// setTxnTickerEnabled — insert branch (lines 103-108) — CORRECT
await ctx.db.insert("pos_settings", {
  founders_summary_enabled: true,      // ← sibling defaulted explicitly
  txn_ticker_enabled: args.enabled,
  updated_at: Date.now(),
  updated_by: staffId,
});
```

The test `"insert branch defaults founders_summary_enabled to true (not clobbered)"` in `settings.test.ts` (line 126) correctly validates that `setTxnTickerEnabled` does NOT clobber `founders_summary_enabled` — and it passes. But there is no symmetric test for `setFoundersSummaryEnabled` inserting a row without clobbering `txn_ticker_enabled`.

**Impact assessment:** In production today, the `pos_settings` row is already populated (v1.0.1 shipped `txn_ticker_enabled` and the field has been written). The insert branch only fires on an empty DB — meaning dev seeds or a completely fresh deployment. The absence of `txn_ticker_enabled` in a `setFoundersSummaryEnabled`-created row means `txn_ticker_enabled` reads back as `undefined`, which resolves to `true` via `?? true` at read time. So the functional behavior is correct today.

**Risk:** The pattern is asymmetric between the two mutations and will only become a real bug when a third notification toggle is added and one sibling's insert branch forgets to default it. This PR did it right for the new mutation; it left the old mutation partially inconsistent.

**Recommendation:** In a follow-up (not a blocker): either (a) add `txn_ticker_enabled: true` to `setFoundersSummaryEnabled`'s insert branch and add the symmetric test, or (b) extract a `buildDefaultSettingsRow()` helper that always includes all required non-optional fields plus explicit `true` defaults for optionals, used by both insert branches and `updateReceiptConfig`. Option (b) is the rule-of-three trigger (three insert branches already exist: `setFoundersSummaryEnabled`, `setTxnTickerEnabled`, `updateReceiptConfig` — all hand-constructing the same shape). Worth tracking as a task.

---

### 2. `getSettings` exposes `txn_ticker_enabled` without session auth — confirm intentional

**Severity:** Improvement (worth a comment, not a code change)

**Finding:** `getSettings` is an unauthenticated query (no `sessionId`). It now returns two notification toggle flags. This is consistent with its prior shape (it already returned `founders_summary_enabled` unauthenticated) and is called from `FoundersSummaryToggle` and `TxnTickerToggle` within a manager-session-gated page. The write mutations are correctly session-gated. So the read side being unauthenticated is not a security issue — these are non-sensitive boolean flags.

However, the API_REFERENCE entry updated in the PR still says "Public-readable" for `getSettings`, which is accurate. The concern is forward-looking: if a future engineer adds a sensitive field (e.g., a fee threshold or a phone number) to `getSettings`, the unauthenticated read pattern is a ready-made leak vector.

**Recommendation:** Add a one-line comment above `getSettings` in `public.ts` stating that this query is intentionally unauthenticated and is restricted to non-sensitive notification preference flags. This makes the decision explicit and gives future engineers a clear signal before widening the return shape.

---

## Refinements

### 3. `TxnTickerToggle` issues a fresh `crypto.randomUUID()` idempotency key on each click — correct but could be misread

The pattern (`idempotencyKey: crypto.randomUUID()`) is correct: each user click is a distinct intent, so a new UUID is appropriate. The founders toggle uses the same pattern. However, unlike a form submit, a toggle flip that bounces (click → error → retry click) will correctly de-duplicate within the same React event since `busy=true` disables the switch during the pending call. No issue — just worth noting in the review that the UUID-per-click approach is intentional and safe here.

### 4. Mutation-order test harness remains position-indexed — acceptable, documented, but fragile

**Finding:** `setupMutationMock()` in `telegram-chats.test.tsx` uses a module-level call-order counter (0=founders, 1=ticker, 2=assignRole, 3=archiveChat, 4=restoreChat). Adding any new mutation to the page will require re-indexing all five slots plus all `beforeEach` blocks. This PR correctly updates all four `beforeEach` blocks and the header comment.

**Risk:** The next PR that adds a mutation to this page (or inserts one between existing components) will need the same mechanical re-index. The test-file header comment documenting the order is present and accurate, which is the mitigation.

**Not a blocker.** The harness was pre-existing; this PR maintains it correctly. The long-term fix (switch to per-mutation mock registration by reference) is worth a follow-up task if a third toggle lands on this page.

### 5. No `aria-describedby` connecting the `<span>` description to the `<Switch>`

**Finding:** The `<Label>` contains a nested `<span className="ml-1 text-xs text-muted-foreground">(silent)</span>` that provides supplemental context. The `<Switch>` has `aria-label="sales ticker toggle"` but the label text ("Post each paid sale...") and the span text ("silent") are associated via `htmlFor` on the label, which is correct for click coupling but doesn't guarantee that screen readers will read the nested span as part of the switch's accessible description.

The founders toggle has an identical structure, so this is consistent. The current approach is acceptable for internal-tool use (staff-only, not customer-facing). Not blocking.

### 6. `SCHEMA.md` audit-verb section — `settings.founders_summary_toggled` was added alongside the new verb, but it was missing before this PR

The diff adds two audit verbs to `SCHEMA.md`:
```
settings.founders_summary_toggled  # setFoundersSummaryEnabled — ...
settings.txn_ticker_toggled        # setTxnTickerEnabled (v1.0.2) — ...
```

`settings.founders_summary_toggled` was a pre-existing audit verb from `setFoundersSummaryEnabled` (v0.4/v0.5) that was not previously documented in the audit-verb list. This PR adds it as a side-effect of adding the sibling verb. This is a net positive (the doc is now more complete), but it means the founders verb is labeled without a `(v0.4)` or `(v0.5)` version tag while the ticker verb has `(v1.0.2)`. Minor inconsistency in version annotation style.

---

## ADR-034 Depth Assessment

| Criterion | Status | Notes |
|---|---|---|
| Module owns its table (`pos_settings`) | PASS | No cross-module `ctx.db` reach |
| Public surface earned | PASS | Genuine new manager capability, not wrapper churn |
| Internal.ts not crossed | PASS | `_getSettings_internal` consumed only by other modules' own code; not reached from `settings/public.ts` |
| Caller knows no table internals | PASS | Args are `{ sessionId, enabled }` — no table shape leaks |
| Cross-module reads via owner API | PASS | `txnTicker.ts` reads the toggle via `internal.settings.internal._getSettings_internal` (correct internal-to-internal path) |
| Graft integrity (v1.1+ Frollie Pro) | PASS | `settings` module is POS-local (`pos_settings`); no external API surface widening; no schema coupling risk |
| No schema migration | PASS | `txn_ticker_enabled: v.optional(v.boolean())` existed since v1.0.1 |

---

## Plan Fidelity

| Plan item | Status | Notes |
|---|---|---|
| `getSettings` returns `txn_ticker_enabled` | DONE | Exact match |
| `setTxnTickerEnabled` mutation (manager-session, idempotent, audited) | DONE | Exact match |
| Backend tests: auth-reject, idempotency replay, insert-default, read-default | DONE | 4 tests, all conformant |
| `TxnTickerToggle` component | DONE | Exact match to plan spec |
| Render beneath founders toggle | DONE | Exact match |
| Mutation mock re-index (0→4) | DONE | All 4 `beforeEach` blocks updated |
| Frontend tests: checked/unchecked/toggle-off/toggle-on | DONE | 4 tests |
| 5 docs updated | DONE | SCHEMA.md, RUNBOOK-telegram.md, CLAUDE.md, API_REFERENCE.md, CHANGELOG.md |
| Plan noted `setupQueryMock` needs no change | DONE | Query mock is args-shape-dispatched; TxnTickerToggle's second `useQuery(getSettings, {})` receives the same stub automatically |

**No gaps. No scope creep. No shortcuts.**

---

## Clone-vs-Abstract Assessment

The plan explicitly chose to clone `setFoundersSummaryEnabled` rather than abstract a shared `setNotificationToggle` helper. This is the correct call at two toggles. The rule-of-three is not yet triggered for the mutation itself (two instances). However:

- The **insert branch** is now at three instances (`setFoundersSummaryEnabled`, `setTxnTickerEnabled`, `updateReceiptConfig`) — rule-of-three is triggered for the `pos_settings` insert shape. A `buildDefaultSettingsRow()` helper would eliminate the drift risk noted in Improvement #1.
- The **frontend toggle component** is at two instances (`FoundersSummaryToggle`, `TxnTickerToggle`) — not yet at three. Clone is still correct.
- The **test seed helper** (`seedSessions`) was correctly extracted as a local function within the `setTxnTickerEnabled` describe block rather than duplicating inline, which is good.

---

## Verdict

APPROVE with follow-ups:
1. Track the `setFoundersSummaryEnabled` insert-branch gap (Improvement #1) as a task — not a blocker.
2. Consider extracting `buildDefaultSettingsRow()` if/when a third notification toggle lands (Improvement #1 / Clone assessment).
3. Add the unauthenticated-read comment to `getSettings` (Improvement #2) — one line, low effort.
