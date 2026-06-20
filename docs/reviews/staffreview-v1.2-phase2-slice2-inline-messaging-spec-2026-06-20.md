# Staff Review: v1.2 #12 slice 2 — inline messaging (spec)

**Date:** 2026-06-20
**Plan:** `docs/superpowers/specs/2026-06-20-v1.2-phase2-slice2-inline-messaging-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ Spec (not plan) — File/Testing/Out-of-scope present; Phases/Rollback deferred to the plan stage (pipeline step 4). Not penalized.

---

## 1. Summary

**Overall Assessment:** Revise

Scope, placement taste, and reuse-only constraint are sound and grounded. One **Critical** contradiction blocks approval: the chosen `toast.error(t(...))` fence would **ban three legitimate non-validation toasts** the spec simultaneously says to keep. Two Improvements correct a wrong helper-location assumption and avoid a dead i18n key. Once the fence/keep convention is reconciled and the humanizer location fixed, this is approvable.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | New `t()`-ban fence collides with 3 legitimate bucket-C/precondition toasts the spec keeps | Logic / Lint | Fence redesign vs Decisions §3 |

### Issue 1: The `t()`-ban fence false-positives on legitimate async/precondition toasts

The spec bans `toast.error(t(...))` in every registered file, **and** says these stay toasts:
- `settlements.tsx:160` `toast.error(t("settlements.errorTryAgain"))` — precondition guard (missing intent key)
- `DeviceActivation.tsx:43` `toast.error(t("deviceActivation.toastDeviceNotReady"))` — precondition guard
- `mgr/receipt.tsx:193` `toast.error(t("mgrReceipt.logoUploadFailed"))` — **async** catch (upload/network failure)

All three are exactly `toast.error(t(<fixed key>))`, so the chosen selector flags them. Forcing `logoUploadFailed` inline would also violate ADR-048's own policy (async failures are bucket-C). The spec is internally inconsistent.

**Recommendation:** Adopt the **existing slice-1 idiom** for legitimate non-validation toasts: assign the message to a variable first, then toast it — `const msg = t("..."); toast.error(msg);`. The arg becomes an `Identifier`, not a `t()` `CallExpression`, so the fence passes cleanly. This is already how server errors are toasted (`settlements.tsx:181–183`: `const msg = humanizeSettlementError(err, t); toast.error(msg)`). Document the convention in the ADR-048 amendment:

> Legitimate async/global/precondition toasts route their message through a humanizer **or** a local variable (`const msg = t(...); toast.error(msg)`). A **bare** `toast.error(t(...))` is reserved for — and banned as — sync validation that escaped inline.

Apply the variable idiom to the 3 sites above as part of their files' conversion task. (Net: the heuristic stays machine-checkable and false-positive-free; no `eslint-disable` proliferation.)

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Fix humanizer location — they're co-located local fns, not `src/lib/errors.ts` | M | L |
| 2 | net<0 → reuse existing `settlements.errorNetInvalid` key (reworded) at MDR, not a new key | L | L |

### Improvement 1: Humanizers are co-located, not shared
`grep "export function humanize"` returns nothing — `humanizeSettlementError` is a **module-local** function (`settlements.tsx:35`), as are `humanizeAuthError`/`humanizeSettingsError`/`humanizeDriftError`/`friendlyActivationError` in their own files. Correct the spec: `humanizeThresholdError` is a **local function inside `stock/$skuId.tsx`** (mirroring `humanizeSettlementError`), not an extraction into `src/lib/errors.ts`. Drop the "(+ wherever `humanize*` helpers live)" ambiguity from Files-touched.

### Improvement 2: Don't mint a new net-error key
`settlements.tsx:142–143` already has `settlements.errorNetInvalid`. Anchoring net<0 under the MDR field, **reword that existing key** ("MDR can't exceed gross") rather than adding `errorMdrExceedsGross` — reuse the key, avoid a dead one. (en + id both updated.)

## 4. Refinements (Optional)

- Confirm the exact `renderRoute` harness import path in the plan (slice-1 `mgr/__tests__/products.test.tsx` uses it; locate the shared helper).
- Note explicitly: all 5 touched route/component files have **no existing `__tests__`** (settlements, mgr/staff, mgr/receipt, DeviceActivation, stock/$skuId) — every test file is **new**, not an extension.
- One-line note that the conversion does **not** trip the *i18n* fence (the other eslint block): `<FieldMessage>{t(...)}</FieldMessage>` child is a JSXExpressionContainer (not JSXText), and `aria-describedby`/`id` aren't in the i18n fence's watched attrs.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `FieldMessage` + `fieldMessageVariants` | `src/components/ui/field-message.tsx` | reuse verbatim (error/success) |
| `useFieldErrors` | `src/hooks/useFieldErrors.ts` | `applyErrors`/`clearFieldError`/`clearErrors` |
| server-error toast idiom | `settlements.tsx:181–183` | template for the Critical-1 variable idiom |
| `humanizeSettlementError` | `settlements.tsx:35` | shape to mirror for `humanizeThresholdError` |

### Potential duplication risks
- None — explicitly reuse-only; the only new helper (`humanizeThresholdError`) mirrors an established local pattern.

## 6. Phase / Wave Accuracy
Spec implies ~6 tasks (4 conversions + stock refactor + fence/docs). Reasonable for one squash PR. Detailed ordering is the plan's job; recommend fence/docs land **last** (after all files convert) so the registry + ADR amendment reflect final state.

## 7. Specialist Agent Recommendations
| Work | Agent | Rationale |
|------|-------|-----------|
| Conversions (per file) | `frontend-integrator` | matches slice-1 convert tasks |
| `FieldMessage` placement nuance | `ui-component-builder` | if any anchor needs layout work (logo control) |
| Fence + ADR + docs | `claude` / `—` | mechanical config + prose |

## 8. Git Workflow Assessment
Single squash PR per pipeline convention. Commit per task (per file + fence + docs). Pre-push: `npm run typecheck && npm run lint && npx vitest run src/ && npm run build:fe`. Rollback = revert one squash commit (FE-only, no schema/deploy-skew surface). ✅

## 9. Documentation Checkpoints
| Item | Update |
|------|--------|
| ADR-048 | amendment: i18n collision + `t()`-ban + variable/humanizer convention (Critical-1) |
| CHANGELOG | slice-2 entry |
| ESLint registry | +6 files, +2 selectors |
| i18n dicts | new `mgrStaff.*` keys + reworded net key (en/id parity) |

No SCHEMA.md / CLAUDE.md changes (FE-only, no schema, policy already in ADR-048).

## 10. Testing Plan Assessment

**Verdict:** Adequate (with Refinement notes)

| Layer | What | Type | Status |
|-------|------|------|--------|
| FE | each of 4 converted forms | inline-behavior (renderRoute) | planned (new files) |
| FE | `humanizeThresholdError` | pure unit | planned |
| Lint | fence smoke (t()-arg fails, humanizer/variable passes) | manual | planned |

### Missing coverage to add
| # | Test | Why | Approach |
|---|------|-----|----------|
| 1 | settlements net<0 surfaces under **MDR** | the one non-obvious placement | assert `entry.mdr-error` present, others absent |
| 2 | a kept toast still fires (e.g. receipt `logoUploadFailed`) | guard against over-conversion | assert toast mock called on async-fail path |

### Regression risk
- Low. No existing tests for these files to break; products/vouchers fence unchanged (additive selectors).

## 11. Edge Cases to Address
- [ ] net<0 with gross/mdr both valid individually (cross-field) → MDR message
- [ ] staff rename inline-row error (`rename.name`) anchors in the row, not the add dialog
- [ ] receipt logo: `logoNotReady` (uploadKey missing) is a **precondition** — variable idiom or inline? (lean: it's pre-submit validation of a fixable state → inline under control)
- [ ] device submit already `disabled={!deviceId}` → `toastDeviceNotReady` (43) is near-unreachable; variable idiom keeps it without fence trip

## 12. Approval Conditions

**To approve, address:**
1. Critical 1 — reconcile the `t()`-ban fence with the 3 kept toasts via the variable/humanizer convention; document in ADR-048 amendment.

**Recommended before planning:**
1. Improvement 1 — fix humanizer location (local, not shared lib).
2. Improvement 2 — reuse `errorNetInvalid` key.

---

*Generated by /staffreview*
