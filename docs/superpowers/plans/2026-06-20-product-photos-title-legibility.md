# Product Photos + Sale-Grid Title Legibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give products an optional manager-uploaded photo with a deterministic colored initials-chip fallback, render it on the `/sale` grid + manager product surfaces, and fix narrow-phone title truncation — in one card layout (Option A: square thumb on top, 2-line title).

**Architecture:** The chip data (`initials`, `hue`) already exists and is captured/seeded — only a render component is new. The photo path is net-new and mirrors the v0.5.3b receipt-logo upload exactly: a manager-session upload-URL mutation → client downscales to a square ~400px webp → POSTs → folds the `storageId` into the existing `updateProductMeta` (manager-session). The `catalog` query gains a server-resolved `photo_url`. No schema change (`photo_storage_id`/`initials`/`hue` already on `pos_products`).

**Tech Stack:** Convex 1.31.7 (storage + idempotency), React 19 + TS, Tailwind 4 (`line-clamp`, arbitrary `min-[380px]:` variants), Framer Motion (existing grid variants), vitest + convex-test.

## Global Constraints

- **Auth tier:** manager-session for both the upload-URL mutation and the save (CLAUDE.md #22; photo is product *meta*). NOT manager-PIN.
- **Idempotency (ADR-013):** every public mutation accepts `idempotencyKey` + `withIdempotency` + `authCheck`-before-cache. Upload-URL intent rotates via `clearIntent` on success.
- **Design tokens (ADR-047):** semantic tokens only (`bg-card`, `text-muted-foreground`, etc.); the **only** raw-color exception is the chip's *dynamic* `hsl(hue …)` inline style (a Tailwind token can't carry a runtime hue). No raw palette literals anywhere else.
- **i18n (ADR-049):** all new visible copy via `useT()` typed keys added to **both** `en.ts` (source of truth for the key union) and `id.ts`. Currency/dates stay `id-ID`. The thumbnail is decorative (`alt=""`/`aria-hidden`) — no alt key.
- **Money:** integer rupiah, format via `rp()` (unchanged).
- **No schema change:** `photo_storage_id`, `initials`, `hue` already exist on `pos_products` (`convex/catalog/schema.ts:27-29`).
- **No superseded-blob delete** (mirror receipt-logo; orphans accepted at booth scale).
- **One PR**, squash-merge. BE+FE ship **atomically** via the Vercel production build — additive optional arg + additive query field, no mutation↔action rename, so no deploy-skew hazard; never hand-deploy one side.

---

### Task 1: `generateProductPhotoUploadUrl` mutation

Mirror `settings.generateLogoUploadUrl` (`convex/settings/public.ts:180`) into the catalog module.

**Files:**
- Modify: `convex/catalog/public.ts` (add export; imports `v`, `mutation`, `requireManagerSession`, `withIdempotency` already present)
- Test: `convex/catalog/__tests__/productPhoto.test.ts` (create)

**Interfaces:**
- Produces: `api.catalog.public.generateProductPhotoUploadUrl({ idempotencyKey: string, sessionId: Id<"staff_sessions"> }) => { uploadUrl: string }`

- [ ] **Step 1: Write the failing test**

```ts
// convex/catalog/__tests__/productPhoto.test.ts
import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession, seedStaffSession } from "./helpers"; // see note below

describe("generateProductPhotoUploadUrl", () => {
  test("manager session returns an upload url", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const res = await t.mutation(api.catalog.public.generateProductPhotoUploadUrl, {
      idempotencyKey: "k1",
      sessionId,
    });
    expect(typeof res.uploadUrl).toBe("string");
    expect(res.uploadUrl.length).toBeGreaterThan(0);
  });

  test("non-manager session is rejected", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedStaffSession(t); // staff, not manager
    await expect(
      t.mutation(api.catalog.public.generateProductPhotoUploadUrl, {
        idempotencyKey: "k2",
        sessionId,
      }),
    ).rejects.toThrow();
  });
});
```

> **Note on seed helpers:** reuse the existing seeding approach in `convex/catalog/__tests__/productAdmin.test.ts` (it already creates manager + staff sessions for the PIN-gated tests). If a shared `helpers.ts` does not exist there, copy that file's inline session-seeding into this test (do NOT invent new helper names). Confirm the exact helper names by reading `productAdmin.test.ts` first.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Claude/frolliepos/.claude/worktrees/v12-product-photos && npx vitest run convex/catalog/__tests__/productPhoto.test.ts`
Expected: FAIL — `generateProductPhotoUploadUrl is not a function` / undefined export.

- [ ] **Step 3: Add the mutation**

In `convex/catalog/public.ts`, after `archiveProduct`:

```ts
type GenerateProductPhotoUploadUrlResult = { uploadUrl: string };

/**
 * Manager-session: mint a Convex storage upload URL for a product photo
 * (v1.2 #3). Mirrors settings.generateLogoUploadUrl. The client POSTs a
 * downscaled webp to this URL, gets a storageId, and folds it into
 * updateProductMeta. ADR-013: idempotency + authCheck-before-cache.
 */
export const generateProductPhotoUploadUrl = mutation({
  args: { idempotencyKey: v.string(), sessionId: v.id("staff_sessions") },
  handler: withIdempotency<
    { idempotencyKey: string; sessionId: Id<"staff_sessions"> },
    GenerateProductPhotoUploadUrlResult
  >(
    "catalog.generateProductPhotoUploadUrl",
    async (ctx) => ({ uploadUrl: await ctx.storage.generateUploadUrl() }),
    {
      authCheck: async (ctx, args) => {
        await requireManagerSession(ctx, args.sessionId);
      },
    },
  ),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/catalog/__tests__/productPhoto.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add convex/catalog/public.ts convex/catalog/__tests__/productPhoto.test.ts
git commit -m "feat(v1.2 #3): generateProductPhotoUploadUrl (manager-session, mirrors receipt-logo)"
```

---

### Task 2: Extend `updateProductMeta` with `photo_storage_id` (keep / set / remove)

**Files:**
- Modify: `convex/catalog/public.ts:110-169` (`updateProductMeta`)
- Test: `convex/catalog/__tests__/productPhoto.test.ts` (append)

**Interfaces:**
- Consumes: existing `updateProductMeta` args.
- Produces: `updateProductMeta({ ..., photo_storage_id?: Id<"_storage"> | null })` — `undefined`=keep, `null`=remove (field deleted), id=set. Audit `product.updated` metadata gains `photo_changed: boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// append to convex/catalog/__tests__/productPhoto.test.ts
import { internal } from "../../_generated/api";

describe("updateProductMeta photo semantics", () => {
  // Helper: create a product and return its id (reuse productAdmin.test.ts's create path)
  async function seedProduct(t: any, sessionId: any) {
    // Use the existing create flow from productAdmin.test.ts (createProduct action
    // or the internal commit). Return the product _id. Confirm exact call by reading
    // productAdmin.test.ts.
  }

  test("setting a photo id persists it and flags audit", async () => {
    const t = convexTest(schema);
    const { sessionId, staffId } = await seedManagerSession(t);
    const productId = await seedProduct(t, sessionId);
    // Fake a storage id by storing a tiny blob
    const storageId = await t.run(async (ctx: any) =>
      ctx.storage.store(new Blob(["x"], { type: "image/webp" })),
    );
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m1", sessionId, productId,
      name: "Dubai 8pcs", pack_label: "8 pcs", sort_order: 0,
      photo_storage_id: storageId,
    });
    const prod = await t.run((ctx: any) => ctx.db.get(productId));
    expect(prod.photo_storage_id).toBe(storageId);
  });

  test("omitting photo_storage_id preserves the existing photo (name-only edit)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const productId = await seedProduct(t, sessionId);
    const storageId = await t.run(async (ctx: any) =>
      ctx.storage.store(new Blob(["x"], { type: "image/webp" })),
    );
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m2", sessionId, productId,
      name: "A", pack_label: "8 pcs", sort_order: 0, photo_storage_id: storageId,
    });
    // name-only edit, photo omitted
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m3", sessionId, productId,
      name: "Renamed", pack_label: "8 pcs", sort_order: 0,
    });
    const prod = await t.run((ctx: any) => ctx.db.get(productId));
    expect(prod.photo_storage_id).toBe(storageId); // preserved
    expect(prod.name).toBe("Renamed");
  });

  test("null removes the photo (field deleted)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const productId = await seedProduct(t, sessionId);
    const storageId = await t.run(async (ctx: any) =>
      ctx.storage.store(new Blob(["x"], { type: "image/webp" })),
    );
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m4", sessionId, productId,
      name: "A", pack_label: "8 pcs", sort_order: 0, photo_storage_id: storageId,
    });
    await t.mutation(api.catalog.public.updateProductMeta, {
      idempotencyKey: "m5", sessionId, productId,
      name: "A", pack_label: "8 pcs", sort_order: 0, photo_storage_id: null,
    });
    const prod = await t.run((ctx: any) => ctx.db.get(productId));
    expect(prod.photo_storage_id).toBeUndefined();
  });
});
```

> Confirm `seedProduct` against the real create path in `productAdmin.test.ts` before running — do not ship the stub body.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/catalog/__tests__/productPhoto.test.ts`
Expected: FAIL — `photo_storage_id` rejected by the arg validator (unknown arg).

- [ ] **Step 3: Extend the mutation**

In `convex/catalog/public.ts`, `updateProductMeta` — add the arg, the generic type member, and the patch logic. Add to `args`:

```ts
    initials: v.optional(v.string()),
    hue: v.optional(v.number()),
    photo_storage_id: v.optional(v.union(v.id("_storage"), v.null())),
```

Add to the generic type param object:

```ts
      initials?: string;
      hue?: number;
      photo_storage_id?: Id<"_storage"> | null;
```

In the handler, replace the `ctx.db.patch(args.productId, {...})` block with:

```ts
      const photoChanged = args.photo_storage_id !== undefined;
      await ctx.db.patch(args.productId, {
        name,
        pack_label: args.pack_label,
        sort_order: args.sort_order,
        ...(args.sku_family !== undefined ? { sku_family: args.sku_family } : {}),
        ...(args.initials !== undefined ? { initials: args.initials } : {}),
        ...(args.hue !== undefined ? { hue: args.hue } : {}),
        // undefined = keep (omitted); null = remove (patch undefined deletes the
        // field); an id = set. No superseded-blob delete (mirror receipt-logo).
        ...(args.photo_storage_id !== undefined
          ? { photo_storage_id: args.photo_storage_id ?? undefined }
          : {}),
        updated_at: Date.now(),
      });
```

And update the audit metadata:

```ts
        metadata: { field: "meta", photo_changed: photoChanged },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/catalog/__tests__/productPhoto.test.ts`
Expected: PASS (all photo-semantics tests).

- [ ] **Step 5: Commit**

```bash
git add convex/catalog/public.ts convex/catalog/__tests__/productPhoto.test.ts
git commit -m "feat(v1.2 #3): updateProductMeta photo_storage_id keep/set/remove + audit flag"
```

---

### Task 3: `catalog` + `listAllProducts` resolve `photo_url`

**Files:**
- Modify: `convex/catalog/public.ts:24-66` (`catalog`), `:77-98` (`listAllProducts`)
- Test: `convex/catalog/__tests__/products.test.ts` (append assertion)

**Interfaces:**
- Produces: `catalog().products` and `listAllProducts().products` element type becomes `Doc<"pos_products"> & { photo_url: string | null }`.

- [ ] **Step 1: Write the failing test**

```ts
// append to convex/catalog/__tests__/products.test.ts (inside the existing catalog describe)
test("catalog projects photo_url (null when no photo)", async () => {
  const t = convexTest(schema);
  // ...reuse this file's existing seed that creates 1 active product...
  const c = await t.query(api.catalog.public.catalog, {});
  expect(c.products[0]).toHaveProperty("photo_url");
  expect(c.products[0].photo_url).toBeNull(); // seeded product has no photo
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/catalog/__tests__/products.test.ts`
Expected: FAIL — `photo_url` is undefined (property missing).

- [ ] **Step 3: Add the projection**

In `catalog`, change the return-type annotation `products` member and map after collection. Update the type:

```ts
  ): Promise<{
    products: (Doc<"pos_products"> & { photo_url: string | null })[];
    skus: Doc<"pos_inventory_skus">[];
    components: Doc<"pos_product_components">[];
    stockLevels: Array<{ inventory_sku_id: string; on_hand: number }>;
    vouchers: Doc<"pos_vouchers">[];
  }> => {
```

Before `return`, resolve URLs (1 getUrl per product — fine at booth scale):

```ts
    // photo_url resolved server-side so the client renders without a 2nd round-trip.
    // getUrl is a metadata lookup, not a blob fetch; negligible at booth scale.
    const productsWithPhoto = await Promise.all(
      products.map(async (p) => ({
        ...p,
        photo_url: p.photo_storage_id ? await ctx.storage.getUrl(p.photo_storage_id) : null,
      })),
    );
```

Change the return to use `products: productsWithPhoto` (keep the existing `activeProductIds`/`components` filter using the original `products` — IDs are identical).

Apply the **same** change to `listAllProducts`: update its `products` return-type member and map `productsWithPhoto` the same way.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/catalog/__tests__/products.test.ts convex/catalog/__tests__/productAdmin.test.ts`
Expected: PASS (existing shape asserts at `products.test.ts:38-45` still pass — additive field).

- [ ] **Step 5: Commit**

```bash
git add convex/catalog/public.ts convex/catalog/__tests__/products.test.ts
git commit -m "feat(v1.2 #3): catalog + listAllProducts resolve photo_url"
```

---

### Task 4: Pure thumbnail logic — `src/lib/productThumb.ts`

**Files:**
- Create: `src/lib/productThumb.ts`
- Test: `src/lib/__tests__/productThumb.test.ts`

**Interfaces:**
- Produces: `deriveInitials(name, storedInitials?) => string`, `resolveHue(code, storedHue?) => number` (0–359), `chipColors(hue) => { bg, fg, border }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/__tests__/productThumb.test.ts
import { describe, test, expect } from "vitest";
import { deriveInitials, resolveHue, chipColors } from "../productThumb";

describe("deriveInitials", () => {
  test("stored initials win, uppercased, max 3", () => {
    expect(deriveInitials("Whatever", "d8")).toBe("D8");
    expect(deriveInitials("Whatever", "abcd")).toBe("ABC");
  });
  test("derives first letter + first digit run from name", () => {
    expect(deriveInitials("Dubai 8pcs")).toBe("D8");
    expect(deriveInitials("Mixed Box 4pcs")).toBe("M4");
  });
  test("no digits → first letter only, uppercase", () => {
    expect(deriveInitials("Lotus")).toBe("L");
  });
});

describe("resolveHue", () => {
  test("valid stored hue wins", () => {
    expect(resolveHue("DUBAI_8PC", 30)).toBe(30);
  });
  test("ignores out-of-range stored hue and hashes code", () => {
    const h = resolveHue("DUBAI_8PC", 999);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
  test("hash is deterministic and in range", () => {
    expect(resolveHue("ABC")).toBe(resolveHue("ABC"));
    expect(resolveHue("ABC")).toBeGreaterThanOrEqual(0);
    expect(resolveHue("ABC")).toBeLessThan(360);
  });
});

describe("chipColors", () => {
  test("returns hsl strings for the hue", () => {
    const c = chipColors(30);
    expect(c.bg).toContain("hsl(30");
    expect(c.fg).toContain("hsl(30");
    expect(c.border).toContain("hsl(30");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/productThumb.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/productThumb.ts
/** Deterministic chip text/color for products without a photo (v1.2 #3).
 *  Stored `initials`/`hue` (already captured in /mgr/products) win; otherwise
 *  derive from the product name + code so a chip never changes between renders. */

export function deriveInitials(name: string, storedInitials?: string): string {
  const stored = storedInitials?.trim();
  if (stored) return stored.slice(0, 3).toUpperCase();
  const trimmed = name.trim();
  const first = trimmed[0] ?? "?";
  const digits = trimmed.match(/\d+/)?.[0] ?? "";
  return (first + digits).slice(0, 2).toUpperCase();
}

export function resolveHue(code: string, storedHue?: number): number {
  if (typeof storedHue === "number" && storedHue >= 0 && storedHue <= 360) {
    return Math.round(storedHue) % 360;
  }
  let h = 0;
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) % 360;
  return h;
}

/** Phthalo-dark-safe chip colors. Dynamic hue → inline hsl (the one sanctioned
 *  raw-color exception; a Tailwind token can't carry a runtime hue). */
export function chipColors(hue: number): { bg: string; fg: string; border: string } {
  return {
    bg: `hsl(${hue} 38% 26%)`,
    fg: `hsl(${hue} 30% 82%)`,
    border: `hsl(${hue} 40% 42% / 0.6)`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/productThumb.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/productThumb.ts src/lib/__tests__/productThumb.test.ts
git commit -m "feat(v1.2 #3): pure productThumb initials/hue fallback logic"
```

---

### Task 5: Client image downscale — `src/lib/imageDownscale.ts`

**Files:**
- Create: `src/lib/imageDownscale.ts`

**Interfaces:**
- Produces: `downscaleToWebp(file: File, size?: number) => Promise<Blob>` (square, EXIF-honored, webp w/ jpeg fallback).

> No unit test — canvas isn't available in jsdom. Verified by manual smoke in Task 9 and the final QA.

- [ ] **Step 1: Implement**

```ts
// src/lib/imageDownscale.ts
/** Center-crop + downscale an image File to a square webp Blob for product
 *  photos (v1.2 #3). Honors EXIF orientation so phone portrait shots don't
 *  upload sideways. Falls back to jpeg if webp encode is unsupported. */
export async function downscaleToWebp(file: File, size = 400): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const side = Math.min(bitmap.width, bitmap.height);
  const sx = (bitmap.width - side) / 2;
  const sy = (bitmap.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("CANVAS_UNAVAILABLE");
  }
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
  bitmap.close?.();
  const webp = await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, "image/webp", 0.82),
  );
  if (webp) return webp;
  const jpeg = await new Promise<Blob | null>((res) =>
    canvas.toBlob(res, "image/jpeg", 0.85),
  );
  if (!jpeg) throw new Error("ENCODE_FAILED");
  return jpeg;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json` (or the project's `npm run typecheck`)
Expected: no errors in `imageDownscale.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/imageDownscale.ts
git commit -m "feat(v1.2 #3): client image downscale to square webp (EXIF-honored)"
```

---

### Task 6: i18n keys (mgr photo controls)

**Files:**
- Modify: `src/lib/i18n/dictionaries/en.ts`, `src/lib/i18n/dictionaries/id.ts`

**Interfaces:**
- Produces: keys `mgrProducts.photoLabel`, `mgrProducts.uploadPhoto`, `mgrProducts.removePhoto`, `mgrProducts.photoUploading`, `mgrProducts.photoHint`.

- [ ] **Step 1: Add keys to `en.ts`**

Find an existing `"mgrProducts.*"` block and add (keep alphabetical-ish grouping):

```ts
  "mgrProducts.photoLabel": "Photo",
  "mgrProducts.uploadPhoto": "Upload photo",
  "mgrProducts.removePhoto": "Remove photo",
  "mgrProducts.photoUploading": "Uploading…",
  "mgrProducts.photoHint": "JPG/PNG/WebP — squared automatically.",
```

- [ ] **Step 2: Add the SAME keys to `id.ts`**

```ts
  "mgrProducts.photoLabel": "Foto",
  "mgrProducts.uploadPhoto": "Unggah foto",
  "mgrProducts.removePhoto": "Hapus foto",
  "mgrProducts.photoUploading": "Mengunggah…",
  "mgrProducts.photoHint": "JPG/PNG/WebP — otomatis dipotong persegi.",
```

- [ ] **Step 3: Typecheck (key-union parity)**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors. (`id.ts` must satisfy the `en`-derived key union; a missing key fails here.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/i18n/dictionaries/en.ts src/lib/i18n/dictionaries/id.ts
git commit -m "feat(v1.2 #3): i18n keys for product photo controls (en + id)"
```

---

### Task 7: `ProductThumb` component

**Files:**
- Create: `src/components/pos/ProductThumb.tsx`

**Interfaces:**
- Consumes: `deriveInitials`, `resolveHue`, `chipColors` (Task 4).
- Produces: `<ProductThumb photoUrl? initials? hue? name code className? />` — decorative (`alt=""`/`aria-hidden`); photo with `onError` → chip.

- [ ] **Step 1: Implement**

```tsx
// src/components/pos/ProductThumb.tsx
import { useState } from "react";
import { cn } from "@/lib/utils";
import { deriveInitials, resolveHue, chipColors } from "@/lib/productThumb";

/** Square product thumbnail (v1.2 #3): photo when present, else a deterministic
 *  colored initials chip. Decorative — the surrounding control carries the
 *  product name (sale Card aria-label; mgr row adjacent text), so alt="". */
export function ProductThumb({
  photoUrl,
  initials,
  hue,
  name,
  code,
  className,
}: {
  photoUrl?: string | null;
  initials?: string;
  hue?: number;
  name: string;
  code: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (photoUrl && !broken) {
    return (
      <img
        src={photoUrl}
        alt=""
        loading="lazy"
        onError={() => setBroken(true)}
        className={cn("aspect-square w-full rounded-md object-cover", className)}
      />
    );
  }
  const text = deriveInitials(name, initials);
  const { bg, fg, border } = chipColors(resolveHue(code, hue));
  return (
    <div
      aria-hidden
      className={cn(
        "flex aspect-square w-full items-center justify-center rounded-md text-lg font-bold tracking-wide",
        className,
      )}
      style={{ background: bg, color: fg, border: `1px solid ${border}` }}
    >
      {text}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/pos/ProductThumb.tsx
git commit -m "feat(v1.2 #3): ProductThumb (photo + initials-chip fallback)"
```

---

### Task 8: Sale-grid card relayout — photo + 2-line title + responsive collapse

**Files:**
- Modify: `src/routes/sale/index.tsx:189-230` (grid + card)

**Interfaces:**
- Consumes: `ProductThumb` (Task 7); catalog products now carry `photo_url`, `initials`, `hue`, `code`.

- [ ] **Step 1: Add the import**

At the top of `src/routes/sale/index.tsx` with the other component imports:

```ts
import { ProductThumb } from "@/components/pos/ProductThumb";
```

- [ ] **Step 2: Replace the grid container className**

Change the `motion.div` grid className (currently `"grid grid-cols-2 gap-2 sm:grid-cols-3"`) to:

```tsx
            className="grid grid-cols-1 min-[380px]:grid-cols-2 sm:grid-cols-3 gap-2 items-stretch"
```

- [ ] **Step 3: Thread `h-full` and relayout the card**

Replace the card `motion.div` + `Card` block (the `products.map` body) with:

```tsx
              {products.map((p) => {
                const line = lines.find((l) => l.productId === p._id);
                return (
                  <motion.div
                    key={p._id}
                    variants={itemV}
                    whileTap={reduce ? undefined : { scale: 0.96 }}
                    className="h-full"
                  >
                    <Card
                      role="button"
                      tabIndex={0}
                      aria-label={buildAddCardLabel(p.name, p.pack_label)}
                      onClick={() => addLine(p._id, p.price_idr)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          addLine(p._id, p.price_idr);
                        }
                      }}
                      className={cn(
                        "relative flex h-full cursor-pointer select-none flex-col p-3 transition-colors hover:bg-accent",
                        line && "ring-2 ring-primary",
                      )}
                    >
                      <ProductThumb
                        photoUrl={p.photo_url}
                        initials={p.initials}
                        hue={p.hue}
                        name={p.name}
                        code={p.code}
                        className="max-h-40"
                      />
                      <p className="mt-2 line-clamp-2 text-sm font-medium leading-tight">
                        {p.name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{rp(p.price_idr)}</p>
                      {line && (
                        <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-citrus text-[11px] font-semibold text-citrus-foreground">
                          {line.qty}
                        </span>
                      )}
                    </Card>
                  </motion.div>
                );
              })}
```

> `max-h-40` caps the 1-col full-width square so the narrowest phones stay
> scannable (staffreview #5 — tunable; adjust during QA if needed).

- [ ] **Step 4: Typecheck + run the sale tests**

Run: `npx tsc --noEmit -p tsconfig.app.json && npx vitest run src/routes/sale`
Expected: no type errors; existing sale tests still pass (aria-label unchanged → selectors hold).

- [ ] **Step 5: Commit**

```bash
git add src/routes/sale/index.tsx
git commit -m "feat(v1.2 #3): sale grid — ProductThumb + 2-line title + 1-col collapse"
```

---

### Task 9: Manager products — list thumb + edit-dialog photo control

**Files:**
- Modify: `src/routes/mgr/products.tsx`

**Interfaces:**
- Consumes: `ProductThumb` (Task 7), `downscaleToWebp` (Task 5), `generateProductPhotoUploadUrl` (Task 1), extended `updateProductMeta` (Task 2), i18n keys (Task 6), `listAllProducts.photo_url` (Task 3).

- [ ] **Step 1: Imports + local type**

Add imports:

```ts
import { ProductThumb } from "@/components/pos/ProductThumb";
import { downscaleToWebp } from "@/lib/imageDownscale";
```

Change the local `Product` type so `photo_url` is visible:

```ts
type Product = Doc<"pos_products"> & { photo_url: string | null };
```

(The `listAllProducts` cast at `MgrProductsInner` already uses `{ products: Product[]; ... }` — no further change needed once the alias includes `photo_url`.)

- [ ] **Step 2: Photo upload state + handler**

Near the other meta-edit state (`metaName`, etc.) add:

```ts
  const [metaPhotoId, setMetaPhotoId] = useState<Id<"_storage"> | undefined>(undefined);
  const [metaPhotoPreview, setMetaPhotoPreview] = useState<string | null>(null);
  const [metaRemovePhoto, setMetaRemovePhoto] = useState(false);
  const [metaPhotoBusy, setMetaPhotoBusy] = useState(false);
  const photoUploadKey = useIdempotency("catalog.photoUploadUrl");
  const generatePhotoUrl = useMutation(api.catalog.public.generateProductPhotoUploadUrl);
```

Add the handler:

```ts
  async function handlePhotoPick(file: File) {
    if (!photoUploadKey) return;
    setMetaPhotoBusy(true);
    try {
      const blob = await downscaleToWebp(file, 400);
      const { uploadUrl } = await generatePhotoUrl({ idempotencyKey: photoUploadKey, sessionId });
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": blob.type },
        body: blob,
      });
      if (!res.ok) throw new Error("UPLOAD_FAILED");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await clearIntent("catalog.photoUploadUrl"); // rotate so the next upload mints a fresh URL
      // revoke a prior object-url preview before replacing
      if (metaPhotoPreview?.startsWith("blob:")) URL.revokeObjectURL(metaPhotoPreview);
      setMetaPhotoId(storageId);
      setMetaRemovePhoto(false);
      setMetaPhotoPreview(URL.createObjectURL(blob));
    } catch (err) {
      toast.error(humanizeCatalogError(err));
    } finally {
      setMetaPhotoBusy(false);
    }
  }
```

- [ ] **Step 3: Init + reset photo state in `openMetaEdit` / `closeMetaEdit`**

In `openMetaEdit(p)` add:

```ts
    setMetaPhotoId(undefined);
    setMetaRemovePhoto(false);
    setMetaPhotoPreview(p.photo_url);
```

In `closeMetaEdit()` add (revoke object URL to avoid a leak):

```ts
    if (metaPhotoPreview?.startsWith("blob:")) URL.revokeObjectURL(metaPhotoPreview);
    setMetaPhotoPreview(null);
    setMetaTarget(null);
```

(Keep the existing `setMetaTarget(null)` — replace it with the block above.)

- [ ] **Step 4: Pass `photo_storage_id` in `commitMetaEdit`**

In the `updateProductMeta({ ... })` call inside `commitMetaEdit`, add:

```ts
        photo_storage_id: metaRemovePhoto ? null : (metaPhotoId ?? undefined),
```

- [ ] **Step 5: Photo control in the Edit dialog**

Inside the Edit-metadata `<DialogContent>` grid, add a full-width control (e.g. after the name field):

```tsx
            <div className="col-span-2 space-y-1.5">
              <Label>{t("mgrProducts.photoLabel")}</Label>
              <div className="flex items-center gap-3">
                <div className="w-16 shrink-0">
                  <ProductThumb
                    photoUrl={metaRemovePhoto ? null : metaPhotoPreview}
                    initials={metaInitials.trim() || undefined}
                    hue={metaHue.trim() ? Number(metaHue) : undefined}
                    name={metaName || metaTarget?.name || ""}
                    code={metaTarget?.code ?? ""}
                  />
                </div>
                <div className="flex-1 space-y-1.5">
                  <input
                    id="edit-photo-input"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    disabled={metaBusy || metaPhotoBusy}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handlePhotoPick(f);
                      e.target.value = ""; // allow re-pick of the same file
                    }}
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={metaBusy || metaPhotoBusy}
                      onClick={() => document.getElementById("edit-photo-input")?.click()}
                    >
                      {metaPhotoBusy ? t("mgrProducts.photoUploading") : t("mgrProducts.uploadPhoto")}
                    </Button>
                    {(metaPhotoPreview || metaTarget?.photo_url) && !metaRemovePhoto && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={metaBusy || metaPhotoBusy}
                        onClick={() => {
                          if (metaPhotoPreview?.startsWith("blob:")) URL.revokeObjectURL(metaPhotoPreview);
                          setMetaPhotoPreview(null);
                          setMetaPhotoId(undefined);
                          setMetaRemovePhoto(true);
                        }}
                      >
                        {t("mgrProducts.removePhoto")}
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{t("mgrProducts.photoHint")}</p>
                </div>
              </div>
            </div>
```

- [ ] **Step 6: Product-list row thumbnail**

In the product list `Card` (the `sortedProducts.map`), wrap the existing name/price block so a small thumb leads it. Change the `<div className="flex items-start justify-between gap-2">` inner left block to include:

```tsx
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <div className="w-10 shrink-0">
                        <ProductThumb
                          photoUrl={p.photo_url}
                          initials={p.initials}
                          hue={p.hue}
                          name={p.name}
                          code={p.code}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium leading-tight">{p.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {t("mgrProducts.skuInfoLine", { packLabel: p.pack_label, skuFamily: p.sku_family, sortOrder: p.sort_order })}
                        </p>
                        <p className="mt-1 text-sm font-mono">
                          {rp(p.price_idr)}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {t("mgrProducts.taxDisplay", { rate: p.tax_rate })}
                          </span>
                        </p>
                      </div>
                    </div>
```

(Replace the existing `<div className="min-w-0 flex-1">…</div>` left block with the above; keep the right-side archived-badge block unchanged.)

- [ ] **Step 7: Typecheck + lint + manager tests**

Run: `npx tsc --noEmit -p tsconfig.app.json && npm run lint && npx vitest run src/routes/mgr`
Expected: no type errors, no lint errors (i18n fence satisfied — all strings via `t()`), manager tests pass.

- [ ] **Step 8: Manual smoke (record in PR)**

- PC: open `/mgr/products` → Edit a product → Upload photo → preview shows → Save → sale grid shows the photo.
- Remove photo → Save → chip returns.
- Phone (if available): same flow; confirm a portrait shot is not sideways (EXIF).

- [ ] **Step 9: Commit**

```bash
git add src/routes/mgr/products.tsx
git commit -m "feat(v1.2 #3): mgr products — photo upload/remove control + list thumb"
```

---

### Task 10: Docs + CHANGELOG

**Files:**
- Modify: `docs/API_REFERENCE.md`, `docs/CHANGELOG.md`, `CLAUDE.md` (catalog row note)

- [ ] **Step 1: API_REFERENCE.md**

Under the catalog module, add:
- `generateProductPhotoUploadUrl(idempotencyKey, sessionId) → { uploadUrl }` — manager-session; mints a storage upload URL for a product photo.
- Note `updateProductMeta` now accepts `photo_storage_id?: Id<"_storage"> | null` (undefined=keep, null=remove, id=set).
- Note `catalog` + `listAllProducts` products now include `photo_url: string | null`.
- Note `pos_products.photo_storage_id` is now live (was a dead field).

- [ ] **Step 2: CHANGELOG.md**

```markdown
## 2026-06-20 — v1.2 #3: Product photos + sale-grid title legibility
- Products can carry a manager-uploaded photo (manager-session); products without one render a deterministic colored initials chip (existing `initials`/`hue`).
- Sale grid: square thumbnail + 2-line wrapping title (drops truncation); 1-column collapse on the narrowest phones.
- New `catalog.generateProductPhotoUploadUrl`; `updateProductMeta` gains `photo_storage_id` (keep/set/remove); `catalog`/`listAllProducts` project `photo_url`. No schema change.
```

- [ ] **Step 3: CLAUDE.md catalog row**

Append to the `catalog/` table row: "**v1.2 #3:** product photo upload (`generateProductPhotoUploadUrl`, manager-session) + `photo_url` projection; `photo_storage_id` now live; initials/hue chip fallback rendered via `ProductThumb`."

- [ ] **Step 4: Commit**

```bash
git add docs/API_REFERENCE.md docs/CHANGELOG.md CLAUDE.md
git commit -m "docs(v1.2 #3): API reference + CHANGELOG + CLAUDE.md for product photos"
```

---

## Success Criteria

- `npm run typecheck` — clean (incl. i18n key-union parity for `id.ts`).
- `npm run build` — clean (`min-[380px]:` + `line-clamp-2` compile under Tailwind 4).
- `npx vitest run` — all pass: `productPhoto.test.ts` (upload auth, photo set/remove/keep), `products.test.ts` (photo_url projection), `productThumb.test.ts` (derive/hash).
- `npm run lint` — clean (i18n fence: no hardcoded strings in converted files).
- Manual: photo upload (PC + phone), remove→chip, sale-grid render, 1-col collapse, EXIF-correct orientation.

## Rollback / Deployment

- **No schema migration** — `photo_storage_id`/`initials`/`hue` already exist. Revert = revert the PR.
- **Atomic BE+FE deploy** via the Vercel production build (`npx convex deploy` then FE). Additive optional arg + additive query field; no mutation↔action rename → no deploy-skew hazard. Never hand-deploy one side.
- Uploaded photos persist in Convex storage; reverting the code leaves them orphaned but harmless (no reader).
- **Post-ship:** manager uploads the 3 booth photos (`docs/frollie photoso/Frollie {1,3,8}pc.webp`) via the new control — dogfoods the path.

## Documentation Checkpoints

API_REFERENCE.md (Task 10) · CHANGELOG.md (Task 10) · CLAUDE.md catalog row (Task 10). No SCHEMA.md change (fields pre-exist; note `photo_storage_id` now live in API_REFERENCE).
