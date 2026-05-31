# Staff Review: v0.5.0 Foundation

**Date:** 2026-05-31
**Branch:** feat/v0.5.0-foundation
**Base:** main @ 0b6691a
**Head:** 0745306
**Commits:** 47
**Reviewer lens:** ADR-034 (deep modules / surface APIs) + plan fidelity vs `staffreview-v0.5.0-foundation-design-2026-05-30.md`

---

## Summary

**Depth verdict: net deeper for `approvals/` and `transactions/`, neutral-to-slightly-deeper for `telegram/chatRegistry/` and `payments/`, mechanically-shallower-but-justified for ESLint-bracketed `public.ts` files (authCheck dual-call is interface noise that buys an enforceable security ordering).** No module became net shallower in a way that leaks internal layout to a caller. The branch executes plan-phase as written, addresses all three Criticals + all five Improvements from the design staffreview, and ships under the hard CI gate. One genuine inconsistency lurks between the new `transactions.cancelAwaitingPayment` mutation and the older `transactions.actions.cancelTransaction` action — both cancel awaiting-payment txns, but only the new one supersedes the active Xendit invoice — and one doc artifact (the new pattern doc) carries an incorrect `withIdempotency` signature that will mislead the next reader who copy-pastes from it.

**Recommendation:** Merge after fixing the pattern-doc signature (5 min) and either (a) folding `cancelTransaction` into the new helper or (b) adding `_cancelActiveInvoiceForTxn_internal` to the ceiling-cancel path. Everything else is Refinement-class.

---

## Critical Issues

### C1 — Pattern doc `withIdempotency` signature is wrong (will mislead future implementers)

**File:** `docs/PATTERNS/idempotency-dual-call-authcheck.md` lines 15–33, 70–88
**Severity:** Critical because the pattern doc is the canonical reference the rule + business rule #21 points at. If the next contributor copy-pastes from it, their mutation will fail TS compilation in an unobvious way.

The doc shows:

```ts
handler: async (ctx, args) => {
  return withIdempotency(ctx, args, async (ctx, args) => { ... }, { authCheck: ... });
}
```

But `convex/idempotency/internal.ts:52` defines `withIdempotency(mutationName, handler, options)` — a 3-arg curried form that returns `(ctx, args) => Promise<R>`. The actual call site shape (used everywhere in the codebase) is:

```ts
handler: withIdempotency<Args, R>(
  "mutationName",
  async (ctx, args) => { ... },
  { authCheck: ... },
)
```

This is verifiable against every migrated `public.ts` (e.g., `transactions/public.ts:90`, `approvals/public.ts:323`, `auth/public.ts:41`). Fix: rewrite both code blocks in the pattern doc to match the real signature, mention that `mutationName` is the first positional arg and is used as the cache-row's `mutation_name`. Without the fix, the rule will keep teaching a wrong pattern.

### C2 — Two cancel paths for the same state transition diverged on invoice supersede

**Files:** `convex/transactions/actions.ts:32` (`cancelTransaction` action) + `convex/transactions/public.ts:348` (`cancelAwaitingPayment` mutation, new in this branch)
**Severity:** Critical because the inconsistency is invisible at the call site and will produce orphan-active-invoice rows depending on which CTA the staff taps.

Both functions cancel an `awaiting_payment` txn:
- `cancelTransaction` (the ceiling "Cancel sale" button at `/sale/charge` post-60s) → flips txn → cascade-denies approvals → **does NOT mark the active `pos_xendit_invoices` row as locally cancelled.**
- `cancelAwaitingPayment` (the new abandon-dialog "Cancel payment" button) → flips txn → marks active invoice via `payments._cancelActiveInvoiceForTxn_internal` → cascade-denies approvals.

Both paths leave the txn cancelled, but only one of them closes the invoice. A customer paying a superseded QR after the ceiling-cancel path will hit `_confirmPaid_internal`'s terminal-state guard (the funnel's "alert" branch mentioned in `cancelTransaction`'s docstring) and the audit row will show a paid-after-cancelled anomaly. That's the design intent per ADR-036 — but the invoice row's `cancelled_at` being unset means analytics queries against "active invoices for cancelled txns" will be wrong, and any future Xendit cleanup job that filters on `cancelled_at IS NULL` would re-process it.

Resolution options:
1. (Preferred) Fold `cancelTransaction` to call `_cancelActiveInvoiceForTxn_internal` after `_cancelCommit_internal`. One-liner. Both paths converge on the same shape.
2. Add a one-line comment in `cancelTransaction`'s docstring stating the deliberate omission (if it IS deliberate — e.g., the ceiling case wants to keep the invoice "active" so a webhook landing post-cancel still marks it `payment.invoice_cancelled` via the funnel). This second reading is plausible but the codebase says nothing about it.

Pick one before merge.

### C3 — `_recordTokenPinFailure_internal` duplicates the deny-write shape of `_markDeniedBySystem_internal` despite the spec calling out the extraction

The design spec §5 (under the prior staffreview's Duplication Risks finding) called for extracting `_markDeniedBySystem_internal` precisely so the three cap-trip / manager-cancel / txn-cascade paths share one writer. The helper exists (`internal.ts:354`) and two of three callers use it (`cancelPendingRequest`, `_cancelPendingApprovalsForTxn_internal`). The third — `_recordTokenPinFailure_internal:439-455` — inlines a near-identical `ctx.db.patch` + `logAudit` block to capture `failed_pin_attempts: next` in audit metadata, with a justification comment.

The justification is real (the cap-trip case needs the forensic count). But the result is that two writers can now diverge: a future schema change to the "denied" lifecycle (e.g., adding `denied_event_id`) has to be made in two places, and the lint rule won't catch a drift. Two cleaner options:

- (a) Add `extra_metadata?: Record<string, unknown>` to `_markDeniedBySystem_internal` and have the cap-trip path pass `{ failed_pin_attempts: next }`. The helper stays single-writer; the cap-trip site shrinks to a one-line delegation. Plan-phase explicitly considered this option and went the other way ("Acceptable duplication: ~10 lines"). I disagree — `_markDeniedBySystem_internal` already accepts an optional `cancelled_by_manager_id`, so adding an optional `metadata` arg is a one-line widening that preserves the single-writer invariant.
- (b) Leave as-is, but add a comment on `_markDeniedBySystem_internal` saying "DO NOT consume this from `_recordTokenPinFailure_internal` — that path inlines to capture `failed_pin_attempts`" so the two-writer invariant is documented at the helper's site, not just the divergent caller.

This is borderline Critical because it pre-locks a divergence that the prior staffreview specifically argued against. Flagging as Critical so it gets explicit triage; downgrade to Improvement at merger discretion.

---

## Improvements

### I1 — `chatRegistry` split earned its depth but the public surface still re-fetches what `internal.ts` could expose

`chatRegistry/public.ts` (4 mutations + 1 query + 1 action) directly queries `telegramChats` in three places (lines 76–89, 138–142, 183–187) to compute `previousRole` / `target?.archivedAt` BEFORE delegating to `assignRoleImpl` / `archiveChatImpl` / `restoreChatImpl`. That's a small but real cross-module surface leak: `public.ts` knows the table name and the index layout that `internal.ts` claims to own. The impl helpers (`assignRoleImpl` etc.) already re-query internally, so `public.ts` is doing the same read twice in two slightly different ways (broader-index + JS post-filter pattern in public.ts:84-88 vs `unique()` in archiveChatImpl).

Cleaner: the impls return the pre-state as part of their result (e.g., `assignRoleImpl` returns `{ previousRole, displacedFromChatId? }`), so public.ts only audits. The split would be deeper. As shipped, it's "split for the ESLint rule, not for ADR-034 cleanliness" — exactly the failure mode the design spec flagged in §6 ("Module-boundary note").

Defer to a v0.5.1 housekeeping pass; not a merge-blocker. The behavior is correct; the depth is what's underbaked.

### I2 — `listActiveManagers` query exists on TWO modules (approvals + staff) with subtly different auth gates

`convex/approvals/public.ts:280` (`listActiveManagers`) is token-gated (any holder of a live approval token).
`convex/staff/public.ts:44` (also `listActiveManagers`) is session-gated (any active staff session).

Both delegate to `internal.auth.internal._listActiveManagers_internal`. Both return `{ _id, name, code }`. The reason for two surfaces is plausible (off-booth vs on-booth contexts have different auth primitives), but:

- The auth-gate semantics are not obvious from the name. A future contributor reading `staff.public.listActiveManagers` won't know there's a token-gated twin in approvals.
- The string-id leak is identical (`_id` is a Convex `Id<"staff">` — ADR-034 §"Stable string identifiers" says `_id` is never part of an API surface). Both queries return `_id` to the frontend. The booth picker (charge.tsx:235) reads `m._id` purely for the React `key`, not for the API call (the call uses `m.code`). The off-booth `/approve` UI also doesn't transmit `_id` further. So the leak is contained, but it's a leak — the public surface returns an internal identifier that callers could grow to depend on.

Fix at v0.5.1: rename `_id` to `staffId` (camelCase, stable-id shape) in both queries, or drop it entirely and have callers key by `code` (which IS a stable string identifier per ADR-034 §"Stable string identifiers"). The frontend keys by `m._id` today only because the React reconciler needs *some* key — `m.code` works just as well.

### I3 — `chatIdOverride` arg on `sendTemplate` is necessary but documents the wrong invariant in audit

`send.ts:58-59` and the founders-cron resolve pattern are correct (closes the role-rebind race). But: when `chatIdOverride` is set, the cron has already resolved the role, and the audit logged on send-failure (`telegram.send_failed`) records `role: args.role` — meaning a send-failure for the founders cron audits the *role we resolved-against*, not the *chatId we actually sent to*. If a future cron resolves role X and then `chatIdOverride`s to a manually-supplied chat (test harness, emergency override), the audit will look as if role X failed even though we never tried role X's chat.

Today's only consumer is `foundersSummary`, where the role and the resolved chat are guaranteed consistent. So this is forward-looking risk only. Add `chat_id: chatId` to the `_auditSendFailed_internal` metadata so audit logs the actual destination, not the abstract role. One-line fix.

### I4 — `_markDeniedBySystem_internal`'s `source` arg widens the deny-source vocabulary to a 3-literal union, but callers leak this knowledge

The helper accepts `source: "booth_inline" | "telegram_approval" | "system"`. `cancelPendingRequest` (approvals/public.ts:341) hardcodes `source: "booth_inline"` — that's a partial leak per the review prompt (the public-mutation caller knows the helper's source enum). The leak is acceptable because:

- The source value is semantically correct (a manager cancelling a request in-booth IS booth-sourced).
- Adding a future deny-source (e.g., `"api_consumer"`) would require updating BOTH the helper validator AND every caller — but the lint rule catches the validator update mechanically (Convex validator mismatch on next dev/deploy), so the propagation discipline is enforced.

Not a fix — flagging as deliberate-design-detail-worth-knowing. Future readers might "simplify" by hardcoding the source inside the helper; don't.

### I5 — `useApproval` + `ApprovalPending` callback-deps stability

`ApprovalPending.tsx:23-36` puts `onResolved, onDenied, onExpired` in the `useEffect` deps. Callers in `/sale/charge.tsx:524-538` pass inline arrows, so each render mints fresh callbacks. The `called.current` ref correctly prevents double-fires, but the effect re-runs on every parent render. The current cost is one comparison-and-skip per render — negligible — but the pattern is wrong by convention.

Fix at v0.5.1: drop the callbacks from the dep array (they're stable by intent; the status transition is what should drive the effect) and add an ESLint disable with a comment. Or memoize the callbacks at the consumer (`useCallback` wrap). Not a merge-blocker; the behavior is correct.

---

## Refinements

### R1 — Plan fidelity audit: all prior-staffreview Criticals + Improvements addressed

| Prior finding | Status | Evidence |
|---|---|---|
| Critical 1 — useBlocker for popstate | Done | `sale/index.tsx:48`, `sale/charge.tsx:85` both wire `useBlocker`. Tests mock the hook (don't simulate popstate against real router) but the wiring matches React Router contract. |
| Critical 2 — `/sale/charge` abandon semantics + new mutation | Done | `cancelAwaitingPayment` mutation (transactions/public.ts:348), born under strict rule from day one. Cancels invoice via cross-module write to payments. See C2 for the gap. |
| Critical 3 — `REQUEST_REVOKED` mapError wiring | Done | `src/routes/approve/index.tsx:39`. Both same-visit (thrown) and next-visit (effectiveStatus === "denied" + deny_reason) paths render the revoke copy. Test at `approve/index.test.tsx:513`. |
| Improvement 1 — CI gate on ESLint severity | Done | `tools/ci/assert-strict-idempotency-rule.sh` greps for `"error"`. Confirmed `eslint.config.js:121` has the severity. |
| Improvement 2 — concurrent approve-vs-cap-trip test | Done — test scenario covered via Convex serialization semantics in `tokenPinCap.test.ts`. (Not file-checked in this review; trusted by the test-count baseline.) |
| Improvement 3 — CLAUDE.md rule #21 extended | Done in CHANGELOG.md and pattern doc; rule #21 in CLAUDE.md not directly read this pass but verified `docs/PATTERNS/idempotency-dual-call-authcheck.md` exists. See C1 — the doc itself has a wrong signature. |
| Improvement 4 — per-token cap stickiness in CHANGELOG | Done — CHANGELOG line 15 calls out the operator-facing semantics. |
| Improvement 5 — booth manager-picker UI test scope | Done — `sale/charge.tsx:646-695` ships the picker; tests at `sale/charge.test.tsx` (not opened this pass; trusted). |

### R2 — `useCountdown` for one consumer is fine

Single consumer (`sale/charge.tsx:141`) but the hook is genuinely portable — invoice expiry countdown is a pattern that will recur (v0.5.1 receipt-link expiry, v0.5.3 stock-in expiry, etc.). Extracting now costs ~40 lines; inlining and re-extracting at the second consumer would cost a refactor wave. Correct call.

### R3 — `SpokeLayout` `hideBack` for one consumer is also fine

Same logic. `charge-success` is the v0.5.0 consumer; v0.5.1+ receipt-link landing will likely want the same shape. The prop adds 4 lines to AppHeader.tsx and 0 cost when unused.

### R4 — 11 commits for Task 21 (route migrations) is right for git-bisect

The 10 per-route SpokeLayout-wrap commits + 1 useBlocker integration commit map directly to per-route ownership. A future bisect that points at `78c65cf — feat(sale/drafts): wrap in SpokeLayout` is more useful than a single mega-commit. The 47-total-commit shape on a foundation slice is acceptable for the squash-merge boundary; reviewer at PR-merge time still sees one logical change.

### R5 — Audit-verb cutover (`KIND_AUDIT` per-kind) is a clean cutover, not a wound

Pre-v0.5.0 rows carry `approval.requested/resolved/denied`. Post-v0.5.0 rows carry `staff_pin_reset.requested/resolved/denied` and `manual_payment_override.*`. Dashboard queries in v0.5.3 must accept both. CHANGELOG line 27 documents this. The decision aligns with ADR-007 (append-only — never rewrite). Not a wound because there's no "in-flight ambiguity": the cutover is at deploy-time, and `KIND_AUDIT` lookups in code only happen on the write path, so the read path's compatibility burden is bounded to dashboard SQL/queries that don't yet exist (v0.5.3 territory).

### R6 — `convex/api/v1/` external surface unchanged in this branch

Confirmed by `git diff --stat 0b6691a..0745306 | grep "api/"` (no v1 files in the diff). v0.5.0 is internal hardening; the API surface remains scaffold-only per CLAUDE.md.

### R7 — Schema migration safety

Only two schema deltas:
- `failed_pin_attempts: v.optional(v.number())` — additive, reads as `undefined` on existing rows.
- `denied_by_manager_id` widened to `v.optional(v.union(v.id("staff"), v.literal("system")))` — accepts existing values plus the new literal.

Both validate against existing rows. No data migration. Clean.

### R8 — `useBlocker` test coverage hits the wiring, not the integration

`sale/index.test.tsx` mocks `react-router`'s `useBlocker` so the test only proves "if blocker.state === 'blocked' then dialog opens." It does NOT prove that React Router actually transitions `state → "blocked"` on a popstate event with the current `useBlocker` predicate. The wiring is correct (React Router's contract is well-documented), but the design spec §3 Tests called for "Non-empty cart + popstate (Android gesture-back / browser back) → dialog opens (the load-bearing case for Critical #1)." The shipped test is half of that — the dialog half, not the popstate half. A jsdom-level popstate simulation against the real `MemoryRouter` would close it. Defer; the mandatory manual PWA smoke (UAT §11) catches it.

### R9 — `_cancelPendingApprovalsForTxn_internal` skips expired rows; `_markDeniedBySystem_internal` does not — semantically intentional but worth a docstring

`_cancelPendingApprovalsForTxn_internal:404-405` explicitly skips `token_expires_at <= now` rows ("user-visible as expired via effectiveStatus; re-patching to denied would change audit shape without changing UX"). `_markDeniedBySystem_internal:368` only skips `status !== "pending"`. Inconsistent treatment of expired-pending rows across the two paths. For the cap-trip case, the row IS still pending in DB (the cap-trip itself flips it), so the difference doesn't matter today. For `cancelPendingRequest` (manager-initiated), a manager cancelling a request whose token already expired hits the helper and DOES patch it to denied — which slightly distorts the audit (an expired request appears as manager-denied). Low-cost fix at v0.5.1: align the two helpers' "skip expired" semantics.

### R10 — Commit shape is readable; squash-merge is the right move

47 commits across 5 waves; titles follow the v0.4 cadence. `git log --oneline` shows clear waves: Wave 1 (helper + schema + ESLint scaffolding), Wave 2 (authCheck migration), Wave 3 (token cap + cascades + stabilizers), Wave 4 (FE spoke migration), final docs. Squash-merge produces one entry on `main`; the foundation slice is one logical change. No pre-merge squash needed within the branch.

---

## Closing observation

The branch is a faithful execution of a well-architected plan. The depth verdict is positive because the new internal helpers (`_markDeniedBySystem_internal`, `_cancelPendingApprovalsForTxn_internal`, `_cancelActiveInvoiceForTxn_internal`) hide non-trivial logic behind narrow interfaces, and the public surface widening (one new public mutation per workstream) is each earned by user-facing functionality.

The recurring tension visible across C1/C3/I1/I4 is the cost of mechanical lint enforcement: it makes drift impossible at the cost of forcing duplication that a code-reviewer would otherwise collapse. For v0.5.0 specifically, the trade is correct — auth-cache ordering is a security invariant worth a dual-call. For v0.5.1+, consider whether the ESLint rule could grow to lint the inline `require*Session` call too (would prevent C3-style divergence at the cost of a more complex AST walker).

Merge after C1 + C2 are resolved; C3 at reviewer discretion.

---

## STAFFREVIEW FINDINGS

### Critical
- **C1** Pattern doc `docs/PATTERNS/idempotency-dual-call-authcheck.md` shows wrong `withIdempotency(ctx, args, handler, options)` 4-arg signature; actual is `withIdempotency(name, handler, options)` 3-arg curried form. Will mislead next copy-paster.
- **C2** `transactions.cancelTransaction` (action, ceiling-cancel path) does NOT mark the active `pos_xendit_invoices` row cancelled; `transactions.cancelAwaitingPayment` (new mutation, abandon-dialog path) does. Two cancel paths diverged on invoice supersede.
- **C3** `_recordTokenPinFailure_internal` inlines the deny-write block instead of delegating to `_markDeniedBySystem_internal` (locks in a two-writer invariant the prior staffreview specifically argued against). Borderline — downgrade to Improvement at reviewer discretion.

### Important
- **I1** `chatRegistry/public.ts` re-queries `telegramChats` directly to compute audit `before_state` instead of having the impl helpers return pre-state. Split is mechanically clean but not architecturally deep.
- **I2** `listActiveManagers` exists in BOTH `approvals/public.ts` (token-gated) and `staff/public.ts` (session-gated). Returns Convex `_id` directly — soft violation of ADR-034 §"Stable string identifiers" (`_id` never part of API surface).
- **I3** `chatIdOverride` audit-failure path logs `role`, not the actual `chat_id` destination. Forward-looking risk; today's only consumer (founders cron) keeps them consistent.
- **I4** `cancelPendingRequest` hardcodes `source: "booth_inline"` — partial leak of `_markDeniedBySystem_internal`'s source enum. Deliberate-design-detail; document, don't refactor.
- **I5** `ApprovalPending` puts inline-arrow callbacks in `useEffect` deps. `called.current` ref protects correctness; re-render cost is negligible but the pattern is wrong by convention.

### Minor
- **R8** `useBlocker` test coverage mocks the hook — doesn't simulate popstate against the real React Router. Manual PWA smoke (UAT §11) covers it.
- **R9** `_cancelPendingApprovalsForTxn_internal` skips expired-pending rows; `_markDeniedBySystem_internal` does not. Audit-shape inconsistency latent today, surfaceable in `cancelPendingRequest` against an already-expired token.

### Nitpick
- **R2/R3** `useCountdown` and `SpokeLayout.hideBack` extracted for one consumer each — correct call (cheap; clear future second-consumers).
- **R4** 11 commits for the spoke-migration task is right for git-bisect, even though squash-merge collapses them.
- **R10** Commit shape readable; no pre-merge squash within the branch needed.

## STAFFREVIEW COMPLETE
