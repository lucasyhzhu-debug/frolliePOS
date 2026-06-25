# Owner Cockpit (Spec 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the entire owner cockpit (Spec 3) — owner-scoped cross-outlet read layer, the `createOutlet`/clone action (single atomic mutation, idempotent, audited), the cross-outlet dashboard, and the owner FE (outlet switcher, real dashboard, outlet list, new-outlet wizard) — on the already-shipped cockpit auth plane.

**Architecture:** Backend lives in a new `convex/cockpit/*` module gated on `requireCockpitSession`, reading cross-outlet **only** via owning-module internal readers (ADR-034). The clone is ONE transactional mutation calling plain V8-safe helpers in each owning module's `lib.ts` (atomic — a crash rolls back everything; resolves OQ-2). The FE extends the **already-shipped** `RootLayout`/`CockpitShell`/`useSession` cockpit plane (NOT a new `CockpitLayout`) and builds the switcher, dashboard, list, and wizard via `/frontend-design`.

**Tech Stack:** Convex 1.31.7 (queries/mutations/actions, `convex-test` + vitest), React 19 + TypeScript + Vite, React Router v7, Tailwind 4 + shadcn/ui, Framer Motion, `FieldMessage` (ADR-048) for inline validation.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-21-owner-cockpit-design.md` — read its **Drift reconciliation (2026-06-25)** block first; it is authoritative over any stale prose.
- **Auth gate:** every `convex/cockpit/*` query/mutation gates on `requireCockpitSession(ctx, sessionId)` (`convex/auth/sessions.ts:54`) as its first line; the `createOutlet` action authCheck bridges via `internal.auth.ownerInternal._assertCockpitSession_internal`. Errors are `NOT_COCKPIT_SESSION` / `NO_SESSION` / `SESSION_IDLE_TIMEOUT` — never `NO_OWNER_SESSION`.
- **Cockpit reads cross-outlet via owning-module internal readers only** (ADR-034); `cockpit` is NOT in the `no-cross-module-db-access` ALLOWLIST, so never raw-`ctx.db` another module's table from `convex/cockpit/*`.
- **Public mutations/actions:** `idempotencyKey` arg + `withIdempotency`/`withActionCache` + authCheck-before-cache (rule #20, ADR-013/046).
- **Money = integer rupiah** (ADR-015); **server time wins** — every `_at` via `Date.now()` inside the function (ADR-031).
- **All FE built via `/frontend-design`** (standing rule); inline validation via `FieldMessage` (ADR-048), brand strings as `{"…"}` JSX (ADR-049); guard Framer Motion with `useReducedMotion`.
- **`docs/PROGRESS.md` is retired** — no `/progress` tooling; progress is `docs/CHANGELOG.md` at ship time + `docs/ROADMAP.md` removal.
- **Tests:** backend `npx vitest run convex/cockpit` (+ touched modules); FE `npx vitest run src/...`; full gate `npm run typecheck && npx vitest run` before merge.

---

## Task List

| ID | Title | Files touched | Wave | Depends-on |
|----|-------|---------------|------|-----------|
| T1 | Widen audit `source` union with `"cockpit"` | `convex/audit/schema.ts`, `convex/audit/internal.ts`, `docs/SCHEMA.md` | 1 | — |
| T2 | Catalog clone helper `cloneCatalogRows` | `convex/catalog/lib.ts` (create), `__tests__` | 1 | — |
| T3 | Settings clone/seed helpers | `convex/settings/lib.ts` (create), `__tests__` | 1 | — |
| T4 | Grant-access plain helper `grantOutletAccessRow` + refactor internal mutation onto it | `convex/auth/grantAccess.ts` (create), `convex/auth/internal.ts`, `__tests__` | 1 | — |
| T5 | `_createOutletAtomic_internal` mutation (consumes T2–T4) | `convex/cockpit/outlets.ts` (create), `__tests__` | 2 | T1,T2,T3,T4 |
| T6 | `createOutlet` action + `listOutlets` + `listAssignableStaff` | `convex/cockpit/outlets.ts`, `convex/staff/internal.ts`, `__tests__` | 2 | T5 |
| T7 | Cross-outlet dashboard queries (`consolidatedSummary`, `perOutletSummary`) | `convex/cockpit/dashboard.ts` (create), `__tests__` | 3 | T6 |
| T8 | OutletContext + OutletSwitcher; wire into `CockpitShell` + keepalive | `src/contexts/OutletContext.tsx`, `src/components/cockpit/OutletSwitcher.tsx`, `src/components/layout/RootLayout.tsx`, `src/lib/storage-keys.ts` | 4 | T6 |
| T9 | Real cockpit dashboard landing (replace placeholder home) | `src/routes/cockpit/index.tsx`, `__tests__` | 4 | T7,T8 |
| T10 | Outlet list page + route | `src/routes/cockpit/outlets/index.tsx`, `src/router.tsx`, `__tests__` | 4 | T8 |
| T11 | New-outlet wizard + route | `src/routes/cockpit/outlets/new/index.tsx`, `src/router.tsx`, `__tests__` | 4 | T6,T10 |
| T12 | Docs + ROADMAP/CHANGELOG | `docs/CHANGELOG.md`, `docs/API_REFERENCE.md`, `docs/ROADMAP.md`, `CLAUDE.md`, `docs/SCHEMA.md` | 5 | T1–T11 |

---

## Execution Strategy — multi-agent, wave-gated

**Wave dispatch map** (parallelize *within* a wave; **barrier between waves**; re-run codegen + full gate on the merged tree at each barrier):

- **Wave 1 (4-wide parallel):** T1, T2, T3, T4 — four different modules (`audit`, `catalog`, `settings`, `auth`), no shared files. Each is a plain helper/validator + test. None registers a new Convex function, so `convex/_generated/api.d.ts` is unaffected.
- **Wave 2 (sequential — T5 then T6):** both write `convex/cockpit/outlets.ts` (shared file → serialize). T5 = the atomic mutation; T6 = the action + two queries (and a tiny `staff/internal.ts` reader). New registered functions → regen `convex/_generated/api.d.ts` once after T6.
- **Wave 3 (solo):** T7 — new `convex/cockpit/dashboard.ts`. Regen after.
- **Wave 4 (FE, mostly parallel, build via `/frontend-design`):** T8 (shell + context), T9 (dashboard), T10 (list), T11 (wizard). **Shared file `src/router.tsx`** is edited by T10 + T11 → serialize those two router edits (do T10 before T11; T11 only appends its route). T8 modifies `RootLayout.tsx` (CockpitShell) solo. T9 depends on T7+T8; T11 depends on T6 (createOutlet) + T10.
- **Wave 5 (main session, NOT a background agent):** T12 docs, then the close-out `/triple-review` → `/simplify xhigh`.

**Shared / generated-file serialization:**
- `convex/cockpit/outlets.ts` — T5 then T6 (sequential).
- `convex/_generated/api.d.ts` (codegen) — regenerate once per wave on the merged tree (`npx convex codegen`); never hand-edit. Run it after Wave 2 and Wave 3 before typechecking.
- `src/router.tsx` — T10 then T11 (sequential append).
- `convex/audit/{schema,internal}.ts` — T1 only (Wave 1), read-only thereafter.
- `convex/auth/internal.ts` — T4 only.
- `src/components/layout/RootLayout.tsx` (CockpitShell) — T8 only.

**Critical path (minimum wall-clock):** T1/T4 → T5 → T6 → T7 → T9. (T2/T3 finish inside Wave 1; T8/T10/T11 ride the FE wave.)

**What can't be done headless (flag "pending", don't claim passed):**
- **Live owner smoke** — promote a real owner, bind their Telegram DM, OTP-login to the cockpit, clone the default outlet, verify the second outlet appears + has copied catalog/empty stock. Needs a real Telegram DM + the prod/dev deployment. **Owner-run after merge.**
- **Visual/UX sign-off** of the switcher/dashboard/wizard — `/frontend-design` builds them, but pixel/interaction review is a human gate.

**Close-out (main session):** after Wave 4 is green, run `/triple-review` (address every Critical + Improvement) then `/simplify xhigh` (apply cleanups); re-run `npm run typecheck && npx vitest run`; only then is the phase done.

---

## File Structure

```
convex/cockpit/                    # NEW module — owner-scoped, outlet-UNSCOPED, requireCockpitSession-gated
  outlets.ts                       # createOutlet (action), _createOutletAtomic_internal (mutation), listOutlets, listAssignableStaff
  dashboard.ts                     # consolidatedSummary, perOutletSummary (fan-out over active outlets)
  __tests__/outlets.test.ts
  __tests__/dashboard.test.ts
convex/catalog/lib.ts              # NEW — cloneCatalogRows(ctx, {source, target, now}) plain helper (V8-safe)
convex/settings/lib.ts             # NEW — cloneSettingsRow / seedSettingsRow plain helpers
convex/auth/grantAccess.ts         # NEW — grantOutletAccessRow(ctx, {...}) plain helper (dedup+insert, NO audit)
src/contexts/OutletContext.tsx     # NEW — { outlets, currentOutletId: Id|"all", setCurrentOutlet }
src/components/cockpit/OutletSwitcher.tsx   # NEW — header dropdown
src/routes/cockpit/index.tsx       # MODIFY — replace placeholder with real dashboard
src/routes/cockpit/outlets/index.tsx        # NEW — outlet list
src/routes/cockpit/outlets/new/index.tsx    # NEW — wizard host + step machine
```

The clone helpers live in their **owning** module's `lib.ts` (catalog/settings/auth) so the raw `ctx.db` writes are attributed to that module by the `no-cross-module-db-access` fence, while executing inside the single cockpit transaction.

---

## Task 1: Widen audit `source` union with `"cockpit"`

**Files:**
- Modify: `convex/audit/schema.ts` (the `source` `v.union`)
- Modify: `convex/audit/internal.ts` (the `logAudit` `source` TS type + any literal list)
- Modify: `docs/SCHEMA.md` (source set + new verb `outlet.created`)
- Test: `convex/audit/__tests__/` (add or extend a logAudit test)

**Interfaces:**
- Produces: `logAudit(...)` accepts `source: "cockpit"`; audit rows persist with `source: "cockpit"`.

- [ ] **Step 1: Write the failing test** — `convex/audit/__tests__/cockpit-source.test.ts`

```ts
import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

test("logAudit persists source 'cockpit'", async () => {
  const t = convexTest(schema);
  // a thin internal test-shim that calls logAudit; or assert via a mutation that uses it.
  await t.run(async (ctx) => {
    const { logAudit } = await import("../internal");
    const staffId = await ctx.db.insert("staff", {
      name: "Owner", code: "O1", role: "owner", pin_hash: "x", active: true, created_at: Date.now(),
    } as any);
    await logAudit(ctx, {
      actor_id: staffId, action: "outlet.created", entity_type: "outlets",
      entity_id: "x", source: "cockpit", metadata: { mode: "blank" },
    });
    const row = await ctx.db.query("audit_log").first();
    expect(row?.source).toBe("cockpit");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (validator rejects `"cockpit"` / TS error)

Run: `npx vitest run convex/audit/__tests__/cockpit-source.test.ts`
Expected: FAIL (arg validator / type error on `source: "cockpit"`).

- [ ] **Step 3: Add `"cockpit"` to the union** in `convex/audit/schema.ts`:

```ts
source: v.union(
  v.literal("booth_inline"),
  v.literal("wa_approval"),
  v.literal("telegram_approval"),
  v.literal("system"),
  v.literal("reaper"),
  v.literal("cockpit"),   // v1.3.0 owner cockpit — owner-initiated writes (no device, no booth)
),
```

And in `convex/audit/internal.ts`, extend the `source` TS union on the `logAudit` arg type **and** any standalone literal list (e.g. line ~8/~35) to include `| "cockpit"`.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run convex/audit/__tests__/cockpit-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Doc + commit** — add `outlet.created` to the verb list and `cockpit` to the source set in `docs/SCHEMA.md`.

```bash
git add convex/audit/schema.ts convex/audit/internal.ts convex/audit/__tests__/cockpit-source.test.ts docs/SCHEMA.md
git commit -m "feat(audit): add 'cockpit' source + outlet.created verb"
```

---

## Task 2: Catalog clone helper `cloneCatalogRows`

**Files:**
- Create: `convex/catalog/lib.ts`
- Test: `convex/catalog/__tests__/clone.test.ts`

**Interfaces:**
- Produces: `cloneCatalogRows(ctx: MutationCtx, args: { sourceOutletId: Id<"outlets">; targetOutletId: Id<"outlets">; now: number }): Promise<{ skus: number; products: number; components: number }>` — copies skus → products → components into the target outlet with remapped FKs; reuses `photo_storage_id` by value; returns counts.

- [ ] **Step 1: Write the failing test**

```ts
import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";

test("cloneCatalogRows copies + remaps FKs into target outlet, reuses photo id", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const src = await ctx.db.insert("outlets", { code: "SRC", name: "Src", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const tgt = await ctx.db.insert("outlets", { code: "TGT", name: "Tgt", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const photo = "kg_fakephoto" as any;
    const sku = await ctx.db.insert("pos_inventory_skus", { sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 5, active: true, created_at: 1, outlet_id: src, photo_storage_id: photo } as any);
    const prod = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "8pcs", price_idr: 100000, active: true, sort_order: 0, tax_rate: 0, created_at: 1, updated_at: 1, outlet_id: src } as any);
    await ctx.db.insert("pos_product_components", { product_id: prod, inventory_sku_id: sku, qty: 8, outlet_id: src } as any);

    const { cloneCatalogRows } = await import("../lib");
    const counts = await cloneCatalogRows(ctx, { sourceOutletId: src, targetOutletId: tgt, now: 999 });
    expect(counts).toEqual({ skus: 1, products: 1, components: 1 });

    const newComp = (await ctx.db.query("pos_product_components").withIndex("by_outlet_product", (q) => q.eq("outlet_id", tgt)).collect())[0];
    const newProd = (await ctx.db.query("pos_products").withIndex("by_outlet_code", (q) => q.eq("outlet_id", tgt).eq("code", "DUBAI_8PC")).collect())[0];
    const newSku = (await ctx.db.query("pos_inventory_skus").withIndex("by_outlet_code", (q) => q.eq("outlet_id", tgt)).collect())[0];
    expect(newComp.product_id).toBe(newProd._id);   // remapped to NEW product
    expect(newComp.inventory_sku_id).toBe(newSku._id); // remapped to NEW sku
    expect(newProd.photo_storage_id).toBe(photo);    // reused BY VALUE
    expect(newComp.product_id).not.toBe(prod);       // not the source id
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`cloneCatalogRows` not found)

Run: `npx vitest run convex/catalog/__tests__/clone.test.ts`

- [ ] **Step 3: Implement `convex/catalog/lib.ts`** (V8-safe — no `"use node"`):

```ts
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Copy a source outlet's catalog (skus → products → components) into a target
 * outlet with remapped foreign keys. Photos reuse the same `_storage` id by
 * value (same deployment, cheap; rows diverge on later edit). V8-safe; runs
 * inside the caller's mutation transaction (atomic with the rest of the clone).
 */
export async function cloneCatalogRows(
  ctx: MutationCtx,
  { sourceOutletId, targetOutletId, now }: { sourceOutletId: Id<"outlets">; targetOutletId: Id<"outlets">; now: number },
): Promise<{ skus: number; products: number; components: number }> {
  const skuIdMap = new Map<string, Id<"pos_inventory_skus">>();
  const skus = await ctx.db.query("pos_inventory_skus").withIndex("by_outlet_active", (q) => q.eq("outlet_id", sourceOutletId)).collect();
  for (const s of skus) {
    const { _id, _creationTime, outlet_id, created_at, ...rest } = s;
    const nid = await ctx.db.insert("pos_inventory_skus", { ...rest, outlet_id: targetOutletId, created_at: now });
    skuIdMap.set(String(_id), nid);
  }

  const productIdMap = new Map<string, Id<"pos_products">>();
  const products = await ctx.db.query("pos_products").withIndex("by_outlet_active_sort", (q) => q.eq("outlet_id", sourceOutletId)).collect();
  for (const p of products) {
    const { _id, _creationTime, outlet_id, created_at, updated_at, ...rest } = p;
    const nid = await ctx.db.insert("pos_products", { ...rest, outlet_id: targetOutletId, created_at: now, updated_at: now });
    productIdMap.set(String(_id), nid);
  }

  const components = await ctx.db.query("pos_product_components").withIndex("by_outlet_product", (q) => q.eq("outlet_id", sourceOutletId)).collect();
  for (const c of components) {
    const newProduct = productIdMap.get(String(c.product_id));
    const newSku = skuIdMap.get(String(c.inventory_sku_id));
    if (!newProduct || !newSku) continue; // dangling FK in source — skip (shouldn't happen)
    await ctx.db.insert("pos_product_components", { product_id: newProduct, inventory_sku_id: newSku, qty: c.qty, outlet_id: targetOutletId });
  }
  return { skus: skus.length, products: products.length, components: components.length };
}
```

> **Note:** `by_outlet_active` / `by_outlet_active_sort` filter on `active` — they iterate only `active: true` source rows. If cloning inactive rows matters, scan `by_outlet_code` instead (no active filter). For v1, cloning the active catalog is correct (a new outlet starts from the live menu).

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git add convex/catalog/lib.ts convex/catalog/__tests__/clone.test.ts
git commit -m "feat(catalog): cloneCatalogRows helper (FK remap, photo reuse)"
```

---

## Task 3: Settings clone/seed helpers

**Files:**
- Create: `convex/settings/lib.ts`
- Test: `convex/settings/__tests__/clone.test.ts`

**Interfaces:**
- Produces:
  - `cloneSettingsRow(ctx, { sourceOutletId, targetOutletId, now, ownerStaffId, overrides }): Promise<void>` — copies the source `pos_settings` row into a new target row, applying wizard `overrides`.
  - `seedSettingsRow(ctx, { targetOutletId, now, ownerStaffId, values }): Promise<void>` — blank-mode insert from wizard values + defaults.
  - `type SettingsOverrides` — the subset of `pos_settings` fields the wizard edits.

- [ ] **Step 1: Write the failing test**

```ts
import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";

test("cloneSettingsRow copies source row + applies overrides into target", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const src = await ctx.db.insert("outlets", { code: "SRC", name: "Src", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const tgt = await ctx.db.insert("outlets", { code: "TGT", name: "Tgt", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const owner = await ctx.db.insert("staff", { name: "O", code: "O1", role: "owner", pin_hash: "x", active: true, created_at: 1 } as any);
    await ctx.db.insert("pos_settings", { founders_summary_enabled: true, receipt_business_name: "Frollie SRC", manual_bca_enabled: true, manual_bca_account_number: "111", updated_at: 1, outlet_id: src } as any);

    const { cloneSettingsRow } = await import("../lib");
    await cloneSettingsRow(ctx, { sourceOutletId: src, targetOutletId: tgt, now: 5, ownerStaffId: owner, overrides: { receipt_business_name: "Frollie TGT" } });

    const row = await ctx.db.query("pos_settings").withIndex("by_outlet", (q) => q.eq("outlet_id", tgt)).first();
    expect(row?.receipt_business_name).toBe("Frollie TGT");     // override applied
    expect(row?.manual_bca_account_number).toBe("111");          // copied from source
    expect(row?.updated_by).toBe(owner);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `convex/settings/lib.ts`**

```ts
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export type SettingsOverrides = Partial<{
  receipt_business_name: string; receipt_address: string; receipt_contact: string;
  receipt_instagram_handle: string; receipt_footer_text: string;
  manual_bca_enabled: boolean; manual_bca_bank_name: string;
  manual_bca_account_name: string; manual_bca_account_number: string;
  founders_summary_enabled: boolean; txn_ticker_enabled: boolean;
}>;

export async function cloneSettingsRow(
  ctx: MutationCtx,
  { sourceOutletId, targetOutletId, now, ownerStaffId, overrides }:
  { sourceOutletId: Id<"outlets">; targetOutletId: Id<"outlets">; now: number; ownerStaffId: Id<"staff">; overrides: SettingsOverrides },
): Promise<void> {
  const src = await ctx.db.query("pos_settings").withIndex("by_outlet", (q) => q.eq("outlet_id", sourceOutletId)).first();
  // receipt_logo_storage_id reused by value; updated_*/outlet_id replaced; founders default true.
  const base = src
    ? (() => { const { _id, _creationTime, outlet_id, updated_at, updated_by, ...rest } = src; return rest; })()
    : { founders_summary_enabled: true };
  await ctx.db.insert("pos_settings", {
    ...base, ...overrides,
    outlet_id: targetOutletId, updated_at: now, updated_by: ownerStaffId,
  } as any);
}

export async function seedSettingsRow(
  ctx: MutationCtx,
  { targetOutletId, now, ownerStaffId, values }:
  { targetOutletId: Id<"outlets">; now: number; ownerStaffId: Id<"staff">; values: SettingsOverrides },
): Promise<void> {
  await ctx.db.insert("pos_settings", {
    founders_summary_enabled: values.founders_summary_enabled ?? true,
    ...values, outlet_id: targetOutletId, updated_at: now, updated_by: ownerStaffId,
  } as any);
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit**

```bash
git add convex/settings/lib.ts convex/settings/__tests__/clone.test.ts
git commit -m "feat(settings): clone/seed per-outlet settings helpers"
```

---

## Task 4: Grant-access plain helper + refactor internal mutation onto it

**Files:**
- Create: `convex/auth/grantAccess.ts`
- Modify: `convex/auth/internal.ts` (`_grantOutletAccess_internal` calls the helper)
- Test: `convex/auth/__tests__/grant-access-helper.test.ts`

**Why:** the atomic clone mutation cannot `runMutation(_grantOutletAccess_internal)` (mutations can't call mutations). Factor the dedup+insert into a plain helper both call. The helper does NOT emit its own audit (the clone's single `outlet.created` row records `staff_granted`; the existing internal mutation keeps its own audit for the standalone grant path).

**Interfaces:**
- Produces: `grantOutletAccessRow(ctx, { staffId, outletId, grantedBy, now }): Promise<{ accessId: Id<"staff_outlet_access">; created: boolean }>` — idempotent on `by_staff_outlet`.

- [ ] **Step 1: Write the failing test**

```ts
import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";

test("grantOutletAccessRow inserts once, dedups on re-run", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outlet = await ctx.db.insert("outlets", { code: "O", name: "O", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const staff = await ctx.db.insert("staff", { name: "S", code: "S1", role: "staff", pin_hash: "x", active: true, created_at: 1 } as any);
    const { grantOutletAccessRow } = await import("../grantAccess");
    const a = await grantOutletAccessRow(ctx, { staffId: staff, outletId: outlet, grantedBy: staff, now: 5 });
    const b = await grantOutletAccessRow(ctx, { staffId: staff, outletId: outlet, grantedBy: staff, now: 6 });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.accessId).toBe(a.accessId);
    const rows = await ctx.db.query("staff_outlet_access").withIndex("by_staff_outlet", (q) => q.eq("staff_id", staff).eq("outlet_id", outlet)).collect();
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement `convex/auth/grantAccess.ts`** and refactor:

```ts
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export async function grantOutletAccessRow(
  ctx: MutationCtx,
  { staffId, outletId, grantedBy, now }: { staffId: Id<"staff">; outletId: Id<"outlets">; grantedBy: Id<"staff">; now: number },
): Promise<{ accessId: Id<"staff_outlet_access">; created: boolean }> {
  const existing = await ctx.db.query("staff_outlet_access")
    .withIndex("by_staff_outlet", (q) => q.eq("staff_id", staffId).eq("outlet_id", outletId)).first();
  if (existing) return { accessId: existing._id, created: false };
  const accessId = await ctx.db.insert("staff_outlet_access", {
    staff_id: staffId, outlet_id: outletId, granted_at: now, granted_by: grantedBy,
  });
  return { accessId, created: true };
}
```

In `convex/auth/internal.ts`, replace the dedup+insert body of `_grantOutletAccess_internal` with a call to `grantOutletAccessRow(ctx, { staffId, outletId, grantedBy, now: Date.now() })`, keeping its existing `logAudit` call afterward (only when `created`). **Do not change its args or audit behavior** — existing callers (`staff.grantOutletAccess`) must be unaffected.

- [ ] **Step 4: Run — expect PASS** (+ re-run existing auth grant tests: `npx vitest run convex/auth`)
- [ ] **Step 5: Commit**

```bash
git add convex/auth/grantAccess.ts convex/auth/internal.ts convex/auth/__tests__/grant-access-helper.test.ts
git commit -m "refactor(auth): extract grantOutletAccessRow plain helper"
```

---

## Task 5: `_createOutletAtomic_internal` mutation

**Files:**
- Create: `convex/cockpit/outlets.ts` (mutation only this task)
- Test: `convex/cockpit/__tests__/outlets.test.ts`

**Interfaces:**
- Consumes: `cloneCatalogRows` (T2), `cloneSettingsRow`/`seedSettingsRow` (T3), `grantOutletAccessRow` (T4), `logAudit`.
- Produces: `internal.cockpit.outlets._createOutletAtomic_internal` — args `{ ownerStaffId, mode, source_outlet_id?, name, code, address?, geo?, timezone, settings, staff_ids, provision_managers_chat }` → `{ outlet_id }`. Throws `OUTLET_CODE_TAKEN` (dup code, before any write) / `SOURCE_OUTLET_REQUIRED` (clone with no source). Atomic: any throw rolls back all inserts.

- [ ] **Step 1: Write the failing tests** (clone remap + skip stock/txn, blank mode, created_by, OUTLET_CODE_TAKEN, atomic rollback):

```ts
import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedSource(ctx: any) {
  const owner = await ctx.db.insert("staff", { name: "O", code: "O1", role: "owner", pin_hash: "x", active: true, created_at: 1 });
  const src = await ctx.db.insert("outlets", { code: "SRC", name: "Src", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null });
  const sku = await ctx.db.insert("pos_inventory_skus", { sku: "dubai", name: "Dubai", unit: "piece", low_threshold: 5, active: true, created_at: 1, outlet_id: src });
  const prod = await ctx.db.insert("pos_products", { sku_family: "dubai", code: "DUBAI_8PC", name: "Dubai 8pcs", pack_label: "8pcs", price_idr: 100000, active: true, sort_order: 0, tax_rate: 0, created_at: 1, updated_at: 1, outlet_id: src });
  await ctx.db.insert("pos_product_components", { product_id: prod, inventory_sku_id: sku, qty: 8, outlet_id: src });
  await ctx.db.insert("pos_settings", { founders_summary_enabled: true, receipt_business_name: "Frollie", updated_at: 1, outlet_id: src });
  // stock that must NOT be cloned:
  await ctx.db.insert("pos_stock_levels", { inventory_sku_id: sku, on_hand: 99, outlet_id: src, updated_at: 1 } as any);
  return { owner, src };
}

test("clone creates outlet with created_by, copies catalog, skips stock", async () => {
  const t = convexTest(schema);
  const { outlet_id } = await t.run(async (ctx) => {
    const { owner, src } = await seedSource(ctx);
    return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
      ownerStaffId: owner, mode: "clone", source_outlet_id: src,
      name: "Frollie Two", code: "TWO", timezone: "Asia/Jakarta",
      settings: {}, staff_ids: [], provision_managers_chat: false,
    });
  });
  await t.run(async (ctx) => {
    const o = await ctx.db.get(outlet_id);
    expect(o?.created_by).not.toBeNull();              // owner stamped
    const prods = await ctx.db.query("pos_products").withIndex("by_outlet_active_sort", (q) => q.eq("outlet_id", outlet_id)).collect();
    expect(prods.length).toBe(1);                       // catalog copied
    const stock = await ctx.db.query("pos_stock_levels").withIndex("by_outlet", (q) => q.eq("outlet_id", outlet_id) as any).collect().catch(() => []);
    expect((stock as any[]).length).toBe(0);            // stock NOT copied
  });
});

test("blank mode creates outlet + settings, no catalog", async () => {
  const t = convexTest(schema);
  const { outlet_id } = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("staff", { name: "O", code: "O1", role: "owner", pin_hash: "x", active: true, created_at: 1 } as any);
    return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
      ownerStaffId: owner, mode: "blank", name: "Blank", code: "BLK", timezone: "Asia/Jakarta",
      settings: { receipt_business_name: "Blank Co" }, staff_ids: [], provision_managers_chat: false,
    });
  });
  await t.run(async (ctx) => {
    const prods = await ctx.db.query("pos_products").withIndex("by_outlet_active_sort", (q) => q.eq("outlet_id", outlet_id)).collect();
    expect(prods.length).toBe(0);
    const s = await ctx.db.query("pos_settings").withIndex("by_outlet", (q) => q.eq("outlet_id", outlet_id)).first();
    expect(s?.receipt_business_name).toBe("Blank Co");
  });
});

test("duplicate code throws OUTLET_CODE_TAKEN, no partial outlet", async () => {
  const t = convexTest(schema);
  await expect(t.run(async (ctx) => {
    const owner = await ctx.db.insert("staff", { name: "O", code: "O1", role: "owner", pin_hash: "x", active: true, created_at: 1 } as any);
    await ctx.db.insert("outlets", { code: "DUP", name: "Existing", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
      ownerStaffId: owner, mode: "blank", name: "X", code: "DUP", timezone: "Asia/Jakarta",
      settings: {}, staff_ids: [], provision_managers_chat: false,
    });
  })).rejects.toThrow("OUTLET_CODE_TAKEN");
});
```

- [ ] **Step 2: Run — expect FAIL** (function not found). `npx vitest run convex/cockpit/__tests__/outlets.test.ts`

- [ ] **Step 3: Implement the mutation** in `convex/cockpit/outlets.ts`:

```ts
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import { cloneCatalogRows } from "../catalog/lib";
import { cloneSettingsRow, seedSettingsRow } from "../settings/lib";
import { grantOutletAccessRow } from "../auth/grantAccess";
import { logAudit } from "../audit/internal";

const settingsArg = v.object({
  receipt_business_name: v.optional(v.string()), receipt_address: v.optional(v.string()),
  receipt_contact: v.optional(v.string()), receipt_instagram_handle: v.optional(v.string()),
  receipt_footer_text: v.optional(v.string()), manual_bca_enabled: v.optional(v.boolean()),
  manual_bca_bank_name: v.optional(v.string()), manual_bca_account_name: v.optional(v.string()),
  manual_bca_account_number: v.optional(v.string()), founders_summary_enabled: v.optional(v.boolean()),
  txn_ticker_enabled: v.optional(v.boolean()),
});

export const _createOutletAtomic_internal = internalMutation({
  args: {
    ownerStaffId: v.id("staff"),
    mode: v.union(v.literal("blank"), v.literal("clone")),
    source_outlet_id: v.optional(v.id("outlets")),
    name: v.string(), code: v.string(),
    address: v.optional(v.string()),
    geo: v.optional(v.object({ lat: v.number(), lng: v.number() })),
    timezone: v.string(),
    settings: settingsArg,
    staff_ids: v.array(v.id("staff")),
    provision_managers_chat: v.boolean(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    // 1. Uniqueness re-check FIRST (clean error; atomic rollback also covers it).
    const dup = await ctx.db.query("outlets").withIndex("by_code", (q) => q.eq("code", args.code)).first();
    if (dup) throw new Error("OUTLET_CODE_TAKEN");
    if (args.mode === "clone" && !args.source_outlet_id) throw new Error("SOURCE_OUTLET_REQUIRED");

    // 2. Create the outlet row (created_by REQUIRED).
    const outlet_id = await ctx.db.insert("outlets", {
      code: args.code, name: args.name, address: args.address, geo: args.geo,
      timezone: args.timezone, active: true, created_at: now, created_by: args.ownerStaffId,
    });

    // 3. Catalog + settings.
    let counts = { skus: 0, products: 0, components: 0 };
    if (args.mode === "clone") {
      counts = await cloneCatalogRows(ctx, { sourceOutletId: args.source_outlet_id!, targetOutletId: outlet_id, now });
      await cloneSettingsRow(ctx, { sourceOutletId: args.source_outlet_id!, targetOutletId: outlet_id, now, ownerStaffId: args.ownerStaffId, overrides: args.settings });
    } else {
      await seedSettingsRow(ctx, { targetOutletId: outlet_id, now, ownerStaffId: args.ownerStaffId, values: args.settings });
    }

    // 4. Grant staff access (owner skipped — implicit).
    let granted = 0;
    for (const sid of args.staff_ids) {
      if (String(sid) === String(args.ownerStaffId)) continue;
      const r = await grantOutletAccessRow(ctx, { staffId: sid, outletId: outlet_id, grantedBy: args.ownerStaffId, now });
      if (r.created) granted++;
    }

    // 5. Audit (single row records the whole clone).
    await logAudit(ctx, {
      actor_id: args.ownerStaffId, action: "outlet.created", entity_type: "outlets",
      entity_id: outlet_id, source: "cockpit",
      metadata: { mode: args.mode, source_outlet_id: args.source_outlet_id, code: args.code, cloned_counts: counts, staff_granted: granted },
    });
    return { outlet_id };
  },
});
```

> **Note on the stock-skip test:** `pos_stock_levels` has no by-outlet query in some shapes — adjust the assertion to whatever index exists (the point is: the clone never inserts stock/movement/txn rows for the target). If `pos_stock_levels` lacks a `by_outlet` index, assert via a full `.collect()` filtered in JS.

- [ ] **Step 4: Run — expect PASS** (regen first if api types are stale: `npx convex codegen`)
- [ ] **Step 5: Commit**

```bash
git add convex/cockpit/outlets.ts convex/cockpit/__tests__/outlets.test.ts
git commit -m "feat(cockpit): _createOutletAtomic_internal — atomic clone/blank mutation"
```

---

## Task 6: `createOutlet` action + `listOutlets` + `listAssignableStaff`

**Files:**
- Modify: `convex/cockpit/outlets.ts` (append action + two queries)
- Modify: `convex/staff/internal.ts` (add `_listAssignableStaff_internal`)
- Test: `convex/cockpit/__tests__/outlets.test.ts` (append)

**Interfaces:**
- Consumes: `_createOutletAtomic_internal` (T5), `withActionCache`, `_assertCockpitSession_internal`, `requireCockpitSession`, `_listActiveOutlets_internal`.
- Produces:
  - `api.cockpit.outlets.createOutlet` (action) — args = wizard payload + `idempotencyKey`, `sessionId`; returns `{ outlet_id }`.
  - `api.cockpit.outlets.listOutlets` (query) — `{ sessionId }` → `{ _id, code, name, address?, timezone, active, created_at }[]` (all outlets, owner-gated).
  - `api.cockpit.outlets.listAssignableStaff` (query) — `{ sessionId }` → `{ _id, name, code, role }[]` (no pin_hash).

- [ ] **Step 1: Write the failing tests** (idempotent re-run; non-cockpit rejected; listOutlets returns all):

```ts
import { test, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

test("listOutlets rejects a booth session, returns all for cockpit", async () => {
  const t = convexTest(schema);
  // booth session → NOT_COCKPIT_SESSION
  const { booth } = await t.run(async (ctx) => {
    const outlet = await ctx.db.insert("outlets", { code: "A", name: "A", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const staff = await ctx.db.insert("staff", { name: "S", code: "S1", role: "staff", pin_hash: "x", active: true, created_at: 1 } as any);
    const booth = await ctx.db.insert("staff_sessions", { staff_id: staff, device_id: "d", kind: "booth", outlet_id: outlet, started_at: 1, last_active_at: 1 } as any);
    return { booth };
  });
  await expect(t.query(api.cockpit.outlets.listOutlets, { sessionId: booth })).rejects.toThrow("NOT_COCKPIT_SESSION");
});
```

(Add: cockpit session returns all outlets; `createOutlet` twice with the same `idempotencyKey` returns the same `outlet_id` and creates only one outlet; audit row `source: "cockpit"`.)

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement** — append to `convex/cockpit/outlets.ts`:

```ts
import { action, query } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { withActionCache } from "../idempotency/action";
import { requireCockpitSession } from "../auth/sessions";

export const listOutlets = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, { sessionId }) => {
    await requireCockpitSession(ctx, sessionId);
    const rows = await ctx.db.query("outlets").withIndex("by_active", (q) => q.eq("active", true)).collect();
    return rows.map((o) => ({ _id: o._id, code: o.code, name: o.name, address: o.address, timezone: o.timezone, active: o.active, created_at: o.created_at }));
  },
});

export const listAssignableStaff = query({
  args: { sessionId: v.id("staff_sessions") },
  handler: async (ctx, { sessionId }) => {
    await requireCockpitSession(ctx, sessionId);
    return ctx.runQuery(internal.staff.internal._listAssignableStaff_internal, {});
  },
});

export const createOutlet = action({
  args: {
    idempotencyKey: v.string(), sessionId: v.id("staff_sessions"),
    mode: v.union(v.literal("blank"), v.literal("clone")),
    source_outlet_id: v.optional(v.id("outlets")),
    name: v.string(), code: v.string(), address: v.optional(v.string()),
    geo: v.optional(v.object({ lat: v.number(), lng: v.number() })),
    timezone: v.string(), settings: settingsArg,
    staff_ids: v.array(v.id("staff")), provision_managers_chat: v.boolean(),
  },
  handler: async (ctx, args): Promise<{ outlet_id: string }> =>
    withActionCache<{ outlet_id: string }>(
      ctx,
      { key: args.idempotencyKey, mutationName: "cockpit.createOutlet" },
      // authCheck BEFORE cache lookup (ADR-046) — bridge cockpit assert into the node action.
      async () => { await ctx.runQuery(internal.auth.ownerInternal._assertCockpitSession_internal, { sessionId: args.sessionId }); },
      async () => {
        const { staffId } = await ctx.runQuery(internal.auth.ownerInternal._assertCockpitSession_internal, { sessionId: args.sessionId });
        return ctx.runMutation(internal.cockpit.outlets._createOutletAtomic_internal, {
          ownerStaffId: staffId, mode: args.mode, source_outlet_id: args.source_outlet_id,
          name: args.name, code: args.code, address: args.address, geo: args.geo,
          timezone: args.timezone, settings: args.settings, staff_ids: args.staff_ids,
          provision_managers_chat: args.provision_managers_chat,
        });
      },
    ),
});
```

> **Verify the `withActionCache` signature/shape against `convex/idempotency/action.ts:43` and the `createProduct` callsite (`convex/catalog/actions.ts:54`)** — match its exact argument order (the auth-before-lookup arg vs the body). Adjust the call above to the real signature. Also confirm `_assertCockpitSession_internal` returns `{ staffId }` (it does — `convex/auth/ownerInternal.ts:148`).

Add `_listAssignableStaff_internal` to `convex/staff/internal.ts`:

```ts
export const _listAssignableStaff_internal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("staff").withIndex("by_active", (q) => q.eq("active", true)).collect();
    return rows.map((s) => ({ _id: s._id, name: s.name, code: s.code, role: s.role })); // NO pin_hash
  },
});
```

> Verify `staff` has a `by_active` index; if not, use the existing active-staff reader pattern in `convex/staff/internal.ts`.

- [ ] **Step 4: Regen + run — expect PASS.** `npx convex codegen && npx vitest run convex/cockpit`
- [ ] **Step 5: Commit**

```bash
git add convex/cockpit/outlets.ts convex/staff/internal.ts convex/cockpit/__tests__/outlets.test.ts
git commit -m "feat(cockpit): createOutlet action + listOutlets/listAssignableStaff queries"
```

---

## Task 7: Cross-outlet dashboard queries

**Files:**
- Create: `convex/cockpit/dashboard.ts`
- Test: `convex/cockpit/__tests__/dashboard.test.ts`

**Interfaces:**
- Consumes: `requireCockpitSession`, `internal.outlets.internal._listActiveOutlets_internal`, `internal.transactions.internal._fetchDayWindow_internal` (`{ dayStartMs, dayEndMs, outletId }` → `DayTxn[]`), `computeDaySummary` (pure, `convex/transactions/lib.ts`), WIB day helpers (`convex/lib/time.ts`).
- Produces:
  - `api.cockpit.dashboard.consolidatedSummary` — `{ sessionId, dayMs? }` → `{ gross, txnCount, refundTotal }` (summed across all active outlets).
  - `api.cockpit.dashboard.perOutletSummary` — `{ sessionId, dayMs? }` → `{ outletId, code, name, gross, txnCount }[]`.

- [ ] **Step 1: Write the failing test** (two outlets, one paid txn each → consolidated sums both; per-outlet splits):

```ts
import { test, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
// seed 2 outlets, a cockpit owner session, one paid txn per outlet in today's WIB window;
// assert consolidatedSummary.txnCount === 2 and perOutletSummary has 2 rows.
```

> Use the existing transaction-seeding shape from `convex/transactions/__tests__/*` (paid txn with `paid_at` in the day window, `outlet_id` set). Match `computeDaySummary`'s field names by reading `convex/transactions/lib.ts`.

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement `convex/cockpit/dashboard.ts`** — fan-out over active outlets, reuse per-outlet reader:

```ts
import { query } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { requireCockpitSession } from "../auth/sessions";
import { computeDaySummary } from "../transactions/lib";
import { wibDayWindow } from "../lib/time"; // verify exact export name/shape

export const consolidatedSummary = query({
  args: { sessionId: v.id("staff_sessions"), dayMs: v.optional(v.number()) },
  handler: async (ctx, { sessionId, dayMs }) => {
    await requireCockpitSession(ctx, sessionId);
    const { dayStartMs, dayEndMs } = wibDayWindow(dayMs ?? Date.now());
    const outlets = await ctx.runQuery(internal.outlets.internal._listActiveOutlets_internal, {});
    let gross = 0, txnCount = 0, refundTotal = 0;
    for (const o of outlets) {
      const day = await ctx.runQuery(internal.transactions.internal._fetchDayWindow_internal, { dayStartMs, dayEndMs, outletId: o._id });
      const s = computeDaySummary(day);  // match returned field names
      gross += s.gross; txnCount += s.txnCount; refundTotal += s.refundTotal;
    }
    return { gross, txnCount, refundTotal };
  },
});

export const perOutletSummary = query({
  args: { sessionId: v.id("staff_sessions"), dayMs: v.optional(v.number()) },
  handler: async (ctx, { sessionId, dayMs }) => {
    await requireCockpitSession(ctx, sessionId);
    const { dayStartMs, dayEndMs } = wibDayWindow(dayMs ?? Date.now());
    const outlets = await ctx.runQuery(internal.outlets.internal._listActiveOutlets_internal, {});
    const out = [];
    for (const o of outlets) {
      const day = await ctx.runQuery(internal.transactions.internal._fetchDayWindow_internal, { dayStartMs, dayEndMs, outletId: o._id });
      const s = computeDaySummary(day);
      out.push({ outletId: o._id, code: o.code, name: o.name, gross: s.gross, txnCount: s.txnCount });
    }
    return out;
  },
});
```

> **Grounding (verify before coding):** the exact name/shape of the WIB day-window helper in `convex/lib/time.ts` and `computeDaySummary`'s return field names in `convex/transactions/lib.ts`. Adapt `gross/txnCount/refundTotal` to the real field names — do not invent.

- [ ] **Step 4: Regen + run — expect PASS.** `npx convex codegen && npx vitest run convex/cockpit`
- [ ] **Step 5: Commit**

```bash
git add convex/cockpit/dashboard.ts convex/cockpit/__tests__/dashboard.test.ts
git commit -m "feat(cockpit): cross-outlet dashboard queries (fan-out over active outlets)"
```

---

## Task 8: OutletContext + OutletSwitcher; wire into CockpitShell + keepalive

> **Build via `/frontend-design`.** This is the cockpit header chrome + outlet context.

**Files:**
- Create: `src/contexts/OutletContext.tsx`, `src/components/cockpit/OutletSwitcher.tsx`
- Modify: `src/components/layout/RootLayout.tsx` (`CockpitShell` — add `OutletProvider` + header switcher + `touchCockpitSession` keepalive)
- Modify: `src/lib/storage-keys.ts` (add `COCKPIT_CURRENT_OUTLET_KEY`)
- Test: `src/contexts/__tests__/OutletContext.test.tsx`

**Interfaces:**
- Consumes: `api.cockpit.outlets.listOutlets`, `api.auth.public.touchCockpitSession`, `useSession`.
- Produces: `useOutletContext()` → `{ outlets, currentOutletId: Id<"outlets"> | "all", setCurrentOutlet }`.

- [ ] **Step 1: Write the failing test** — context defaults to `"all"`, persists to `COCKPIT_CURRENT_OUTLET_KEY`, `setCurrentOutlet` updates + persists. (Render a probe child; mock the `listOutlets` query.)
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** — `OutletContext` (provider reads `listOutlets`, holds `currentOutletId`, persists to localStorage, default `"all"`); `OutletSwitcher` (shadcn dropdown: "All outlets" + one row per outlet). In `CockpitShell` (RootLayout.tsx:227): wrap children in `<OutletProvider>`, render `<OutletSwitcher/>` in the cockpit header, and add a keepalive effect that calls `touchCockpitSession({ idempotencyKey, sessionId })` on mount + on an interval (e.g. every 5 min) / window focus, treating any throw as "session ended → the gate redirects to /cockpit/login". Use `useReducedMotion`-guarded motion only.
- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/contexts`
- [ ] **Step 5: Commit** — `feat(cockpit): outlet context + switcher + session keepalive`

---

## Task 9: Real cockpit dashboard landing (replace placeholder)

> **Build via `/frontend-design`.**

**Files:**
- Modify: `src/routes/cockpit/index.tsx` (replace the placeholder body; keep the sign-out)
- Test: `src/routes/cockpit/__tests__/index.test.tsx` (update)

**Interfaces:**
- Consumes: `api.cockpit.dashboard.consolidatedSummary`, `api.cockpit.dashboard.perOutletSummary`, `useOutletContext`.

- [ ] **Step 1: Write the failing test** — renders the consolidated headline (gross/txn/refund) + one card per outlet from mocked queries; shows a loading state while queries are `undefined`.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** — consolidated headline (today WIB) + per-outlet cards (name, code, today's gross, txn count). Format money via `src/lib/format.ts` (`Intl.NumberFormat("id-ID")`). Empty state when no outlets. Preserve the existing logout control.
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat(cockpit): cross-outlet dashboard landing`

---

## Task 10: Outlet list page + route

> **Build via `/frontend-design`.**

**Files:**
- Create: `src/routes/cockpit/outlets/index.tsx`
- Modify: `src/router.tsx` (register `cockpit/outlets`)
- Test: `src/routes/cockpit/outlets/__tests__/index.test.tsx`

**Interfaces:** Consumes `api.cockpit.outlets.listOutlets`.

- [ ] **Step 1: Write the failing test** — renders a row per outlet (name, code, address, active) + a "New outlet" CTA linking to `/cockpit/outlets/new`.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** the list + register the lazy route in `src/router.tsx` (mirror the existing `cockpit` route registration at `router.tsx:108–109`).
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat(cockpit): outlet list page`

---

## Task 11: New-outlet wizard + route

> **Build via `/frontend-design`.** Multi-step in-component machine (no router sub-routes per step).

**Files:**
- Create: `src/routes/cockpit/outlets/new/index.tsx`
- Modify: `src/router.tsx` (register `cockpit/outlets/new` — **after** T10's router edit)
- Test: `src/routes/cockpit/outlets/new/__tests__/index.test.tsx`

**Interfaces:** Consumes `api.cockpit.outlets.listOutlets` (clone picker + code-uniqueness), `api.cockpit.outlets.listAssignableStaff`, `api.cockpit.outlets.createOutlet` (with `idempotencyKey` via `useIdempotency`).

Steps (in-component `useReducer`): 0 Mode (blank|clone, source_outlet_id) · 1 Name+code (code-uniqueness inline-validated against `listOutlets` codes; `FieldMessage` error) · 2 Address (optional) · 3 Timezone (default `Asia/Jakarta`) · 4 Bank/receipt (clone: prefill from source — note: prefill is best-effort UI; the BE clone copies settings regardless, wizard `settings` overrides) · 5 Staff access (multi-select from `listAssignableStaff`) · 6 Telegram (`provision_managers_chat` toggle → `/register` hint card) · 7 Review/Create → `createOutlet`.

- [ ] **Step 1: Write the failing test** — blank vs clone fork (step 4 prefill behavior), code-uniqueness blocks "Next" on a dup code, "Create" calls `createOutlet` with the assembled payload + idempotencyKey; on success sets outlet context + navigates to `/cockpit/outlets`.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement** the step machine + register the route in `src/router.tsx`. Inline errors via `FieldMessage` (ADR-048); brand strings as `{"…"}` (ADR-049). On success: `setCurrentOutlet(newId)` + `navigate("/cockpit/outlets")`.
- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat(cockpit): new-outlet wizard (blank/clone)`

---

## Task 12: Docs + ROADMAP/CHANGELOG

**Files:** `docs/CHANGELOG.md`, `docs/API_REFERENCE.md`, `docs/ROADMAP.md`, `CLAUDE.md`, `docs/SCHEMA.md`

- [ ] **Step 1:** `docs/CHANGELOG.md` — add the dated `v1.3.0 owner cockpit` entry (BE queries + clone + dashboard + FE switcher/dashboard/list/wizard).
- [ ] **Step 2:** `docs/API_REFERENCE.md` — document `cockpit/outlets.*` + `cockpit/dashboard.*`.
- [ ] **Step 3:** `docs/ROADMAP.md` — remove the cockpit-queries + cockpit-shell/wizard/dashboards bullets from "In flight" (shipped).
- [ ] **Step 4:** `CLAUDE.md` — add the `cockpit/` module row to the file-locations table; note `convex/cockpit/*` is the sanctioned outlet-UNSCOPED read surface.
- [ ] **Step 5:** `docs/SCHEMA.md` — confirm `outlet.created` verb + `cockpit` source (from T1) are present.
- [ ] **Step 6: Commit** — `docs: v1.3.0 owner cockpit — CHANGELOG/API_REFERENCE/ROADMAP/CLAUDE`

---

## Verify-First Checklist (confirm against real code BEFORE writing each task)

1. **`withActionCache` exact signature** (`convex/idempotency/action.ts:43`) + the `createProduct` callsite (`convex/catalog/actions.ts:54`) — match the auth-before-lookup arg order in T6. *(This is the most likely place to mis-shape the action.)*
2. **`_assertCockpitSession_internal` returns `{ staffId }`** (`convex/auth/ownerInternal.ts:148`) — used for `created_by`/`actor_id` in T6.
3. **`computeDaySummary` return field names** (`convex/transactions/lib.ts`) + the **WIB day-window helper** name/shape (`convex/lib/time.ts`) — T7 must use the real names (don't invent `gross/txnCount/refundTotal`).
4. **`staff` has a `by_active` index** for `_listAssignableStaff_internal` (T6) — else use the existing active-staff reader pattern.
5. **`pos_stock_levels` outlet query shape** for the T5 skip-assertion — adapt to whatever index exists.
6. **Cockpit gate is in `RootLayout` (`CockpitShell`, RootLayout.tsx:227) using `useSession`** — T8/T9 extend it; do NOT build `CockpitLayout`/`useOwnerSession`/`COCKPIT_SESSION_KEY` (booth+cockpit share `SESSION_KEY`).
7. **`logAudit` stringifies `metadata` internally** (takes `Record<string, unknown>`) — pass an object, not `JSON.stringify(...)` (T5).

---

## Self-Review

- **Spec coverage:** Stream A → already shipped (T8 extends the shell + keepalive); Stream B → T8; Stream C → T6 (queries) + the cockpit module; Stream D → T11; Stream E → T1–T6 (helpers + atomic mutation + action); Stream F → T7 (BE) + T9 (FE). Audit/schema changes → T1. Docs → T12. ✅ all streams mapped.
- **Type consistency:** `cloneCatalogRows`/`cloneSettingsRow`/`grantOutletAccessRow` signatures defined in T2–T4 are consumed verbatim in T5; `createOutlet`/`listOutlets`/`listAssignableStaff`/`consolidatedSummary`/`perOutletSummary` named identically across T6/T7/T8/T9/T11.
- **Placeholder scan:** every BE step ships real code; FE steps defer *visual* detail to `/frontend-design` but pin the data contract, file paths, and test assertions. The `> Grounding/verify` notes are explicit "confirm the real name" instructions, not TODOs.
