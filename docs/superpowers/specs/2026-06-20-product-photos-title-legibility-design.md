# v1.2 #3 — Product photos + sale-grid title legibility — Design Spec

**Date:** 2026-06-20
**Phase:** v1.2 #3 (last "polish" item, roadmap `docs/superpowers/specs/2026-06-18-pos-backlog-roadmap-design.md` item #3)
**Auth tier:** manager-session (photo is product *meta*, CLAUDE.md rule #22)
**One PR for the phase.**

---

## 1. Goal

Give every product on the `/sale` grid a visual identity and fix the narrow-phone
title truncation **in one card layout**:

1. **Photo** — optional, manager-uploaded per-product image.
2. **Initials chip fallback** — products without a photo render a deterministic
   colored chip (e.g. "Dubai 8pcs" → "D8" on a hue-derived background). Never a
   blank box, never a broken `<img>`.
3. **Title legibility** — the sale card drops `truncate`, wraps the title to two
   lines (`line-clamp-2`), and the grid collapses to one column on the narrowest
   phones so a long name is never cut.

Surfaces: the `/sale` product grid **and** the manager product list/form
(`/mgr/products`). Cart line items and receipts are out of scope.

---

## 2. Grounded current state (verified in code — supersedes the brief)

The brief's "grounded state" was written against an older snapshot. The real
tree (main `6e8d69e`) is **further along** than the brief claimed:

| Field | Schema | Write path | Shipped to client | Rendered |
|---|---|---|---|---|
| `initials` (`v.optional(v.string())`) | ✅ `catalog/schema.ts:11,27` | ✅ `updateProductMeta`, `createProduct`, `createInventorySku`, seed | ✅ in `catalog` Doc | ❌ never |
| `hue` (`v.optional(v.number())`) | ✅ `catalog/schema.ts:12,28` | ✅ same as above | ✅ in `catalog` Doc | ❌ never |
| `photo_storage_id` (`v.optional(v.id("_storage"))`) | ✅ `catalog/schema.ts:13,29` | ❌ **no writer anywhere** | raw id shipped, **no `photo_url`** | ❌ never |

**Implications that shrink this phase:**

- **The initials-chip data + capture already exist.** `convex/catalog/public.ts::updateProductMeta`
  (manager-session) already accepts and persists `initials` + `hue`; the
  `/mgr/products` Add-product, Edit-metadata, and Add-SKU dialogs already render
  validated `initials` (≤3 chars) and `hue` (0–360) inputs
  (`src/routes/mgr/products.tsx`). Seed populates both
  (`convex/seed/internal.ts`). **We only need to build the render component** —
  no new capture UI, no schema change for the chip.
- **`photo_storage_id` is the genuinely dead field.** No mutation/action accepts
  it; the `catalog` query ships the raw id but never resolves a serving URL. The
  photo work is net-new: an upload-URL action, a save path, a `photo_url`
  projection, and the render.
- **No avatar/chip primitive exists** (`src/components/ui/` has none) — `ProductThumb`
  is new.
- **The sale card still uses `truncate`** (`src/routes/sale/index.tsx:219`) — the
  legibility fix has not shipped; it is scoped here.
- **Reference pattern to mirror exactly = the receipt-logo upload** (v0.5.3b):
  `convex/settings/public.ts::generateLogoUploadUrl` (idempotency-wrapped mutation,
  `ctx.storage.generateUploadUrl()`, `authCheck: requireManagerSession`) +
  read-side `ctx.storage.getUrl(storage_id)` (`getReceiptConfig`, line 163). Logo
  is folded into `updateReceiptConfig` (one save) — we mirror that by folding the
  photo into `updateProductMeta`.

---

## 3. Locked design decisions

| # | Decision | Rationale |
|---|---|---|
| Card layout | **Option A** — square photo/chip on top, 2-line title below, price, qty badge; equal-height cards | Approved in brainstorm; simplest, degrades gracefully to labeled chips |
| Photo model | Upload + initials-chip fallback | Locked #1 |
| Scope | Photo **and** title fix in one card layout | Locked #2 — card laid out once |
| Title fix | `grid-cols-1 min-[380px]:grid-cols-2 sm:grid-cols-3` + `items-stretch`; drop `truncate`, add `line-clamp-2` | Locked #3 — arbitrary min-width variants, no `index.css` change |
| Surfaces | sale grid + mgr product list/form | Locked #4 (cart lines OUT) |
| Auth tier | manager-session (mirror receipt-logo) | Locked #5 / CLAUDE.md #22 |
| **A.** Home tiles | **DROP** the photo slot | Nav tiles, not products |
| **B.** Client downscale | **YES** — center-crop square, resize ~400px, encode webp before POST | Booth phone photos are multi-MB |
| **C.** Chip color | Stored `hue`/`initials` first; deterministic hash of `code` only when absent | The field already exists — use it |
| **D.** Photo shape | Square, `rounded-md`, leading the card | Option A |
| **E.** Remove/replace | `null` sentinel clears `photo_storage_id` → falls back to chip | Convex deletes a field patched to `undefined` |
| **F.** Loading/broken | Render the chip while loading or on `<img>` error | Never a broken image; also the offline story (IDB-cached catalog, images need network) |

---

## 4. Architecture

Three units, each independently testable.

### 4.1 Backend — `convex/catalog/`

**(a) NEW `generateProductPhotoUploadUrl`** (public mutation, `catalog/public.ts`)
Mirror `settings.generateLogoUploadUrl` exactly:
```ts
export const generateProductPhotoUploadUrl = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<{ idempotencyKey: string; sessionId: Id<"staff_sessions"> }, { uploadUrl: string }>(
    "catalog.generateProductPhotoUploadUrl",
    async (ctx) => ({ uploadUrl: await ctx.storage.generateUploadUrl() }),
    { authCheck: async (ctx, args) => { await requireManagerSession(ctx, args.sessionId); } },
  ),
});
```
ADR-013 compliant (idempotencyKey + withIdempotency + authCheck-before-cache).

**(b) EXTEND `updateProductMeta`** (existing public mutation, manager-session)
Add one arg: `photo_storage_id: v.optional(v.union(v.id("_storage"), v.null()))`.
Three-state semantics:
- `undefined` (omitted) → **keep** existing photo (current callers unaffected).
- `null` → **remove**: `patch(productId, { photo_storage_id: undefined })` (Convex
  deletes the field).
- an id → **set/replace**: patch the new id.

Audit row stays the existing `product.updated` verb with
`metadata: { field: "meta", photo_changed: boolean }` — **no new audit verb, no
SCHEMA.md mint** (free-string `action`, CLAUDE.md #4).

> Decision (staffreview #1): we do **NOT** delete the superseded `_storage` blob.
> The locked reference pattern (`settings.updateReceiptConfig`) doesn't either,
> `ctx.storage.delete` is used nowhere in the repo, and a delete adds a failure
> mode (throws if the blob is already gone) for negligible benefit at booth scale
> (~6 products, rare edits → a handful of orphan blobs over the app's life).
> Orphan cleanup is deferred debt — a future storage-GC cron if it ever matters.

**(c) EXTEND `catalog` + `listAllProducts` read projection**
Resolve a serving URL per product so the client renders without a second
round-trip. Return shape changes:
`products: Doc<"pos_products">[]` → `products: (Doc<"pos_products"> & { photo_url: string | null })[]`.
Implementation: after collecting products, `await Promise.all(products.map(async p => ({ ...p, photo_url: p.photo_storage_id ? await ctx.storage.getUrl(p.photo_storage_id) : null })))`.
The explicit return-type annotation on both queries must be updated (they already
carry one to break the cross-module inference cycle). `catalog` stays
unauthenticated — product photos are non-sensitive (unlike `receipt_token`),
and `photo_storage_id` is already shipped today.

> Scale note (staffreview refinement): `getUrl` is a metadata lookup (not a blob
> fetch), 1 per product per catalog re-run. Negligible at booth scale (~6); add a
> code comment marking the assumption. The 6 existing `catalog` consumers
> (`home`, `sale/index`, `sale/drafts`, `sale/voucher`, `mgr/spoilage`,
> `useCatalogCache`) are additive-safe — a new field doesn't break structural reads.

> **Deploy note (staffreview #2):** the `updateProductMeta` change is an *additive
> optional arg* and `photo_url` is an *additive query field* — both ship BE+FE
> **atomically** via the single Vercel production build (`npx convex deploy` then
> FE build). It is NOT a mutation↔action rename, so no deploy-skew-fatal hazard.
> Don't hand-deploy one side (a new FE sending `photo_storage_id` to an old BE
> would fail Convex arg validation). Under skew both directions degrade
> gracefully (old BE → no `photo_url` → chip fallback).

### 4.2 Frontend — render

**(a) NEW `src/lib/productThumb.ts`** — pure, testable fallback logic:
- `deriveInitials(name: string, storedInitials?: string): string` — stored value
  wins; else first letter of name + first digit run (mirrors the seed convention
  `(name[0] + pack.match(/\d+/)?.[0]).slice(0,2)`), uppercased, ≤2 chars.
- `resolveHue(code: string, storedHue?: number): number` — stored value wins;
  else a deterministic hash of `code` → `0..359` (stable per product, so a chip
  never changes color between renders).
- Chip color formula (phthalo-dark-safe, semantic-ish via inline hsl since hue is
  dynamic): bg `hsl(h 38% 26%)`, fg `hsl(h 30% 82%)`, border `hsl(h 40% 42% / .6)`.
  These are tuned against the `--card #163630` canvas (the mockup uses exactly
  these). Dynamic hue can't be a Tailwind token, so inline `style` is the
  sanctioned exception; everything else uses semantic tokens.

**(b) NEW `src/components/pos/ProductThumb.tsx`** — presentational:
```
props: { photoUrl?: string | null; initials?: string; hue?: number;
         name: string; code: string; className?: string }
```
- `photoUrl` truthy → `<img>` (`object-cover`, square, `rounded-md`, `alt={t(...)}`),
  with `onError` → swap to chip (state flag).
- else → chip: `deriveInitials` text on `resolveHue` background.
- Guard: no motion here (static). `loading="lazy"` on the img.

**(c) `src/routes/sale/index.tsx`** — relayout the card once:
- Grid: `className="grid grid-cols-1 min-[380px]:grid-cols-2 sm:grid-cols-3 gap-2 items-stretch"`.
- **Equal-height chain (staffreview #4):** `items-stretch` only equalizes grid
  *cells* — the card fills the cell only if `h-full` is threaded through every
  layer: grid → `motion.div` (the `gridItemVariants` child) `className="h-full"` →
  `Card className="h-full flex flex-col"`. Without the full chain, stretch is a
  visual no-op.
- Card body: `ProductThumb` (full-width square) → title
  `text-sm font-medium leading-tight line-clamp-2` (drop `truncate`) → price →
  qty badge (unchanged, `absolute`; it now overlays the photo's top-right corner —
  its solid `bg-citrus` keeps it readable).
- **1-col thumbnail cap (staffreview #5):** a full-width *square* photo at
  `grid-cols-1` (~320–360px) is ~320px tall per card → long scroll. Cap the thumb
  height (e.g. `aspect-square w-full` with `max-h-40`, or a fixed `h-28`/`h-32` +
  `object-cover`) so 1-col stays scannable. Exact value is a QA/visual call in
  execution — flag it as a tunable, don't ship an un-capped full-width square.
- `p.photo_url`, `p.initials`, `p.hue` now read off the catalog product.
- `buildAddCardLabel(p.name, p.pack_label)` stays on the Card's `aria-label` —
  a11y unaffected by the visual change.

**(d) `src/routes/mgr/products.tsx`** — two additions:
- Product-list rows: small leading `ProductThumb` (size variant) next to the name.
- Edit-metadata dialog (already manager-session, already calls `updateProductMeta`):
  add a photo control — current photo preview (or chip), "Upload photo" (file
  input `accept="image/*"` → client downscale → POST to
  `generateProductPhotoUploadUrl` result → hold storageId in local state),
  "Remove photo" (sets a local `removePhoto` flag). On Save, pass
  `photo_storage_id`: `removePhoto ? null : (uploadedId ?? undefined)`.
- **Idempotency-intent rotation (staffreview #3):** the upload-URL mutation is
  idempotency-cached — a replayed key returns the *same* (short-lived) upload
  target. Give it a dedicated `useIdempotency("catalog.photoUploadUrl")` intent and
  `clearIntent` it after each successful POST, so a second photo upload in the same
  session mints a fresh URL (matches the existing rotate-on-success pattern in this
  file). The same file input works on phone (camera/gallery) and PC — no separate
  path.

> **Seed photos (revised, staffreview pass-2):** do NOT build a seed-photo
> mechanism. Convex mutations/seed can't read the repo FS and only an action can
> `ctx.storage.store` — a seed script is real scope for marginal benefit. Instead,
> **after the feature ships the manager uploads the 3 booth photos**
> (`docs/frollie photoso/Frollie {1,3,8}pc.webp`, already webp, named to Dubai
> 1/3/8pc) **through the new control** — 2 minutes on PC, and it dogfoods the exact
> upload path. The photos stay in the repo as the source assets. (Optional dev
> convenience: a throwaway local Node upload script, NOT part of this phase.)

**(e) Client downscale helper** — `src/lib/imageDownscale.ts` (new, pure-ish):
`downscaleToWebp(file: File, size = 400): Promise<Blob>` — decode via
`createImageBitmap(file, { imageOrientation: "from-image" })` (**staffreview pass-2:
honor EXIF orientation or phone portrait shots upload sideways**), center-crop to
square, draw to a `size×size` canvas, `canvas.toBlob(resolve, "image/webp", 0.82)`.
Fallback to `image/jpeg` if the webp blob is null (older WebView). Returns the Blob
to POST. Canvas isn't testable in jsdom → manual-smoke only (no unit test).

### 4.3 i18n — `src/lib/i18n/dictionaries/{en,id}.ts`

New keys (exact namespace confirmed at plan-staffreview against the dictionary
structure). All copy via `useT()`; the ESLint i18n fence forbids hardcoded
strings. Currency/dates stay `id-ID`.
- `mgrProducts.photoLabel`, `mgrProducts.uploadPhoto`, `mgrProducts.removePhoto`,
  `mgrProducts.photoUploading`, `mgrProducts.photoTooLarge` (if we cap input).
- `sale.productPhotoAlt` (parameterized `{name}`) — `<img alt>`.

---

## 5. Data flow — photo upload

```
manager opens Edit dialog for product P
  → picks a file
  → downscaleToWebp(file, 400)                       [client, src/lib/imageDownscale.ts]
  → generateProductPhotoUploadUrl({idempotencyKey, sessionId})  [mutation → uploadUrl]
  → POST blob to uploadUrl                            [fetch; Convex returns { storageId }]
  → hold storageId in dialog state (preview via URL.createObjectURL)
  → manager clicks Save
  → updateProductMeta({ ..., photo_storage_id: storageId })     [set; deletes old blob]
  → catalog query re-resolves photo_url = getUrl(storageId)     [reactive]
  → sale grid + mgr list re-render with the photo
```

Remove: Save with `photo_storage_id: null` → field deleted + blob deleted →
`photo_url` resolves null → ProductThumb falls back to the chip.

---

## 6. Error handling / edge cases

- **Broken / 404 image** → `<img onError>` swaps to chip (F).
- **Offline** → catalog payload is IDB-cached (`useCatalogCache`); images need
  network, so offline cards show the chip. Acceptable; the chip is the offline
  identity.
- **Cancelled upload** (picked a photo, POSTed, then cancels the dialog) → an
  orphan blob. Rare; acceptable at v1 (noted, not handled). The *replace/remove*
  paths DO delete superseded blobs.
- **`getUrl` returns null** (storage id present but blob missing) → `photo_url:
  null` → chip. No throw.
- **Webp unsupported on encode** → jpeg fallback in `downscaleToWebp`.
- **Manager edits name but not photo** → `photo_storage_id` omitted → blob
  untouched (the `undefined` = keep branch). Critical: existing `updateProductMeta`
  callers (name-only edits) must not lose the photo.

---

## 7. Testing

Storage + projection deserve coverage (payment/refund/stock-tier rigor does not
apply — no money).

**Backend (convex-test):**
- `generateProductPhotoUploadUrl`: non-manager session throws; manager returns a
  url; same-key replay returns the cached url without re-auth bypass.
- `updateProductMeta` photo semantics: (i) omitted → photo unchanged; (ii) id →
  set + old blob deleted; (iii) null → field removed + blob deleted; (iv) audit
  row carries `photo_changed`.
- `catalog` / `listAllProducts`: product with `photo_storage_id` → `photo_url`
  non-null; without → null. Update the existing catalog shape assertions.

**Frontend (vitest):**
- `productThumb.ts`: `deriveInitials` (stored wins; derive from name+digits;
  ≤2 chars; uppercase) and `resolveHue` (stored wins; hash deterministic + in
  range) — pure unit tests.
- (Optional) `ProductThumb` render: photo → img; no photo → chip; img error → chip.

---

## 8. Out of scope

Cart line-item thumbnails · receipt photos (text/logo only) · home nav-tile
imagery (decision A: dropped) · cross-deployment products sync (v1.1+) ·
#9 refunds · #12 remaining slices · #13 receipt cleanup.

---

## 9. Assumptions to verify at plan-staffreview (confirm against real code)

1. `requireManagerSession` / `withIdempotency` import paths in `catalog/public.ts`
   (currently imports `requireManagerSession`, `withIdempotency`, `logAudit`).
2. Exact i18n dictionary structure + the `useT()` key-path convention (namespaces
   `sale.*`, `mgrProducts.*`) — confirm before adding keys.
3. `ctx.storage.delete` + `ctx.storage.getUrl` signatures (Convex 1.31.7).
4. The `catalog` query is consumed by `useCatalogCache<T>` (generic — tolerant of
   the added field) and any home-screen reader — confirm no consumer destructures
   a fixed product shape that the added `photo_url` would break.
5. `line-clamp-2` is available (Tailwind 4 ships `line-clamp` utilities by default).
6. The existing catalog test file path + the shape assertions to update.
7. `min-[380px]:` arbitrary variant compiles under this Tailwind 4 config.
