# Staff Review: v0.5.5 — Inventory-SKU admin + route error boundary (plan)

**Date:** 2026-06-03
**Plan:** `docs/superpowers/plans/2026-06-03-v0.5.5-inventory-sku-admin-and-error-boundary.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated

---

## 1. Summary

**Overall Assessment:** **Approve** (with five small improvements folded in before execution)

The plan is concrete, codebase-grounded, TDD-disciplined, and has no placeholders. Twelve focused tasks; every test case has full code; every line-number citation in `src/routes/mgr/products.tsx` was re-verified against the actual file (lines 58, 78, 93, 123, 160, 461 all match). The four spec-staffreview findings flowed through cleanly: `source: "booth_inline"` (not `"manager_pin"`), `/mgr/products` as the UI home, `${key}:commit` derived key spelled out, `errorElement` covers all four shells (root + 3 publics via `PublicShell`). The bundled-checkbox extension (`withInventorySku` + qty input) is wired correctly through both the action and internal validators with full back-compat for unbundled callers.

No Critical issues. Five small improvements would tighten things further; none block execution.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| — | None | — | — |

All four spec-staffreview Criticals are resolved in the plan. The plan's load-bearing assumptions verify against actual code:

- **`seedManagerSession`** returns `{ managerId, sessionId, deviceId }` with PIN `"9999"` — `convex/staff/__tests__/_helpers.ts:21-40`. The plan's tests call it correctly.
- **`withIdempotency`** is the curried `(mutationName, handler, options)` form with optional `authCheck` — `convex/idempotency/internal.ts:52-86`. The plan's generic shape matches.
- **`products.tsx` line citations** — line 58 (`PinAction`), 78 (`humanizeCatalogError`), 93 (`parseIntStrict`), 123 (`MgrProductsInner`), 160 (`setPinAction`), 461 (`handlePinSubmit`), 550 (header button), 671-786 (Add Product dialog body): all match the current file.
- **shadcn `Checkbox`** is genuinely absent (`Glob src/components/ui/checkbox*` returns no results) — the plan correctly uses a native `<input type="checkbox">`.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | `deviceId` in test fixtures: use the helper's returned `"mgr-device"` instead of inline `"d"` / `"dev-booth-device"` strings | L | L |
| I2 | Audit metadata on `inventory_sku.created` should include `low_threshold` for forensics | M | L |
| I3 | CLAUDE.md rule #22's PIN-gated list should add `createInventorySku` | M | L |
| I4 | Add a codegen note in Task 1 / Task 12: `npx convex codegen` (or `npx convex dev` running) must materialise `api.catalog.actions.createInventorySku` before vitest can import it | M | L |
| I5 | CHANGELOG date — `2026-06-XX` placeholder should be `2026-06-03` (today) at the time the planning PR lands | L | L |

### I1. `deviceId` consistency in test fixtures

`seedManagerSession` returns three IDs (`{ managerId, sessionId, deviceId }`). The plan's Task 1 tests destructure `{ managerId }` only and pass `deviceId: "dev-booth-device"` or `"d"` literally. The Task 3 tests pass `"d"`. The actual returned `deviceId` is `"mgr-device"` (`convex/staff/__tests__/_helpers.ts:26`).

Using the inline literals works (the audit row just captures whatever string we pass), but using the helper's `deviceId` is mechanically safer — if the helper's literal ever changes, the assertions stay aligned without grep-and-replace. Match the rest of the test suite which prefers `const { managerId, sessionId, deviceId } = await seedManagerSession(t);`.

**Recommendation:** In Tasks 1 and 3 test cases, destructure `{ managerId, sessionId, deviceId }` and pass `deviceId` through instead of `"d"`. Where a test specifically asserts on `audit.device_id`, assert it equals the helper's returned `deviceId`.

### I2. `inventory_sku.created` audit metadata should include `low_threshold`

The plan's standalone `_createInventorySkuCommit_internal` audits `metadata: { sku, name }`. The bundled path is the same. Forensics may want to reconstruct "what threshold did the manager set at creation time" — especially for the bundled-existing-SKU case where the threshold value the manager typed is silently ignored. Capturing it on the audit row even when ignored makes that visible.

**Recommendation:** Add `low_threshold` to the audit metadata in both standalone Task 1 and bundled Task 3. For the bundled-existing-SKU case (where the SKU is reused), don't emit `inventory_sku.created` (current behaviour) — but extend `product.components_set` metadata to include `{ low_threshold_attempted, ignored: true }` so the audit trail records the manager's intent.

### I3. CLAUDE.md rule #22 should list `createInventorySku`

CLAUDE.md rule #22 (v0.5.3b admin tier doc) currently lists `createStaff`, `setStaffRole`, `deactivateStaff`, `createProduct`, `updateProductPricing` as manager-PIN identity/money writes. `createInventorySku` is the same tier — should appear in the same list.

**Recommendation:** Add to Task 11 Step 1 (alongside the SCHEMA.md audit-verb addition): a one-line edit to CLAUDE.md rule #22 appending `createInventorySku` to the manager-PIN list.

### I4. Convex codegen runs before vitest

Vitest imports `api.catalog.actions.createInventorySku` — this symbol lives in `convex/_generated/api.d.ts`, regenerated by `npx convex dev` (or one-shot `npx convex codegen`). If the executor runs the test before either has fired against the new `actions.ts`, vitest will error on the import.

**Recommendation:** Add to Task 1 Step 4 (the "run tests to verify they pass" step) AND Task 12 Step 3: a one-line prerequisite: *"Ensure Convex codegen has run for the new exports — either `npx convex dev` is running in another shell, or run `npx convex codegen` once. Vitest imports from `convex/_generated/api` which is regenerated by both."*

### I5. CHANGELOG date placeholder

Task 11 Step 4 writes `## 2026-06-XX — v0.5.5`. Should be `2026-06-03` (the date this plan lands, per the spec's date). Mechanical.

---

## 4. Refinements (Optional)

- **R1.** `PublicShell` uses `<Suspense fallback={null}>`. A blank screen during chunk load is acceptable (matches today's behaviour) but a tiny `<Spinner />` would be friendlier on slow mall WiFi. Out of v0.5.5 scope; mention in the ADR as a future iteration.
- **R2.** The bundled-existing-SKU case silently ignores the manager's typed `inventorySkuLowThreshold`. The toast already says "linked to existing dubai SKU at qty 3" — consider appending "(threshold unchanged)" so the manager doesn't think their input had an effect.
- **R3.** Task 7's router edit deletes the existing `// lazy() loads the bundle ...` docblock that lives above the route table (`src/router.tsx:5-36`). Preserve it — the comment is useful onboarding context for the next reader. (The Edit will replace `const routes = [...]` block specifically, not the comment above it; just call this out explicitly.)
- **R4.** The error boundary's "Reload" button clears the timestamp before reloading. On the third+ failure (truly bad deploy), the manager would be in a "reload → fail → reload → fail" loop driven by button clicks. Acceptable: each click is intentional, and the booth can fall back to a different device. Worth a one-line comment in the boundary so future maintainers don't "fix" it.
- **R5.** `productAdmin.test.ts` has the import `import { internal as internalApi }` aliasing — but `internal` is already imported in the existing file (it's not, actually — let me verify). Re-checking: `productAdmin.test.ts:4` imports `{ api, internal }`. So `import { internal as internalApi }` would shadow the existing `internal`. Either: (a) reuse the existing `internal` import (recommended — drop the `as internalApi` rename), or (b) put the new import at the top alongside the existing one with a different alias.

---

## 5. Duplication Analysis

### Existing code to leverage — all correctly identified by the plan

| Code | Location | How the plan uses it |
|------|----------|----------------------|
| `_createProductCommit_internal` shape | `convex/catalog/internal.ts:175-232` | Direct template for `_createInventorySkuCommit_internal` |
| `createProduct` action | `convex/catalog/actions.ts:20-64` | Extended in-place, not cloned |
| `verifyManagerPinOrThrow` | `convex/auth/verifyPin.ts:67-93` | Reused, captures `{ managerId, deviceId }` |
| `withActionCache` + `${key}:commit` discipline | `convex/idempotency/action.ts:34-50` + docblock | Reused verbatim |
| `withIdempotency` curried form | `convex/idempotency/internal.ts:52-86` | Same pattern as existing internals |
| `upsertStockLevel` (deliberately NOT called at SKU creation) | `convex/inventory/internal.ts:20-42` | Plan documents the reasoning |
| `humanizeCatalogError` | `src/routes/mgr/products.tsx:78-91` | Extended with five new codes |
| `parseIntStrict` | `src/routes/mgr/products.tsx:93-101` | Reused for qty + threshold inputs |
| `PinAction` discriminated union | `src/routes/mgr/products.tsx:58-76` | Extended with one new variant |
| `seedManagerSession` test harness | `convex/staff/__tests__/_helpers.ts:21-40` | Used in all backend tests |
| `productAdmin.test.ts` idempotency-replay pattern | `convex/catalog/__tests__/productAdmin.test.ts:69-90` | Cloned for SKU idempotency test |

### Potential duplication risks

- **None.** The plan correctly extends-in-place instead of cloning where possible (e.g. `createProduct` action keeps a single entry point).

---

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| Tasks 1-2 (standalone backend) | Good | TDD order correct: internal first, action second. |
| Tasks 3-4 (extended createProduct) | Good | Internal extended first, then action. Test for unbundled back-compat at the right step. |
| Tasks 5-7 (resilience) | Good | Helper → boundary component → router wiring. Each commit is shippable on its own. |
| Tasks 8-10 (FE catalog) | Good | Error-mapper extension before dialog work means the new error codes are available when needed. |
| Task 11 (docs) | Good | Single commit groups SCHEMA + API_REFERENCE + ADR + CHANGELOG. |
| Task 12 (verification) | Good | Typecheck → lint → tests → build → manual smoke. |

**Ordering issues:** None.
**Missing phases:** None.

---

## 7. Specialist Agent Recommendations

(N/A — this plan is intended for inline / subagent-driven execution by a fresh Claude session post-`/clear`, per the `/spec-plan-pipeline` skill. No external specialist needed.)

---

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ — already in `worktree-v0.5.5-plan` off main |
| Branch naming follows convention | ✅ — `worktree-<slug>` |
| Merge strategy documented | ✅ — squash PR per repo convention (CLAUDE.md + `ship-it` memory) |

### Commit checkpoints

The plan creates one commit per task (12 logical commits). Natural boundaries:
1. After Task 1 → `feat(catalog): _createInventorySkuCommit_internal — standalone SKU writer`
2. After Task 2 → `feat(catalog): catalog.createInventorySku action`
3. After Task 3 → `feat(catalog): bundled SKU+link in _createProductCommit_internal`
4. After Task 4 → `feat(catalog): createProduct action takes optional bundled SKU args`
5. After Task 5 → `feat(lib): pure isChunkLoadError helper`
6. After Task 6 → `feat(layout): RouteErrorBoundary with one-shot chunk reload`
7. After Task 7 → `feat(router): PublicShell + errorElement on app-shell and public routes`
8. After Task 8 → `chore(mgr/products): map new SKU / threshold error codes`
9. After Task 9 → `feat(mgr/products): standalone Add SKU dialog`
10. After Task 10 → `feat(mgr/products): bundled SKU+link checkbox in Add Product`
11. After Task 11 → `docs(v0.5.5): SCHEMA audit verb + API_REFERENCE + ADR-045 + CHANGELOG`
12. After Task 12 (if any fixup) → `chore(v0.5.5): verification fixups`

All commit messages are present and follow conventional-commits style (`feat(scope): summary` body). Multi-line bodies explain WHY, matching repo norms.

### Pre-push verification

- [x] `npm run build` (Task 12 Step 4)
- [x] `npm run typecheck` (Task 12 Step 1)
- [x] `npm run lint` (Task 12 Step 2)
- [x] `npx vitest run` (Task 12 Step 3)
- [x] Manual smoke on `npm run dev` (Task 12 Step 5)

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ — additive only (no schema field changes, no data migration). Revert the 12 commits. |
| Deployment order | ✅ — Convex backend deploys first (`npx convex deploy`), then Vercel frontend (`npm run deploy`). Standard order. |
| Data backup needed | No |
| Migration safety | ✅ — no migration |

---

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Task 11 | `docs/SCHEMA.md` (audit verb), `docs/API_REFERENCE.md` (new functions + extended args), `docs/ADR/045-route-chunk-reload-boundary.md` (new), `docs/CHANGELOG.md` (v0.5.5 entry) |
| Plan-extension (I3) | `CLAUDE.md` rule #22 — add `createInventorySku` to manager-PIN list |

### CHANGELOG draft

The plan's CHANGELOG draft in Task 11 Step 4 is solid. With I5 applied (date) and one line on the bundled-existing-SKU UX clarification, it's PR-ready.

---

## 10. Testing Plan Assessment

**Verdict:** Adequate.

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend | `_createInventorySkuCommit_internal` — happy path | convex-test | planned (Task 1) |
| Backend | duplicate sku → `SKU_EXISTS` | convex-test | planned |
| Backend | duplicate code → `CODE_EXISTS` | convex-test | planned |
| Backend | bad slug shape (4 cases) → `SKU_INVALID` | convex-test (it.each) | planned |
| Backend | empty / too-long name → `NAME_INVALID` | convex-test | planned |
| Backend | bad low_threshold (3 cases) → `LOW_THRESHOLD_INVALID` | convex-test (it.each) | planned |
| Backend | whitespace `code` coerced to undefined | convex-test | planned |
| Backend | standalone internal :commit idempotency replay | convex-test | planned |
| Backend | standalone action happy path with PIN | convex-test | planned (Task 2) |
| Backend | standalone action wrong PIN → INVALID_PIN | convex-test | planned |
| Backend | standalone action-level replay | convex-test | planned |
| Backend | `listAllProducts.skus` includes new SKU (read-seam) | convex-test | planned |
| Backend | bundled fresh-SKU at qty 1 | convex-test | planned (Task 3) |
| Backend | bundled fresh-SKU at qty 3 (multi-pack) | convex-test | planned |
| Backend | bundled reuse-existing-SKU at qty 3 | convex-test | planned |
| Backend | bundled bad `sku_family` → `SKU_FAMILY_NOT_SLUGGABLE` + rollback | convex-test | planned |
| Backend | bundled bad `qty` (3 cases) → `QTY_INVALID` | convex-test (it.each) | planned |
| Backend | bundled missing low_threshold → `LOW_THRESHOLD_INVALID` | convex-test | planned |
| Backend | unbundled call back-compat | convex-test | planned |
| Backend | bundled internal :commit idempotency replay | convex-test | planned |
| Backend | bundled action forwards args + PIN gate | convex-test | planned (Task 4) |
| Backend | bundled action wrong PIN → no rows written | convex-test | planned |
| Frontend (lib) | `isChunkLoadError` — true cases (4) | vitest (it.each) | planned (Task 5) |
| Frontend (lib) | `isChunkLoadError` — false cases (3) | vitest (it.each) | planned |
| Frontend (lib) | `isChunkLoadError` — null/undefined/empty (5) | vitest (it.each) | planned |
| Frontend (lib) | `isChunkLoadError` — plain object with .message | vitest | planned |
| Frontend (UI) | Standalone Add SKU manual flow | manual smoke | planned (Task 12) |
| Frontend (UI) | Bundled new-SKU manual flow | manual smoke | planned |
| Frontend (UI) | Bundled existing-SKU manual flow | manual smoke | planned |

### Missing test coverage (must add)

| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| — | None blocking. The frontend dialog flows are intentionally manual-smoke only (matches `/mgr/products` precedent — `convex/catalog/__tests__/productAdmin.test.ts` is the backend gate; `src/routes/mgr/` has no RTL test for the products page). | — | — |

### Test execution checkpoints

1. After Task 1: `npx vitest run convex/catalog/__tests__/skuAdmin.test.ts`
2. After Task 2: same file (action tests appended)
3. After Task 3: `npx vitest run convex/catalog/__tests__/productAdmin.test.ts`
4. After Task 4: same file (action bundled tests appended)
5. After Task 5: `npx vitest run src/lib/__tests__/chunkLoadError.test.ts`
6. After Task 12: full `npx vitest run` + `npm run build`

### Regression risk

- Existing `productAdmin.test.ts` cases (10+ tests covering the unbundled `createProduct` path). The plan extends-in-place — Task 3's "unbundled call back-compat" test pins the contract. Risk: low.
- Existing route loading. `PublicShell` adds a `<Suspense>` above the three public routes; today they have no wrapping `<Suspense>`. If a public route happens to throw a Promise during render that isn't already caught, the new boundary will catch it. Risk: low (none currently do).
- `/r/:receiptNumber`'s existing httpAction path is server-side; the frontend route is the receipt landing. Adding the boundary doesn't change the httpAction. Risk: none.

---

## 11. Edge Cases to Address

- [x] **`existingSku.active === false` reuse in bundled mode** — spec acknowledges this can't occur in v0.5.5 (no SKU deactivate UI). Documented in plan via spec reference. ✓
- [x] **Bundled flow with `sku_family` matching an existing different-shape SKU** — slug is `sku_family.toLowerCase()`; if it matches, reuse. Tested in Task 3 (Dubai reuse case). ✓
- [x] **Slug collision between standalone and bundled paths** — both use the same `pos_inventory_skus.sku` index. Standalone throws `SKU_EXISTS`; bundled reuses. By design (spec §A.0). ✓
- [x] **`code` collision** — standalone throws `CODE_EXISTS`; bundled never sets `code`. Tested. ✓
- [x] **Whitespace-only `code` input** — coerced to `undefined`. Tested. ✓
- [x] **Idempotency replay across both the action and the internal levels** — tested at both layers. ✓
- [ ] **Convex transaction rollback under Convex-test** — `convex-test` emulates rollback on throw. Memory `convex-optional-field-filter-gotcha` notes test/prod can diverge for optional fields; not applicable here since the rollback path doesn't depend on optional-field filtering. Tested via the `SKU_FAMILY_NOT_SLUGGABLE` rollback assertion. ✓
- [ ] **`useLocation()` inside a route error element** — verified: react-router v7 provides `useLocation` inside error elements (the boundary is mounted in the route tree). ✓
- [ ] **Quick double-deploy within the 30-second guard window** — boundary's fallback is acceptable; manager hits "Reload" button which clears the timestamp. R4 above suggests a code comment to document this on purpose.

---

## 12. Approval Conditions

**To approve, address:** None blocking.

**Recommended before implementation:**
1. **I1** — destructure `deviceId` from `seedManagerSession` and use it in test assertions.
2. **I2** — include `low_threshold` in `inventory_sku.created` audit metadata.
3. **I3** — append `createInventorySku` to CLAUDE.md rule #22's PIN-gated list (one line in Task 11).
4. **I4** — note the Convex codegen prerequisite in Task 1 and Task 12.
5. **I5** — replace `2026-06-XX` with `2026-06-03` in the CHANGELOG draft.

All five are small inline tweaks the executor can apply during implementation. Approving the plan with these noted; no second staffreview cycle needed.

---

*Generated by `/staffreview` — Frollie POS spec-plan pipeline, 2026-06-03.*
