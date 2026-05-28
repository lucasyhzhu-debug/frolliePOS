# Staff Review: `feat/v0.3-sale-xendit` — Implementation (Deep-Module Lens)

**Date:** 2026-05-28
**Branch:** `feat/v0.3-sale-xendit`
**Base:** `c0cd56e` (origin/main) → **Head:** `34f3c13`
**Scope:** 92 changed `.ts`/`.tsx` files, ~9,200 insertions. New Convex modules `transactions/`, `payments/`, `inventory/`, `vouchers/`, `approvals/`; `auth/` + `idempotency/` + `catalog/` + `seed/` + `telegram/` extensions; 5 FE hooks; 6+ FE routes.
**Lens:** ADR-034 deep-modules / surface-APIs. Plan-to-implementation fidelity + graft integrity.
**Reviewer:** Principal/Staff Engineer (architecture)

---

## 1. Summary

**Verdict on module depth: this change makes the affected modules *deeper*.** Every new module presents a narrow public surface (`transactions/public.ts` = 5 functions, `payments/public.ts` = 1, `inventory/public.ts` = 1, `vouchers/public.ts` = 2, `approvals/public.ts` = 1) over substantial hidden implementation in `internal.ts` + `actions.ts` + `schema.ts`. The load-bearing complexity — the three-path payment funnel, ADR-026 movement dedup, race-tolerant voucher redemption, action-level idempotency — is all internal. No shallow pass-throughs were introduced. Cross-module access is disciplined: I verified zero `ctx.db.*` violations of the ADR-034 ownership map via the CI lint rule, and every cross-module read/write routes through the owning module's `internal.ts` surface (`internal.catalog.internal._getComponentsForProducts_internal`, `internal.auth.internal._resolveSession_internal`, `internal.transactions.internal._setCurrentInvoice_internal`, etc.).

**The funnels held.** `_confirmPaid_internal` is genuinely THE single convergence point for webhook + polling + manual paths (status-guarded, idempotent). `_changePinCommit_internal` funnels all three PIN-change paths. `_redeemVoucher_internal` is the single redemption funnel. `_createRequest_internal` / `_markNotified_internal` / `_markResolved_internal` / `_deleteRequest_internal` own the approval lifecycle and are reused (not hand-rolled) by the actions. The shared `logAudit` helper and `withIdempotency` HOF are reused everywhere, never re-implemented. Plan fidelity is high — the two design-stage Critical issues (action-idempotency duplicate-invoice risk; WIB receipt-year boundary) are both demonstrably fixed in code, and all 12 design Improvements + the 6 missing tests are present.

**Verification performed:** `tsc -b` clean; ESLint on `convex/**` + `src/**` clean (incl. boundary rule); `npx vitest run convex` → 182 pass / 34 files; `npx vitest run src` → 85 pass / 20 files. (The 34 lint errors `npm run lint` reports are all inside `packages/ceo-progress-report/` — the frozen npm-package snapshot, Node `process`/`console` globals — and are out of v0.3 scope.)

**Net:** ship-quality. The findings below are one real dev-tooling correctness bug (seed wipe), a couple of doc-drift items, and minor authz/over-engineering observations. None block merge; the seed-wipe item should be fixed before the next dev reset to avoid orphaned-data confusion during the manual smoke flows.

---

## 2. Critical Issues (Must Fix)

None that block merge. The one functional bug below is dev-tooling-only (cannot reach prod — guarded), so it is filed as Important rather than Critical.

---

## 3. Improvements (Recommended)

### I-1 — `seed/_reset_internal` wipe list omits all 8 new v0.3 tables (dev-tooling correctness bug)

**`convex/seed/internal.ts:24-30`.** The wipe loop clears:

```
audit_log, pos_idempotency, pos_auth_attempts, staff_sessions,
registered_devices, pending_device_setups, pos_stock_levels,
pos_product_components, pos_products, pos_inventory_skus, staff
```

It does **not** clear: `pos_transactions`, `pos_transaction_lines`, `pos_receipt_counters`, `pos_xendit_invoices`, `pos_stock_movements`, `pos_vouchers`, `pos_voucher_redemptions`, `pos_approval_requests`.

**Consequence:** after `seedActions.reset`, every prior sale/invoice/movement/voucher-redemption/approval row survives but now references **deleted** `staff` and `pos_products` `_id`s — dangling foreign references. The reseeded SKUs/products get fresh `_id`s, so `pos_product_components` (wiped) and the surviving `pos_stock_movements` (not wiped) point at different generations of rows. Plan manual-smoke-flow 1 opens with "wipe + bootstrap"; a developer who has run a sale, then re-seeds, will see stale receipt counters (`R-2026-NNNN` keeps climbing) and orphaned transactions in any history view. Worse: `pos_receipt_counters` surviving means the WIB-year regression test's premise ("fresh counter") won't hold against a reset deployment.

**Why it's not Critical:** `reset` is `internalAction`, prod-guarded by the `savory-zebra-800` deny-list (`convex/seed/actions.ts:27-35`), and `bootstrap` separately aborts when staff exist. No prod blast radius. But it undermines the dev smoke-test premise the plan relies on.

**Fix:** extend the wipe array (children-before-parents) with the 8 tables. Suggested order to respect FK direction: `pos_voucher_redemptions, pos_stock_movements, pos_transaction_lines, pos_xendit_invoices, pos_approval_requests, pos_transactions, pos_receipt_counters, pos_vouchers` inserted before `staff`. Note the ADR-034 wrinkle: `seed` is already in the ESLint `ALLOWLIST`, so cross-module `ctx.db.delete` on those tables is sanctioned here — no boundary concern.

### I-2 — SCHEMA.md "Data integrity rules" still describes the pre-v0.3 dedup constraint

**`docs/SCHEMA.md:589-590`** states: *"`pos_stock_movements` unique constraint on `(ref_type, ref_id, inventory_sku_id)` prevents reconciliation double-decrements."* The shipped schema (`convex/inventory/schema.ts:5-22`) has **no** `ref_type`/`ref_id` fields — it uses `source_transaction_line_id` + the `by_line_and_sku` index. CLAUDE.md business-rule #18 already acknowledges the divergence ("v0.3 shipped this index rather than a unique `(ref_type, ref_id, sku_id)` constraint"), but the SCHEMA.md integrity-rules block was not updated to match. The per-table section (`SCHEMA.md:291-306`) *is* correct; only the rollup at line 590 is stale. **Fix:** reword line 590 to reference the `by_line_and_sku` dedup index (and note Convex has no native unique-constraint primitive — the dedup is enforced by the `.first()` existence check in `_recordSaleMovement_internal`).

### I-3 — `useStartupReconciliation.ts` doc comment repeats the stale `ref_type+ref_id+sku_id` description

**`src/hooks/useStartupReconciliation.ts:23-25`** comments: *"The movement dedup index (unique on ref_type+ref_id+sku_id) protects against double-decrement…"*. Same drift as I-2, in code comments. The actual guard is the `by_line_and_sku` existence check. Harmless at runtime but misleads the next reader. **Fix:** align the comment to `(source_transaction_line_id, inventory_sku_id)`.

### I-4 — `transactions.public.getById` / `listRecentAwaitingPayment` ownership is unauthenticated by session

**`convex/transactions/public.ts:26-40`.** `getById` accepts only `{ txnId }` and returns the full transaction doc + lines with no session/ownership gate. `listRecentAwaitingPayment` *does* resolve the session but then returns **all** recent `awaiting_payment` txns deployment-wide, not just the caller-staff's. For v1 (single registered device, 2-3 trusted staff, no customer PII on the transaction row) this is an acceptable, deliberate simplification — and `listRecentAwaitingPayment`'s breadth is arguably correct for reconciliation (any staff reloading should re-check any pending sale on the shared device). **But it is a latent information-disclosure surface the moment this data is reachable outside the booth.** This matters specifically for graft integrity: when Frollie Pro consumption arrives, it MUST go through `convex/api/v1/` (bearer-token, PII-scoped, ADR-034 §Layer 2) and never call these public queries cross-deployment. Recommend a one-line POC-tradeoff comment on `getById` noting "no session gate — v1 single-device trust model; external access is api/v1/ only" so a future engineer doesn't promote it to an external surface. No code change required for v1.

### I-5 — Manual-override role check is correct but the comment over-promises a v0.4 design

**`convex/payments/actions.ts:222-226`.** `manuallyConfirmPayment` requires `actor.role === "manager"` and verifies the manager's own PIN — correct and matches business rule #9. The inline comment ("v0.4 will route through approvals/ for off-booth") is fine, but note the action currently has **no off-booth path at all** — a non-manager staff member at the booth cannot trigger a manual override even with a manager physically present unless that manager's session is active. That's the intended v0.3 constraint (manager-session-required), but it's slightly stricter than business-rule #9's "manager PIN OR WA approval" wording. Confirm with product that v0.3 manual override requiring an active *manager session* (not just a manager PIN entered by a staff member) is the accepted v0.3 reduction. If so, leave as-is; it's the safer interpretation.

---

## 4. Refinements (Optional / Nitpick)

### R-1 — `_decrementOnHandUnchecked_internal` is dead code in v0.3

**`convex/inventory/internal.ts:121-137`.** Exported, documented as "Used by v0.5 stock-adjustment flows", but called by nothing in v0.3 and not covered by a test. This is *mild* over-engineering — building a v0.5 surface now. It's cheap (10 lines) and the comment is honest about it being a forward hook, so this is a judgment call, not a defect. If you want to keep depth honest, delete it and re-add in v0.5; if the team prefers the hook, leave the comment. Either is defensible.

### R-2 — `_projectedOnHand_internal` and `_getOnHandBySkus_internal` are near-duplicates

**`convex/inventory/internal.ts:72-113`.** `_projectedOnHand_internal({skuQtys})` returns `on_hand - qty`; `_getOnHandBySkus_internal({skuIds})` returns raw `on_hand`. The funnel uses the latter (post-decrement re-check) and `commitCart` uses the former (pre-commit projection). They differ only by the subtraction. Defensible as two intent-named surfaces (caller doesn't pass a phantom `qty: 0`), but a single `_getOnHandBySkus_internal` + caller-side subtraction would shrink the inventory internal surface by one function. Marginal. Leave if the team values the named intent.

### R-3 — `getById` returns confirmation-provenance + `xendit_invoice_id_current` to the FE

The full `pos_transactions` doc (incl. `confirmed_mgr_approver_id`, `confirmed_manual_reason`, `xendit_invoice_id_current`) is returned to the charge screen. The FE only needs `status` + `receipt_number` + totals + lines. Returning the manual-reason/approver to the client is a small information-leak of audit-adjacent data. Not exploitable in v1 (trusted device) and the data isn't PII, but a projected return shape would be tidier. Defer.

### R-4 — `payments.public.getCurrentInvoice` returns the raw invoice row (incl. `xendit_idempotency_key`)

**`convex/payments/public.ts:9-19`** returns the whole `pos_xendit_invoices` row, which includes `xendit_idempotency_key` and `status_at_create`. The charge screen only needs `xendit_invoice_id`, `method`, `qr_string`, `va_number`. Exposing the idempotency key to the client is harmless (it's the client's own key) but unnecessary surface. A projected shape would be marginally cleaner. Defer.

---

## 5. Deep-Module Discipline Assessment (ADR-034 — the core lens)

| Check | Result | Evidence |
|---|---|---|
| Each touched module is **deep** (narrow public, fat internal) | ✅ | public surfaces are 1-5 fns; the funnel/dedup/race logic lives in `internal.ts`. |
| No shallow pass-throughs added | ✅ | `payments/actions.ts` actions do real work (Xendit HTTP, idempotency orchestration); they don't merely forward. |
| Public interface didn't widen unnecessarily | ✅ (one watch item) | `getById` breadth (I-4) is the only "could be narrower" public surface; everything else is minimal. |
| No information leakage of internal layout to callers | ✅ mostly | Flag bitset is hidden behind `flags.ts` helpers (`hasFlag`/`withFlag`); FE reads `flags` only via tests. Minor: full-doc returns (R-3/R-4) leak field shape but not structure callers must understand. |
| Cross-module access via public/internal only (no foreign `ctx.db.*`) | ✅ | ESLint `no-cross-module-db-access` passes clean on all v0.3 modules; ownership map (`eslint.config.js:20-51`) updated for all 8 new tables incl. the `pos_stock_levels` catalog→inventory move. |
| `logAudit` reused, not re-implemented | ✅ | every state-changing mutation imports `../audit/internal`; no module re-rolls audit. |
| `withIdempotency` reused, not re-implemented | ✅ | `transactions`, `payments`, `auth` all wrap via the shared HOF; actions use the documented 3-step `_lookup_internal` → HTTP → wrapped-commit pattern; `_writeCache_internal` is the sanctioned stand-alone cache write owned by `idempotency/`. |
| External/Frollie-Pro access stays out of internal tables | ✅ (v1 N/A) | No `api/v1/` endpoints added this phase (correctly out of scope); the graft watch item is I-4 (don't let `getById` become an external surface). |
| Funnels are load-bearing & not bypassed | ✅ | `_confirmPaid_internal` (3 paths), `_changePinCommit_internal` (3 paths), `_redeemVoucher_internal`, approval `_create/_notify/_resolve/_delete` internals all reused; no hand-rolled writes around them. Verified in `confirmPaid.test.ts` (all 3 sources + idempotent re-fire + NEG_STOCK re-check + voucher over-redeem). |

**Graft integrity:** POS data shape remains independent. Nothing in v0.3 mirrors a Frollie Pro table field-for-field; stable string IDs (`R-YYYY-NNNN`, `S-NNNN`, product/component codes) are allocated server-side and the schema notes (`SCHEMA.md:571`) already sketch the v1.1 sales→kitchen feed as a *scheduled action joining on `sku_family`*, not a shared schema. The only graft risk is procedural (I-4): keep `getById`/`listRecentAwaitingPayment` off the external surface; Frollie Pro must consume `api/v1/`.

---

## 6. Plan Fidelity

| Plan claim | Status | Evidence |
|---|---|---|
| Three-path payment confirmation converges on one funnel | ✅ | `_confirmPaid_internal` status-guarded; webhook/polling/manual all route via `_onPaid*_internal` → funnel. |
| Single active invoice per txn (ADR-014) | ✅ | `retryWithFreshInvoice` best-effort-cancels prev invoice, sets `replaced_by_invoice_id`, repoints `xendit_invoice_id_current` via `_setCurrentInvoice_internal`. |
| Reconciliation on reload (ADR-026) | ✅ | `listRecentAwaitingPayment` (5-min window, `by_status_created` index) + `useStartupReconciliation` ref-guarded once-per-mount; double-decrement blocked by `by_line_and_sku` dedup. |
| Action-level idempotency (design Critical #1) | ✅ | `_lookup_internal` pre-check + `X-IDEMPOTENCY-KEY` to Xendit + wrapped commit mutation returning the FULL response blob (so `qrString`/`vaNumber` survive replay). |
| WIB receipt-year (design Critical #2) | ✅ | `wibYear()` helper + `_allocateReceiptNumber_internal` uses it; `receiptCounter.test.ts` covers the boundary. |
| Paid-only stock decrement | ✅ | `_recordSaleMovement_internal` called only from the funnel. |
| `pos_stock_levels` catalog→inventory move | ✅ | schema moved, ownership map updated, comment left in `catalog/schema.ts` per plan. |
| Design Improvements 3-14 | ✅ | optional `created_by_staff_id`, `updated_at` written on decrement, lockout dedup guard, self-reset-via-Telegram documented, constant-time token compare (`timingSafeEqual`), CLAUDE.md updates all present. |
| Missing tests T1-T6 | ✅ | token-lifecycle, cancel-no-invoice, cancel-Xendit-5xx, multi-product-same-SKU, WIB rollover, concurrent resumeDraft all present in `__tests__/`. |
| Out-of-scope respected (refunds, history, mgr dashboard, api/v1) | ✅ | none of these landed. |

No scope creep beyond R-1 (`_decrementOnHandUnchecked_internal` forward hook) and the `packages/ceo-progress-report/` snapshot churn (unrelated to v0.3 functional scope; it's the extracted-renderer work tracked separately).

---

## 7. Architectural Risk Scan

- **Real-time subscription load:** the charge screen subscribes to `getById` + `getCurrentInvoice` (2 queries) and polls Xendit every 2s up to 60s. `getStockLevels` does a full `pos_stock_levels.collect()` + per-call `_getActiveSkuIds_internal` (full active-SKU scan) on every reactive tick — fine at booth volume (5 SKUs) but a known O(table) read that should not be promoted to an external endpoint without an index-backed rewrite. Acceptable for v1.
- **Schema migration:** new tables only + one in-deployment table move (no data migration). `last_movement_id` deliberately kept `v.string()` to avoid rejecting legacy dev rows (`inventory/schema.ts:28`) — documented, sound.
- **Harness bypass:** none found. Idempotency, audit, and the funnels are reused everywhere; no module writes `pos_idempotency`/`audit_log` directly outside their owners.
- **`getStockLevels` + funnel coupling:** the funnel re-checks NEG_STOCK *after* decrement via `_getOnHandBySkus_internal` — correct (stock can drain between commit and confirm), and the test proves the flag fires. Good.

---

## 8. Approval

**Approve for merge.** No Critical blockers. Recommend addressing **I-1 (seed wipe)** before the next dev reset / smoke-flow run, and folding **I-2/I-3** (doc + comment drift on the dedup key) into this PR since they're one-line edits. I-4/I-5 are watch items to record, not fixes. Refinements are optional.

---

*Generated by /staffreview — Frollie POS v0.3 implementation review, 2026-05-28. Verification: tsc -b clean, ESLint (convex+src) clean, 182 backend + 85 FE tests passing.*
