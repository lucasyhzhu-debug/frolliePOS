# Staff Review: `feat/v1.0-launch-polish` (implementation, ADR-034 lens)

**Date:** 2026-06-12
**Branch:** `feat/v1.0-launch-polish` · Base `59f52e6` · Head `3a25d23` (12 commits)
**Reviewers:** Senior engineer — deep-module / surface-API architectural review per ADR-034
**Inputs:** plan `docs/superpowers/plans/2026-06-12-v1.0-launch-polish.md`, spec `docs/superpowers/specs/2026-06-12-v1.0-launch-polish-design.md`, prior plan staffreview, ADR-034, CLAUDE.md, full diff
**Gate re-verification (this review):** `npm run typecheck` ✅ · `npm run lint` 0 errors / 5 warnings ✅ · all 4 new/changed test files pass (37/37) ✅

---

## Summary

**Module-depth verdict: net deeper.** `useIsOnline` is a genuine deepening — the Convex private-state-API feature detection, subscription wiring, and 5s polling fallback now live behind a single one-bit surface (`boolean`), consumed by two call sites (ConnDot, charge) that previously would have duplicated it. The launch-catalog seed lands in the right module (`seed/`, the lint-ALLOWLISTed data-population crosscut, mirroring `_bootstrapCommit_internal`'s one-shot-guard idiom) and creates **no graft hazard** — it is run-once bootstrap *data*, not a contract; the product/SKU codes it mints (`DUBAI_1PC`…`WATER_1BTL`, `DUBAI`, `WATER`) conform to ADR-034's stable-string-ID formats that the future `/api/v1/` surface will expose. The single architectural erosion is that the seed re-introduces a **third raw writer** of `pos_inventory_skus`/`pos_products`, bypassing the canonical `insertInventorySku` helper that v0.5.5 created precisely to stop multi-writer row-shape drift (and which the v0.5.7 retro flagged as "sweep ALL writers — 3rd writer in seed/").

Plan fidelity is high: Tasks 1–7 landed essentially verbatim, with three deviations — all sound, two fully documented, one leaving stale references behind:

| Deviation | Sound? | Documented? |
|---|---|---|
| Offline-gating extended beyond the plan's four controls to the approval-request buttons (commit `45ed0c1`) | ✅ — `requestManualPaymentApproval` writes `pos_approval_requests` + sends Telegram; it is a server action and belongs behind the same gate | ✅ CHANGELOG names all five surfaces |
| RUNBOOK §7 → §8 (file already had a §7) | ✅ — correct renumber | ⚠️ CHANGELOG says §8 ✅, but plan Task 9 + PROGRESS task still say §7/§7.7 (see I-3) |
| `_seedLaunchCatalog_internal` replacing RUNBOOK §8.7's manual SKU/product entry (user-requested mid-phase) | ✅ — guard refuses on any pre-existing catalog row; transactional so partial seed is impossible; tested 6 ways | ⚠️ CHANGELOG + runbook ✅, but no SCHEMA.md audit verb and no PROGRESS task (see I-1, I-2) |

No Critical issues. The money path is untouched, as the spec demanded.

---

## Critical Issues

None.

- Money path (commit funnel, webhook, refund funnel) untouched — verified by diff scope.
- Seed guard semantics on prod are correct-fail: any pre-existing `pos_products` **or** `pos_inventory_skus` row aborts with `catalog_already_populated` (commit `3dca212` widened a products-only check — the partial-seed dupe hazard was caught in-branch). Convex mutation transactionality means a mid-run throw rolls back everything, so the guard's two-table check is sufficient; orphaned components/levels cannot exist without their parent rows.
- `_seedLaunchCatalog_internal` is an `internalMutation` (CLI-only via deploy key), correctly outside the client surface; rule #20 (idempotencyKey) applies to public mutations only, and the guard provides natural at-most-once semantics.

---

## Improvements

### I-1 — New audit verb `seed.launch_catalog` is not documented in `docs/SCHEMA.md`
CLAUDE.md "How to add a feature" #4: every new `logAudit` verb is documented in SCHEMA.md's audit-verb list. `seed.reset` (SCHEMA.md:626) and `staff.bootstrapped` (:697) are listed; `seed.launch_catalog` is not. Mechanical fix — add the verb in this PR.

### I-2 — Seed task missing from `docs/PROGRESS.md` (mandatory mid-phase workflow #5)
The v1.0 phase block explicitly states *"no backend tasks — the polish slice is frontend-only"* (PROGRESS.md:1848), which the seed falsifies. CLAUDE.md mandates `/progress-update <id> --new-task` for mid-phase additions. Add e.g. `v10-be-launch-catalog-seed` during the Task 9 Step 7 reconciliation at the latest — but doing it pre-merge keeps the tracker truthful for the launch-day readers it exists for.

### I-3 — Stale §7.x references in the live launch checklist (plan Task 9) after the §8 renumber
Plan Task 9 Step 5 instructs Lucas to seed *"following RUNBOOK §7.7 order"* and Step 7 cites *"§7.3"*; the PROGRESS task `v10-xc-runbook-booth-ops` title also says "§7". Task 9 is the **not-yet-executed human-in-loop launch document** — its references now point at a section that doesn't exist (§7.7 in RUNBOOK.md is the prod-deploy section's tail, not booth ops). Also: Task 9 Step 5 still describes the superseded *manual* seeding flow, not the seed command. One small amendment note in the plan (or in the handoff prompt for the launch session) closes both.

### I-4 — Third raw writer of `pos_inventory_skus`/`pos_products` bypasses the v0.5.5 canonical insert helper
`catalog/internal.ts:173` `insertInventorySku` exists so *"the row shape … lives in one place and can't drift when the table gains a column"* — both catalog write paths funnel through it. `_seedLaunchCatalog_internal` (and the pre-existing dev `seed:reset`) hand-roll the same insert. The ESLint module-boundary ALLOWLIST sanctions seed's table access, but the v0.5.1a lesson applies: *the allowlist is a tax, not a free pass* — lint exemption doesn't exempt the drift hazard the helper was built to kill (v0.5.7 retro: "single-writer refactor must sweep ALL writers — 3rd writer in seed/"). Recommended: export `insertInventorySku` from `catalog/internal.ts` and import it as a plain helper from both seed writers (the `logAudit` plain-function pattern, ADR-034 §Cross-module patterns #1). The launchCatalog tests pin today's shape, which mitigates but doesn't prevent silent column-miss on a future schema change. Acceptable to defer to v1.0.1 given the seed is one-shot launch-day code — but log it if deferred.

---

## Refinements

### R-1 — Seed's explicit `pos_stock_levels` rows at 0 diverge from the documented lazy-init pattern
`_createInventorySkuCommit_internal` deliberately writes **no** stock-level row — *"`upsertStockLevel` lazy-inits on first movement; all reads default absent rows to 0"* (catalog/internal.ts:204). The launch seed inserts two `on_hand: 0` rows that the lazy-init would have produced identically. Harmless (drift recon computes expected-from-movements = 0, no false drift) but they are dead writes per the v0.5.2 lesson, and a second answer to "who creates stock-level rows?". Dropping the two inserts simplifies.

### R-2 — Two catalogs with colliding stable codes at different prices now live in one file
`seed:reset` (dev) defines `DUBAI_8PC` at Rp 340.000 / pack `"8 pcs"`; `_seedLaunchCatalog_internal` (prod) defines `DUBAI_8PC` at Rp 320.000 / pack `"Eight"`. Codes are ADR-034 *immutable post-creation* identifiers — same code, two prices in source is a confusion magnet for future readers (and for any v1.1 Frollie Pro sync that keys on `productCode`). A one-line comment on each defs block ("dev fixture ≠ launch catalog; prod truth is the DB after launch day") is enough; aligning the dev fixture to launch prices is optional and would touch e2e expectations.

### R-3 — `skuIds: Record<string, any>` in the seed
Could be `Record<string, Id<"pos_inventory_skus">>` (the import already exists in the file). `no-explicit-any` is off in this repo so lint passes, but the typed version is free.

### R-4 — Offline banner renders only in the `phase.kind === "showing"` branch
During `creating`/error phases an offline user gets the failure toast rather than the banner. Within audit scope (the audited gap was the awaiting-payment screen) and the toast path already surfaces the error — note for the v1.0.1 full-route pass.

### R-5 — `useIsOnline` re-render and polling characteristics (reviewed, acceptable)
Each consumer instantiates its own listener/interval (2 consumers today). On the `onStateChange` path, `setOnline(sameBoolean)` bails out of re-render, so connection-state chatter doesn't fan out; the 5s polling fallback only activates on clients lacking the 1.31+ state API and was the pre-existing ConnDot trade-off, now centralized — a strict improvement (one place to fix when the Convex API moves). Initial `true` default means a one-paint optimistic flash when mounting offline; ADR-025's "block with clear UI" intent is met within one effect tick. The voucher-fallback test's `useConvex` mock needed `onStateChange` added — the only ripple, contained.

### R-6 — ESLint ignores for `.claude/**` and `tools/stub-canvas/**`
Justified (vendored browser-runtime skill JS + CJS stub), comment-documented in the config, consistent with the existing `packages/**`/`docs/**` entries. No app code escapes the lint surface.

---

## Plan-fidelity table (Tasks 1–7)

| Task | Landed | Notes |
|---|---|---|
| 1 audit doc | ✅ `docs/reviews/v1.0-launch-audit-2026-06-12.md` | Plus a gate-confirmation section with e2e/vitest evidence — exceeds plan |
| 2 `useIsOnline` | ✅ verbatim | Tests *hardened* beyond plan (polling path, unmount cleanup, mock reset) |
| 3 charge offline guard | ✅ + extension | All four planned controls + approval-request buttons; truthful online-side assertions added |
| 4 `/stock` empty state | ✅ verbatim | Rows branch byte-identical (spoilage e2e guard honored) |
| 5 home-tile cleanup | ✅ verbatim | Tile, route, lazy import, comment, stub file all removed |
| 6 runbook | ✅ as §8 | Renumber correct; §8.7 step 1 swapped to the seed command (documented deviation) |
| 7 CHANGELOG + gate | ✅ | Entry updated to reflect both deviations; gate evidence recorded in audit doc |
| — seed (unplanned) | ✅ | User-requested; see I-1/I-2/I-4 for the paperwork + drift follow-ups |

Task 8 (triple-review / simplify / merge) is in flight — this review is part of that pipeline; commits `3dca212` and `45ed0c1` already show in-branch review-driven hardening.

## Graft-integrity verdict

Clean. The code-resident catalog is acceptable for v1: it is a dated, one-shot, guard-inert-after-first-run data fixture; ongoing catalog truth lives in the DB and changes flow through `/mgr/products` (runbook §8.7 step 2). It mints ADR-034-conformant stable string IDs and creates no schema coupling, no new external surface, and no assumption the v1.1+ `products` sync would have to unwind. The only Frollie-Pro-adjacent caution is R-2 (code/price divergence between dev fixture and launch catalog under the same immutable `productCode`s).

---

*Generated by /staffreview (implementation pass)*
