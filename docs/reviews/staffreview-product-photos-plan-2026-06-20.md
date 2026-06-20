# Staff Review: Product photos + title legibility — Implementation Plan

**Date:** 2026-06-20
**Plan:** `docs/superpowers/plans/2026-06-20-product-photos-title-legibility.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (Goal, Global Constraints, 10 tasks w/ files + TDD steps, Success Criteria, Rollback, Docs).

---

## 1. Summary

**Overall Assessment:** Approve (after the test-seeding fix)

Tasks are real-signature, correctly ordered (backend → pure helpers → i18n → components → screens → docs), and each carries an independently testable deliverable. One Critical-for-executability defect: the test files reference seeding helpers that don't exist as written. Fixed inline against the verified helper. All additive changes confirmed non-breaking against the real test suite.

## 2. Critical Issues (Must Fix)

### Issue 1: Test seeding references non-existent helpers
- Task 1's test imports `seedStaffSession` and Task 2 uses a stub `seedProduct`. Verified against the codebase:
  - `convex/staff/__tests__/_helpers.ts` exports **only** `seedManagerSession(t)` → `{ managerId, sessionId, deviceId }` (manager PIN "9999", code "S-0001"). **No `seedStaffSession`.**
  - `productAdmin.test.ts` makes products via `t.action(api.catalog.actions.createProduct, { idempotencyKey, sessionId, managerPin: "9999", sku_family, code, name, pack_label, price_idr, tax_rate, sort_order })` → `{ productId }`. There is no importable `seedProduct`; it's a per-file local insert.
**Recommendation (applied):** import `seedManagerSession` from `../../staff/__tests__/_helpers`; seed a non-manager inline via `internal.auth.actions._seedHashedStaff_internal({ name, pin, role: "staff" })` + a `staff_sessions` insert; create products via the real `createProduct` action. Fixed in the plan's Task 1 + Task 2 code.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | State the `createProduct` arg set + `managerPin: "9999"` explicitly in the seed helper so the executor doesn't guess | M | L |

Applied — the hardened Task 2 seed uses the full verified arg set + a valid `code` (`DUBAI_8PC`).

## 4. Refinements (Optional)

- `max-h-40` on the sale-grid thumb is a guess; the plan already flags it as a QA tunable. Fine.
- `URL.createObjectURL` preview is revoked in `closeMetaEdit` + on re-pick — good leak hygiene; keep.

## 5. Duplication Analysis

No duplication. `generateProductPhotoUploadUrl` reuses the `withIdempotency` + `requireManagerSession` pattern; `ProductThumb` is the single chip/photo home; pure logic in `productThumb.ts`. Imports in `catalog/public.ts` (`v`, `mutation`, `Id`, `requireManagerSession`, `withIdempotency`, `Doc`) and `mgr/products.tsx` (`useMutation`, `useIdempotency`, `clearIntent`, `toast`, `humanizeCatalogError`) are all already present — no new import churn beyond `ProductThumb` + `downscaleToWebp`.

## 6. Phase / Wave Accuracy

| Task | Assessment | Notes |
|------|------------|-------|
| 1 → 10 | Good | Backend first, pure helpers (4,5) before components (7), i18n (6) before consumers, screens (8,9) last before docs. No ordering issue. |

## 7. Specialist Agent Recommendations

Single execution subagent per the pipeline handoff. Optional: `convex-expert` for Tasks 1–3, `ui-component-builder` for 7–9.

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch (worktree `v12-product-photos`) | ✅ |
| Commit-per-task | ✅ (each task ends in a commit) |
| Pre-push typecheck/build/test | ✅ (Success Criteria) |
| Squash-merge, atomic deploy | ✅ documented |

## 9. Documentation Checkpoints

Task 10 covers API_REFERENCE + CHANGELOG + CLAUDE.md. No SCHEMA.md change (fields pre-exist; `photo_storage_id` now-live note goes in API_REFERENCE). ✅

## 10. Testing Plan Assessment

**Verdict:** Adequate (after the seeding fix)

| Layer | What | Type | Status |
|-------|------|------|--------|
| Backend | upload-url auth (manager ok / non-manager reject) | convex-test | planned (seeding fixed) |
| Backend | updateProductMeta set / remove / keep | convex-test | planned (seeding fixed) |
| Backend | catalog photo_url projection | convex-test | planned (additive — `toHaveProperty`) |
| Frontend | productThumb derive/hash | vitest | planned |
| Frontend | downscale | — | manual (canvas not in jsdom) — acknowledged |

**Regression confirmed safe:** `productAdmin.test.ts` audit assertions use `toMatchObject`/`arrayContaining` (additive `photo_changed` won't break); no `toEqual`/`toStrictEqual` on catalog products (additive `photo_url` safe); `products.test.ts:38-45` length/`toHaveProperty` asserts unaffected.

## 11. Edge Cases to Address

- [x] name-only edit preserves photo (Task 2 test)
- [x] null removes photo (Task 2 test)
- [x] non-manager rejected (Task 1 test, fixed)
- [x] broken image → chip (`ProductThumb onError`)
- [x] EXIF orientation (`downscaleToWebp`)
- [x] object-URL leak (revoke on close/re-pick)

## 12. Approval Conditions

**To approve:** fix Issue 1 (test seeding) — **applied inline**.
**Recommended:** none outstanding.

**Verdict:** Approved post-fix. Ready to land + hand off for execution.

---

*Generated by /staffreview*
