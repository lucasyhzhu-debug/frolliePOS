# Staff Review: v1.2 #10 — Retire BCA VA + static-account manual transfer (SPEC)

**Date:** 2026-06-19
**Plan:** `docs/superpowers/specs/2026-06-19-v1.2-phase3-manual-bca-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (spec carries implementation intent: file changes, signatures, test plan, rollback)

---

## 1. Summary

**Overall Assessment:** Revise (small, surgical) — the architecture is sound and well-grounded against real code, but one **Critical** correctness gap (the manual tab can't render under the existing `phase` machine) and one **Improvement** money-safety gap (live QR not invalidated on manual confirm) must be folded into the spec before planning.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | Manual tender UI cannot render under the current `phase` machine | Logic / FE correctness | §6.3 |

### C1: The manual tab renders nothing under the existing phase machine

`useXenditPayment.computePhase` (`src/hooks/useXenditPayment.ts:21-29`) returns `{kind:"loading"}` whenever `!invoice`. The charge screen's entire body is a `phase.kind` switch (`charge.tsx:462-724`): `loading → "Preparing payment…"` spinner. The MANUAL_BCA tab has **no invoice by design**, so `phase` is permanently `"loading"` and the account/attestation UI never renders. Worse: after a manual confirm, `txn.status` flips to `"paid"` but `computePhase` still returns `"loading"` (it short-circuits on `!invoice` *before* checking status), so the reactive `phase.kind === "paid"` navigation effect (`charge.tsx:236-240`) never fires either.

**Recommendation:** make the spec explicit that the manual tender is rendered **independent of `phase`**, gated on `selectedMethod === "MANUAL_BCA"` (its own branch covering amount-due + account + attestation + confirm), and that post-confirm navigation relies on the **awaited `confirmManualBcaPayment` result** (navigate on resolve), not the reactive phase. The `phase` machine stays the QRIS tab's concern only. (No change to `computePhase` needed — just don't route the manual tab through it.)

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | Invalidate the live QRIS invoice on manual confirm (double-pay safety) | H | L |
| I2 | Stable idempotency key for the confirm | M | L |
| I3 | Acknowledge the EOD double window-scan trade-off | L | L |

### I1: Cancel the active QRIS invoice when a manual-BCA confirm commits

The charge screen defaults to QRIS (`selectedMethod` initial `"QRIS"`, `charge.tsx:75`), so a live QR is auto-minted on mount before staff ever switch to the manual tab. Confirming manual-BCA flips the txn to `paid` but leaves that QR **live on Xendit** — and per ADR-036 Decision E there is **no QR expire API**, so a customer who later scans it pays a *second* time. The webhook re-fire is ledger-safe (the funnel status-guards → silent no-op) but cash is double-collected with **no alert** (the `confirmed_on_terminal` branch only fires for non-paid terminal txns, not an already-`paid` one).

**Recommendation:** in `confirmManualBcaPayment`, after the funnel commits, call `internal.payments.internal._cancelActiveInvoiceForTxn_internal({ txnId, cancel_reason: "manual_bca_confirmed", actor_id: staffId, source: "booth_inline" })` — this supersedes the local invoice row + emits an audit trail. Document the **residual** in the ADR-036 amendment: the local cancel cannot expire the QR on Xendit's side, so the reconciliation summary (which surfaces every manual-BCA deposit) remains the backstop for catching a stray double-pay. This mirrors the existing cancel-on-abandon path (`_cancelActiveInvoiceForTxn_internal` is already the sanctioned writer).

### I2: Use a stable idempotency key for `confirmManualBcaPayment`

The spec leaves the key generic. A stable `confirm-manual:${txnId}` (rather than a fresh `crypto.randomUUID()` per tap) makes an accidental double-tap a cache hit instead of a second funnel attempt. The funnel is idempotent regardless, but the stable key keeps the cache clean and matches the `pay:${txnId}:${method}` convention already used for invoice creation (`charge.tsx:90`).

### I3: EOD double window-scan is acceptable — note it

The founders cron will call both `_dailySalesSummary_internal` and the new `_manualBcaReconciliation_internal` over the same WIB window (two scans of the same paid set). At booth volume this is negligible, and keeping `_manualBcaReconciliation_internal` standalone is the right call because **#6's clock-out reads it independently** (different window: device-day vs founders-day; different role gate). Just record the trade-off in the spec so it isn't re-litigated.

## 4. Refinements (Optional)

- **R1:** `renderTxnTicker` and `renderFoundersSummary`'s new lines must route staff names + receipt numbers through `escapeHtml` (the renderers already do for existing fields — keep the invariant).
- **R2:** `instrumentLabel`'s signature change (boolean → `{isManual, isManualBca}`) ripples to `convex/lib/__tests__/telegramHtml.test.ts` — note the test update in the plan.
- **R3:** Pin the founders-summary itemized-line cap to a concrete number (e.g. 30) so the overflow note is testable.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| Receipt-config CRUD | `convex/settings/public.ts:154-290` + `internal.ts:5-31` | Template for `getManualBcaConfig`/`updateManualBcaConfig` + `MANUAL_BCA_DEFAULTS` |
| `_onPaidManual_internal` read-back guard | `convex/payments/internal.ts:331-376` | Template for `confirmManualBcaPayment`'s RECEIPT_UNCONFIRMED guard |
| `_cancelActiveInvoiceForTxn_internal` | `convex/payments/internal.ts:223-267` | Reuse for I1 (don't write a new cancel path) |
| `_dailySalesSummary_internal` window scan | `convex/transactions/internal.ts:327-351` | Pattern for `_manualBcaReconciliation_internal` (same `by_status_paid_at` index) |
| `FieldMessage` (#12) | `src/components/ui/field-message.tsx` | Inline error on the manual tab + auto-create catch |

### Potential duplication risks
- None — the spec correctly reuses the funnel rather than re-implementing confirm logic.

## 6. Phase / Wave Accuracy

Ordering is correct: schema → settings defaults/CRUD → funnel/confirm → ticker → reconciliation/EOD → FE → docs/ADR. Backend before frontend; atomic ship (mutation, no action rename). No ordering issues.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Backend (settings/funnel/reconciliation) | `convex-expert` | Convex funnel + index + idempotency surface |
| Charge-screen rewrite | `frontend-integrator` | React + Convex hook wiring, FieldMessage |

(Execution dispatches via the `/clear` handoff; agents above are advisory.)

## 8. Git Workflow Assessment

Squash-PR per repo convention; atomic backend+frontend (deploy-skew safe — mutation, `BCA_VA` literal retained). Commit boundaries: schema+defaults → settings CRUD → funnel+confirm+cancel → ticker → reconciliation+EOD → FE → docs/ADR → tests. Pre-push: `npm run typecheck` + `npx vitest` + `npm run build`. Rollback: additive schema (no migration) + a mutation (revertible without deploy-skew).

## 9. Documentation Checkpoints

`docs/SCHEMA.md` (pos_settings fields + `settings.manual_bca_updated` audit string), `docs/ADR/036` amendment, `CHANGELOG`/PROGRESS. CLAUDE.md needs no new rule (reuses existing patterns).

## 10. Testing Plan Assessment

**Verdict:** Adequate (spec §9 covers happy + idempotent re-fire + non-awaiting no-op + RECEIPT_UNCONFIRMED + reconciliation + ticker + settings + charge render). **Add for the folded findings:** a test that manual confirm cancels the active QRIS invoice (I1), and a charge-screen test that the manual tab renders its UI (not the phase spinner) and navigates on confirm (C1). Test homes exist: `convex/payments/__tests__/onPaidPaths.test.ts`, `settings/__tests__/receiptConfig.test.ts`, `lib/__tests__/telegramHtml.test.ts`.

## 11. Edge Cases to Address

- [x] Live QR double-pay after manual confirm → I1 + documented residual
- [x] Manual tab render under phase machine → C1
- [ ] `enabled:false` hides the tab AND blocks `confirmManualBcaPayment` server-side? **Recommend the mutation does NOT gate on `enabled`** (a sale mid-flight when a manager toggles off shouldn't fail) — the toggle gates UI visibility only. Note this in the spec.
- [x] `count===0` omits the EOD section
- [x] Telegram 4096 cap on itemized lines

## 12. Approval Conditions

**To approve, address:**
1. C1 — manual tender renders independent of `phase`; navigate on awaited confirm.

**Recommended before implementation (fold into spec):**
1. I1 — cancel active invoice on manual confirm + document residual.
2. I2 — stable idempotency key.
3. I3 — note EOD double-scan trade-off.
4. Edge case: confirm mutation does not gate on `enabled`.

---

*Generated by /staffreview*
