# Staff Review: v1.2 #12 slice 2 — inline messaging (plan)

**Date:** 2026-06-20
**Plan:** `docs/superpowers/plans/2026-06-20-v1.2-phase2-slice2-inline-messaging.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, Files, Tasks/TDD, Testing, Constraints, Self-Review all present; rollback = single-squash revert, FE-only — stated).

---

## 1. Summary

**Overall Assessment:** Revise

TDD structure, reuse-only discipline, and the fence redesign are correct and grounded. **One Critical**: settlements and staff-add use a **disabled-submit gate** that makes their on-submit validations unreachable — naive conversion yields dead `FieldMessage`s and tests that can't click a disabled button. Two Improvements fix wrong test label strings and align the net-error copy with the actual field label. Once the gates are loosened (matching slice-1's "gate minimum, validate-on-submit fine") and copy/labels corrected, this is approvable.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | Disabled-submit gate makes inline validations unreachable (settlements all 6; staff-add pin + empty-name) | Logic / Testing | Task 1, Task 2 |

### Issue 1: Disabled-submit gates make the inline messages dead code

Slice-1 `products.tsx` gates the Continue button on the **minimum** fields only (`!createKey || addName.trim().length===0 || !bundleInputsValid`), so finer validations (price, tax…) remain reachable on submit and fire inline. The slice-2 targets don't follow that:

- **settlements.tsx:327** — `disabled={!entryKey || !formValid}`, and `formValid` (99–108) mirrors **all six** validations (date regex, gross≥1, mdr≠null, count≥1, last4 regex, netPreview≥0). So every `toast.error`/future `FieldMessage` in `submitFormOpenPin` is **unreachable** — the button is disabled until the form is already valid. The net<0 branch is doubly dead (`formValid` requires `netPreview≥0`). Task 1's test (`click "Save"` on empty form) can't run — the button is disabled and labeled `t("settlements.next")` = "Continue", not "Save".
- **staff.tsx:605–610** — `disabled={!createKey || addName.trim().length===0 || !/^\d{4}$/.test(addPin)}`. The gate already rejects empty name + bad PIN, so `errorPinDigits` and the empty-name branch are unreachable; only **name > 60** can fire. Task 2's "click Continue on empty form" can't run either.

This is the exact slice-1 lesson ("disabled-gate must match submit validator"). ADR-048's intent is that **inline messages tell the user what's wrong** rather than a silently-disabled button.

**Recommendation:** Loosen the gates to the idempotency-key guard only, so submit runs the collect-all validator and renders inline errors:
- settlements:327 → `disabled={!entryKey}`; delete the now-unused `formValid` const (99–108) — it's referenced nowhere else (`netPreview` stays, it feeds the preview line 319).
- staff:605–610 → `disabled={!createKey}`.
- Update both tests: open the dialog, click the enabled submit (settlements: "Continue"; staff: "Continue"/`mgrStaff.continue`) on empty/invalid input → assert all expected `FieldMessage`s render + no toast. Keep the net<0 test (now reachable) under the fee field.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Correct Task-1 test label strings to verified dict values | M | L |
| 2 | Net-error copy must say "fee" not "MDR" (matches the visible field label) | M | L |

### Improvement 1: Test label strings are guessed, not verified
Verified `en.ts`: `fieldDate`="Settlement date", `fieldGross`="Gross (Rp)", `fieldMdr`="**Xendit fee (Rp)**", `fieldCount`="Transaction count", `fieldLast4`="BCA account last 4 digits", `recordButton`="Record settlement", submit=`settlements.next`="Continue". Task 1's `getByLabelText("Date"/"Gross (IDR)"/"MDR / fee (IDR)")` and `getByText("Save")` will all miss. Replace with the verified strings (or resilient regex matchers, e.g. `/Gross/i`).

### Improvement 2: Net copy should match the field label
The net<0 field is user-labeled **"Xendit fee (Rp)"**, not "MDR". Reword `settlements.errorNetInvalid` to **"Fee can't exceed gross."** (en) / "Fee tidak boleh melebihi bruto." (id) — the spec's "MDR can't exceed gross" leaks the internal var name (`fMdr`). Update the Task-1 dict reword and the net<0 test assertion accordingly.

## 4. Refinements (Optional)

- **DeviceActivation is a named export** (`export function DeviceActivation()` at line 29) — Task 3's test must `import { DeviceActivation }`, not a default import. (settlements/staff/receipt/stock are default exports — those are fine.)
- Task 4 receipt test: simulate the file pick via `fireEvent.change(input, { target: { files: [file] } })` (already noted in Self-Review — keep).
- Confirm `t("settlements.next")` button stays enabled once `!formValid` is dropped (only `!entryKey` remains; `entryKey` is mocked to a string in tests).

## 5. Duplication Analysis
No duplication — reuse-only (`FieldMessage`, `useFieldErrors`). The one new helper (`humanizeThresholdError`) mirrors the co-located `humanizeSettlementError` pattern. ✓

## 6. Phase / Wave Accuracy
| Task | Assessment | Notes |
|------|------------|-------|
| 1 settlements | Needs adjustment | drop `!formValid` gate (Critical 1) |
| 2 staff | Needs adjustment | drop name/pin gate (Critical 1) |
| 3 device | Good | named-export import (Refinement) |
| 4 receipt | Good | — |
| 5 stock humanizer | Good | — |
| 6 fence | Good | lands after 1–5 ✓ |
| 7 docs+verify | Good | last ✓ |

Ordering correct (conversions → fence → docs/verify). Tasks independently testable.

## 7. Specialist Agent Recommendations
| Task | Agent | Rationale |
|------|-------|-----------|
| 1,2,3,4 conversions | `frontend-integrator` | matches slice-1 |
| 5 humanizer, 6 fence, 7 docs | `claude` | mechanical |

## 8. Git Workflow Assessment
| Check | Status |
|-------|--------|
| Worktree branch | ✅ (`worktree-v12-msg-slice2`) |
| Commit per task | ✅ (7 commits, conventional messages) |
| Pre-push verify | ✅ (`typecheck && lint && vitest run src/ && build:fe`, Task 7) |
| Rollback | ✅ single squash revert, FE-only |
| Deploy order | ✅ N/A — no schema/backend, no deploy-skew surface |

## 9. Documentation Checkpoints
| Task | Docs |
|------|------|
| 1 | en/id dict (net reword) |
| 2 | en/id dict (mgrStaff keys) |
| 7 | ADR-048 amendment + CHANGELOG |
No SCHEMA.md/CLAUDE.md change (FE-only; policy already in ADR-048). ✓

## 10. Testing Plan Assessment

**Verdict:** Adequate (after Critical 1 makes the tests runnable)

| Layer | What | Type | Status |
|-------|------|------|--------|
| FE | settlements/staff/device/receipt forms | renderWithLocale inline-behavior | planned (new) |
| FE | `humanizeThresholdError` | pure unit | planned |
| Lint | fence smoke (t()-arg fails, var/humanizer passes) | manual | planned |

### Missing coverage to add
| # | Test | Why | Approach |
|---|------|-----|----------|
| 1 | settlements net<0 under the **fee** field | the one non-obvious placement | `getElementById("entry.mdr-error")` contains "Fee can't exceed gross" |
| 2 | a kept toast still fires (receipt async fail) | guard over-conversion | assert sonner mock called on catch path |

### Regression risk
Low — no existing tests for these files; products/vouchers/login fence entries unchanged (selectors are additive).

## 11. Edge Cases to Address
- [ ] settlements: button enabled on empty form after gate-loosening → submit shows all 6 inline (the new behavior)
- [ ] staff: empty-name AND name>60 both reachable after gate-loosening
- [ ] staff rename row uses `mergeErrors` (single field, no focus map) — clears on `startRename`/`cancelRename`
- [ ] receipt: `clearErrors("logo.")` on successful upload so a prior error doesn't persist
- [ ] device: `act.*` errors clear per-field on change (no dialog `clearErrors` seam)

## 12. Approval Conditions

**To approve, address:**
1. Critical 1 — loosen the settlements + staff-add disabled gates so inline validation is reachable; update both tests to the enabled-button flow.

**Recommended before execution:**
1. Improvement 1 — verified test label strings.
2. Improvement 2 — net copy "Fee can't exceed gross" (en/id) + test assertion.
3. Refinement — DeviceActivation named-export import.

---

*Generated by /staffreview*
