# Staff Review: v0.5.5 — Inventory-SKU admin + route error boundary (spec)

**Date:** 2026-06-03
**Spec:** `docs/superpowers/specs/2026-06-03-v0.5.5-inventory-sku-admin-and-error-boundary-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (spec, not a plan — structure section deferred to the `/superpowers:writing-plans` output)

---

## 1. Summary

**Overall Assessment:** **Revise** — one schema-breaking audit `source` value, one wrong UI home, one stock-cache pattern instruction that contradicts the canonical `upsertStockLevel` helper. All cheap to fix; the underlying architecture (mirror `createProduct`, root-layout `errorElement`) is correct.

Two slices are well-scoped and independent. Once these four targeted fixes land, the spec is plan-ready.

---

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| C1 | `source: "manager_pin"` is not a valid audit `source` enum value — schema rejects it | Schema / Correctness | Part A.1 — `logAudit` call |
| C2 | UI home `/mgr/stock` is the v0.6 drift-triage surface — adding "Add SKU" there mixes PIN-gated creation into a session-only drift UI | Architecture | Part A.2 |
| C3 | Action retry / dual-cache pattern not specified — missing the `${key}:commit` derived key to the inner mutation, repeating the exact v0.5.3b post-review bug | Logic / Idempotency | Part A.1, A.3 |
| C4 | Root-route `errorElement` won't catch chunk-load failures on the **public** sibling routes (`/activate`, `/approve/:token`, `/r/:receiptNumber`) | Architecture / Resilience | Part B.1 |

### C1. Audit `source: "manager_pin"` is invalid

`convex/audit/schema.ts:14-19` defines the enum:

```ts
source: v.union(
  v.literal("booth_inline"),
  v.literal("wa_approval"),
  v.literal("telegram_approval"),
  v.literal("system"),
  v.literal("reaper"),
),
```

There is **no `"manager_pin"`** literal. The spec's recommendation would throw `ArgumentValidationError` at insert time. The intended convention is documented in `convex/audit/internal.ts:6-12` — `source` describes the **channel** the action came through, not the auth mechanism.

The mirror target `_createProductCommit_internal` (`convex/catalog/internal.ts:227`) uses `source: "booth_inline"` — that is what a manager-PIN-at-the-booth action looks like in the audit table. Off-booth approvals use `"telegram_approval"`.

**Recommendation:** Replace `source: "manager_pin"` in A.1 with `source: "booth_inline"`. (Memory `v04-triple-review-lessons` already warns about audit-source threading drift across new code paths — this is the same shape.)

### C2. `/mgr/stock` is the wrong UI home for "Add SKU"

`src/routes/mgr/stock.tsx:1-19` is the v0.6 (R9 / ADR-044) **stock drift triage** screen — `pos_stock_drift_log` rows + `resolveDrift`. It is manager-session-gated (not PIN), has no `PinSheet` wiring, and a "Add SKU" surface there would force adding a PIN-gated dialog into a page whose UX promise is "review drift; mark resolved."

`src/routes/mgr/products.tsx` is the v0.5.3b admin already holding:
- `PinSheet` wired up with `pending`/`error`/PinAction discriminator (lines 1049-1057)
- `data.skus` from `listAllProducts` (line 124) — the same Convex query that needs to return the new SKU
- An "Add product" Dialog flow that the SKU dialog can clone (lines 671-786)
- The `humanizeCatalogError` mapper already maps the catalog error vocabulary (line 78)

**Recommendation:** Resolve open-item #2 in favour of `/mgr/products`. Add an "Add SKU" button next to "Add product" in the header (line 550); reuse the same PinAction discriminator with a new `kind: "createInventorySku"` variant; the components-editor `data.skus` list refreshes reactively after insert (no manual refetch). Update spec A.2 to drop the `/mgr/stock` option.

### C3. Action retry / dual-cache `${key}:commit` not specified

Spec A.1 says `withActionCache({ key, mutationName })` and `_createInventorySkuCommit_internal (internalMutation, withIdempotency)` separately, but never names the load-bearing detail: the action's `runMutation` call MUST pass `${args.idempotencyKey}:commit` to the inner mutation, not the bare key.

This is the canonical pattern in `convex/catalog/actions.ts:50-52` (with the docblock at lines 14-19) and `convex/refunds/actions.ts:_commitRefund_internal`. The two layers compose so an action retry crashed between commit and action-level cache write doesn't double-insert. v0.5.3b retrofitted this after triple-review caught it; we should not re-litigate.

`withActionCache` itself (`convex/idempotency/action.ts:17-32`) explicitly documents that callers still pass `${key}:commit` to the wrapped internal.

**Recommendation:** Add to A.1 under `createInventorySku` (action): *"Inner `runMutation` passes `idempotencyKey: \`${args.idempotencyKey}:commit\`` to `_createInventorySkuCommit_internal` — mirrors `catalog.actions.createProduct:50-52` and the `withActionCache` docblock at `convex/idempotency/action.ts:17-32`."* Add a test step asserting that a same-key crash-and-retry leaves exactly one `pos_inventory_skus` row + one audit row.

### C4. `errorElement` on root layout misses public routes

`src/router.tsx:73-115` has the route table in two tiers:

- **Public siblings** (lines 75-77): `/activate`, `/approve/:token`, `/r/:receiptNumber` — no parent layout.
- **App shell** (lines 80-113): `path: "/"` with `<RootLayout />` and children.

The spec's "add `errorElement` at the root route" attaches the boundary to the app-shell parent — but the public routes are siblings, not children. A stale-chunk failure on `/r/:receiptNumber` (the customer's receipt link, the most external-facing surface) would still show the bare React Router default screen.

This matters because:
1. `/r/:receiptNumber` is served to customers via Telegram, not staff — the failure mode there is even worse than a booth staff seeing it.
2. `/approve/:token` is the manager off-booth approval landing — equally external.
3. PWA stale-chunk windows correlate with prod deploys; that is exactly when a customer might click a receipt link.

**Recommendation:** Attach the same `errorElement: <RouteErrorBoundary />` to all four entries: the root app-shell route AND the three public sibling routes. Alternative (cleaner): wrap the three public routes under a `PublicShell` layout that carries the same `errorElement`. Update B.1 to call this out.

---

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| I1 | Drop the `pos_stock_levels` seed-at-create — `upsertStockLevel` already lazy-inits on first movement and all read paths use `?? 0` | M | L |
| I2 | `verifyManagerPinOrThrow` returns `{ managerId, deviceId }` — capture `deviceId` for the audit row's `device_id` field (matches v0.5.3b convention) | M | L |
| I3 | The `useIdempotency` hook returns `string \| undefined` — guard `if (!key) return;` in the UI and disable submit until ready | M | L |
| I4 | Add a `listAllProducts` regression test that exercises a freshly-created SKU showing in the admin payload | M | L |
| I5 | Add a copy of the `withActionCache`/`:commit` docblock from `createProduct` to the new action for in-file reader context | L | L |
| I6 | Move B.1's `isChunkLoadError(err): boolean` from "optional unit test" to a required pure-helper export (already extracted, so it gets tested for free) | M | L |

### I1. The stock-level seed at create is unnecessary clutter

`convex/inventory/internal.ts:20-42` (`upsertStockLevel`) is the canonical helper for SKU-level writes. It already handles the "no row exists" case by inserting at `on_hand: delta`. Every consumer of `pos_stock_levels` either calls this helper or reads with `level?.on_hand ?? 0`:

- `convex/inventory/public.ts:16-34` (`getStockLevels`) — iterates `pos_stock_levels.collect()`, only emits entries with rows; absent SKUs simply don't appear in the map.
- `convex/inventory/public.ts:128`, `:365`; `convex/inventory/internal.ts:308`, `:538` — all use `level?.on_hand ?? 0`.
- Consumers downstream apply `?? 0` again (e.g. `useCart`).

Seeding a `pos_stock_levels` row at SKU creation time:
- Creates a row that no consumer needs (since reads default to 0 anyway)
- Splits the "rows are created by movements" mental model
- Adds a write that has to be tested, audited (or not?), and reasoned about during nightly recon

The cost of NOT seeding is zero: the first stock-in / sale / spoilage / recount calls `upsertStockLevel` which inserts the row. Until then, `getStockLevels` legitimately omits the SKU.

**Recommendation:** Drop "Seed the stock-level cache" from A.1. Resolve open-item #1 the same way. Document in the action docblock: *"No `pos_stock_levels` seed — `upsertStockLevel` lazy-inits on first movement; reads default to 0."*

### I2. Capture `deviceId` for the audit `device_id` field

`verifyManagerPinOrThrow` returns `{ managerId: Id<"staff">; deviceId: string }` (`convex/auth/verifyPin.ts:74`). The spec destructures only `{ managerId }`. The v0.5.3b convention for PIN-gated admin actions is to also thread `deviceId` into the audit row's `device_id` field so the audit log records which booth device PIN'd the action.

`createProduct` doesn't currently pass `device_id` either (so this is technically a v0.5.3b oversight, not a v0.5.5 regression), but adding it now for the SKU action is one extra line and tightens future forensics. Mention it in the spec; the planning step can decide whether to retrofit `createProduct` simultaneously.

**Recommendation:** A.1 destructuring: `const { managerId, deviceId } = await verifyManagerPinOrThrow(...)`. Pass `deviceId` through to `_createInventorySkuCommit_internal`; emit `device_id: args.deviceId` on the `logAudit` call.

### I3. Spell out the `useIdempotency` undefined-guard in A.2

`useIdempotency` returns `string | undefined` during the initial IDB read (`src/hooks/useIdempotency.ts:106-120`, docstring lines 14-22). The products admin handles this via `disabled={!createKey || ...}` on submit buttons (line 780) and an early `if (!createKey) throw new Error("idempotency key not ready");` (line 468). Spec A.2 currently doesn't mention this — easy omission to repeat in a new dialog. Spell it out in the UI section.

### I4. Test the admin read query reflects a fresh SKU

The spec testing section says "New SKU appears in the components-editor read query." `listAllProducts` already filters skus by `active: true`, but a dedicated test that creates a SKU then asserts `listAllProducts({ sessionId }).skus` includes it is one extra `expect` and pins the read seam (ADR-034). Use the `productAdmin.test.ts` harness — same shape exists for products (`convex/catalog/__tests__/productAdmin.test.ts:23-44`).

### I5. Repeat the docblock

The dual-cache `${key}:commit` pattern's "why" is spelled out in `convex/catalog/internal.ts:170-174` (and again in `convex/catalog/actions.ts:14-19`). New module readers benefit from finding the rationale in-file; future-you will be grateful when the same retry case fires.

### I6. Promote `isChunkLoadError` to a required helper

The spec lists "extract `isChunkLoadError(err): boolean`" as part of the **optional** test plan. It's actually the cleanest API: the boundary stays a thin React component, the regex lives in one place, and the test for it doesn't need a router harness. Make it a required deliverable in B.1: `src/lib/chunkLoadError.ts` exports `isChunkLoadError(err: unknown): boolean`; the boundary imports it; the test imports it. Three lines of code total, full unit coverage.

---

## 4. Refinements (Optional)

- **R1.** Add a slug-shape regex constant — `SKU_SLUG_RE = /^[a-z0-9-]{1,32}$/` (mirrors the seed values `dubai`, `choco`, `matcha`, `lotus`, `brownie`). Resolves open-item #5.
- **R2.** Keep `code` optional in the create form (resolve open-item #4). The schema comment at `convex/catalog/schema.ts:7` says "required in Task F6 (DEFERRED)" — until that flips, the form should not artificially require it. Backend validates only "if present, non-empty and unique."
- **R3.** Version number — v0.5.5 slots after v0.5.4 (BT printing); v0.6 is already spec'd. No collision. Spec's "renumber if it collides" is moot.
- **R4.** Audit verb `inventory_sku.created` matches the `product.created` precedent — good. Add to `docs/SCHEMA.md`'s audit-verb list in the same PR (CLAUDE.md "How to add a feature" #4).
- **R5.** The error-boundary fallback should NOT include a stack trace even in dev — staff debugging happens at the booth too, and a stack in their face during the morning rush is worse than a generic "Reload" button.

---

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| `createProduct` action + `_createProductCommit_internal` | `convex/catalog/actions.ts:20-64`, `internal.ts:175-233` | Direct template for the new SKU action + internal commit |
| `verifyManagerPinOrThrow` | `convex/auth/verifyPin.ts:67-93` | Same PIN gate, same call shape |
| `withActionCache` | `convex/idempotency/action.ts:34-50` | Same wrapper |
| `withIdempotency` | `convex/idempotency/internal.ts` | Same `:commit`-key short-circuit |
| `MgrProducts` "Add product" dialog | `src/routes/mgr/products.tsx:671-786` | Clone shape; add to `PinAction` union as `kind: "createInventorySku"` |
| `humanizeCatalogError` | `src/routes/mgr/products.tsx:78-91` | Extend with `SKU_EXISTS`, `CODE_EXISTS`, `SKU_INVALID` mappings |
| `parseIntStrict` | `src/routes/mgr/products.tsx:93-101` | Reuse for `low_threshold` integer input |
| `PinSheet` | `src/components/pos/PinSheet.tsx` | Same component, no changes |
| `useIdempotency("catalog.createInventorySku")` | `src/hooks/useIdempotency.ts` | New intent string; same hook |
| `clearIntent("catalog.createInventorySku")` | `src/hooks/useIdempotency.ts` | Rotate on success |
| Pattern doc — dual-call authCheck | `docs/PATTERNS/idempotency-dual-call-authcheck.md` | Reference, don't re-explain |

### Potential duplication risks

- **None significant.** The "extend `humanizeCatalogError`" path keeps catalog error mapping in one place. The PinAction discriminated union extends naturally.

---

## 6. Phase / Wave Accuracy

(Spec is pre-plan; this section becomes substantive in the plan staffreview. Noted as N/A here.)

---

## 7. Specialist Agent Recommendations

(N/A at spec stage. Defer to the plan; `/superpowers:writing-plans` will sequence the implementation tasks.)

---

## 8. Git Workflow Assessment

Spec doesn't yet specify a branch / commit boundary plan. Per CLAUDE.md and the user's preference for `/spec-plan-pipeline`:

- Worktree off `main` for the plan branch (already done — `worktree-v0.5.5-plan`).
- Plan and PROGRESS.md refresh land via a squash-PR (per repo convention).
- Implementation is a separate post-`/clear` session, by hand from `.claude/handoff/execute_<slug>.md`.

The plan should organise commits per natural boundary:
1. Action + internal commit + audit verb in `docs/SCHEMA.md`.
2. Frontend dialog + PinAction extension + error mapper.
3. Tests (catalog admin harness extension).
4. Router `errorElement` + `RouteErrorBoundary` + `isChunkLoadError` helper.
5. `CHANGELOG.md` entry.

---

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Backend A | `docs/SCHEMA.md` (audit verb `inventory_sku.created`), `docs/API_REFERENCE.md` (new catalog action + internal commit), `CLAUDE.md` rule #22 if PIN-gated tier list needs to mention SKU creation explicitly |
| Frontend A | None (admin surface; route already documented) |
| Frontend B | `docs/ADR/` — likely a small ADR titled "Route-level chunk-reload error boundary" so the policy "auto-reload once via sessionStorage, then friendly fallback" is captured. Lightweight ADR, not a foundations-level change |
| Both | `docs/CHANGELOG.md` entry |

### CHANGELOG draft

~~~markdown
## 2026-06-04 — v0.5.5

- **Inventory SKU admin:** managers can now create new inventory SKUs from `/mgr/products` (PIN-gated, audited as `inventory_sku.created`). Closes the v0.5.3b gap where products could be created but the underlying SKU line was seed-only.
- **Route-level chunk-load recovery:** stale-deploy "Failed to fetch dynamically imported module" errors now auto-recover via a guarded one-shot reload; a hard-missing chunk renders a friendly "Reload" fallback instead of React Router's default error screen. Covers app-shell routes and the public `/r/:receiptNumber`, `/approve/:token`, `/activate` routes.
~~~

---

## 10. Testing Plan Assessment

**Verdict:** Adequate, with two additions.

### Planned tests (carry into the plan)

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Backend | `_createInventorySkuCommit_internal` — happy path | convex-test | planned |
| Backend | duplicate `sku` → `SKU_EXISTS` | convex-test | planned |
| Backend | duplicate `code` → `CODE_EXISTS` | convex-test | planned |
| Backend | bad `low_threshold` → validation throw | convex-test | planned |
| Backend | bad slug shape → `SKU_INVALID` | convex-test | planned |
| Backend | idempotency replay returns same `skuId`, no double insert | convex-test | planned |
| Backend | PIN gate: wrong PIN → throws before insert | convex-test | planned (reuse `productAdmin.test.ts` harness) |
| Backend | `listAllProducts` returns the new SKU after creation (I4) | convex-test | **add** |
| Backend | action retry with same key after crash → exactly one row, one audit (C3) | convex-test | **add** |
| Frontend | `isChunkLoadError(err)` — pure unit test (I6) | vitest | promoted from optional |

### Missing test coverage (must add)

| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| T1 | Action-level crash-retry leaves one row + one audit | The dual-cache `${key}:commit` pattern is load-bearing per memory `v05-triple-review-lessons` | Spy/mock cache miss on first call, simulate second call with same key, assert single insert |
| T2 | `listAllProducts({ sessionId }).skus` includes a freshly-created SKU | Confirms the ADR-034 read seam still works for an admin who just created a row | One extra `expect` in the create-happy-path test |

### Test execution checkpoints

1. After backend implementation: `npx vitest run convex/catalog`.
2. After frontend implementation: `npx vitest run src/routes/mgr` + manual smoke.
3. Before merge: full `npm run typecheck && npm run lint && npx vitest run && npm run build`.

### Regression risk

- `listAllProducts` (`convex/catalog/public.ts:77-98`) — already covered; adding a SKU shouldn't change behaviour for products.
- `MgrProducts` "Add product" flow — extending `PinAction` could refactor the discriminator; keep `kind` checks exhaustive.
- `RootLayout` — confirm `errorElement` doesn't shadow `<RootLayout />`'s own redirect-to-login logic; the boundary catches render/lazy-load errors, not `<Navigate>` redirects.

---

## 11. Edge Cases to Address

- [ ] **Slug normalisation** — should the form `trim()` and lowercase before validation, or reject upper/whitespace input? Lean: trim + reject (less magic).
- [ ] **`code` collision with an existing PRODUCT code** — `pos_products.code` and `pos_inventory_skus.code` are separate fields with separate indexes. The duplicate check is per-table; do NOT cross-validate. (Spec already implies this.)
- [ ] **`code` provided but empty string after trim** — treat as not-provided, don't insert empty string.
- [ ] **Reload-loop edge** — `sessionStorage.setItem("chunk-reload-attempted", ...)` must be cleared on a SUCCESSFUL render, not just on first mount. Put the clear in a `useEffect(() => sessionStorage.removeItem(...), [])` on the boundary's normal subtree.
- [ ] **Tab opened from old QR** — a 30-min-old `/r/:receiptNumber` opened from Telegram after a deploy hits the boundary; user is a customer, not staff. Fallback copy should be customer-friendly ("Halaman tidak bisa dimuat. Buka ulang link dari Telegram.") OR Indonesian, since receipts are customer-facing.
- [ ] **Hue value 360** — current validation in `MgrProducts` allows 0-360 inclusive. Mirror exactly (don't tighten to <360).
- [ ] **Active=false SKU re-creation** — out of scope this phase (no deactivate UI), but the `by_sku` uniqueness check should not be relaxed if a row is `active: false`. (Currently `by_sku` is bare, so any row collides — correct.)

---

## 12. Approval Conditions

**To approve the spec, address:**
1. **C1** — change `source: "manager_pin"` → `source: "booth_inline"`.
2. **C2** — resolve open-item #2 to `/mgr/products`; update A.2 accordingly.
3. **C3** — explicitly specify `${args.idempotencyKey}:commit` to the inner mutation.
4. **C4** — extend `errorElement` to cover the public sibling routes (`/activate`, `/approve/:token`, `/r/:receiptNumber`).

**Recommended before implementation:**
1. **I1** — drop the `pos_stock_levels` seed step.
2. **I2** — capture `deviceId` from `verifyManagerPinOrThrow` and audit it.
3. **I3** — spell out the `useIdempotency` undefined-guard in A.2.
4. **I6** — promote `isChunkLoadError` to a required helper, not optional.

After fixes land, proceed to `/superpowers:writing-plans`; the resulting plan goes through `/staffreview` again before execution.

---

*Generated by `/staffreview` — Frollie POS spec-plan pipeline, 2026-06-03.*
