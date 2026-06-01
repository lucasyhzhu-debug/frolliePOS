# Staffreview — feat/v0.5.1b-refunds

**Date:** 2026-06-01
**Branch:** `feat/v0.5.1b-refunds` (HEAD `617e4157`, base `origin/main` `1e80edae`)
**Lens:** ADR-034 deep-module / surface-API discipline + plan fidelity.
**Stats:** 42 files changed, +4569 / -28; 28 plan tasks (B1–B28) all present.

## Summary

**Verdict: this PR makes the affected modules *deeper*.** `refunds/` ships with a 4-function `public.ts` and ~263-line `internal.ts` (single-writer commit funnel, dedup guard, preview compute, list-for-txn read), a 57-line pure `lib.ts` with one ADR-040 helper used in 4 call sites, and a 320-line `actions.ts` for two PIN-gated paths — that is textbook deep: thin surface, substantial implementation, single responsibility. Cross-module discipline was respected throughout: zero direct `ctx.db.query("pos_refunds")` outside `refunds/` (D:\Claude\frolliePOS\convex\refunds\public.ts:182 is the lone direct read and it's intra-module), zero direct `pos_transactions` / `pos_transaction_lines` reads outside `transactions/`, and the eslint OWNERSHIP map was updated (D:\Claude\frolliePOS\eslint.config.js:47). The 4-touchpoint discipline for the new `refund` approval kind is wired end-to-end. Graft integrity preserved: `commitRefundInline` and `approveRefund` both use `managerStaffCode` (stable string ID per ADR-034) and the refund subsystem never leaves POS.

`npm run lint` is clean (5 unused-import warnings, 0 errors). `npm run typecheck` is clean.

## Critical Issues

**None.** No ADR-034 violations, no schema-migration risk, no idempotency holes, no audit-source leaks, no information leakage.

## Improvements

### I1. `refunds/public.ts:50` — `listForTransaction` re-reads refunds through internal helper but never strips `line_id`

`listForTransaction` returns `refunds: Doc<"pos_refunds">[]` (full row), which leaks the refunds-internal `lines[].line_id` array to every frontend caller via the wire. This is a *legitimate* leak for the form (the FE uses it to render the "Already refunded" history), but the form only consumes `r._id`, `r.created_at`, `r.total_refund` (`src/routes/refund/detail.tsx:304-308`). Returning a shaped projection (`{ _id, created_at, total_refund }[]`) instead of `Doc<"pos_refunds">[]` would tighten the public-API contract and align with the discipline shown in `approvals/public.ts:213` where `line_id` is explicitly stripped when surfacing context to `/approve/:token`. Symmetry matters: the same field is hidden in one surface and freely exposed in another.

**Fix scope:** small — change the return type + map in the public handler; no internal helper changes. Defer if you prefer to ship and tighten in v0.5.3 when the history view lands its own contract.

### I2. `refunds/public.ts:177` — `listPendingSettlement` returns unbounded `Doc<"pos_refunds">[]`

Same widening concern: `/mgr/refunds-pending.tsx:67` only consumes `_id`, `total_refund`, `created_at`, `reason`. Returning the full row exposes `approval_request_id`, `requested_by`, `approver_id` etc. to anyone who can read the manager bundle. Real risk is low (manager-only) but the surface is wider than its caller.

**Fix scope:** same as I1 — projection map.

### I3. Real-time subscription bound — `listPendingSettlement` has no upper bound

The reactive query (`.collect()` over `by_settlement_status`) is unbounded. At single-booth volume this is fine for years, but the helper already takes `sessionId` — a soft `.take(200)` would document the design assumption and protect against a forgotten settlement backlog blowing up the manager-dashboard reactive subscription. Cheap insurance; defer if you prefer.

### I4. `transactions/internal.ts:152-263` `_commitRefund_internal` is not wrapped in `withIdempotency`

The action layer (`refunds/actions.ts:74-77`, 188-191) does its own `_lookup_internal` pre-check + `_writeCache_internal` post-write, so end-to-end same-key retries are safe through both paths. But the *internal mutation* (called from `approveRefund` at `convex/approvals/actions.ts:603`) has no second-level idempotency wrapper. If a future caller invokes `_commitRefund_internal` directly without action-level caching, double-commit is possible. The pattern already used in `_cancelCommit_internal` (D:\Claude\frolliePOS\convex\transactions\internal.ts:480) is the precedent — `withIdempotency` around the internal mutation itself. Today's two callers cache correctly; flag as a tripwire for the next caller.

**Fix scope:** small — wrap with `withIdempotency`, thread `idempotencyKey` through both action callers (already in scope as the action-level key + a `:commit` suffix).

### I5. `approvals/actions.ts:619-624` — `approveRefund` derives a `:resolve` suffix key

This is defensively correct (the comment at 499-505 explains why), but it creates two cache rows per off-booth refund approval (action top-level + `_markResolved_internal`'s `:resolve` key). The `:onpaid` precedent in `approveManualPayment` only has one extra (the funnel uses its own key but `_markResolved` shares the top-level). The asymmetry is intentional — `_commitRefund_internal` returns `{refundId, total_refund}` while `_markResolved` returns `{resolved: true}`. Fine as-is; document the divergence in CLAUDE.md or the actions.ts header so the next reviewer doesn't try to "fix" it.

## Refinements

### R1. `src/routes/refund/detail.tsx:136-145` — ADR-040 math duplicated in the frontend

The preview total is computed inline using the same `floor(line_subtotal × total × qty / (subtotal × line.qty))` formula that `convex/refunds/lib.ts:26-28` owns. Comment at 134 acknowledges this. The single-source-of-truth promise of `lib.ts` is broken by a copy.

Two options: (a) expose `computeRefundAmount` via a shared ESM file usable from both convex/ and src/ (the existing `convex/lib/time.ts` precedent — V8-safe, importable both sides); (b) add a public query `previewRefund` that takes selections and returns the per-line + total numbers, replacing the inline math with a `useQuery`. Option (a) is cheaper and matches the "lib is the spec" promise in ADR-040.

**Fix scope:** small — move helper to a shared location and import.

### R2. `convex/refunds/internal.ts:93` — `TXN_NOT_PAID` thrown for missing `receipt_number` is misleading

The error string is `TXN_NOT_PAID` but the actual condition is "paid txn with no receipt_number" (schema-invariant violation — `_confirmPaid_internal` always sets it). `TXN_NOT_REFUNDABLE` was used for the missing/non-paid case two lines above; this divergence will confuse the next reader. Rename to `TXN_MISSING_RECEIPT_NUMBER` or fold into the same `TXN_NOT_REFUNDABLE` bucket (the frontend `mapErr` collapses both anyway).

### R3. `useRefund.ts` — over-genericized for v0.5.1's single caller?

The hook takes `Array<{ _id: string; refundable: number }>` and ignores both fields (`_initialLines` is underscore-prefixed unused). The `refundable` cap is enforced at the component level (`RefundLineSelector.tsx:20,38`), not the hook. The hook is essentially a `useState<Record<string, number>>` + a derived array, with no validation tied to its parameter.

It's not *wrong* — the v0.5.3 history view may want this — but as shipped today it could be a 15-line inline `useState` in `detail.tsx`. Two paths: drop the parameter entirely and let the component enforce caps, or use the parameter to enforce caps inside the hook (cleaner separation). Either is fine; the dead parameter is the smell.

### R4. `refunds/internal.ts` — `_computeRefundPreview_internal` and `_commitRefund_internal` duplicate the validate+lookup loop

Both helpers walk the same `lineById` map and call `computeRefundAmount` per arg-line. The validation rules differ slightly (commit also enforces `refundQty > refundable`), but the lookup + map-build is identical. Extracting a `validateLines(lines, args) → lineDocs[]` helper would let the two paths converge to one validator + one math step. Cosmetic; defer unless a third path arises.

### R5. `mgr/refunds-pending.tsx:134` — `crypto.randomUUID()` minted per click

This is the right pattern (commented as such), but the comment refers to "sale/drafts.tsx" precedent. If a third caller adopts this, a small `useFreshIdempotencyKey()` hook would be cleaner than three copies of "mint at click time" guidance. Defer.

### R6. Cross-path test asymmetry

`convex/refunds/__tests__/commit.test.ts` covers the commit-funnel atomic flow well, but there's no end-to-end test exercising `approveRefund → _commitRefund_internal` through the Telegram path. `audit-trail.test.ts` covers verbs but not the line-id translation at `convex/approvals/actions.ts:599-602`. The cast `l.line_id as unknown as Id<"pos_transaction_lines">` is the most fragile point in the off-booth path — a stored context with a malformed line_id would only surface in production. Worth a test.

### R7. `approval_request_id` on `pos_refunds` is optional but always set for telegram path

Schema marks `approval_request_id: v.optional(v.id("pos_approval_requests"))` — but the inline path *also* could conceivably tie back to an approval_request_id one day. Today only the telegram path passes it (`refunds/internal.ts:215` + `approvals/actions.ts:612`). Cosmetic — the optionality is correctly modelled because the booth path has no approval row. Document in `refunds/schema.ts:24` to lock the invariant: "present iff `approval_source === 'telegram_approval'`."

---

## Module-depth comparison

- **`refunds/` vs `approvals/`:** `approvals/` has a larger public surface (5 public functions) and supports 3 kinds plus deny; `refunds/` has 4 public functions and one kind. Per surface area, `refunds/` is comparably deep — its `_commitRefund_internal` is the equivalent of approvals' `_markResolved_internal`-plus-funnels-out, and the single-writer pattern is executed with the same discipline as `transactions._confirmPaid_internal`.
- **`refunds/internal.ts._commitRefund_internal` vs `transactions/internal.ts._confirmPaid_internal`:** clarity is on par. Both are linear 7-step pipelines, both audit at step 7-8, both route every cross-module operation through owning-module internals. `_commitRefund_internal`'s header comment block (lines 128-151) is actually clearer than `_confirmPaid_internal`'s — explicit ADR-034 boundary annotations on every cross-module call.

## Plan fidelity

All 28 B-tasks (B1–B28) have matching commits. No scope creep; no shortcuts. Test commits land before feature commits per TDD discipline. Docs (CHANGELOG, SCHEMA, CLAUDE.md rule #22, API_REFERENCE) updated in B27.

---

## STAFFREVIEW FINDINGS

### Critical
*(none)*

### Important
- **I1** — `refunds/public.ts:50` `listForTransaction` returns full `Doc<"pos_refunds">[]`, leaking refunds-internal `lines[].line_id` over the wire; tighten to a projection mirroring the `approvals/public.ts:213` discipline.
- **I4** — `_commitRefund_internal` (`refunds/internal.ts:152`) is not `withIdempotency`-wrapped; today's two callers cache at the action layer, but a future direct caller could double-commit. Mirror the `_cancelCommit_internal` precedent.

### Minor
- **I2** — `listPendingSettlement` (`refunds/public.ts:177`) widens to full row; tighten projection.
- **I3** — `listPendingSettlement` `.collect()` is unbounded; add a `.take(200)` soft cap.
- **I5** — Document the `:resolve` derived idempotency-key asymmetry between `approveRefund` and `approveManualPayment`.
- **R1** — `src/routes/refund/detail.tsx:136-145` duplicates ADR-040 math instead of importing from `convex/refunds/lib.ts`; promote `computeRefundAmount` to a shared V8-safe module.
- **R2** — `TXN_NOT_PAID` thrown for missing `receipt_number` (`refunds/internal.ts:93`) is misleading; rename or fold.
- **R6** — No e2e test for `approveRefund → _commitRefund_internal` line-id-cast translation.

### Nitpick
- **R3** — `useRefund` hook takes a parameter it does not use.
- **R4** — `_computeRefundPreview_internal` and `_commitRefund_internal` duplicate the lineById validation loop.
- **R5** — `crypto.randomUUID()`-at-click pattern starting to accumulate copies; extract a hook when a third caller appears.
- **R7** — Document `pos_refunds.approval_request_id` invariant ("present iff `approval_source === 'telegram_approval'`") in schema.

## STAFFREVIEW COMPLETE
