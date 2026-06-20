# Staffreview — v1.2 #3 Product Photos + Sale-Grid Title Legibility

**Branch:** `v12-product-photos` · **Base:** `041dcd8` · **Date:** 2026-06-20
**Reviewer lens:** Senior-engineer architectural review through the deep-module / surface-API discipline (ADR-034).

---

## Summary

**Verdict on module depth: deeper.** The catalog module's public surface grows by exactly one earned mutation (`generateProductPhotoUploadUrl`) and one additive query field (`photo_url`), while a genuinely complex chunk of work — image acquisition, EXIF-correct downscale, square crop, webp/jpeg fallback, deterministic chip fallback, broken-image recovery — is hidden behind two small, pure, independently-tested seams (`productThumb.ts`, `imageDownscale.ts`) and one presentational component (`ProductThumb`). The interface-to-implementation ratio moves the right way: callers say "give me a thumbnail for this product" and "mint me an upload URL," and never see canvas, hue hashing, storage IDs, or onError state. This is the ADR-034 ideal — narrow surface, hidden complexity.

The photo path mirrors the v0.5.3b receipt-logo upload (`settings.generateLogoUploadUrl` + `getReceiptConfig` `getUrl`) faithfully: same `withIdempotency` + `authCheck`-before-cache shape, same manager-session tier, same "fold the storageId into an existing meta mutation" idiom, same deliberate no-superseded-blob-delete decision. It does **not** create a second inconsistent upload idiom — it instantiates the established one. Graft integrity is intact: the new field lives entirely behind the internal `catalog` query (POS-FE-only); the external `api/v1/` surface reads transaction-line snapshots, never `pos_products`, so nothing here touches the Frollie Pro contract.

Plan fidelity is high. The single notable adaptation (Task 2's content absorbed into Task 1's commit, Task 2 commit empty) is cosmetic-only under squash-merge. No critical issues. A handful of minor refinements below.

---

## Critical Issues

None.

The four "don't break this" risk surfaces all check out:
- **Existing `updateProductMeta` callers don't lose the photo.** The `undefined` = keep branch is correct and explicitly tested (`productPhoto.test.ts` "omitting photo_storage_id preserves the existing photo"). The spec flagged this as the one critical edge case; it's covered.
- **Idempotency (ADR-013, rule #20).** `generateProductPhotoUploadUrl` is `withIdempotency`-wrapped with `authCheck`-before-cache, matching the receipt-logo reference exactly. The FE rotates the intent via `clearIntent("catalog.photoUploadUrl")` on success, so a second upload in the same session mints a fresh URL — staffreview #3 honored.
- **Deploy skew.** Additive optional arg + additive query field, no mutation↔action rename. Ships atomically via the Vercel production build. Under skew both directions degrade to the chip. No deploy-skew-fatal hazard.
- **Graft.** `api/v1/` never reads `pos_products`, so `photo_url`/`photo_storage_id` cannot leak into the external contract or lock the v1.1+ cross-deployment products sync.

---

## Improvements

These are worth considering but none block merge.

1. **`catalog` is unauthenticated and now does N `getUrl` calls per re-run.** The comment ("metadata lookup, negligible at booth scale") is honest and correct at ~6 products, and the query already shipped `photo_storage_id` raw, so exposure isn't new. The mild concern is that `catalog` re-runs reactively on any catalog/voucher/stock change, and each re-run now does `Promise.all` over `getUrl`. At 6 products this is nothing; the only thing to watch is that the assumption is *scale-bound* — if the product count ever grows by an order of magnitude (multi-SKU expansion, Frollie Pro catalog graft), this becomes a per-subscription-tick cost on the hottest query in the app. The inline comment is the right mitigation for now; flag it as a known tunable rather than an invariant.

2. **`metaTarget?.photo_url` in the remove-button visibility predicate is slightly stale-prone.** The remove button shows when `(metaPhotoPreview || metaTarget?.photo_url) && !metaRemovePhoto`. After a fresh upload, `metaPhotoPreview` is a `blob:` URL so the button shows correctly. After remove, `metaRemovePhoto` gates it off. The edge: `openMetaEdit` sets `metaPhotoPreview = p.photo_url`, so the `metaPhotoPreview` term already covers the "existing photo" case — the `|| metaTarget?.photo_url` disjunct is redundant. Harmless, but it reads as defensive belt-and-suspenders that could confuse a future editor into thinking the two can diverge. Minor simplification opportunity.

3. **Upload-then-cancel orphans a blob with no preview cleanup of the *storage* side.** Covered and accepted in the spec (§6 "Cancelled upload → an orphan blob. Rare; acceptable"). The FE does revoke the object-URL on close (no memory leak), but the uploaded `_storage` blob is orphaned if the manager uploads then cancels the dialog without saving. This is the documented, accepted v1 debt and mirrors the receipt-logo path. Noting it only so it's visible in the review trail, not as a defect.

---

## Refinements

Nitpick-tier; ship as-is is fine.

1. **Chip color formula is well-judged, not over-engineered.** Three HSL channels tuned against the `--card #163630` canvas, with the dynamic-hue inline-style exception correctly called out as the *one* sanctioned ADR-047 raw-color escape. `resolveHue` clamps stored hue to `[0,360]` and falls back to a deterministic `code` hash, so a chip never changes color between renders. The `* 31 + charCode` hash is the standard cheap string hash — adequate; no need for anything fancier. This is the right altitude.

2. **The `max-h-40` 1-col thumbnail cap is correctly shipped as a tunable.** The plan and spec both flag it as a QA/visual call (staffreview #5). `max-h-40` (10rem ≈ 160px) on a full-width square at `grid-cols-1` keeps the narrowest-phone layout scannable instead of shipping a ~320px-tall card. The equal-height `h-full` chain (grid `items-stretch` → `motion.div h-full` → `Card flex h-full flex-col`) is threaded completely — staffreview #4's "stretch is a no-op without the full chain" warning is satisfied. Verify the exact `max-h-40` value visually during QA but the mechanism is sound.

3. **`deriveInitials` digit-run heuristic is slightly lossy but acceptable.** `"Mixed Box 4pcs"` → `"M4"` is the intended seed convention. Edge: a name like `"3pcs Dubai"` would derive `"3"` (first char is a digit, first digit run is "3", slice(0,2) = "3" + "" ... actually `first="3"`, `digits` matches "3" again → `"33"` then slice → `"33"`). Cosmetic only — managers can override via stored `initials`, and the real products are well-named. Not worth a fix.

4. **Empty Task-2 commit.** Confirmed: `53d097b` (Task 1) carries both the upload-URL mutation *and* the `updateProductMeta` photo changes (+34 lines in `public.ts`); `e2b84b6` (Task 2) is an empty commit carrying only the Task-2 message. Under the one-PR squash-merge convention this collapses to a single commit and is invisible in history. **Does not matter.** The only thing it would affect is a hypothetical `git bisect` or cherry-pick of "just the upload-URL mutation," which isn't a real workflow here. No action.

5. **Spec keys `sale.productPhotoAlt` + `mgrProducts.photoTooLarge` were intentionally dropped.** The locked design made the thumbnail decorative (`alt=""`/`aria-hidden`) and added no client-side size cap, so neither key is needed. This is correct scope discipline (fewer keys, fewer i18n-parity surfaces), not a gap — `en.ts`/`id.ts` parity holds for the five keys actually used.

---

## Verdict

Merge-ready. Module depth increases, the surface grows only by what's earned, the upload idiom is the established one (not a fork), and the graft is untouched. The improvements above are optional polish and a couple of scale-watch flags; none are blocking.
