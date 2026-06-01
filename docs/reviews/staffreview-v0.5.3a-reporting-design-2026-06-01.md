# Staff Review: v0.5.3a — Reporting (transaction history + manager dashboard)

**Date:** 2026-06-01
**Plan:** `docs/superpowers/specs/2026-06-01-v0.5.3a-reporting-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Design spec, not a full plan — structural additions noted in §0

---

## 0. Plan Structure Additions

This is a brainstorm design spec, not a `/superpowers:writing-plans` plan. The following plan-level sections are intentionally deferred to the plan, but the spec should at least stub the ones that affect approval:

- **Implementation phases/waves (PARALLEL/SEQUENTIAL):** deferred to plan. OK.
- **Success criteria:** spec should state the minimum bar (typecheck + build + new unit/integration tests green). Added to spec.
- **Rollback/deployment notes:** read-only + additive (no schema change after fixes), so rollback = revert the commits; no migration ordering. Added to spec.

---

## 1. Summary

**Overall Assessment:** Revise (3 issues to fix before planning; all addressable in the spec)

The design is architecturally sound — the deep-module framing, day-window model, and device-clock invariant are correct and well-grounded. But one **load-bearing flow is impossible as written** (a query cannot trigger the lazy-mint mutation), and one **schema change is redundant** (the required index already exists). Both are exactly what this review exists to catch before code. A third (refund-status label duplication) is a clean reuse opportunity that the "no duplication" rule demands.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `getTransactionDetail` (a query) cannot trigger `_lazyMintReceiptToken_internal` (an internalMutation) — Convex queries can't `runMutation` | Logic/Architecture | spec §Backend, §Data flow, §Access |
| 2 | New `by_created_at` index is redundant — `by_status_created` already serves day-window reads | Schema | spec §Schema |

### Issue 1: Read query cannot lazy-mint a receipt token

`_lazyMintReceiptToken_internal` (`convex/receipts/internal.ts:238`) is an **`internalMutation`** that takes `actor: v.id("staff")` and delegates to `transactions._ensureReceiptTokenForPaidTxn_internal` (mint + patch + audit). Convex **queries are read-only and cannot call `ctx.runMutation`** — so the spec's design of "`getTransactionDetail` query … triggers `_lazyMintReceiptToken_internal` if the token is absent" cannot compile, let alone run.

**Recommendation:** Split the concern.
- `getTransactionDetail(txnId)` stays a **pure query**: returns lines, totals, payment method, refund status, and the *existing* `receipt_token` (may be `null`).
- Add a public **mutation** `shareReceipt({ idempotencyKey, sessionId, txnId })` invoked on the "Share receipt" tap. It resolves session → `staff_id`, calls `_lazyMintReceiptToken_internal({ transactionId, actor: staffId })`, and returns `{ token }`. The frontend then opens `/r/<token>`. This mutation **must** carry `idempotencyKey` + `withIdempotency(...)` + `authCheck` per business rule #21 (it's a public mutation that writes).
- **Amend the spec's "read-only" claim:** 3a now has exactly one public mutation (`shareReceipt`). It is still side-effect-minimal (mint-once; idempotent on re-tap since `_ensureReceiptTokenForPaidTxn_internal` no-ops when a token exists), but the spec must stop calling the slice "zero public mutations."

### Issue 2: Redundant index

The spec adds a new `by_created_at` index. But `pos_transactions` already has **`by_status_created` `["status","created_at"]`** (`convex/transactions/schema.ts:46`), and `listRecentAwaitingPayment` already uses it for a status-scoped created-at range.

History is a list of **sales** — `status = "paid"` (a paid-then-fully-refunded txn keeps `status: "paid"`; refund state is computed on read per ADR-008; drafts/cancelled are not sales). So the day-window read is:

```ts
.withIndex("by_status_created", q =>
  q.eq("status", "paid").gte("created_at", window.start).lt("created_at", window.end))
```

The "needs attention" awaiting-payment rows already come from `listRecentAwaitingPayment` (same index), and flagged neg-stock txns are `status:"paid"` with a flags bit — caught by the paid scan.

**Recommendation:** Drop the new index. Reuse `by_status_created`. The slice becomes **zero schema changes**. Only add a bare `by_created_at` if a future requirement needs a single cross-status day scan — not the case here.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Extract a shared `refundStatus(...)` helper into `refunds/lib.ts` | M | L |
| 2 | Name the ADR-034 session-resolution pattern for the new queries | M | L |

### Improvement 1: Refund-status label belongs in a shared helper

`refunds/lib.ts` exposes `computeRefundAmount`, `lineRefundedQty`, `lineRefundable` — but the **LUNAS / SEBAGIAN DIKEMBALIKAN / DIKEMBALIKAN** *label* derivation lives in the receipt `template.ts`, not in `lib.ts`. The history row badge (spec §Frontend) needs the same three-state label. Re-deriving it in the frontend duplicates the logic and risks drift.

**Recommendation:** Extract a pure `refundStatus(txn, lines, refunds) → "lunas" | "sebagian" | "dikembalikan"` into `refunds/lib.ts`; have **both** the receipt template and the history badge consume it. Honors the "reuse, no duplication" constraint that drove the whole deep-module choice.

### Improvement 2: Cross-module session resolution

The new queries read sessions across a module boundary. Per ADR-034 and the worked example in `listRecentAwaitingPayment` (`convex/transactions/public.ts:309`), they must resolve via `internal.auth.internal._resolveSession_internal` and degrade gracefully (`return []` / null on invalid session) — **not** read `staff_sessions` directly from `transactions/`.

**Recommendation:** Spec should name this pattern so the plan wires it correctly and the manager-only surfaces (`dashboardSummary`, prior-day history) re-check role server-side after resolution.

## 4. Refinements (Optional)

- Explicit zero-sales empty-state for `dashboardSummary` (all-zero summary object, not null) so the dashboard renders cleanly on a fresh day.
- The "lightweight per-line summary" shape returned by `listDayTransactions` — already an open item; decide in the plan (one round-trip vs. minimal headers + separate detail fetch).

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `wibDayWindow(now)` | `convex/lib/time.ts:49` | server-time day window resolution (Q7 invariant) |
| `by_status_created` index | `convex/transactions/schema.ts:46` | day-window paid-sales read (Issue 2) |
| `_resolveSession_internal` | `convex/auth/internal.ts` | cross-module session resolution (Improvement 2) |
| `lineRefundedQty` / `lineRefundable` / `computeRefundAmount` | `convex/refunds/lib.ts:35/42/15` | per-line refund math behind the badge |
| `_lazyMintReceiptToken_internal` | `convex/receipts/internal.ts:238` | mint-on-share via the new `shareReceipt` mutation (Issue 1) |
| `listRecentAwaitingPayment` | `convex/transactions/public.ts:309` | template for the new queries (session pattern + index usage) |

### Potential duplication risks
- Refund-status label (Improvement 1) — the actual duplication risk; resolve by extraction.

## 6. Phase / Wave Accuracy

Deferred to `/superpowers:writing-plans`. Suggested ordering: (1) `refunds/lib.ts` `refundStatus` extraction + `transactions/lib.ts` aggregators (pure, parallel, unit-tested) → (2) backend queries + `shareReceipt` mutation → (3) frontend history + detail → (4) frontend dashboard. Backend before frontend; pure helpers first.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Backend queries + lib | `convex-expert` | Convex query/index/runtime-split idioms |
| Frontend history + dashboard | `frontend-integrator` + `ui-component-builder` | Convex hooks wiring + laptop-first dashboard cards |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ⚠️ planning artifact on `worktree-spec+v0.5.3`; implementation branch named in plan |
| Commit boundaries | ✅ natural per suggested waves (helpers / backend / fe-history / fe-dashboard) |
| Pre-push verification | ⚠️ add `npm run typecheck && npm run build && npx vitest` to plan success criteria |
| Rollback | ✅ read-mostly + additive; revert commits, no migration |
| Deployment order | ✅ backend (convex deploy) before frontend (vercel) |

## 9. Documentation Checkpoints

| Item | Update |
|------|--------|
| `CLAUDE.md` | add the new `transactions` query surface + `shareReceipt` to file-locations; note `refundStatus` helper moved to `refunds/lib.ts` |
| `docs/SCHEMA.md` | no table change; note `by_status_created` reused for history (no new index) |
| `docs/CHANGELOG.md` | v0.5.3a entry |
| `docs/PROGRESS.md` | retrofit `v053a-*` Task IDs at plan time (not before — per CLAUDE.md) |

## 10. Testing Plan Assessment

**Verdict:** Adequate (spec names the right units) — strengthen at plan time.

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend | `transactions/lib.ts` aggregators | vitest (pure) | planned |
| Backend | `refundStatus` helper | vitest (pure) | **add** (Improvement 1) |
| Backend | clock invariant `(day,role)→output` | convex-test | planned |
| Backend | role gating (staff prior-day collapse; cross-scope detail reject) | convex-test | planned |
| Backend | `shareReceipt` mint-once + idempotent re-tap + auth reject | convex-test | **add** (Issue 1) |
| Frontend | history list / detail / dashboard cards smoke | (optional) | encouraged |

### Regression risk
- `_ensureReceiptTokenForPaidTxn_internal` now gets a second caller (`shareReceipt`) — confirm its existing idempotent no-op-on-existing-token behavior holds (lazy-mint tests already cover this; extend for the booth-staff actor path).

## 11. Edge Cases to Address

- [ ] Zero-sales day → all-zero summary, empty list (not error/null).
- [ ] Paid-then-fully-refunded txn still appears in history with `dikembalikan` badge (status stays `paid`).
- [ ] Staff requests a past `day` → server collapses to today (don't error).
- [ ] `shareReceipt` on a non-paid txn → reject (lazy-mint asserts paid).
- [ ] Re-tap "Share receipt" → same token, no second mint (idempotent).

## 12. Approval Conditions

**To approve, address:**
1. Issue 1 — split detail (query) from `shareReceipt` (mutation); amend the read-only claim.
2. Issue 2 — drop the new index; reuse `by_status_created`; slice becomes zero schema changes.

**Recommended before implementation:**
1. Improvement 1 — extract `refundStatus` into `refunds/lib.ts`.
2. Improvement 2 — name the `_resolveSession_internal` pattern in the spec.

---

*Generated by /staffreview*
