# Staffreview — v0.5.5 (worktree-exec-v0.5.5)

**Reviewer:** senior-engineer pass (deep-module / surface-API lens, ADR-034)
**Date:** 2026-06-04
**Base:** `32c51eb` (origin/main) → **Head:** `5eefa40`
**Scope:** inventory-SKU admin (standalone `createInventorySku` + bundled `createProduct` extension) + route-level chunk-load error boundary (ADR-045)

## Summary

**Verdict: depth unchanged — the catalog module stays deep, with one localized seam that slightly widens but does not flatten it.**

The change is high-quality, plan-faithful, and tested (50 green across the three touched suites; typecheck clean). The catalog module keeps its established shape: a thin PIN-gated action front-half in `actions.ts`, a single-writer `withIdempotency`-wrapped commit in `internal.ts`, and no new public surface leaking table layout to callers. The standalone `createInventorySku` is a textbook clone of the v0.5.3b `createProduct` pattern — nothing to fault there.

The one genuine architectural judgment call is bundling SKU lookup-or-create + component-link into `_createProductCommit_internal` via three optional args. This is the **right seam** for the stated use case (single-SKU products = the overwhelming common case at this booth) because all-or-nothing atomicity in one Convex transaction is exactly what a "create product + its SKU + the link" operation wants, and decomposing it into three composed public calls would push transaction-orchestration and partial-failure handling up into the React layer — strictly worse. The interface widening (3 optional args, all-present-or-absent, validated server-side) is reasonable and back-compat is tested. It does *not* make the commit a shallow pass-through: the function still owns real policy (slug derivation, lookup-or-create, audit-only-on-insert, all-or-nothing rollback).

Graft integrity (Frollie Pro v1.1+) is intact: no new tables, no schema mirroring, no `Id<>` leak across a boundary, no reach into another module's `internal.ts`/`schema.ts`. The bundled write touches only catalog-owned tables (`pos_products`, `pos_inventory_skus`, `pos_product_components`) plus the sanctioned `audit/` allow-list helper.

The error boundary (Part B) is appropriately scoped — `PublicShell` is justified (not over-engineering), the sessionStorage-timestamp guard is a sound one-shot pattern, and ADR-045 documents the decision well. Minor refinements below.

No Critical issues. Two Important findings (one parity gap with a real operational consequence, one validation asymmetry). The rest are Refinements.

---

## Critical Issues

None.

---

## Improvements (Important)

### I-1. Bundled SKU reuse path skips the `active` check that `setProductComponents` enforces — can silently link a product to an archived SKU

`setProductComponents` (`convex/catalog/public.ts:212-213`) rejects linking a product to an inactive SKU:

```ts
if (!sku) throw new Error("SKU_NOT_FOUND");
if (!sku.active) throw new Error("SKU_INACTIVE");
```

The bundled path in `_createProductCommit_internal` does a lookup-or-create on the slug but **reuses any matching row regardless of `active`**:

```ts
const existing = await ctx.db.query("pos_inventory_skus")
  .withIndex("by_sku", (q) => q.eq("sku", skuSlug)).first();
if (existing) { bundledSkuId = existing._id; bundledSkuCreated = false; }
```

So a manager who creates "Dubai 1pc" with the bundle checkbox while a `dubai` SKU exists but has been archived (`active: false`) gets a product linked to a dead SKU — the exact state the standalone components editor refuses to produce. Worse, because the bundled path reuses silently, the manager has no signal the SKU is inactive. This is an inconsistency in the same module's two write paths into `pos_product_components`.

**Fix (small):** in the reuse branch, if `existing.active === false`, either (a) throw `SKU_INACTIVE` to match `setProductComponents`, or (b) reactivate it in the same transaction and audit the reactivation. Option (a) is the conservative, consistent choice — managers reactivate via the existing flow first, identical to the standalone editor's contract. Add a test: pre-insert an inactive `dubai`, expect `SKU_INACTIVE`.

There is currently no soft-delete/archive path for SKUs in catalog (only products archive), so this is latent rather than live today — but the `active` field exists, `listAllProducts` filters on it, and v0.5.6+ admin-wiring is explicitly adding more SKU lifecycle surface. Closing the gap now is cheap; discovering it after an archive-SKU feature ships is a data-integrity bug.

### I-2. Bundled SKU `name` is `sku_family.trim()` with no length validation — the standalone path validates 1–80, the bundled path doesn't

The standalone `_createInventorySkuCommit_internal` validates the SKU name:

```ts
const name = args.name.trim();
if (name.length === 0 || name.length > 80) throw new Error("NAME_INVALID");
```

The bundled path derives the SKU's `name` from `sku_family.trim()` and inserts it **unvalidated**:

```ts
bundledSkuId = await ctx.db.insert("pos_inventory_skus", {
  sku: skuSlug, name: args.sku_family.trim(), unit: "piece", ...
});
```

Because `skuSlug` must pass `/^[a-z0-9-]{1,32}$/`, the resulting `name` is bounded to ≤32 chars and non-empty in practice, so this can't currently produce an invalid row — the slug regex incidentally protects it. But the protection is accidental: the two code paths in the same module disagree on what a valid SKU name is, and a future change to the slug rule (or a bundled flow that someday takes a separate display name) would silently drop the floor. The asymmetry is a latent trap, not a live bug.

**Fix (optional but recommended):** either factor the SKU validation+insert into a shared helper that both the standalone commit and the bundled branch call (eliminates the divergence by construction — this is the cleaner deep-module move), or add an inline comment at the bundled insert noting the slug regex is the de-facto name guard. The helper-extraction is the better answer and matches the repo's stated "rule-of-three / shared-math" lessons; there are now two writers of `pos_inventory_skus` rows that should agree on validation.

---

## Refinements (Minor / Nitpick)

### R-1 (Minor). `metadata.source: "create_product_bundled"` overloads the audit `source` concept

In the bundled audit rows, the top-level `source` field is the schema enum `"booth_inline"` (correct), but the `metadata` object *also* carries a key literally named `source`:

```ts
metadata: { sku, name, low_threshold, source: "create_product_bundled" }
```

Two different "source" meanings now coexist on one audit row (the enum provenance vs. the metadata "which flow minted this"). A forensics reader grepping audit JSON for `source` gets both. It works and the intent is good (distinguishing bundled-mint from standalone), but the key name collides with the well-known schema field. **Suggest** renaming the metadata key to `origin` or `via` (e.g. `via: "create_product_bundled"`) to avoid the semantic overload. Cheap, and the metadata blob has no consumers yet so there's no migration cost.

### R-2 (Minor). FE bundled-path validation is duplicated across three layers; only server-side is load-bearing

The slug regex `/^[a-z0-9-]{1,32}$/` and the qty/threshold checks now live in: (a) `_createProductCommit_internal` (server, authoritative), (b) `submitAddOpenPin` in `products.tsx`, and (c) the live `bundleSlugValid` derivation + the submit-button `disabled` predicate. This is acceptable UX defense-in-depth (disable the button, pre-toast before burning a PIN entry), and the server remains the single source of truth — so it's not a correctness issue. The note is only that the regex literal is now written four times across the diff (twice in BE: standalone `SKU_SLUG_RE` constant + bundled inline literal; twice in FE). **Suggest** the BE bundled branch reuse the `SKU_SLUG_RE` module constant instead of re-inlining `/^[a-z0-9-]{1,32}$/`, so the two backend writers can't drift. (FE duplication is fine — different runtime.)

### R-3 (Minor). ADR-045 is good; one gap — it doesn't address the receipt route's own error semantics vs. chunk errors

ADR-045 is well-written: the "why timestamp not boolean" and "why PublicShell" sections pre-empt exactly the questions a reviewer asks, and "Out of scope" is honest. One thing it glosses: the `/r/:receiptNumber` route can throw **non-chunk** errors (e.g. a receipt-fetch failure surfaced as a thrown error in a loader/suspense boundary). Those now render the Indonesian "Buka ulang link dari Telegram" fallback regardless of actual cause, because the boundary only special-cases chunk errors and lumps everything else into the branded screen. That's a reasonable default (customer shouldn't see a stack), but the ADR's "Anything else → branded fallback" line undersells that the receipt route's genuine data errors are now indistinguishable from chunk errors to the end user. Not a defect — just worth one sentence in the ADR so a future engineer debugging "why does my receipt error show a reload button" finds the rationale. The decision itself is correct for a customer-facing surface.

### R-4 (Nitpick). `isChunkLoadError` matching a plain `{ message }` object is tested but slightly broader than needed

The helper deliberately matches any object with a `.message` containing the pattern (tested at `chunkLoadError.test.ts`). This is fine and defensive (React Router can hand you a non-`Error`), but the regex `/Failed to fetch dynamically/` (without "imported module") would also match an unrelated hypothetical "Failed to fetch dynamically-priced item" string. The collision probability is ~zero in this app and the broad match is the safe direction (false-positive → one extra reload, harmless), so this is purely a note, not a request to change.

### R-5 (Nitpick). `PublicShell` Suspense `fallback={null}` flashes blank during public-route chunk load

`PublicShell` uses `<Suspense fallback={null}>`. During a (non-stale) lazy chunk load of `/activate` or `/r/:receiptNumber`, the user sees a blank screen rather than a spinner. The docblock acknowledges this is to avoid rendering `null`, but `null` *is* the fallback. For the customer-facing receipt opened from Telegram on a cold cache, a blank flash is slightly worse than a minimal "Loading…" The app-shell `RootLayout` presumably has a nicer fallback; the public shell deliberately does not. Acceptable for v1 (loads are fast, chunks small), but a one-line skeleton would be a trivial polish if customer-facing perception matters. Per project UX philosophy (pragmatic, no pixel-polish unless asked), leaving it is defensible — flagging only for completeness.

---

## Plan fidelity

Excellent. The implementation matches the 12-task plan task-for-task:

- Standalone internal + action (Tasks 1–2): identical to plan, including the `${key}:commit` dual-cache discipline, `booth_inline` source, no `pos_stock_levels` seed (lazy-init relied upon and documented), and the whitespace-`code`→`undefined` coercion.
- Bundled extension (Tasks 3–4): the **created-only-on-insert audit semantic the focus asked about is correct** — `inventory_sku.created` fires only in the `bundledSkuCreated` branch; the reuse test asserts zero `inventory_sku.created` rows. `product.components_set` always fires on the bundled path. Verified by `productAdmin.test.ts` reuse + fresh cases.
- Error boundary (Tasks 5–8): helper, boundary, PublicShell, router wiring all as planned.
- FE (Tasks 9–10): Add SKU dialog + bundled checkbox + error mapper + PinAction variants present; slug-invalid disables the checkbox; toast distinguishes created-vs-reused.
- Docs (Task 11): SCHEMA audit verb, API_REFERENCE rows, CHANGELOG, CLAUDE.md #22, ADR-045 all updated.

No scope creep, no shortcuts beyond the two validation gaps in I-1/I-2 (which the plan also didn't call out — the plan inherited the same blind spot, so this is a spec/plan miss faithfully implemented, not an executor deviation).

One process note: PROGRESS.md still shows the v0.5.5 block as 📋 PLANNED with all tasks un-ticked. Per the mandatory workflow this should be advanced to done with commit SHAs on merge — flagging so it's not forgotten at land time.

## Deep-module / graft scorecard

| Dimension | Assessment |
|---|---|
| Public surface narrow? | Yes — one new action, no new public mutation; table layout stays hidden. |
| Implementation hidden in internal.ts? | Yes — both writers are `withIdempotency` internal commits. |
| createProduct now shallow pass-through? | No — still owns slug derivation, lookup-or-create, conditional audit, atomic rollback. |
| Caller must know internal table layout? | No — FE passes 3 scalar flags; the join/SKU mechanics are server-internal. |
| Cross-module reach into other internal.ts/schema.ts? | None. Catalog-owned tables + sanctioned `audit/logAudit` only. |
| Graft lock-in (v1.1 cross-deployment)? | None — no new tables, no `Id<>` leak, no schema mirroring. |
| Right seam: bundle vs compose? | Bundle is correct — atomicity belongs server-side, not orchestrated from React. |

**Net: the change is a deep-module-respecting addition. Ship after addressing I-1 (active-SKU reuse guard); I-2 and the refinements are strongly-suggested follow-ups but not merge blockers.**
