# Staff Review: v0.5.6 — Admin wiring + receipt/refund UX (SPEC)

**Date:** 2026-06-03
**Plan:** `docs/superpowers/specs/2026-06-03-v0.5.6-admin-wiring-and-receipt-refund-ux-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (design spec; phase/wave + commit detail deferred to `writing-plans` by design)

---

## 1. Summary

**Overall Assessment:** Revise (then proceed to `writing-plans`)

The spec's core premise — "every backend function already exists; this is pure UI wiring" — **holds up under verification**. All four backend surfaces are confirmed present with zero (or single-screen) FE callers. No backend change is needed for A/C/D, and B's optional device-deactivate is correctly fenced out.

But four "open items" the spec deferred to planning are **answerable now by reading code**, and one spec claim is **materially wrong**: Part D's `/refund` index is *not* a stub — it is a complete, shipped, tested refundable-transactions list. Planning against the spec as written would specify rebuilding working code. Fix the five Improvements below (mostly spec corrections) before planning; none are blocking architecture defects.

### Verification ledger (claims checked against real code)

| Spec claim | Verdict | Evidence |
|---|---|---|
| `auth.changePin` exists, not called in `src/` | ✅ TRUE | `convex/auth/actions.ts:177`; `grep changePin src/` → 0 matches |
| `staff.public.generateDeviceSetupCode` exists, not wired into UI | ✅ TRUE | `convex/staff/public.ts:113`; `grep generateDeviceSetupCode src/` → 0 matches |
| `getReceiptForPrint` exists, surfaced only on charge-success | ✅ TRUE | `convex/receipts/public.ts:24`; only FE caller `src/routes/sale/charge-success.tsx:41` |
| Printer stack (`useThermalPrinter`, `PrinterSheet`, `PrinterProvider`) exists | ✅ TRUE | `PrinterProvider` wraps `<Outlet>` in `RootLayout.tsx:56` — context reaches every spoke |
| Refund routes exist (`/refund`, `/refund/:txnId`) | ✅ TRUE | `router.tsx:96-97` |
| `/refund` index is a stub | ❌ **FALSE** | `src/routes/refund/index.tsx` is a full `RefundList` querying `refunds.public.listTodaysRefundable` (`convex/refunds/public.ts:21`), navigating to `/refund/:txnId` |
| History detail computes `refundStatus`/`REFUND_BADGE` | ✅ TRUE | `src/routes/history/$txnId.tsx:116-117`; keys `none\|partial\|full` (`src/lib/pos-labels.ts:9`) |
| `USE_CHANGE_PIN_FOR_SELF` blocks self-reset | ✅ TRUE (line drift) | logic in `convex/auth/actions.ts` `resetStaffPin` (~line 241+), not line 25 as spec cites |

## 2. Critical Issues (Must Fix)

None. All backend dependencies verified present; no schema/migration/security defect. The items below are spec corrections that prevent wasted/incorrect implementation, classified as Improvements.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Part D — `/refund` list already built; shrink scope to *linking*, don't rebuild | H | L |
| 2 | Part A — error map is incomplete; FE idempotency mechanism must be specified | H | L |
| 3 | Part C — mirror `charge-success`'s `usePrinter()` button, not "open PrinterSheet" | M | L |
| 4 | Part B — `mgr/home` is a nav launcher, not a content screen; use a dedicated spoke | M | L |
| 5 | Part A — resolve placement: a "Change PIN" tile in home's YOU group → spoke route | M | L |

### Improvement 1: Part D — the refund list exists; scope is *linking only*

`src/routes/refund/index.tsx` is a complete `RefundList`: it queries `api.refunds.public.listTodaysRefundable` (`convex/refunds/public.ts:21`), renders today's refundable txns, and navigates to `/refund/:txnId`. It is routed at `/refund` (`router.tsx:96`). The spec's Open Item #3 ("confirm implemented vs stub") and its fallback ("build a minimal refundable-transactions list") are **resolved: implemented**. CLAUDE.md's routes table still says *"Stubbed: refund"* — stale.

The genuine gap is exactly what the spec's first sentence says: **nothing links to it.** So Part D collapses to two link additions, no list-building:
- **(a)** A per-txn "Refund" button on `history/$txnId.tsx` → `navigate(\`/refund/\${txnId}\`)`.
- **(b)** A "Refund" entry tile on the staff home launcher (`home.tsx` `TILES`, group `sell` or `you`) → `/refund` (the existing list).

**Recommendation:** Rewrite Part D + Open Item #3 to state the list is shipped; specify only the two links. Update CLAUDE.md routes table (`refund` → live list + detail). Do not re-implement `RefundList`.

### Improvement 2: Part A — incomplete error map + unspecified idempotency mechanism

`auth.changePin` (`convex/auth/actions.ts:177-230`) throws a **wider** set than the spec's three:
- `NEW_PIN_INVALID` (newPin not 4 digits, line 190)
- `SAME_PIN` (currentPin === newPin, line 191)
- `SESSION_INVALID` (session gone, line 196) — **not in spec**
- `INVALID_PIN` (deactivated/missing staff at line 201, **and** wrong currentPin via `verifyPinOrThrow`)
- `LOCKED_OUT` (3-strike lockout via `verifyPinOrThrow` pre-check, ADR-002) — **not in spec**, but spec text says "respect the 3-strike lockout"

The FE must map `LOCKED_OUT` (show the 60s lockout state) and `SESSION_INVALID` (force re-login) in addition to the three named.

**Idempotency mechanism (critical detail for the plan):** `changePin` is an **action** that does its *own* action-level cache (`_lookup_internal` at line 185, `_writeCache_internal` at line 223) — it is **not** a `withIdempotency`-wrapped mutation. The FE therefore mints a **one-shot `crypto.randomUUID()`** at submit time (the `shareReceipt` / `sale/drafts.tsx` convention, e.g. `$txnId.tsx:57`), **NOT** `useIdempotency` (which is for replayed mutations like login/payment). State this explicitly so the plan doesn't reach for `useIdempotency`.

**Recommendation:** Expand the Part A error-map bullet to the full set incl. `LOCKED_OUT`/`SESSION_INVALID`; add a line specifying the one-shot UUID idempotency key.

### Improvement 3: Part C — reuse `charge-success`'s `usePrinter()` button, not "open PrinterSheet"

The spec says Part C should "open `PrinterSheet`, fetch the view-model…". But `charge-success.tsx` — the canonical reprint surface — does **not** open `PrinterSheet`. It consumes the `PrinterProvider` context directly via `usePrinter()` (`{status, connect, print}`, line 38) and renders a single **connect-or-print button** (lines 159-163):

```ts
const { status: printerStatus, connect, print } = usePrinter();
const printData = useQuery(api.receipts.public.getReceiptForPrint,
  sessionId && txnId ? { sessionId, txnId } : "skip");
const onPrint = async () => {
  const bytes = encodeReceipt(printData.viewModel, printData.status, printData.statusLabel);
  await print(bytes); // toast on success/failure
};
```

`PrinterSheet` is the *standalone connection-management sheet* shown in the home header (`home.tsx:81`, `AppHeader.tsx`) — not the per-receipt print trigger. Part C should **lift the `charge-success` button verbatim** onto `history/$txnId.tsx` (next to "Bagikan struk"), reusing the same `PrinterProvider` context (no re-pair). This is simpler than the spec's PrinterSheet framing and matches the one proven pattern.

**Recommendation:** Reword Part C to "mirror `charge-success.tsx`'s `usePrinter()` connect-or-print button (reuses `PrinterProvider` context already wrapping the route tree)."

### Improvement 4: Part B — `mgr/home` is a nav launcher; use a dedicated spoke

The spec "decides" the setup code displays **inline on `mgr/home.tsx`**. But `mgr/home.tsx` is a **pure `NAV_CARDS` launcher** — a grid of `<Link>` cards to sub-routes (`mgr/home.tsx:13-23`). Every manager function (products, staff, vouchers, spoilage, receipt, refunds-pending, stock) is its **own spoke route**. Embedding a stateful mint→display→countdown→regenerate widget *inside* the launcher grid breaks that uniformity (a card that doesn't navigate but mutates+expands) and crowds the 2-col grid.

**Recommendation:** Add a 10th `NAV_CARD` → a new `/mgr/device-setup` spoke route that hosts the mint button + large monospace code + expiry countdown + regenerate. This honors the spec's intent (no modal, no CLI) while matching the established launcher→spoke idiom. A spoke route is *not* a "modal hop." Update Part B + Open Item #2 accordingly. (Optional device-list/deactivate stays deferred — needs a new backend mutation.)

### Improvement 5: Part A — resolve placement (Open Item #1)

The staff home (`home.tsx`) groups tiles into `SELL / STOCK / YOU / MANAGER` (`TILES`, line 28-38). The **YOU** group (Settlements, Lock+handoff) is the natural home for self-service account actions.

**Recommendation:** Add a "Change PIN" tile to the `you` group → a new `/account` (or `/account/pin`) spoke hosting the change-PIN form (current/new/confirm via `NumericKeypad`/`PinSheet`). Available to **any** logged-in staff (not `mgrOnly`). Resolves Open Item #1; mirrors the tile-launcher→spoke pattern used everywhere else. Avoids the larger "settings IA" the spec explicitly de-scopes.

## 4. Refinements (Optional)

- **Part D gate predicate:** confirm `getTransactionDetail`'s returned `txn` exposes a paid signal (it surfaces `paid_at`, `$txnId.tsx:118`) and gate the button on **paid AND `refundStatus !== "full"`**. `refundStatus` keys are `none|partial|full` (`pos-labels.ts:9`) — show "Refund" for `none`/`partial`, hide for `full`. For staff, `getTransactionDetail` is already server-today-scoped, so older txns 404 gracefully (refunds of old sales route via manager — consistent).
- **Part B countdown source:** `generateDeviceSetupCode` returns `{ code, expiresAt }` (confirmed by `convex/staff/__tests__/staff.test.ts:24`) — drive the countdown off `expiresAt`, format the code monospace. Regenerate re-calls the mutation (server supersedes prior code).
- **Part A copy:** map `LOCKED_OUT` to the same 60s-lockout affordance the login screen uses (reuse existing lockout copy if present) for consistency.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `usePrinter()` connect/print + `onPrint` | `src/routes/sale/charge-success.tsx:38-57` | Lift the button + `onPrint` onto `history/$txnId.tsx` (Part C) |
| `RefundList` (today's refundable) | `src/routes/refund/index.tsx` | **Already built** — link to it, don't rebuild (Part D) |
| One-shot idempotency-key idiom | `src/routes/history/$txnId.tsx:57` (`crypto.randomUUID()`) | Part A change-PIN submit key |
| `NumericKeypad` / `PinSheet` | `src/components/pos/` | Part A form inputs |
| `NAV_CARDS` launcher card | `src/routes/mgr/home.tsx:13` | Part B: add card → `/mgr/device-setup` spoke |
| `TILES` launcher tile | `src/routes/home.tsx:28` | Part A: add "Change PIN" (YOU); Part D: add "Refund" |
| `REFUND_BADGE` status keys | `src/lib/pos-labels.ts:9` | Part D gate predicate |

### Potential duplication risks
- **Rebuilding the refund list** (Improvement 1) — the single biggest duplication risk if the spec is planned verbatim.
- **Re-deriving receipt view-model client-side** for Part C — don't; consume `getReceiptForPrint` (ADR-043 explicitly rejects client re-derivation).

## 6. Phase / Wave Accuracy

Spec defers waves to `writing-plans`. Recommended ordering (all FE-only, independent, parallelizable):

| Part | Assessment | Notes |
|------|------------|-------|
| A (change PIN) | New `/account` spoke + tile + form | One-shot UUID key; full error map |
| B (device setup) | New `/mgr/device-setup` spoke + NAV_CARD | Mint/countdown/regenerate |
| C (reprint) | Additive button on `history/$txnId` | Lift `charge-success` `usePrinter()` pattern |
| D (refund entry) | 2 links only (history button + home tile) | List already exists |

No cross-part dependency; each is its own commit. No backend, so no deploy-ordering constraint (unlike v0.5.4).

## 7. Specialist Agent Recommendations

| Part | Recommended Agent | Rationale |
|------|-------------------|-----------|
| A–D FE wiring | `frontend-integrator` | React+Convex hook wiring, loading/error/toast states — its exact remit |
| A/B/C/D component tests | `frontend-integrator` (or general) | Vitest + Testing Library smoke/interaction tests |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ (worktree per pipeline) |
| Merge strategy | ✅ squash-PR (repo convention) |
| Rollback | ✅ additive UI; revert commits, no schema/migration |
| Deployment order | ✅ N/A — no backend change |

**Commit checkpoints (suggested):** (A) `feat(account): self change-PIN screen`; (B) `feat(mgr): device setup-code spoke`; (C) `feat(history): reprint receipt button`; (D) `feat(refund): wire entry points`; then docs (CLAUDE.md routes table, CHANGELOG).

### Pre-push verification
- [ ] `npm run typecheck`
- [ ] `npx vitest run` (new component tests + no regression on `$txnId.test.tsx`, `refund/__tests__`)
- [ ] `npm run build`

## 9. Documentation Checkpoints

| Part | Docs to update |
|------|----------------|
| D | **CLAUDE.md routes table** — `refund` is live (list + detail), not "Stubbed"; add `/account`, `/mgr/device-setup` |
| A/B/C/D | `docs/CHANGELOG.md` — v0.5.6 entry |
| — | `docs/PROGRESS.md` — v0.5.6 phase + Task IDs (pipeline step 6) |

### CHANGELOG draft
```markdown
## 2026-06-03 — v0.5.6 Admin wiring + receipt/refund UX
- Self "Change PIN" screen (/account) — wires existing auth.changePin (no backend change).
- Manager "Generate device setup code" spoke (/mgr/device-setup) — wires generateDeviceSetupCode.
- "Print receipt" on history detail — reuses getReceiptForPrint + PrinterProvider (ADR-043).
- Refund flow entry points — per-txn button on history + home tile to the existing /refund list.
```

## 10. Testing Plan Assessment

**Verdict:** Adequate (spec lists per-part tests); augment with the cases below.

### Missing test coverage (must add)
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | Part A maps `LOCKED_OUT` (and `SESSION_INVALID`) to copy | Spec's map omits them; lockout is a real path | mock `changePin` reject → assert lockout UI |
| 2 | Part A happy path calls `changePin` once with a UUID key | Guards against `useIdempotency` misuse | mock action, assert single call + key shape |
| 3 | Part C `onPrint` calls `encodeReceipt(viewModel,status,statusLabel)` | Ensures it consumes `getReceiptForPrint`, not re-derived | mock `getReceiptForPrint` + `usePrinter` |
| 4 | Part D button shown for `none`/`partial`, hidden for `full` | The gate predicate | render `$txnId` with each `refundStatus` |
| 5 | Part B non-manager cannot reach `/mgr/device-setup` | Manager gate (mirror `mgr/home` redirect) | render as staff → `<Navigate to="/" />` |

### Regression risk
- `src/routes/history/__tests__/$txnId.test.tsx` — adding buttons must not break existing share/render assertions.
- `src/routes/refund/__tests__/index.test.tsx` — untouched (don't modify the list).

## 11. Edge Cases to Address

- [ ] Part A: lockout mid-change (3rd wrong currentPin) → `LOCKED_OUT`, disable submit 60s.
- [ ] Part A: `SESSION_INVALID` (session force-ended) → toast + redirect to `/login`.
- [ ] Part C: `getReceiptForPrint` → `null` (non-paid/out-of-scope) → disable button (mirror `!printData` guard at `charge-success.tsx:160`).
- [ ] Part C: printer `unsupported` (non-Android-Chrome) → disabled-with-hint (existing pattern).
- [ ] Part D: fully-refunded txn → no "Refund" button; partial → button still shows.
- [ ] Part B: expired code → countdown hits 0, prompt regenerate (don't show a dead code as usable).

## 12. Approval Conditions

**To approve (edit spec before `writing-plans`):**
1. Improvement 1 — Part D: list exists; scope to linking; fix CLAUDE.md routes table.
2. Improvement 2 — Part A: full error map (`+LOCKED_OUT`, `+SESSION_INVALID`) + one-shot UUID idempotency key.
3. Improvement 3 — Part C: mirror `charge-success` `usePrinter()` button (not PrinterSheet).
4. Improvement 4 — Part B: dedicated `/mgr/device-setup` spoke + NAV_CARD.
5. Improvement 5 — Part A: "Change PIN" tile in home YOU group → `/account` spoke.

**Recommended:** adopt the 5 augmented test cases (§10).

---

*Generated by /staffreview*
