# Staff Review: v0.5.6 — Admin wiring + receipt/refund UX (PLAN)

**Date:** 2026-06-03
**Plan:** `docs/superpowers/plans/2026-06-03-v0.5.6-admin-wiring.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, File Structure, ordered TDD tasks, Testing, Success Criteria, Rollback all present)

---

## 1. Summary

**Overall Assessment:** Approve

The plan is execution-ready. Every flagged assumption was re-verified against real code (table below) and **all hold**. It reuses established patterns (login action-call + substring error-match, charge-success print wiring, the launcher→spoke idiom), ships complete TDD code with no placeholders, commits per logical unit, and carries the docs correction (CLAUDE.md routes table) the spec-gate mandated. No Critical or Improvement issues — three small refinements only.

### Plan-assumption verification ledger

| Plan assumption | Verdict | Evidence |
|---|---|---|
| `changePin` is an action w/ own idempotency cache; call via `useAction`, one-shot UUID | ✅ | `convex/auth/actions.ts:177,185-188,223-227` |
| `changePin` errors matchable by substring; `LOCKED_OUT:<secs>` format | ✅ | `verifyPin.ts:43` throws `LOCKED_OUT:${seconds_remaining}` on pre-check, **independent of `lockOnFail`**; `login.tsx:95` matches `/LOCKED_OUT:(\d+)/` |
| `generateDeviceSetupCode` mutation `{ idempotencyKey, sessionId } → { code, expiresAt }`, mgr-gated | ✅ | `convex/staff/public.ts:113-117,152-154` |
| `getReceiptForPrint → { viewModel, status, statusLabel }`; `encodeReceipt(vm,status,label)` | ✅ | `convex/receipts/public.ts:24`; `sale/charge-success.tsx:51` |
| `usePrinter()` shape `{ status, connect, print }`; safe `unsupported` default outside provider | ✅ | `PrinterProvider.tsx:9-18,36-38` |
| `getTransactionDetail` returns `txn: Doc<"pos_transactions">` incl. `status` (Part D gate) | ✅ | `transactions/public.ts:490-494` (`TxnDetail.txn = Doc<…>`) |
| `refundStatus` keys `none\|partial\|full` | ✅ | `src/lib/pos-labels.ts:9-13`; detail returns `refundStatus` `$txnId.tsx:116` |
| `SpokeLayout` accepts `title`/`backTo` (backTo optional) | ✅ | `SpokeLayout.tsx:4-8` spreads into `AppHeader`; usage `mgr/home.tsx:43`, `$txnId.tsx:124` |
| `PinEntry(onSubmit, reset)`, `NumericKeypad` buttons aria-label `Digit N` | ✅ | `PinEntry.tsx:5-10`; `NumericKeypad.tsx:94` |
| Router has `lock`, `mgr/staff` anchors; `home.tsx` TILES groups `sell`/`you` | ✅ | `router.tsx:95,108`; `home.tsx:28-38` |

## 2. Critical Issues (Must Fix)

None.

## 3. Improvements (Recommended)

None. (The spec-gate already folded the structural improvements — list-already-built, idempotency mechanism, spoke-not-inline, error-map — into the plan upstream.)

## 4. Refinements (Optional — at implementer's discretion)

- **R1 — LOCKED_OUT timing nuance (Part A).** Because `changePin` calls `verifyPinOrThrow` *without* `lockOnFail` (`actions.ts:205-211`), the **3rd** wrong current-PIN throws `INVALID_PIN` and only the **next** attempt (now locked) throws `LOCKED_OUT:<secs>` — unlike login, which surfaces `LOCKED_OUT` on the tripping attempt. The FE maps both, so behavior is correct; worth a one-line code comment so a future reader doesn't "fix" it to match login.
- **R2 — Manual smoke matrix.** Add a short manual checklist to Success Criteria for the device-only paths automated tests can't cover: real BLE reprint produces identical bytes to charge-success (Part C), and a real 2nd-device `/activate` consumes a minted code (Part B). Bluetooth + device-registration can't be exercised in jsdom.
- **R3 — `glyph` choices.** The chosen glyphs (`⚷`, `⊕`, `↩`) are arbitrary unicode; confirm they render in the booth device's font. Low stakes (cosmetic, matches existing glyph convention in `TILES`/`NAV_CARDS`).

## 5. Duplication Analysis

### Existing code to leverage (plan already does)
| Code | Location | Plan usage |
|------|----------|------------|
| Action call + substring error-match | `login.tsx:23,88-100` | Part A `changePin` + `friendlyChangePinError` |
| Print wiring (`usePrinter`+`getReceiptForPrint`+`encodeReceipt`) | `charge-success.tsx:38-57,159-163` | Part C lift-verbatim |
| `RefundList` (today's refundable) | `refund/index.tsx` | Part D links to it — **not rebuilt** ✅ |
| `PinEntry` inline pad | `auth/PinEntry.tsx` | Part A 3-step collector |
| Manager-gate redirect | `mgr/home.tsx:38-40` | Part B `<Navigate to="/" replace />` |

### Potential duplication risks
- None observed. The plan explicitly avoids the one real risk (rebuilding the refund list) and reuses the print pattern rather than re-deriving the view-model (ADR-043 compliant).

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|------|------------|-------|
| 1 Part A | Good | Self-contained; new route + tile + test |
| 2 Part B | Good | Self-contained; new spoke + NAV_CARD + test |
| 3 Part C | Good | Additive to `$txnId.tsx` |
| 4 Part D | Good | Additive to `$txnId.tsx` (after Task 3) + home tile |
| 5 Docs | Good | CLAUDE.md routes + CHANGELOG + full suite + build |

**Ordering issues:** none. Tasks 3 & 4 share `$txnId.tsx`; plan correctly sequences 3→4. No backend ⇒ no deploy-ordering constraint.
**Missing phases:** none.

## 7. Specialist Agent Recommendations

| Task | Recommended Agent | Rationale |
|------|-------------------|-----------|
| 1–4 | `frontend-integrator` | React+Convex hook wiring, loading/error/toast — its remit |
| 5 | general / inline | Docs edits + suite/build run |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch (worktree) | ✅ |
| Atomic commits per task | ✅ (5 commits, one per logical unit) |
| Merge strategy | ✅ squash-PR convention |
| `npm run typecheck` in plan | ✅ (Tasks 1,2,4,5) |
| `npx vitest run` in plan | ✅ (per-task + full in Task 5) |
| `npm run build` in plan | ✅ (Task 5) |
| Rollback | ✅ revert commits; no schema/migration |
| Deployment order | ✅ N/A (frontend-only) |

## 9. Documentation Checkpoints

| Task | Docs |
|------|------|
| 5 | CLAUDE.md routes table (refund→live; +`/account`, +`/mgr/device-setup`); `docs/CHANGELOG.md` v0.5.6 |
| pipeline step 6 | `docs/PROGRESS.md` + `progress.html` (outside the plan, by design) |

## 10. Testing Plan Assessment

**Verdict:** Adequate.

| Layer | What | Type | Status |
|-------|------|------|--------|
| FE A | changePin happy (single call + UUID key), mismatch, INVALID_PIN, LOCKED_OUT:30, SESSION_INVALID redirect | Vitest+RTL | planned |
| FE B | mint+countdown+UUID, regenerate distinct key, non-manager redirect | Vitest+RTL | planned |
| FE C | encode-from-view-model + print; disconnected→connect | Vitest+RTL | planned |
| FE D | shown none/partial, hidden full, hidden non-paid, navigates | Vitest+RTL | planned |
| Regression | existing `$txnId.test.tsx` untouched (safe `unsupported` default; unrecognized query→undefined) | Vitest | covered |

**Manual (must do, can't automate):** real BLE reprint byte-parity (C); real 2nd-device activation (B). → fold into R2.

## 11. Edge Cases to Address (plan covers)

- [x] Part A: wrong current PIN / lockout / new≠confirm mismatch / session death mid-flow
- [x] Part B: non-manager redirect; expired code (countdown→0 shows regenerate prompt)
- [x] Part C: printData null (disabled), unsupported printer (disabled), disconnected (connect)
- [x] Part D: fully-refunded hidden, non-paid hidden, partial shown

## 12. Approval Conditions

**To approve:** nothing blocking — assumptions verified, tests adequate, rollback safe.
**Recommended (optional):** R1 code comment on LOCKED_OUT timing; R2 manual smoke note in Success Criteria.

---

*Generated by /staffreview*
