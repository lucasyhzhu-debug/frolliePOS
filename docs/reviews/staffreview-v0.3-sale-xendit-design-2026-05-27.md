# Staff Review: v0.3 Sale Flow + Xendit + PIN Management — Design Spec

**Date:** 2026-05-27
**Plan:** [`docs/superpowers/specs/2026-05-27-v0.3-sale-xendit-design.md`](../superpowers/specs/2026-05-27-v0.3-sale-xendit-design.md)
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — spec-shaped, not plan-shaped (file changes + commit checkpoints + branch strategy belong in the downstream plan)

---

## 1. Summary

**Overall Assessment:** **Revise** — fix 2 Critical issues (idempotency-retry semantics, receipt-number timezone), apply ~11 Improvement-class refinements, then approve for plan writing.

The architecture is sound. The single-funnel `_confirmPaid` design + the client-Zustand cart + the paid-only stock decrement form a coherent and testable core. The voucher race resolution via `VOUCHER_OVER_REDEEMED` flag mirrors the existing `NEG_STOCK` pattern — consistent precedent. Cross-module boundary discipline holds; ADR-034 is respected.

Two Critical issues need to be fixed before plan writing: (1) the idempotency error-caching design from v0.2 creates a duplicate-commit risk when `commitCart` fails server-side mid-execution, and (2) receipt-number year boundary uses UTC by default, which will produce wrong year prefixes for sales near WIB midnight. Both are correctness issues, both have well-defined fixes.

The Improvement-class findings cluster around explicitness — the spec under-specifies some operational details (locked-out manager self-reset, multi-lockout dedup, schema fields that should be optional, CLAUDE.md update checklist). Easy to address inline.

The testing strategy is strong but missing 6 specific cases listed in §10.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location in spec |
|---|-------|----------|----------|
| 1 | Idempotency retry semantics — failed `commitCart` server-side can create duplicate txn on client retry | Logic | "Frontend hooks → useIdempotency" + transactions/ surface API |
| 2 | Receipt-number year boundary uses UTC, not WIB — wrong year prefix near midnight WIB | Logic | transactions/ schema + `_allocateReceiptNumber_internal` |

### Issue 1: Idempotency error caching creates retry-duplicate risk

**Quote from `convex/idempotency/internal.ts:12-14`** (existing v0.2 code):
> "Errors are NOT cached in v0.2 — a handler that throws does not write to pos_idempotency, so a retry with the same key re-executes."

**Quote from spec line 9 (v0.2 plan):**
> "idempotency-key persistence across reload (v0.3 — see Task 11), error-path caching in `withIdempotency` (v0.3 — see Task 3)."

These were explicitly flagged as v0.3 follow-ups by v0.2. The v0.3 spec persists keys to IDB (good) but **does not address what happens when the server-side handler succeeds but the response fails to reach the client OR when the handler throws partway**.

**The risk:** with IDB-persisted keys + uncached errors, this sequence is possible:
1. Client calls `commitCart(idemKey=ABC, intent=charge, ...)`.
2. Server: handler runs, but throws after some side-effects somehow OR connection drops after handler succeeds.
3. Client doesn't get response. Reload mid-payment → IDB still has `idemKey=ABC`.
4. Client retries `commitCart(idemKey=ABC, ...)`.
5. Server: cache miss (error wasn't cached). Re-executes. Creates a SECOND `pos_transactions` row.

For Convex mutations specifically this is partially mitigated: Convex mutations are transactional, so a thrown handler rolls back ALL its writes. So case (a) "handler throws partway" → no duplicate. But case (b) "handler succeeds but response is lost" → re-execution succeeds → creates duplicate.

**Wait.** Re-reading: if the FIRST call succeeded, the cache row WAS written (handler success → cache write at end of `withIdempotency`). So the retry should hit the cache. The risk is *only* if the first call's cache write itself was lost — which is impossible in Convex because it's in the same transaction as the txn write.

**Revised analysis:** the issue is narrower but still real for **actions** (not mutations). The Xendit-related work (`requestPayment`, `manuallyConfirmPayment`, `cancelTransaction`) are all ACTIONS. Actions are NOT transactional. So:

- `requestPayment` action: 1) Xendit HTTP succeeds, 2) Convex `_persistInvoiceCommit_internal` succeeds, 3) cache write happens — if the action throws between (2) and (3), retry would re-call Xendit and create a SECOND invoice on Xendit's side.

The action-level idempotency must use a different pattern: do the **idempotency check before the side-effecting HTTP call**, and persist the cache row **inside the same internal mutation** that records the Convex-side effect of the action.

**Recommendation:** add an explicit "Idempotency for actions" section to the spec covering:
- The `_lookup_internal` query (v0.2 pattern) is called at action start; on hit, return cached response and skip the action body.
- After the side-effecting work succeeds, the internal mutation that commits to Convex ALSO writes the idempotency cache row in the same transaction. This guarantees: if the Convex side commits, the cache is written; if the Convex side rolls back, the cache is not written.
- Xendit-side idempotency: pass `X-IDEMPOTENCY-KEY` header to Xendit so Xendit also dedupes (Xendit Invoice API supports this). Same key → same invoice.

This collapses the duplicate-invoice risk: if the first call succeeded on Xendit + Convex but the response was lost, the retry passes the same Xendit idempotency key → Xendit returns the same invoice → Convex internal mutation sees the cache row exists → returns cached response.

### Issue 2: Receipt-number year boundary timezone

**Spec text:** "atomic per-year counter for `R-YYYY-NNNN` allocation" and `_allocateReceiptNumber_internal(year)` — but the spec doesn't specify *which* year (UTC or WIB).

**Reality:** the booth operates in WIB (UTC+7). A sale at 23:30 WIB Dec 31 = 16:30 UTC Dec 31 — same calendar year, no drift. But a sale at 03:00 WIB Jan 1 = 20:00 UTC Dec 31 — **UTC year is OLD, WIB year is NEW**. Receipt number would be `R-OldYear-9999` when the booth, customers, and accounting all expect `R-NewYear-0001`.

**Recommendation:** explicitly compute year in WIB.

```ts
// in convex/lib/time.ts (new helper)
export function wibYear(timestamp: number): number {
  // WIB is UTC+7, no DST
  const wibMs = timestamp + 7 * 60 * 60 * 1000;
  return new Date(wibMs).getUTCFullYear();
}

// in transactions/internal._allocateReceiptNumber_internal:
const year = wibYear(Date.now());
```

Add a test for the boundary case: `_allocateReceiptNumber at 20:00 UTC Dec 31 returns R-{newYear}-0001`.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 3 | `pos_vouchers.created_by_staff_id` should be optional (vouchers created via Convex dashboard have no staff context) | M | L |
| 4 | `pos_stock_levels.updated_at` must be written in `_recordSaleMovement_internal` (spec doesn't mention it) | M | L |
| 5 | Multiple-lockouts dedup: don't fire second Telegram if a pending request for the same staff already exists | M | L |
| 6 | Self-reset via Telegram: explicitly note that locked-out manager can reset themselves through the Telegram path | L | L |
| 7 | Token hash comparison: use `crypto.timingSafeEqual` even for SHA-256 (consistency + defense in depth) | L | L |
| 8 | CLAUDE.md update checklist: enumerate which sections of CLAUDE.md need updates in this phase | M | L |
| 9 | Re-export existing `hashPin` helper (v0.2 `convex/auth/actions.ts`) so changePin/resetStaffPin/manuallyConfirmPayment/bootstrap/approveStaffPinReset all use the same path | L | L |
| 10 | Document Convex optimistic-concurrency retry behavior on `pos_receipt_counters` and `pos_vouchers.used_count` (no manual locking needed) | L | L |
| 11 | Manual override fraud surface: explicitly document the trade-off ("trust the manager") and the daily dashboard countermeasure (v0.5) | M | L |
| 12 | `pos_approval_requests.status` enum extensibility note — v0.4 will add "denied" state | L | L |
| 13 | Service worker policy for `/approve/:token`: network-first (token validity must be live; can't be cached) | L | L |
| 14 | `_persistInvoiceCommit_internal` arg should include the `xendit_idempotency_key` that the action sent to Xendit, for audit traceability | L | L |

### Improvement 3: pos_vouchers.created_by_staff_id should be optional

**Spec line:** `created_by_staff_id: v.id("staff")` (required).

**Reality:** v0.3 ships no manager UI for voucher CRUD. Managers create vouchers via the Convex web dashboard, which has no staff session context. They can insert a row directly. The schema would reject the row without a valid `staff_id` value.

**Fix:** `created_by_staff_id: v.optional(v.id("staff"))`. When the v0.5/v0.6 manager portal lands, it'll always supply this. Dashboard-created rows can omit it (with audit noting `created_via: "dashboard"`, or just an empty field).

### Improvement 4: pos_stock_levels.updated_at must be written

**Spec lists** `pos_stock_levels.updated_at: v.number()` in the moved-to-inventory schema. But the `_recordSaleMovement_internal` description says only "decrements pos_stock_levels.on_hand". The patch must also update `updated_at: Date.now()` for read-side staleness detection.

**Fix:** in the `_recordSaleMovement_internal` body sketch, add: `patch pos_stock_levels: { on_hand: prev - qty, updated_at: Date.now() }`.

### Improvement 5: Multiple-lockouts dedup

**Scenario:** Lucy fails 3 PINs → locked → 60s passes → counter resets → Lucy fails 3 more → locked again. Spec's current trigger: `if (justLocked) scheduler.runAfter(notifyStaffLockout)`. This fires a SECOND Telegram message, creates a SECOND `pos_approval_requests` row. Manager now has two pending links for the same staff.

**Fix:** in `notifyStaffLockout` action:
```
Before _createRequest_internal, query existing pending requests:
  const existing = await query pos_approval_requests
    .by_subject_staff(staffId)
    .filter(r => r.status === "pending" && r.token_expires_at > Date.now() && r.kind === "staff_pin_reset")
    .first();
  if (existing) return { skipped: true, reason: "pending_request_exists" };
```

### Improvement 6: Locked-out manager self-reset via Telegram

**Edge case:** Lucas (sole manager in v0.3 bootstrap) locks himself out at the booth. Telegram message arrives in the Managers group. Lucas taps the link, enters his own PIN, sets a new one for himself.

**Question:** does this work? Lockout state in `pos_auth_attempts` is checked by `loginWithPin`. `approveStaffPinReset`'s manager-PIN verify (argon2id only checks pin_hash) doesn't consult the lockout table. So yes, this works.

**This is by design**, but needs to be explicit in the spec so future readers don't "fix" the lockout-check oversight.

**Fix:** add a sentence to the "Telegram approval flow" section: *"Locked-out managers can reset themselves through this path; the argon2id verify of `managerPin` against `pin_hash` does not consult `pos_auth_attempts`. This is intentional — Telegram authorizes off-booth action, lockout only restricts booth login."*

### Improvement 7: Constant-time token comparison

**Spec text:** "sha256-hash token, look up by `by_token_hash`". After the lookup retrieves the row, the comparison is implicitly `index_match`, which is internally `===`. SHA-256 of high-entropy input is collision-resistant, but constant-time comparison is the standard discipline.

**Fix:** in the action, after retrieving the stored hash, explicitly compute `crypto.timingSafeEqual(Buffer.from(computedHash, "hex"), Buffer.from(storedHash, "hex"))`. Minor perf cost, consistent with ADR-034's API-token pattern.

### Improvement 8: CLAUDE.md update checklist

Spec's success criteria mentions "no TODO/TBD/FIXME" but doesn't enumerate which sections of `CLAUDE.md` need touching. They are:

- **File locations** section — add `convex/transactions/`, `convex/payments/`, `convex/inventory/`, `convex/vouchers/`, `convex/approvals/` paths + new `src/hooks/useCart.ts`, `useXenditPayment.ts`, `useOfflineQueue.ts`, `useStartupReconciliation.ts`, `routes/sale/*.tsx`, `routes/approve/[token].tsx`.
- **Business rules that affect code** — possibly add an explicit rule about "All approvals go through `pos_approval_requests` rows (off-booth) OR direct manager-PIN-at-booth flow (inline); both produce identical audit shapes via the shared `_changePinCommit_internal` pattern." Or codify into ADR-035.
- **How to add a feature** — if any new step (e.g., "if the feature adds an approval kind, document the kind in `pos_approval_requests.kind` enum + `approvals/__tests__/`").
- **Auth section** — add a sentence about the changePin / resetStaffPin / lockout-→-Telegram-reset paths.

### Improvement 11: Manual override fraud surface

The spec calls it "trust the manager" path but doesn't document the trade-off or the countermeasure. ADR-000 §8 already says: "Manual override governance: daily dashboard surfaces manual-override count per staff. Sustained high rate triggers manager investigation."

**Fix:** add a "Security trade-offs" subsection to the manual override description noting: (a) manual override is a known fraud surface, (b) mitigation is audit-log surveillance via the v0.5 manager dashboard, (c) v0.3 ships the action; the surveillance UI lands v0.5.

---

## 4. Refinements (Optional)

- Voucher `value` field for `type=percentage` should be bounded (0-100 inclusive). v0.3 has no schema validator for this; tests can catch but `v.number()` is permissive. Defer to runtime check in `validateVoucher`.
- The Xendit `payment_methods: ["QRIS", "BCA"]` array order in spec mentions `["QRIS", "BCA"]` (single array). Confirm in plan whether to send both methods on one invoice or two separate invoices (per ADR-011 it's one invoice with both methods listed).
- `approvals/public.getByToken` should NOT return the `token_hash` field in the response payload — only the request shape needed for UI rendering. Defense-in-depth: don't even ship hashed token to the client.
- Re-state in the spec that `idempotencyKey` is `v.string()` (UUID format expected, not enforced server-side — Convex doesn't have UUID type).

---

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| `withIdempotency` HOF | `convex/idempotency/internal.ts` | Wrap every new public mutation in v0.3 |
| `_lookup_internal` query | `convex/idempotency/internal.ts` | Action pre-execution short-circuit (v0.2 auth pattern) |
| `logAudit` plain helper | `convex/audit/internal.ts` | Called inside every state-changing mutation |
| `hashPin` argon2id helper | `convex/auth/actions.ts` (exported in v0.2) | Reuse for bootstrap, changePin, resetStaffPin, manuallyConfirmPayment, approveStaffPinReset |
| `_recordFailedAttempt` mutation | `convex/auth/internal.ts` | Extend with `scheduler.runAfter` trigger; do not re-implement |
| `useDeviceId`, `useSession` hooks | `src/hooks/` | Cart and charge screens consume these unchanged |
| `useCatalogCache` hook | `src/hooks/` | Extend with voucher cache; do not implement separate `useVoucherCache` |
| `convex/telegram/send.ts` | existing v0.2 POC | Add `staff_pin_reset` kind to the discriminated union; reuse webhook + HTML escape + idempotency machinery |
| `NumericKeypad` component | `src/components/pos/` | Reuse for new PIN entry in changePin UI (v0.5) and manual-override modal (v0.3) and `/approve/:token` (v0.3) |
| `convex/lib/telegramHtml.ts` | existing v0.2 POC | Reuse HTML-escape for `staff_pin_reset` template |

### Potential duplication risks

- **Voucher cache hydration**: spec says voucher list is added to catalog cache snapshot. Make sure this is **one extension to `useCatalogCache`**, not a separate `useVoucherCache` (would duplicate IDB schema, cache lifecycle, etc.).
- **PIN entry UI**: three new contexts need PIN entry (changePin, manual-override modal, approve.tsx). Build one `<PinSheet>` component that takes a label + onSubmit; don't fork three near-identical components.

---

## 6. Phase / Wave Accuracy

The spec defers phase ordering to the implementation plan. The "Open items deferred to plan-writing" section explicitly lists ordering as a plan-time concern. ✅ Correct separation of concerns.

**One pre-plan flag:** schema must land first (per CLAUDE.md "If the feature adds a table or column, update SCHEMA.md first, then convex/schema.ts"). The plan must order:
1. Schema additions (transactions, payments, inventory, vouchers, approvals) + `pos_stock_levels` move
2. Foundation: bootstrap action (independent of sale flow)
3. Backend module bodies (transactions → payments → vouchers → inventory + approvals)
4. Auth extensions (changePin, resetStaffPin)
5. Frontend hooks (useCart, useXenditPayment, useOfflineQueue, useIdempotency upgrade, useStartupReconciliation)
6. Frontend routes (sale, drafts, voucher, charge, charge-success, approve)
7. Webhook + polling + manual override wiring
8. ADR-035 + CLAUDE.md updates + CHANGELOG

---

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Schema additions, `_confirmPaid` funnel, all backend modules | `convex-expert` | Domain match — Convex backend |
| Frontend hooks (`useCart`, `useXenditPayment`, `useOfflineQueue`, etc.) | `frontend-integrator` | React + Convex hooks |
| Frontend routes + charge screen state machine | `ui-component-builder` | shadcn/Tailwind components |
| `/approve/:token` route | `ui-component-builder` | shadcn + Convex public query |
| Cross-cutting: ADR-035, CLAUDE.md updates, RUNBOOK | `—` (manual / no specific agent) | Documentation work |
| Code review post-implementation | `code-reviewer` | Existing project agent |

(All agents listed exist in the project's roster per the system prompt.)

---

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branch specified | ⚠️ Deferred to plan (spec says `feat/v0.3-sale-xendit` likely) |
| Branch naming follows convention | ✅ Matches v0.2's `feat/v0.2-auth-catalog` |
| Merge strategy documented | ⚠️ Deferred to plan — PR + squash-or-merge decision pending |

### Commit checkpoints (recommended for plan)

The plan should commit at these natural boundaries (each one atomic + rollback-able):

1. After schema additions → `feat(v0.3): add transactions, payments, inventory, vouchers, approvals schemas`
2. After `pos_stock_levels` move → `refactor(v0.3): move pos_stock_levels from catalog/ to inventory/`
3. After bootstrap action → `feat(v0.3): seed bootstrap action`
4. After each backend module → one commit per module
5. After each frontend hook → one commit per hook
6. After each frontend route → one commit per route
7. After ADR-035 → `docs(v0.3): ADR-035 telegram as internal comms`
8. After CLAUDE.md + RUNBOOK + CHANGELOG → `docs(v0.3): update CLAUDE/RUNBOOK/CHANGELOG`

### Pre-push verification

- ✅ `npm test` in spec
- ✅ `npm run typecheck` in spec
- ✅ `npm run build` in spec
- ✅ Manual smoke flows enumerated (5 of them) in success criteria

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ⚠️ Deferred to plan (per-task atomic commits is the v0.2 pattern; will be inherited) |
| Deployment order | ⚠️ Deferred to plan, but the implicit order (schema → backend → frontend, all in one PR) is implied by the section ordering |
| Data backup needed | No — v0.3 ships against dev/staging only per prod-cutover-deferral decision |
| Migration safety | ✅ — new tables only, one table moved within same deployment (no data migration) |

---

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Schema additions | `docs/SCHEMA.md` — new tables + new audit enum |
| Bootstrap action | New `docs/RUNBOOK.md` |
| Backend modules complete | `docs/API_REFERENCE.md` (if it exists and is current) |
| ADR-035 (Telegram graduation) | `docs/ADR/035-telegram-as-internal-comms.md` + `docs/ADR/README.md` (index) + mark 027 + 033 as superseded |
| Frontend complete | `CLAUDE.md` file locations section + business rules section |
| Phase complete | `docs/CHANGELOG.md` |
| Phase complete | `docs/PROGRESS.md` — mark all v0.3 tasks ✅ with commit SHAs |

### CHANGELOG draft (proposed for v0.3 entry)

```markdown
## [v0.3] — 2026-MM-DD - Sale flow + Xendit + PIN management

### Added
- Sale flow: cart → charge → QRIS/BCA VA → receipt (snapshot pricing, integer rupiah)
- Three-path payment confirmation (webhook + polling + manager-PIN manual override)
- Saved drafts + resume + delete
- Voucher apply (cached read, server re-validate, race-tolerant redemption with VOUCHER_OVER_REDEEMED flag)
- Stock movements (sale-source) with paid-only decrement, negative-stock allowed + NEG_STOCK flagged
- Reconciliation on reload (ADR-026)
- Receipt number allocation (R-YYYY-NNNN, WIB calendar year)
- PIN management: bootstrap, self-change PIN, manager-reset-other-staff PIN
- Off-booth PIN reset via Telegram approval (first use of pos_approval_requests pattern, generalized for v0.4 expansion)
- ADR-035: Telegram as internal comms channel (supersedes ADR-027 + ADR-033)

### Changed
- pos_stock_levels moved from catalog/ to inventory/ module
- useIdempotency: now IDB-persisted with 24h TTL matching server window
- catalog query reads stock_levels via inventory.public.getStockLevels (cross-module reactive sub)
```

---

## 10. Testing Plan Assessment

**Verdict:** Adequate — but 6 specific cases need to be added.

### Planned tests (from spec)

Strong coverage across:
- All backend modules: public functions + key internal helpers
- All frontend hooks: state transitions, persistence, polling cadence, IDB
- All routes: smoke renders
- Star tests: funnel through 3 sources, webhook dedup, voucher race, reconciliation race, lockout-fires-scheduler

### Missing test coverage (must add)

| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| T1 | Token TTL boundary: token at exactly `token_expires_at - 1ms` accepts; at exactly `token_expires_at` rejects | Off-by-one in date math can let expired tokens authorize | `approvals/__tests__/tokenLifecycle.test.ts` with fake timer at boundary |
| T2 | `cancelTransaction` with no current invoice | requestPayment-failure-then-cancel must work | `transactions/__tests__/cancelTransaction.test.ts` setup: commit charge intent, do not call requestPayment, then cancel |
| T3 | `cancelTransaction` when Xendit cancel-API returns 5xx | Best-effort behavior must be exercised | Mock Xendit `cancelInvoice` to throw; assert status flips to cancelled + audit logs `success: false` |
| T4 | `_projectedNegStockFlag_internal` with multi-product-same-SKU cart | A "Dubai 1pc" + "Dubai 8pc" cart both decrement the same `dubai` component; flag detection must sum across products | `transactions/__tests__/commitCart.test.ts` — cart with two different products that share a component |
| T5 | `_allocateReceiptNumber_internal` year rollover at WIB midnight | Critical Issue #2 — must be regression-tested | `transactions/__tests__/receiptCounter.test.ts` with fake clock at 16:00 UTC Dec 31, then 17:01 UTC Dec 31 (= 00:01 WIB Jan 1) |
| T6 | `resumeDraft` race: two staff concurrently resume same draft → only one succeeds, other gets "draft already resumed" error | Two staff on overlapping shifts can both see the draft on `/sale/drafts` and tap resume simultaneously | `transactions/__tests__/resumeDraft.test.ts` — convex-test concurrent invocation |

### Test execution checkpoints (recommended for plan)

1. After each backend module → `npm test convex/<module>` passes
2. After each frontend hook → `npm test src/hooks/<hook>` passes
3. After each route → smoke test passes
4. Before merge → full `npm test && npm run typecheck && npm run build`
5. Pre-merge manual smoke: all 5 flows in success criteria

### Regression risk

- v0.2 auth tests must continue to pass after `_recordFailedAttempt` is extended with scheduler trigger
- v0.2 catalog test must continue to pass after `pos_stock_levels` moves to `inventory/`
- v0.2.1 module-boundary lint must continue to pass with new modules

---

## 11. Edge Cases to Address

- [ ] Idempotency: action-level error handling + Xendit-side idempotency-key passthrough (Critical Issue #1)
- [ ] Receipt-number: WIB year boundary (Critical Issue #2)
- [ ] Multiple lockouts in succession: dedup notification (Improvement #5)
- [ ] Locked-out manager self-reset via Telegram (Improvement #6 — explicit documentation)
- [ ] `requestPayment` fails before invoice persisted, then cancel called (test T2)
- [ ] Xendit cancel-API itself fails on cancelTransaction (test T3)
- [ ] Multi-product-same-SKU NEG_STOCK detection (test T4)
- [ ] Concurrent resumeDraft from two staff (test T6)
- [ ] Voucher race already covered in star tests
- [ ] Reconciliation race against webhook already covered in star tests

---

## 12. Approval Conditions

**To approve, address:**
1. **Critical Issue #1** — action-level idempotency + Xendit idempotency-key passthrough explicitly specified
2. **Critical Issue #2** — receipt-number uses WIB year

**Recommended before implementation:**
3-14. All Improvement-class items folded into the spec
T1-T6. All Missing test coverage items added to the testing strategy section

After these fixes, the spec is approvable for downstream plan writing via `superpowers:writing-plans`.

---

*Generated by /staffreview — Frollie POS v0.3 design spec review, 2026-05-27*
