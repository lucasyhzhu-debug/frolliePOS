# Staff Review: v0.5.4 — Bluetooth thermal receipt printing

**Date:** 2026-06-02
**Plan:** `docs/superpowers/specs/2026-06-02-bluetooth-thermal-printing-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Sections added — see §0

---

## 0. Plan Structure Additions

The artifact is a design/spec doc, not a phased plan. Reviewed as a pre-implementation plan; the following were missing and are supplied here:

- **Implementation phases / waves with SEQUENTIAL/PARALLEL markers** → see §6.
- **Explicit Success Criteria** (typecheck + build + behavioral) → see §12 of this review.
- **Rollback / deployment ordering as a discrete section** → see §8.
- **Test execution checkpoints** → see §10.

These must be carried into the PLAN.md that `writing-plans` produces.

---

## 1. Summary

**Overall Assessment: Revise** (2 Critical, fixable in-spec before planning — no rework of the approach).

The approach is sound and the feasibility is proven on-device. But the spec **collides with an existing, deliberate ADR-021 invariant** (public query seams must never return `receipt_token`) and **misses three already-built reuse points** (`shareReceipt`, `getTransactionDetail`, `src/lib/format.ts:buildReceiptUrl/rp/fmtDate`). It also omits the `@types/web-bluetooth` dependency, without which the client won't typecheck. Fix those and it's ready to plan.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `getReceiptForPrint` returns `receiptUrl` (embeds `receipt_token`) — violates the ADR-021 token-narrowing invariant enforced everywhere else | Security/Architecture | spec §3, §4 |
| 2 | `@types/web-bluetooth` not in `package.json`; `navigator.bluetooth`/`getDevices()` won't typecheck | Build/Testing | spec §6, §10 |
| 3 | Print query is "require session" only — but the comparable `getTransactionDetail` enforces staff→today-only scope; a flat session gate lets any staff print any historical receipt by id | Security | spec §4 |

### Issue 1: Returning the receipt token through a query seam breaks ADR-021

`transactions/public.ts:486 getTransactionDetail` deliberately withholds the token (lines 516–519):

> *"receipt_token is intentionally NOT returned. The FE goes through `shareReceipt` to mint/fetch the token, which narrows the capability surface (a Doc read at any other public seam can't accidentally leak the signed-URL secret — ADR-021)."*

The spec's `getReceiptForPrint` returning `receiptUrl = ${POS_BASE_URL}/r/${receipt_token}` reintroduces exactly the leak that comment guards against. The token (32-byte view capability) would now flow through a second public seam.

**Recommendation:** Split the responsibilities, reusing existing infra:
- **`getReceiptForPrint` (new query)** returns the `ReceiptViewModel` **only** (no token, no URL) — body data for the encoder.
- **Token for the QR** comes from the **existing `transactions.shareReceipt` mutation** (`public.ts:585`) — mint-on-demand, idempotent (reprints reuse the same token → stable QR), already audited. The client builds the URL with the **existing `src/lib/format.ts:buildReceiptUrl(token)`** (line 62).
- Print flow becomes: `shareReceipt` (token) **∥** `getReceiptForPrint` (ViewModel) → `encodeReceipt(vm, buildReceiptUrl(token))` → `print()`.

This deletes the `POS_BASE_URL`-in-query design entirely and reuses three existing pieces.

### Issue 2: Missing `@types/web-bluetooth`

`grep` confirms it's absent from `package.json`. Web Bluetooth has no ambient types in the default `lib`. `navigator.bluetooth`, `BluetoothDevice`, `getDevices()`, `writeValueWithoutResponse` all fail `tsc -b`.

**Recommendation:** Add `@types/web-bluetooth` as a devDependency and include it in `tsconfig`'s `types`/`compilerOptions.lib` path. Add a Task-0 "deps" step before any client code.

### Issue 3: Print query must mirror `getTransactionDetail`'s role scope

`getTransactionDetail` (lines 486–526) gates via `_resolveSessionRole_internal` and restricts **staff** to server-today (WIB) txns, manager to any. `getReceiptForPrint` reads the *same* sensitive data (full lines, RRN, payment detail) and must apply the **identical** scope, or it's a strictly weaker seam for the same data.

**Recommendation:** `getReceiptForPrint` reuses `_resolveSessionRole_internal` + the `wibDayWindow` today-check, returning `null` out-of-scope (graceful, matches the established pattern). Don't invent a new "require session" gate.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Reuse `src/lib/format.ts` (`rp`, `fmtDate`, `fmtTime`, `buildReceiptUrl`) in `escpos.ts` — do **not** reimplement money/time or import `convex/lib/*` into the client bundle | H | L |
| 2 | BE pre-derives the status label into `getReceiptForPrint`'s return (`status` + `statusLabel`) so the client never imports `convex/receipts/template.ts` (`computeReceiptStatus`/`STATUS_LABELS`) — avoids a `src → convex` layer breach | M | L |
| 3 | Extract a pure `chunkBytes(bytes, size)` from `useThermalPrinter.print()` and unit-test it — the only unit-testable slice of the BLE layer | M | L |
| 4 | Mount the printer icon via `AppHeader`'s existing `rightSlot` prop (it already takes one — no AppHeader internals edit) | L | L |
| 5 | Strip emoji (🍪💛) in the ESC/POS text path — the head can't render them; they'd print as `?`/garbage | M | L |

### Improvement 2: keep the client off `convex/`
`computeReceiptStatus` + `STATUS_LABELS` live in `convex/receipts/template.ts`, which imports `convex/lib/time`, `convex/lib/html`, `convex/refunds/lib`. Importing it into `src/lib/escpos.ts` drags server modules into the browser bundle and breaks the layer boundary. Per the v0.5.3a lesson "BE pre-derives UI labels when it has all inputs," have `getReceiptForPrint` return `status`/`statusLabel` computed server-side (it already runs `computeReceiptStatus` in the render path).

---

## 4. Refinements (Optional)

- Consider whether `PrinterSheet` belongs in a shared layout slot vs per-screen `rightSlot` (single-device booth — printer state is effectively global).
- `qrcode.react@4.2.0` is already a dep; if the raster-QR fallback is needed, prefer a matrix-producing lib (`qrcode`) over `qrcode.react` (DOM-only) — note in the fallback path.
- Name the sample test-print ViewModel as an exported fixture so the golden tests and `testPrint()` share one source.

---

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `shareReceipt` mutation | `convex/transactions/public.ts:585` | Mint/fetch the QR token (idempotent, audited) — don't add a token path |
| `getTransactionDetail` | `convex/transactions/public.ts:486` | Reference impl for session+role+today scoping; mirror it |
| `_buildViewModel_internal` | `convex/receipts/internal.ts:111` | Returns full `ReceiptViewModel` — wrap, don't rebuild |
| `computeReceiptStatus` | `convex/receipts/template.ts:68` | Call **server-side** in the new query; return derived label |
| `buildReceiptUrl(token)` | `src/lib/format.ts:62` | Build the QR target client-side |
| `rp` / `fmtDate` / `fmtTime` | `src/lib/format.ts:8,36,46` | Money + datetime in `escpos.ts` |
| `AppHeader` `rightSlot` | `src/components/layout/AppHeader.tsx:15` | Printer icon mount point |

### Potential duplication risks
- A second money formatter inside `escpos.ts` (use `rp`).
- A second receipt-status map client-side (return from BE instead).
- A hand-rolled receipt-URL string (use `buildReceiptUrl`).

---

## 6. Phase / Wave Accuracy

Spec had no ordered phases. Proposed:

| Wave | Work | Mode | Notes |
|------|------|------|-------|
| 0 | Add `@types/web-bluetooth` (+ `esc-pos-encoder`) dep; tsconfig types | SEQUENTIAL (first) | Unblocks client typecheck |
| 1 | BE: `receipts/public.ts:getReceiptForPrint` (ViewModel + status, role/today-scoped, **no token**) + tests | SEQUENTIAL | Deploy before FE uses it |
| 2a | `src/lib/escpos.ts` (pure encoder) + golden tests | PARALLEL with 2b | Depends on ViewModel type only |
| 2b | `src/hooks/useThermalPrinter.ts` + pure `chunkBytes` test | PARALLEL with 2a | No backend dep |
| 3 | `PrinterSheet` + `charge-success` print button (wires `shareReceipt` ∥ `getReceiptForPrint`) | SEQUENTIAL | Needs 1,2a,2b |
| 4 | ADR-043, CHANGELOG, API_REFERENCE, PROGRESS v0.5.4, on-device verification | SEQUENTIAL | Docs + manual QA |

**Ordering issue in spec:** none stated. **Missing:** Wave 0 dep step (critical).

## 7. Specialist Agent Recommendations

| Wave | Agent | Rationale |
|------|-------|-----------|
| 1 | `convex-expert` | Query auth/scoping + reuse of internal surfaces (ADR-034) |
| 2a/2b | `frontend-integrator` | Hook + lib wiring, Web Bluetooth lifecycle |
| 3 | `ui-component-builder` | `PrinterSheet` (shadcn bottom sheet, status states) |
| review | `code-reviewer` | Post-implementation |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ⚠️ Spec defers to "new branch off main" — confirm `feat/v0.5.4-printing` |
| Branch naming convention | ✅ matches `feat/vX.Y.Z-slug` |
| Merge strategy | ✅ squash-merge per repo convention |

**Commit checkpoints:** (1) deps → `chore: add web-bluetooth + esc-pos deps`; (2) BE query → `feat(receipts): getReceiptForPrint view-model query`; (3) encoder → `feat(print): ESC/POS receipt encoder`; (4) hook → `feat(print): useThermalPrinter Web Bluetooth`; (5) UI → `feat(print): printer sheet + charge-success print button`; (6) docs/ADR.

**Pre-push:** `npm run typecheck` + `npm run build` + `npx vitest` (golden + chunk tests).

### Rollback & deployment
| Concern | Status |
|---------|--------|
| Rollback | ✅ Additive (new files + one button + one query) — revert commits, drop deps. No schema change. |
| Deployment order | ⚠️ Deploy Convex (`getReceiptForPrint`) **before** Vercel FE that calls it |
| Data backup | No (no writes; `shareReceipt` token mint already exists) |
| Migration safety | ✅ No schema migration |

## 9. Documentation Checkpoints

| Wave | Docs |
|------|------|
| 1 | `docs/API_REFERENCE.md` (`getReceiptForPrint`) |
| 4 | `docs/ADR/043-web-bluetooth-escpos-printing.md`; `CLAUDE.md` (file locations: `src/lib/escpos.ts`, `useThermalPrinter`, new ADR row); `docs/CHANGELOG.md`; `docs/PROGRESS.md` (v0.5.4 phase + Task IDs) |

### CHANGELOG draft
~~~markdown
## v0.5.4 — Bluetooth thermal receipt printing
- Print 58mm receipts to the EPPOS EP5811AI over Web Bluetooth (ESC/POS), one tap on sale-complete.
- Printer auto-reconnects (Web Bluetooth getDevices); connect/test-print via printer sheet.
- New query receipts.getReceiptForPrint (view-model only; QR token via existing shareReceipt). ADR-043.
~~~

## 10. Testing Plan Assessment

**Verdict: Insufficient** (spec names golden tests + "manual on-device" but omits backend-query tests and the testable BLE slice).

### Planned / required tests
| Layer | What | Type | Status |
|-------|------|------|--------|
| BE | `getReceiptForPrint`: paid happy-path, not-paid→null, staff-out-of-today→null, manager-any, invalid-session→null | convex-test | **add** |
| Client | `escpos.encodeReceipt`: paid / voucher / partial-refund / full-refund golden bytes (fixed `paid_at`) | vitest | planned |
| Client | `chunkBytes` boundaries (empty, < MTU, exact, > MTU) | vitest | **add** |
| Manual | Real EP5811AI: connect, auto-reconnect cold-start, full-length receipt (no truncation), QR scans → `/r/<token>`, test-print | on-device checklist | planned |

### Missing coverage (must add)
| # | Test | Why | Approach |
|---|------|-----|----------|
| 1 | `getReceiptForPrint` role/today scope | Same data-leak class as Issue 3 | convex-test, mirror `getTransactionDetail` tests |
| 2 | Golden tests pin a fixed `paid_at` | Time-dependent bytes = flaky golden | pass literal epoch in fixture |
| 3 | `chunkBytes` unit | Truncation/one-line bug lives here | pure-fn test |

### Regression risk
- Low. New seams; the only touched existing file is `charge-success.tsx` (additive button) and `AppHeader` usage via `rightSlot` (no signature change). Smoke-test charge-success still renders + "New sale" works.

## 11. Edge Cases to Address

- [ ] Web Bluetooth absent (non-Chrome) → `unsupported`, hide print UI (spec ✅ — keep).
- [ ] `getReceiptForPrint` for a non-paid txn → `null` → button shows "receipt not ready" (don't crash encoder on null).
- [ ] `shareReceipt` throws `TXN_NOT_PAID` → surface as toast, don't print.
- [ ] BLE disconnect mid-print → catch, toast "reconnect & retry", leave state `disconnected`.
- [ ] Printer paper-out (no `0x2AF0` status read in v1) → user-visible "check paper" hint after a print with no obvious result.
- [ ] Reprint reuses the same token (idempotent `shareReceipt`) → stable QR across reprints.
- [ ] Emoji/non-ASCII in business name/product names → ASCII-fold or strip in `escpos.ts`.

## 12. Approval Conditions

**To approve (fix in spec before planning):**
1. Issue 1 — drop `receiptUrl`/token from the query; reuse `shareReceipt` + `buildReceiptUrl` for the QR.
2. Issue 2 — add `@types/web-bluetooth` (Wave 0 dep step).
3. Issue 3 — `getReceiptForPrint` mirrors `getTransactionDetail` role/today scope.

**Recommended before implementation:**
1. Improvements 1–2 (reuse `format.ts`; BE-derive status label — keep client off `convex/`).
2. Add the three missing tests (§10).

**Success criteria for the phase:** `npm run typecheck` + `npm run build` clean; `npx vitest` green (BE query + encoder golden + chunk); on-device checklist passed (connect, auto-reconnect, full receipt, QR resolves, test-print).

---

*Generated by /staffreview*
