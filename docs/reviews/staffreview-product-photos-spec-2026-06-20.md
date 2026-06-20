# Staff Review: Product photos + title legibility — Design Spec

**Date:** 2026-06-20
**Plan:** `docs/superpowers/specs/2026-06-20-product-photos-title-legibility-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ⚠️ This is a *design spec*, not the implementation plan — Success Criteria / Rollback / Git-workflow sections are deferred to the writing-plans step (the pipeline's next gate). Noted, not auto-added to a design doc.

---

## 1. Summary

**Overall Assessment:** Approve (with Improvements)

The spec is sound, well-grounded, and correctly re-baselines the brief's stale "grounded state" (initials/hue are already wired — only the render is missing). No Critical issues. The improvements below tighten one pattern deviation (superseded-blob deletion), three implementation details (deploy-skew, idempotency-key rotation, equal-height propagation), and a narrow-phone UX risk (giant 1-col images). Addressing them inline before planning.

## 2. Critical Issues (Must Fix)

None. The architecture mirrors a proven, in-repo reference (receipt-logo upload) and changes are additive.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Drop the superseded-blob `ctx.storage.delete` — mirror the receipt-logo reference exactly (no delete) | M | L |
| 2 | Note the atomic deploy covers the additive-arg skew window | M | L |
| 3 | Dedicated, rotated idempotency intent for the upload-URL mutation | M | L |
| 4 | Equal-height needs `h-full` threaded grid-child → Card | M | L |
| 5 | Cap thumbnail height so 1-col collapse doesn't yield full-screen images | M | L |

### Improvement 1: Blob-delete deviates from the locked reference pattern
The spec proposed `ctx.storage.delete(before.photo_storage_id)` on replace/remove. **`ctx.storage.delete` is used nowhere in the repo** — and the reference pattern the spec locks onto (`settings.updateReceiptConfig`, the receipt-logo upload) does **not** delete the old logo blob. Adding a delete introduces a new storage API + a new failure mode (delete throws if the blob is already gone → needs a guard) for negligible benefit at booth scale (~6 products, rare photo edits → a handful of orphan blobs over the app's life).
**Recommendation:** Drop the delete. Mirror receipt-logo: patch the field only. Accept orphan blobs as deferred debt (note a follow-up: a future storage-GC cron if it ever matters). Lower risk, fewer tests, faithful to locked decision #5.

### Improvement 2: Deploy-skew window for the additive `updateProductMeta` arg
Adding `photo_storage_id` to `updateProductMeta` is an **additive optional arg** — but Convex validates args strictly, so a *new FE calling an old BE* with the new arg would throw. This is safe here because the repo ships BE+FE **atomically** via the single Vercel production build (`npx convex deploy` then FE build — CLAUDE.md "Convex deployment" / `convex-vercel-deploy-skew` memory). It is **not** a mutation↔action rename, so no deploy-skew-fatal hazard.
**Recommendation:** One line in the plan's deployment notes: "additive optional arg + new query field; ships atomically; no hand-deploy of one side." The new `generateProductPhotoUploadUrl` and the `photo_url` field are both graceful under skew (old BE → no `photo_url` → chip fallback).

### Improvement 3: Upload-URL idempotency intent must rotate
The receipt-logo reference caches the upload URL by idempotency key. A replayed key returns the **same** (soon-expired) upload target. A second photo upload in the same session must mint a **fresh** key (Convex upload URLs are short-lived). The mgr/products page already rotates per-surface keys via `clearIntent` on success.
**Recommendation:** Give the photo upload its own `useIdempotency("catalog.photoUploadUrl")` intent and `clearIntent` it after each successful upload POST, matching the existing rotate-on-success pattern in `mgr/products.tsx`.

### Improvement 4: Equal-height cards need `h-full` threaded through the grid child
`items-stretch` only equalizes the grid *cells*. The card fills the cell only if the intermediate `motion.div` (grid child, `gridItemVariants`) **and** the `Card` both carry `h-full`, with the Card as `flex flex-col`. Otherwise stretch is a no-op visually.
**Recommendation:** Plan the chain explicitly: grid `items-stretch` → `motion.div className="h-full"` → `Card className="h-full flex flex-col"`.

### Improvement 5: Cap thumbnail height in the 1-col collapse
A full-width *square* photo at the narrowest breakpoint (`grid-cols-1`, ~320–360px) is ~320px tall per card → ~6 products is a very long scroll. Option A (square, leading) was approved, but the 1-col case wasn't visualized at full width.
**Recommendation:** Constrain the thumb (e.g. `aspect-square w-full max-h-40` or a fixed `h-28`/`h-32` with `object-cover`) so the 1-col cards stay scannable. Final value is a QA/visual call during execution; the plan should flag it as a tunable, not ship an un-capped full-width square.

## 4. Refinements (Optional)

- **getUrl per product in `catalog`:** `Promise.all(products.map(getUrl))` is 6 metadata lookups per catalog re-run (reactive, heavily subscribed). Negligible at booth scale; would want memoization/pagination only at 100s of products. Add a one-line comment noting the scale assumption.
- **Qty badge over photo:** the `absolute right-2 top-2` qty badge now overlays the photo's top-right corner. It has a solid `bg-citrus` so contrast holds — just confirm visually it doesn't hide a key part of the image.
- **`ProductThumb` is product-scoped this phase:** `resolveHue(code)` relies on `pos_products.code` (REQUIRED). `pos_inventory_skus.code` is optional, but SKUs don't render a chip this phase — keep the component product-scoped and say so.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `generateLogoUploadUrl` | `convex/settings/public.ts:180` | Copy verbatim → `generateProductPhotoUploadUrl` |
| `getUrl` read projection | `convex/settings/public.ts:163`, `receipts/internal.ts:96` | Same `getUrl(storage_id)` pattern for `photo_url` |
| `updateProductMeta` | `convex/catalog/public.ts:110` | Extend (don't duplicate) — already manager-session, idempotent, audited |
| `useIdempotency` + `clearIntent` rotate | `src/routes/mgr/products.tsx:183-188` | Add one intent for photo upload |
| initials/hue inputs | `src/routes/mgr/products.tsx` (Edit dialog) | Already present — only add the photo control |
| `line-clamp-2` | `src/routes/mgr/audit.tsx:114` | Confirms utility availability |

### Potential duplication risks
- Don't re-implement an avatar primitive elsewhere — `ProductThumb` is the single home for the chip/photo fallback. Pure logic in `src/lib/productThumb.ts` so both the sale grid and mgr list share it.

## 6. Phase / Wave Accuracy

Deferred to the plan. The natural order is: (1) backend (upload-url action, updateProductMeta extension, catalog projection) + tests → (2) pure thumb logic + `ProductThumb` + tests → (3) sale-grid relayout → (4) mgr/products photo control + list thumb → (5) i18n + docs. Schema needs **no** change (fields exist).

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Backend | `convex-expert` | storage URL + idempotency + projection nuances |
| Frontend | `ui-component-builder` / `frontend-integrator` | `ProductThumb` + card relayout + dialog wiring |

(Execution is a single subagent per the pipeline handoff; these are optional specializations.)

## 8. Git Workflow Assessment

Deferred to the plan (design spec carries no git workflow). For the record: one PR for the phase (locked), squash-merge convention, atomic BE+FE deploy. Plan must include: feature branch (the `v12-product-photos` worktree), commit-per-phase, `npm run typecheck` + `npm run build` + `npx vitest` before push, CHANGELOG entry.

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Backend | `docs/API_REFERENCE.md` (new `generateProductPhotoUploadUrl`, extended `updateProductMeta` + catalog `photo_url`); **no** `docs/SCHEMA.md` change (fields exist) — but add a note that `photo_storage_id` is now live |
| Close-out | `docs/CHANGELOG.md` entry |
| CLAUDE.md | optional one-line in the `catalog/` row (photo wired) |

## 10. Testing Plan Assessment

**Verdict:** Adequate (with one addition)

### Planned tests
| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend | `generateProductPhotoUploadUrl` auth + cache | convex-test | planned |
| Backend | `updateProductMeta` photo set/remove/keep + audit | convex-test | planned |
| Backend | `catalog`/`listAllProducts` `photo_url` projection | convex-test | planned (update existing shape asserts in `convex/catalog/__tests__/products.test.ts` + `productAdmin.test.ts`) |
| Frontend | `productThumb.ts` derive/hash | vitest | planned |
| Frontend | `ProductThumb` photo→img / none→chip / error→chip | vitest | optional |

### Missing test coverage (must add)
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | name-only `updateProductMeta` (photo omitted) preserves existing photo | the most likely regression — a name edit must not wipe the photo | convex-test: set photo, then call with photo_storage_id omitted, assert unchanged |
| 2 | Manual smoke: upload → preview → save → sale grid shows photo; remove → chip | the client downscale + POST path can't be unit-tested | manual QA line in the plan |

### Regression risk
- `convex/catalog/__tests__/products.test.ts` / `productAdmin.test.ts` assert the catalog return shape → update for the added `photo_url`.
- The 6 `catalog` consumers (`home`, `sale/index`, `sale/drafts`, `sale/voucher`, `mgr/spoilage`, `useCatalogCache`) are additive-safe (structural typing) — confirm none destructure a closed product shape.

## 11. Edge Cases to Address

- [x] Broken/404 image → chip (in spec §6)
- [x] Offline → chip (spec §6)
- [x] `getUrl` null → chip (spec §6)
- [x] name-only edit preserves photo (spec §6 vi) — **now also a required test**
- [ ] Cancelled-upload orphan blob — accepted at v1 (note follow-up)
- [ ] webp encode unsupported → jpeg fallback (spec §6) — confirm in `downscaleToWebp`

## 12. Approval Conditions

**To approve:** no Criticals — approved.

**Address before planning (Improvements 1–5):**
1. Drop blob-delete (mirror reference).
2. Deploy-skew note.
3. Rotated upload-URL idempotency intent.
4. `h-full` propagation for equal height.
5. Cap 1-col thumbnail height.

---

## Pass 2 (fresh-eyes re-review of the revised spec)

Two findings pass 1 missed; both addressed inline.

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| P2-1 | "Seed photos via a one-off storage insert" is infeasible — Convex mutations/seed can't read the repo FS; only an action can `ctx.storage.store`. Building a seed mechanism is real scope for marginal benefit. | Improvement | **Dropped from scope.** Post-ship, the manager uploads the 3 photos through the new control (dogfoods the path). Source webps stay in the repo. |
| P2-2 | Client downscale via canvas renders phone *portrait* photos sideways unless EXIF orientation is honored. | Improvement | `createImageBitmap(file, { imageOrientation: "from-image" })` added to the `downscaleToWebp` spec. The single most common phone-upload bug. |

Re-affirmed (no change): additive deploy-skew is atomic-ship-safe; `line-clamp-2` + `min-[380px]:` compile under Tailwind 4; the 6 catalog consumers are additive-safe; no blob-delete (matches reference). No Critical issues introduced by the pass-1 edits.

**Pass 2 verdict:** Approve. Spec is ready for the writing-plans step.

---

*Generated by /staffreview (2 passes)*
