# Staff Review: v0.6 design spec (vouchers + spoilage + stock-recon + Playwright)

**Date:** 2026-06-02
**Plan:** `docs/superpowers/specs/2026-06-02-v0.6-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated — spec follows the established v0.5.3c shape (goal / shipped-already grounding / locked Q-table / architecture overview / per-subsystem backend+frontend / data flow / access & correctness / naming guard / testing / success criteria / open items). One adaptation: this is a *spec*, not a *plan* — Wave ordering is intentionally deferred to writing-plans (Open Item, last bullet), which matches the pipeline gate.

---

## 1. Summary

**Overall Assessment:** **Revise** *(2 Critical, 4 Improvement, 2 Refinement — all crisp, mechanical fixes; no architectural rework)*

The spec is well-grounded against `origin/main` (the "What is already shipped" table is real-code accurate) and decomposes a multi-subsystem phase cleanly. Two **Critical** corrections must be made before writing the plan: (a) the `verifyManagerPinOrThrow` signature in the spec is wrong — the real helper requires `idempotencyKey` and takes a single params object, not positional args — so every `createVoucher`/`recordSpoilage` snippet in the plan would compile-error without correction; (b) the spec proposes `crypto.randomUUID()` for spoilage_event_id, which is not portable across the V8/Node action runtime split per `convex/lib/tokens.ts`'s explicit comment — must use `mintUrlSafeToken` or its primitive. Four **Improvements** clean up naming alignment with `docs/SCHEMA.md` and patch missing-helper assumptions. Once these land inline, the spec is plan-ready.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `verifyManagerPinOrThrow` signature mismatch — spec call sites would not compile | Logic / Implementation | "Backend — Vouchers" §createVoucher; "Backend — Spoilage" §recordSpoilage |
| 2 | `crypto.randomUUID()` for `spoilage_event_id` is not portable across Convex V8 / Node action bundling | Implementation | "Open items §Spoilage" + implied in §recordSpoilage |

### Issue 1: `verifyManagerPinOrThrow` signature

The spec describes the manager-PIN funnel call as `verifyManagerPinOrThrow(ctx, sessionId, managerPin)` (e.g. under "Backend — Vouchers" §createVoucher and Open Items §Vouchers point 2). The actual signature in `convex/auth/verifyPin.ts:67-93` is:

```ts
verifyManagerPinOrThrow(
  ctx: ActionCtx,
  params: { sessionId: Id<"staff_sessions">; managerPin: string; idempotencyKey: string },
): Promise<{ managerId: Id<"staff">; deviceId: string }>
```

Key differences:
- **One params object**, not three positional args.
- **Requires `idempotencyKey`** — used internally to derive `${idempotencyKey}:failed` for crash-safe failed-attempt recording (verifyPin.ts:49).
- **Returns `{managerId, deviceId}`** — the action should use both for audit attribution (`actor_id: managerId`, `device_id: deviceId` per booth-inline audit pattern, e.g. `convex/catalog/public.ts:138`).

The spec also asserts in Open Items §Vouchers: *"the spec assumes it takes `(ctx, sessionId, pin)` and throws on mismatch; the v0.5.3b admin-actions plan defined it but signatures can drift"* — confirming the spec author already knew this needed verification. Now verified: **the assumption is wrong**.

**Recommendation:** Inline-edit the spec wherever `verifyManagerPinOrThrow` is invoked:
- Update §createVoucher call shape to `await verifyManagerPinOrThrow(ctx, { sessionId, managerPin, idempotencyKey })`.
- Update §recordSpoilage same way.
- Note in §createVoucher that the returned `{managerId, deviceId}` should be threaded into both `_createVoucher_internal` (as `created_by_staff_id`) and the audit row (as `actor_id` + `device_id`).
- Update Open Items §Vouchers bullet 2 to "✅ verified — see staffreview" so it's not re-litigated at plan time.

### Issue 2: `crypto.randomUUID()` not portable across V8 / Node bundling

The spec proposes minting `spoilage_event_id` via `crypto.randomUUID()` (§Spoilage backend, "Mints spoilage_event_id server-side (Convex env is V8 — use crypto.randomUUID() per existing tokens.ts pattern; if action runs in Node, use Node's randomUUID)").

This is the **opposite** of what `convex/lib/tokens.ts:1-13` documents:

> *"Implemented with Web Crypto (globalThis.crypto.getRandomValues) so the module is safe to bundle in BOTH the Convex V8 runtime AND "use node" actions. The earlier `node:crypto.randomBytes` implementation broke `npx convex codegen` because Convex statically bundles every module under V8 first, and `node:crypto` is unresolvable there."*

`crypto.randomUUID()` lives in the same Web Crypto namespace and **is available** under Convex V8 — so it works for V8 mutations — but the `recordSpoilage` action is `"use node"` (the spec puts it in `convex/inventory/actions.ts` because verifyManagerPinOrThrow needs argon2 via hash-wasm, which the existing pattern keeps in `"use node"` actions). Under bundling, `crypto.randomUUID` is the same global as in V8, BUT the cleaner precedent — and the one that documents the bundling gotcha — is `mintUrlSafeToken` in `convex/lib/tokens.ts:53`.

There is no need for a UUID-shape specifically. A `mintUrlSafeToken(16)` value (22 base64url chars, 128 bits of entropy) is at least as good a grouping key, comes from the existing helper, and dodges the question entirely.

**Recommendation:** Replace `crypto.randomUUID()` references in the spec with `mintUrlSafeToken(16)`. The schema field stays `spoilage_event_id: v.optional(v.string())` — the value is just an opaque grouping token, not a parsable UUID. Update the Open Items §Spoilage `randomUUID` bullet to "✅ resolved — use mintUrlSafeToken(16) per convex/lib/tokens.ts." Document the byte count once in the writer comment.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Voucher + spoilage audit verbs diverge from `docs/SCHEMA.md` preview | H | L |
| 2 | Missing internal helpers assumed: `catalog._getActiveSkus_internal`, `transactions._fetchReceiptByTxnIds_internal` | H | L |
| 3 | ADR number 043 collides with v0.5.3c — coordinate explicit numbering now | M | L |
| 4 | Cron concurrency window: 02:00 WIB is fine, but document the band so v0.7+ doesn't pile on | L | L |

### Improvement 1: Audit-verb naming alignment with SCHEMA.md preview

`docs/SCHEMA.md:609-622` already documents reserved verbs for v0.6:

```
stock.received
stock.adjusted
stock.spoilage          ← single verb, not two
stock.returned
...
voucher.created         ← matches spec ✓
voucher.edited          ← spec proposes voucher.updated_meta
voucher.deactivated     ← spec proposes voucher.archived
```

The spec's reasoning for two-verb spoilage (`stock.spoilage_recorded` + `stock.spoilage_line`) is the v0.5.1b lesson on separating "approval-row state transitions" from "underlying writer commits" — a real lesson that earned the verb-split for refunds. BUT for spoilage the booth-inline path has **no approval row** (PIN at the booth, direct write), so the separation is less load-bearing. A simpler `stock.spoilage` (one per event) with `metadata.lines` carrying the per-line breakdown matches SCHEMA.md's preview and is one less verb to invent.

For vouchers: `voucher.updated_meta` vs documented `voucher.edited` and `voucher.archived` vs documented `voucher.deactivated` are pure naming. Either choice works.

**Recommendation:** Pick one and align. Two options:

**Option A — align spec to SCHEMA.md preview:**
- `voucher.updated_meta` → `voucher.edited`
- `voucher.archived` → `voucher.deactivated`
- `stock.spoilage_recorded` + `stock.spoilage_line` → `stock.spoilage` (single verb, lines in metadata)

**Option B — keep spec verbs, update SCHEMA.md preview** (since SCHEMA.md is descriptive, not prescriptive; spec author explicitly cites the v0.5.3b lesson "no code enum, just SCHEMA.md doc" per rule #4).

**Lean Option A** — `voucher.edited` and `voucher.deactivated` are crisper and match precedent (`product.archived` exists at `convex/catalog/public.ts:281`; `voucher.deactivated` is a closer fit for the same concept here). The single-verb `stock.spoilage` is simpler and matches the documented preview. Whichever option chosen, **the verb list section of the spec and SCHEMA.md must agree** before writing the plan — silent divergence is the v0.5.3b lesson the spec author cited.

### Improvement 2: Missing internal helpers assumed

The spec references two helpers that do not exist:

- **`catalog._getActiveSkus_internal`** (referenced under "Nightly stock-reconciliation §Backend"): no grep hit anywhere in `convex/`. The recon needs to iterate active SKUs; the existing `inventory.public.getStockLevels` reads them but as `Record<id, on_hand>`. **Options:**
  - **Add it:** trivial — one new `internalQuery` in `convex/catalog/internal.ts` (`pos_inventory_skus` is owned by *catalog* per ADR-034 per `convex/catalog/public.ts:43-46` direct access, **not** by inventory — verify at plan time and place accordingly).
  - **Reuse `getStockLevels`:** read its `Record<id, on_hand>`, iterate the keys. Less explicit, and the recon also needs `sku_code` for the drift_log snapshot — so a dedicated `_getActiveSkus_internal` returning `Array<{_id, code}>` is cleaner.
  - **Lean:** add the helper. One file, one query, six lines.

- **`transactions._fetchReceiptByTxnIds_internal`** (referenced under "Backend — Vouchers §getVoucherRedemptions"): no grep hit. Used to annotate redemption history with the receipt number for the manager UI's deep-link.
  - **Options:** add the helper, OR change the UI to query each txn lazily on row expansion (no helper needed; slower for N redemptions but trivial here — N ≤ `limit` ≤ 500).
  - **Lean:** add the helper — manager UI gets a clean payload, no per-row lazy queries.

**Recommendation:** Update the spec's "Open items to resolve in writing-plans" section to explicitly call out these two helpers as **must-add** at plan time, with the recommended placement (`catalog/internal.ts` and `transactions/internal.ts`). Remove the "if not present" wishful phrasing.

### Improvement 3: ADR number coordination with v0.5.3c

Both the v0.5.3c settlements spec (`docs/superpowers/specs/2026-06-02-v0.5.3c-settlements-design.md:236`) and this v0.6 spec (§"v0.6 ADR" + Open Items §"Nightly recon" bullet 1) claim **ADR-043**. ADRs are sequential — first-to-merge wins.

v0.5.3c is further along the pipeline (spec + plan both on `main` per commit `ac2ada0` per the recent git log); v0.6 is at spec stage in this worktree. Operationally v0.5.3c will land first.

**Recommendation:** Lock the numbering in this spec now: **v0.5.3c → ADR-043 (settlements); v0.6 → ADR-044 (stock recon).** Update §Q15 and Open Items §Nightly recon bullet 1 to reflect ADR-044. This avoids a write-time collision when the v0.5.3c plan executes and writes its ADR before v0.6's writing-plans starts.

### Improvement 4: Document the cron-time band convention

The spec's cron registration at 02:00 WIB / 19:00 UTC slots in cleanly between existing crons (per `convex/crons.ts`):
- 22:00 WIB / 15:00 UTC — founders-shift-summary
- 02:00 WIB / 19:00 UTC — **stock-recon (new)**
- 03:00 WIB / 20:00 UTC — telegram-updates-purge
- 03:05 WIB / 20:05 UTC — telegram-log-purge
- 09:00 WIB / 02:00 UTC — settlement-recon (per v0.5.3c spec)

So v0.6's choice is fine. **But** the spec does not document the policy of *why* these times are spaced as they are (avoid business-hour booth load + avoid same-minute conflicts). v0.7+ will pile on more crons without this guidance.

**Recommendation:** Add one line under §Crons noting the convention: *"Crons live in the 19:00–05:00 UTC band (booth closed); each new cron picks a 5+ minute offset from existing entries to avoid the resilient-cron concurrency budget overlapping."* This isn't blocking — but the spec already documents adjacency policies elsewhere, and this is a cheap insurance line.

## 4. Refinements (Optional)

- **R1.** Open Items §Spoilage bullet on `pos_stock_movements.spoilage_event_id` indexing: spec leans "no index needed (queried by audit drilldown, not by event_id filter)." This is correct *today* — but the manager UI's "spoilage event detail" view (if added) would group movements by event_id and benefit from `by_event` indexed lookup. The current spec doesn't plan that view; if added later, the index becomes a follow-up. Note it in the schema comment so a future reader doesn't add the index speculatively.
- **R2.** Playwright spec for `voucher-offline.spec.ts` describes "kill network (`page.context().setOffline(true)`)" — verify that Convex's WebSocket reconnects predictably after `setOffline(false)` in test contexts. If reconnect timing is flaky, the spec may need a `waitFor` on a sentinel query before commit. Note as a test-stability watch-item, not a blocker.

## 5. Duplication Analysis

### Existing code to leverage

| Code | Location | How to use |
|------|----------|------------|
| `verifyManagerPinOrThrow` funnel | `convex/auth/verifyPin.ts:67` | createVoucher + recordSpoilage actions; pass `idempotencyKey`, use returned `{managerId, deviceId}` |
| `mintUrlSafeToken` | `convex/lib/tokens.ts:53` | spoilage_event_id (replace randomUUID) |
| `computeVoucherDiscount` | `convex/lib/voucher.ts:10` | shared between BE `validateVoucher` + FE `lib/voucher-validate.ts` (confirmed V8-safe — pure function) |
| `sendFoundersSummaryResilient` shape | `convex/telegram/foundersSummary.ts:52` | `sendStockReconResilient` direct port — same cronRetry / transient-check / audited-skip skeleton |
| `withIdempotency` + `authCheck` dual-call | `docs/PATTERNS/idempotency-dual-call-authcheck.md` + `convex/catalog/public.ts:163` | All new mutations (updateVoucherMeta, archiveVoucher, resolveDrift) |
| Action-level idempotency cache | `convex/auth/actions.ts:63-78` | createVoucher + recordSpoilage actions |
| Per-kind approval flow (request + approve + deny) | `convex/approvals/actions.ts` (refund/manual-payment precedent) | requestSpoilageApproval + approveSpoilage |
| Catalog admin route IA | `src/routes/mgr/products.tsx` | `/mgr/vouchers` direct port (per spec §Frontend — already noted) |
| `useCatalogCache` payload reuse | `src/hooks/useCatalogCache.ts` + `convex/catalog/public.ts:36` | Voucher offline cache already there — FE just needs to consume `.vouchers` |
| `_fetchDayWindow_internal` (v0.5.3a) | `convex/transactions/internal.ts` | Available if any spoilage/recon reporting needs date-windowed transaction reads (not currently planned, but available) |

### Potential duplication risks

- **None significant.** The spec is explicit about reuse. The one risk is: if Improvement 2 (add `_getActiveSkus_internal` to catalog) is skipped and the spec defaults to direct `pos_inventory_skus` reads from `inventory/internal.ts`, that would cross the catalog↔inventory module boundary in violation of ADR-034. The plan must place the helper in `catalog/internal.ts` per the table's true owner.

## 6. Phase / Wave Accuracy

Spec defers wave ordering to writing-plans (Open Items, last bullet) — that's correct per the pipeline gate. The spec's lean is sound:

| Wave | Subsystem | Notes |
|------|-----------|-------|
| 1 | Vouchers (4 backend + 3 FE, parallel) | Touches transactions.commitCart return type — coordinate test fixture update |
| 2 | Spoilage (5 backend + 1 FE, parallel) | New approval kind = 4-touchpoint propagation per CLAUDE.md #8 — make this a checklist subtask |
| 3 | Nightly recon (4 backend + 1 FE, parallel) | Independent — could run before Wave 2 if convenient |
| 4 | Playwright | **Must run last** — specs target the surfaces Waves 1-3 ship |

**Ordering issues:** Wave 4 dependency on Waves 1-3 is correct. **No missing phases.**

## 7. Specialist Agent Recommendations

| Wave | Recommended Agent | Rationale |
|------|-------------------|-----------|
| Wave 1 BE (vouchers actions+mutations) | `convex-expert` | Action+mutation+idempotency funnel territory |
| Wave 1 FE (`mgr/vouchers.tsx`, cart fallback, banner) | `frontend-integrator` (or `ui-component-builder` for the new manager route alone) | Direct mgr/products.tsx pattern reuse |
| Wave 2 BE (spoilage approval kind + writer + actions) | `convex-expert` | Approval-kind 4-touchpoint + cross-module audit threading |
| Wave 2 FE (`mgr/spoilage.tsx` + `/approve` variant) | `ui-component-builder` | New form-heavy route |
| Wave 3 BE (recon cron + drift log + lib) | `convex-expert` | Cron + new table + resilient action |
| Wave 3 FE (drift log tab on `/mgr/stock`) | `frontend-integrator` | Extends existing route |
| Wave 4 Playwright | `general-purpose` | First-time Playwright integration; no specialized E2E agent in roster — general-purpose handles tooling install + spec authoring |

All agents above appear in the project roster per CLAUDE.md PROGRESS lane-agent guidance + the global agent list.

## 8. Git Workflow Assessment

### Branch & merge strategy

| Check | Status |
|-------|--------|
| Feature branch specified | ✅ (this worktree's branch + pipeline squash-PR convention) |
| Branch naming follows convention | ✅ — worktree name `plan-v0.6a-vouchers` (legacy from pre-bundle) is harmless; PR title carries v0.6 |
| Merge strategy documented | ✅ — squash-PR per repo convention (ship-it memory; CLAUDE.md PR-branch skill) |

### Commit checkpoints (recommended for the implementation phase, not for this spec PR)

1. After voucher BE land → `feat(vouchers): manager CRUD + commit-time reject signal`
2. After voucher FE land → `feat(vouchers): /mgr/vouchers + offline-apply banner`
3. After spoilage approval-kind plumbing → `feat(spoilage): add spoilage kind to APPROVAL_KINDS`
4. After spoilage writer + actions → `feat(spoilage): recordSpoilage + Telegram approval path`
5. After spoilage FE → `feat(spoilage): /mgr/spoilage entry route`
6. After recon BE → `feat(stock-recon): nightly cron + drift log`
7. After recon FE → `feat(stock-recon): /mgr/stock drift tab`
8. After Playwright install → `chore(e2e): install Playwright + config`
9. After Playwright specs → `test(e2e): 7-spec golden-path suite`
10. After ADR + docs → `docs: ADR-044 + SCHEMA + CHANGELOG for v0.6`

### Pre-push verification

- [x] `npm run typecheck` — required (CLAUDE.md commands)
- [x] `npm run build` — required
- [x] `npm run lint` — required (catches the strict-idempotency CI gate via `tools/ci/assert-strict-idempotency-rule.sh`)
- [x] `npm run test` (vitest) — required
- [ ] `npm run test:e2e` — once Playwright lands

### CI/CD & rollback

| Concern | Status |
|---------|--------|
| Rollback strategy | ✅ documented (spec §Success criteria & rollback — additive, no destructive migrations) |
| Deployment order | ✅ correct (BE before FE; cron registration arrives in BE deploy) |
| Data backup needed | No — schema additions are optional fields + a new table; no destructive changes |
| Migration safety | ✅ safe — optional fields on `pos_stock_movements` preserve existing rows; new `pos_stock_drift_log` is greenfield |

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Vouchers backend | SCHEMA.md (verb list reconciliation per Improvement 1), CLAUDE.md `business-rules-22` (v0.6 additions row) |
| Spoilage backend | SCHEMA.md (new `pos_stock_movements` fields + new verbs), CLAUDE.md §Telegram (new template kind) |
| Recon backend | SCHEMA.md (new `pos_stock_drift_log` table + new verbs), ADR-044, CLAUDE.md §crons |
| Playwright | docs/RUNBOOK additions (running e2e locally + CI), package.json scripts, README.md install steps |
| All | docs/CHANGELOG.md |

### CHANGELOG draft

```markdown
## 2026-XX-XX — v0.6 (vouchers + spoilage + nightly stock-recon + Playwright E2E)

### Added
- Manager portal `/mgr/vouchers`: create voucher (manager-PIN), edit meta (active/expiry/min_cart/max_redemptions), deactivate (session), redemption history per code.
- ADR-009 offline-apply reject banner: `commitCart` now returns `voucher_rejected?: {code, reason}` when server-side re-validation drops the voucher; charge screen surfaces it.
- Shared `lib/voucher-validate.ts` for online/offline parity.
- Manager portal `/mgr/spoilage`: log spoilage at the booth (manager-PIN, multi-line) or off-booth via Telegram URL-button approval (new `spoilage` APPROVAL_KIND).
- `pos_stock_movements.spoilage_reason?` + `spoilage_event_id?` (optional fields, only populated for source:"spoilage").
- Nightly `stock-recon` cron at 02:00 WIB: rebuilds `pos_stock_levels.on_hand` from the `pos_stock_movements` ledger; on drift, audits + appends to new `pos_stock_drift_log` table + alerts the `inventory` Telegram role. **Report-only** — no silent cache correction (ADR-044).
- Manager portal "Drift log" tab on `/mgr/stock` with "Mark resolved" action.
- First Playwright E2E suite: 7 specs covering auth, sale (QRIS + BCA VA), refund, vouchers (online + offline), spoilage.

### Changed
- `transactions.commitCart` return type — additive `voucher_rejected?` field (existing destructured callers unaffected).
- `convex/audit/schema.ts` — new audit verbs (see SCHEMA.md verb list).

### Docs
- ADR-044 (nightly stock reconciliation: ledger is truth, drift reported not corrected).
- CLAUDE.md business-rules-22 updated for v0.6 admin-tier additions.
- SCHEMA.md updated for new fields + verbs + table.
```

## 10. Testing Plan Assessment

**Verdict:** **Adequate** — coverage spec is thorough and concrete; both happy-path and rejection paths are named per surface; the Playwright suite explicitly targets the surfaces this phase ships.

### Planned tests

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| BE unit | `lib/voucher-validate.ts` reason paths | vitest | planned |
| BE unit | `createVoucher` validators | vitest | planned |
| BE unit | `validateContext("spoilage")` cross-check | vitest | planned |
| BE unit | `inventory/lib.ts` (reconstructOnHand, computeDrift) | vitest | planned |
| BE integration | Voucher CRUD (auth + happy + replay) | convex-test | planned |
| BE integration | commitCart rejection signal (3 reasons) | convex-test | planned |
| BE integration | Spoilage booth + off-booth (writer parity) | convex-test | planned |
| BE integration | `_runStockRecon_internal` + resilient action | convex-test | planned |
| BE integration | Drift resolution + audit | convex-test | planned |
| FE | `mgr/vouchers.tsx` smoke + manager-redirect | vitest + RTL | planned (implied by mgr/products.tsx precedent) |
| FE | `mgr/spoilage.tsx` smoke + PinSheet wiring | vitest + RTL | planned (implied) |
| FE | sale/voucher.tsx cached-fallback | vitest + RTL | planned (Change V2 implies) |
| E2E | 7-spec Chromium mobile suite | Playwright | planned (Wave 4) |

### Missing test coverage (must add at plan time)

| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | `commitCart` `voucher_rejected` test exercises `archiveVoucher`-during-cart-build sequence | The spec describes the EXPIRED + INACTIVE + MIN_CART_VALUE reasons in prose; need a test asserting each value path | One test per reason path; mock `Date.now()` for EXPIRED |
| 2 | `_redeemVoucher_internal` race (regression) under `max_redemptions:1` | Spec marks as "confirm at plan time and add only if missing"; verify before assuming | Grep `convex/vouchers/__tests__/` at plan time; add if absent |
| 3 | `recordSpoilage` action-level idempotency replay returns cached `{event_id, line_count}` without re-inserting | Spec says "Idempotency at the action layer" but the replay path needs a test | Mirror `auth/actions:resetStaffPin` test pattern |
| 4 | Cron `sendStockReconResilient` transient-error retry counted but doesn't double-send Telegram alert | Resilient wrapper edge — mirrors v0.4 foundersSummary lesson | Mock cronRetry; assert single send |
| 5 | Telegram template wiring: `kind:"stock_drift_alert"` payload validator + render output stability | Per the v0.4 lesson on stale `as { ... }` casts | Render the HTML against a fixture, snapshot-test |

### Test execution checkpoints

1. After Wave 1 BE: BE unit + integration green
2. After Wave 1 FE: FE smoke green
3. After Wave 2 BE+FE: spoilage integration + smoke
4. After Wave 3 BE+FE: recon integration + smoke
5. After Wave 4: full Playwright suite + full vitest suite locally + CI

### Regression risk

- **`convex/transactions/__tests__/commitCart.test.ts`** — the additive `voucher_rejected?` field is back-compat for destructuring callers, but any test that does a structural-equality on the full return shape will fail. Update fixtures.
- **`convex/refunds/__tests__/voucher-math.test.ts`** — ADR-040 math is unchanged; this test should not regress. Smoke-run as a sanity check.
- **`src/routes/sale/voucher.tsx`** — adding cached fallback changes the loading/disabled-button states. Component tests should re-render under offline mode and assert the fallback path activates.

## 11. Edge Cases to Address

- [ ] Voucher race: `createVoucher` collides with another active voucher of the same code (uniqueness check is server-side via `_getVoucherByCode_internal` BEFORE insert — confirm the timing window can't be raced by two concurrent action calls).
- [ ] `updateVoucherMeta` clears `expires_at` (sets back to undefined) — does the API surface allow `null` to mean "remove"? Spec is silent.
- [ ] Spoilage `lines.length === 0` — spec leans reject; encode in test (also flagged in Open Items §Spoilage).
- [ ] Spoilage with `qty > on_hand` (over-spoiling, pushing on_hand negative) — this is allowed per ADR-018 spirit (flag, don't block); confirm at plan time whether `pos_transactions.flags` mechanism extends or whether stock-side flagging needs its own bit (ADR-042 low-stock alert IS effectively this for the sale path). Lean: allow, let it surface as a drift in the next recon if relevant.
- [ ] `_runStockRecon_internal` running while a `recordSpoilage` mutation is in flight — Convex serialises mutations, but the recon spans multiple read transactions across SKUs (one query per SKU). Two SKUs A and B: spoilage commits B between recon-reading-A and recon-reading-B → both reads see consistent ledger snapshots but the cache snapshot may have been mid-update. Probably harmless (recon either sees pre-spoilage cache vs pre-spoilage ledger, or post-vs-post — both consistent within one SKU). Worth a test fixture confirming concurrency safety.
- [ ] Voucher applied offline + cart drifts to below `min_cart_value` after a line removal → server-side reject fires with `MIN_CART_VALUE` even though the FE thinks the voucher was valid when applied. Banner copy handles this case correctly.
- [ ] Playwright spec for `voucher-offline`: handling Convex WebSocket reconnect timing post-`setOffline(false)` (R2 above).

## 12. Approval Conditions

**To approve (must fix before writing the plan):**
1. Correct `verifyManagerPinOrThrow` invocation signature throughout the spec (Critical #1).
2. Replace `crypto.randomUUID()` with `mintUrlSafeToken(16)` for `spoilage_event_id` (Critical #2).

**Recommended before implementation (do at spec-edit time, not plan time):**
3. Align audit-verb naming with `docs/SCHEMA.md:609-622` preview (Improvement 1) — pick Option A or B and update both docs.
4. Promote the two missing helpers (`catalog._getActiveSkus_internal`, `transactions._fetchReceiptByTxnIds_internal`) from "if not present" to explicit "add at plan time" with placement notes (Improvement 2).
5. Lock ADR-044 numbering (Improvement 3).

**Recommended at writing-plans time:**
6. Test fixture update for `commitCart.test.ts`.
7. Add the 5 missing test cases enumerated in §10.
8. Confirm reused helpers (`requireManagerSession`, `_resolveSession_internal`, etc.) still match their assumed signatures.

---

*Generated by /staffreview*
