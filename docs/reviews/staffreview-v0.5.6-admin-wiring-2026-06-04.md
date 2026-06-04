# Staff Review: v0.5.6 — Admin wiring + receipt/refund UX (IMPLEMENTATION)

**Date:** 2026-06-04
**Branch:** `worktree-v0.5.6-admin-wiring`
**Diff base:** `73eb0e2` (v0.5.5 land)
**Commits:** 5 (`3dfb756` A, `4e7ab0e` B, `94fd41a` C, `8cdea7a` D, `b93c1cd` docs)
**Files:** 12 (4 new routes/components, 4 new test files, 4 modified files), +764/−2 LOC
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture, ADR-034 lens)

---

## 1. Summary

**Module-depth verdict:** **Depth unchanged — and that is the correct outcome.** This PR is pure UI wiring of already-deep backend modules (`auth.actions.changePin`, `staff.public.generateDeviceSetupCode`, `receipts.public.getReceiptForPrint`, `refunds.public.*`). Each new FE surface earns its own depth by encapsulating real flow logic (3-stage PIN collector with `bump()` reset + per-error restart, manager-gated spoke with Inner-component type narrowing, countdown lifecycle, gated refund predicate) — none is a shallow pass-through. No backend module's public surface widened. No `internal.ts` was reached for. ADR-034's "public.ts is the contract; data is private" invariant is honoured throughout.

**Overall:** **Approve — ship as-is.** Plan-to-diff is byte-faithful (12 files match the plan's File Structure table exactly; commit boundaries match Tasks 1→5). All three local gates green: `npm run typecheck` clean, `npx vitest run src/routes/` = 138/138 passing (5 new account + 3 new device-setup + 2 new print + 4 new refund = 14 new tests, all load-bearing), `npm run build` succeeds (`built in 6.41s`; PWA precache 64 entries). Zero Critical, zero Important. Four Minor / Nitpick refinements only — all optional.

### Plan-fidelity ledger

| Plan element | Implementation | Verdict |
|---|---|---|
| 12 files in File Structure table | All 12 present in `git diff 73eb0e2..HEAD --stat` | ✅ exact |
| Task 1 — `/account` + 5 tests + tile + lazy import | `account.tsx:126L`, `account.test.tsx:118L`, `router.tsx:54,108`, `home.tsx:37` | ✅ |
| Task 2 — `/mgr/device-setup` + 3 tests + NAV_CARD | `device-setup.tsx:115L`, `device-setup.test.tsx:91L`, `router.tsx:69,122`, `mgr/home.tsx:23` | ✅ |
| Task 3 — print button + 2 tests, byte-parity with `charge-success.tsx` | `$txnId.tsx:54–71,244–252`; encode call `(viewModel, status, statusLabel)` identical to `charge-success.tsx:51`; disabled triple identical | ✅ |
| Task 4 — refund button + 4 tests + home tile | `$txnId.tsx:140,253–262`; `home.tsx:32`; gate `txn.status === "paid" && status !== "full"` | ✅ |
| Task 5 — CLAUDE.md routes row + CHANGELOG | `CLAUDE.md +1` (one-line row), `docs/CHANGELOG.md +9` | ✅ |
| Commit messages match plan's `git commit -m "..."` | `git log --oneline -5` matches verbatim | ✅ |
| Plan R1 (LOCKED_OUT timing comment) | `account.tsx` carries the JSDoc on the action + idempotency convention but does **not** annotate the `verifyPinOrThrow`-without-`lockOnFail` nuance specifically | Minor (see N1) |
| Plan R2 (manual smoke matrix) | Plan's Success-Criteria section captures it; no in-repo checklist artifact | Minor (deferred to release prep) |
| Plan R3 (glyph rendering) | `⚷`, `⊕`, `↩` present in code — depends on booth-device font | Cosmetic |

### ADR-034 module-boundary audit

| Check | Result |
|---|---|
| FE imports any `convex/<module>/internal.ts`? | **No.** `grep -r 'from .*convex/.*/internal' src/` → 0 hits. Only `_generated/api` references in new files. |
| FE imports any `convex/<module>/schema.ts`? | **No.** Only `_generated/dataModel` for `Id<…>` types (`device-setup.tsx:5`, `$txnId.tsx:6`) — public type surface. |
| Cross-module reach inside backend? | N/A — zero backend changes (`git diff --stat` shows no `convex/**` files). |
| New public surface widened by FE need? | **No.** All four backend functions called (`auth.actions.changePin`, `staff.public.generateDeviceSetupCode`, `receipts.public.getReceiptForPrint`, `transactions.public.shareReceipt`, `transactions.public.getTransactionDetail`) existed pre-PR. |
| FE re-implements logic that lives in a `public.ts`? | **No.** Print path uses the exact ADR-043 chain (`getReceiptForPrint → encodeReceipt → print`) verbatim from `charge-success.tsx`. Refund path navigates to the existing `/refund/:txnId` flow; no FE-side refund math. PIN-error mapping is a **string-display translator** (server-thrown enums → Indonesian copy) — that translation belongs in FE, not in the auth module's response shape (ADR-034 keeps `Error("INVALID_PIN")` etc. as the wire contract and FE owns localisation). |

### Pattern-conformance audit

| Pattern | Reference | Implementation | Verdict |
|---|---|---|---|
| Action + UUID per click (vs `useIdempotency` for retried mutations) | `sale/drafts.tsx`, `history/$txnId.tsx::handleShare:79` (in-PR file) | `account.tsx:86` + `device-setup.tsx:45` | ✅ correct mechanism for both call sites (one is `useAction` w/ own cache, the other is `withIdempotency` mutation — but both are user-initiated one-shots; UUID at click matches the convention) |
| Substring error-match for thrown enums | `login.tsx:95-100` | `account.tsx:19–26` (`friendlyChangePinError`) | ✅ extracted as a named helper (rather than inlined) because it has 4 branches and a test asserts each — earned extraction, not premature abstraction |
| Manager-gate redirect | `mgr/home.tsx:39–40`, `mgr/staff.tsx`, others | `device-setup.tsx:31–32` | ✅ same `<Navigate to="/" replace />` idiom |
| `Inner` component for `useSession()` type narrowing | `mgr/staff.tsx` and others use top-level guard | `device-setup.tsx:34–37` introduces `MgrDeviceSetupInner({ sessionId })` | ✅ earned — `useMutation` is unconditional and `sessionId` is non-null inside Inner; alternative would be `session.status === "active" && useMutation(...)` which is brittle |
| Spoke layout (`SpokeLayout title` + `backTo`) | `SpokeLayout.tsx:4–8`, used across `mgr/*` | Both new spokes use it consistently | ✅ |
| Print wiring byte-parity | `charge-success.tsx:38–57,159–163` | `$txnId.tsx:54–71,244–252` | ✅ **literal-byte parity** in the encode call and the disabled-triple; the only deltas are the added `data-testid="history-print"` and the toast on success (cosmetic to charge-success which already has its own UX). This is the **right** kind of duplication — the print sequence is a 3-line composition, not a hook-worthy abstraction, and forcing it through a hook would hide the printer-status branching the disabled triple expresses inline. |

## 2. Critical Issues (Must Fix)

**None.**

## 3. Improvements (Recommended)

**None.**

The four parts ship the minimum surface that closes their respective dead-ends. There is nothing to add without scope-creeping into v0.5.7 (e.g., a shared `useChangePin` hook would only make sense if a 2nd caller existed; a shared `<PrintButton txnId={…}/>` component would make sense at the 3rd call site — currently 2). Rule-of-three is not yet earned.

## 4. Refinements (Optional — Nitpick)

- **N1 — One-line "LOCKED_OUT timing" comment in `account.tsx`.** Plan R1 flagged that `changePin` calls `verifyPinOrThrow` *without* `lockOnFail`, so the **3rd** wrong PIN throws `INVALID_PIN` and only the **4th** (now-locked) attempt throws `LOCKED_OUT:<secs>`. The FE correctly maps both, but a future contributor reading `friendlyChangePinError` will assume the login-tsx semantic (LOCKED_OUT on the tripping attempt) and may "fix" the perceived inconsistency. A two-line JSDoc above `friendlyChangePinError` referencing `actions.ts:205–211` + `verifyPin.ts:43` would lock that knowledge in. (The implementer carried over the action-mechanism comment but not this timing-nuance comment.)

- **N2 — `MgrDeviceSetupInner` could elide the inner-component split** if `useMutation` accepted a conditional. It can't (Convex hook is unconditional), so the split is the conventional escape hatch. **No action recommended** — flagging only because the same pattern appears 4× across `mgr/*` and a future `useManagerSession()` micro-hook returning `{ sessionId } | null` could collapse the boilerplate. Defer until rule-of-five.

- **N3 — `SetupCodeCard` countdown drifts ~0–1s at each render boundary.** `setInterval(…, 1000)` fires off-phase from the `expiresAt` boundary; users may see `0:01 → 0:00 → kedaluwarsa` with a perceptible jitter. Acceptable for a 60-min TTL with no money on the line; if anyone complains, switch to `requestAnimationFrame` + `Math.max(0, expiresAt - performance.now())` or align the interval to wall-clock boundaries. Strictly cosmetic.

- **N4 — `home.tsx` "Refund" tile has hint `"today's refundable"` in English while sibling tiles in the same `sell` group are also mixed-locale (`"start a cart"`, `"drafts (v0.3)"`, `"today (v0.5)"`, `"ubah PIN Anda"` is the only Indonesian one). Locale consistency is a pre-existing wart, not new. Skip.

## 5. Duplication Analysis

| Code | Source | Reuse in this PR | Risk |
|---|---|---|---|
| Print sequence (`usePrinter` + `getReceiptForPrint` + `encodeReceipt` + disabled-triple) | `sale/charge-success.tsx:38–57,159–163` | `$txnId.tsx:54–71,244–252` | **Acceptable — byte-faithful copy.** Rule of three not yet reached (2 call sites). Extraction would hide the printer-status branching the disabled triple expresses inline. If a 3rd call site ships (e.g., `/refund/:txnId` print-after-refund), refactor then. |
| Action-call + substring-error-map | `login.tsx:88–104` | `account.tsx:81–98` + `friendlyChangePinError` | **Acceptable.** Login uses different copy + different error set + different post-error UX (PIN-reset bump vs full-flow restart). Two call sites; no shared helper yet earned. |
| Manager-gate `<Navigate to="/" replace />` | `mgr/home.tsx:39–40`, `mgr/staff.tsx`, others | `device-setup.tsx:31–32` | **Acceptable** — three-line gate that's clearer inline than wrapped. |
| `/refund` index (today's refundable list) | `src/routes/refund/index.tsx` (shipped v0.5.1b) | Linked via home tile + per-txn navigate; **not re-built** | ✅ Plan's explicit anti-rebuild rule observed. |

**Verdict:** No duplication anti-patterns introduced. Two copy-patterns (print, error-map) are at 2/3 call sites — extraction premature.

## 6. Module Depth — ADR-034 lens

This PR adds FE depth where it earns it, never widens backend public surfaces, and never reaches into `internal.ts`. Per-route assessment:

| Route | Internal complexity | Public-API surface widened? | Depth verdict |
|---|---|---|---|
| `/account` | State machine: `current → new → confirm → submitting`, with restart-on-error, mismatch detection, `bump()`-driven `PinEntry` reset, 5-error mapper | No (`auth.actions.changePin` existed pre-PR) | **Earned own depth** — collapses 4 server errors + 2 client states into one flow with one public surface. A future Telegram-approval reset flow would call the same `auth.actions.changePin`-equivalent through a different orchestrator; FE is reusable. |
| `/mgr/device-setup` | Two-state machine (none / minted), countdown lifecycle, regenerate-supersedes UX, manager-gate, Inner-component for type narrowing | No (`staff.public.generateDeviceSetupCode` existed pre-PR) | **Earned own depth** — replaces a CLI-only bootstrap with a self-serve flow. SetupCodeCard sub-component is justified because the countdown effect (with cleanup) and expiry branch are tied together; inlining would muddy the parent. |
| `history/$txnId` print button | Adds `usePrinter` + `getReceiptForPrint` + `encodeReceipt` chain, mirroring `charge-success.tsx` byte-for-byte | No | **Additive, not deepening** — file gains 17 LOC (print) + 9 LOC (refund button). Component stays under 270 LOC. |
| `history/$txnId` refund button | Single derived predicate (`canRefund`), navigate to existing route | No | **Additive** — 3 LOC of derivation + 9 LOC of conditional button. |

**Backend module surfaces post-PR:** identical to pre-PR. No new `public.ts` exports. No new fields on any function args/return. ADR-034 invariant preserved.

## 7. Test Coverage

| Test file | Cases | Quality |
|---|---|---|
| `account.test.tsx` (5) | Happy path (single call + UUID key + navigate), mismatch, INVALID_PIN copy, LOCKED_OUT:30 surfaces seconds, SESSION_INVALID → /login | Load-bearing — each asserts a distinct error-mapping branch + UI behaviour. None redundant. |
| `device-setup.test.tsx` (3) | Mint + countdown + UUID, regenerate distinct key, non-manager redirect | Covers all three branches (gate, mint, regenerate) |
| `$txnId.print.test.tsx` (2) | Connected click → encode + print w/ correct args; disconnected click → connect | Asserts byte-parity contract (`encodeReceipt` args match `getReceiptForPrint` shape) — most load-bearing of the four |
| `$txnId.refund.test.tsx` (4) | shown(none) + navigates, shown(partial), hidden(full), hidden(non-paid) | 4 of 4 cells of the 2D gate matrix |

**Manual gaps (cannot automate in jsdom; plan acknowledges):** real BLE byte-parity (C), real 2nd-device `/activate` consuming a minted code (B). These belong on the v0.5.6 release-prep checklist, not in CI.

## 8. Verification (Run on `worktree-v0.5.6-admin-wiring`)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | ✅ clean (no output past banner) |
| Unit tests | `npx vitest run src/routes/` | ✅ **138 passed (138)** — 24 files, 13.36s |
| Build | `npm run build` | ✅ `built in 6.41s`; PWA precache 64 entries |
| Module-boundary lint | `grep -r 'from .*convex/.*/internal' src/` | ✅ 0 hits |
| Plan file-list match | `git diff 73eb0e2..HEAD --stat` | ✅ 12/12 files match plan |
| Commit boundary match | `git log --oneline -5` | ✅ Tasks 1→5 each = 1 commit, message verbatim from plan |

## 9. Graft Integrity

Nothing in this PR assumes POS-specific schema, IDs, or auth shapes that would break under Frollie Pro's deployment. All FE calls go through `_generated/api` (the public surface). The new routes are POS-internal admin spokes — they have no Frollie Pro graft surface. ADR-034's "data is private; public.ts is the contract" invariant remains intact.

## 10. Approval Conditions

**To approve:** nothing blocking — plan fidelity exact, depth discipline correct, all gates green.
**Recommended (optional):** N1 (one-line LOCKED_OUT timing comment in `account.tsx`). N2–N4 are deferable.

---

*Generated by /staffreview (implementation-gate) — depth-lens architectural review per ADR-034.*
