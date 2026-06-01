# Staff Review: v0.5.3b In-app Admin (SPEC)

**Date:** 2026-06-01
**Plan:** `docs/superpowers/specs/2026-06-01-v0.5.3b-in-app-admin-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (design spec with full implementation intent — backend/frontend file lists, mutation surfaces, schema, testing, rollback)

---

## 1. Summary

**Overall Assessment: Approve (after Improvements applied inline).**

The spec is architecturally sound and reuse-aware. Tiered gating maps cleanly onto the existing `withIdempotency`/`authCheck` + two-layer-action plumbing; the `verifyManagerPin` extraction and `_purgeAllReceiptCache_internal` are the right calls. Grounding against the codebase confirmed every named function/table EXCEPT one factual inaccuracy (no audit "enum" exists) and one imprecise injection point (receipt branding). No Critical/blocking defects. Six improvements applied to the spec below.

## 2. Critical Issues (Must Fix)

None. All named reuse targets exist and the gating mechanism is buildable as described.

## 3. Improvements (Recommended) — all applied to the spec

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Audit "enum" does not exist — `action` is `v.string()` | M | L |
| 2 | Receipt-branding injection point is `buildVmFromTxnWithLines` (l.99), not `_buildViewModel_internal` | M | L |
| 3 | Resolve cache-clear mechanism (full scan-delete; no token list) | L | L |
| 4 | Reuse the existing `mgr/telegram-chats` manager-portal pattern for the 3 new routes | M | L |
| 5 | Last-active-manager guard reuses `_listActiveManagers_internal` | M | L |
| 6 | Note the extra per-render settings read on cache-miss (acceptable) | L | L |

### Improvement 1: There is no audit "enum" to extend
`convex/audit/schema.ts:8` types `action: v.string()` — a free string, not a closed union. `logAudit` (`audit/internal.ts:24`) accepts `action: string`. The spec's "Audit enum (`audit/` + `docs/SCHEMA.md`): new verbs…" implies a code-level enum edit that does not exist; it would send the planner hunting for a non-existent file. **CLAUDE.md "How to add a feature" #4 is itself stale** (references `convex/audit.ts` enum). New verbs need only be **documented in `docs/SCHEMA.md`** — no schema/code change. (Verb-collision check still matters: confirmed `settings.founders_summary_toggled` is the only existing `settings.*` verb, so `settings.receipt_updated` is free; `staff.created`/`staff.pin_reset` exist and are reused, not redefined.)
**Recommendation:** Reword the schema section: new audit verbs are free strings, documented in SCHEMA.md only; flag CLAUDE.md #4 as stale. *(Applied.)*

### Improvement 2: Name the real injection point
Both `_buildViewModel_internal` (id-keyed) and `_renderReceiptByToken_internal` (public `/r/<token>`) delegate to the shared `buildVmFromTxnWithLines` helper, where `settings: RECEIPT_SETTINGS` is set (`receipts/internal.ts:99`). The spec named only `_buildViewModel_internal`, which is the *non-public* path. Replacing the single line-99 injection with `ctx.runQuery(internal.settings.internal._getSettings_internal, {})` + `ctx.storage.getUrl(logo_storage_id)` covers **both** paths. Mechanically valid: `buildVmFromTxnWithLines` already calls `ctx.runQuery` from inside an `internalQuery` (lines 66, 74), and `ctx.storage.getUrl` is available in `QueryCtx`.
**Recommendation:** Point the un-hardcode at `buildVmFromTxnWithLines` (l.99); state both paths are covered by one change. *(Applied.)*

### Improvement 3: Resolve the cache-clear open item
`pos_receipt_html_cache` (`receipts/schema.ts:9`) = `{ token, html, expires_at }` indexed `by_token`. A config change clears it via `ctx.db.query("pos_receipt_html_cache").collect()` → delete each — no token list needed (answers the spec's own open item). Intra-module write (receipts owns the table). Rebuild is lazy on next view.
**Recommendation:** Move from "Open items" to the cache-invalidation section as resolved. *(Applied.)*

### Improvement 4: Reuse the existing manager-portal route pattern
v0.4 shipped `src/routes/mgr/telegram-chats.tsx` — a manager-session-gated table-with-actions surface over `api.telegram.chatRegistry.public.mgr*` mutations. The three new `mgr/*` routes are the same shape (manager-gated list + row actions + PinSheet on the gated ones). Model them on it rather than inventing a layout.
**Recommendation:** Add the reuse callout to the frontend section. *(Applied.)*

### Improvement 5: Last-active-manager guard
The deactivate/demote invariant needs an active-manager count. `staff/public.ts:listActiveManagers` already routes through `auth/internal._listActiveManagers_internal` — the commit guard reuses that internal (count actives excluding the target; refuse if zero), rather than a fresh `staff` scan.
**Recommendation:** Name the reuse in §Staff admin. *(Applied.)*

### Improvement 6: One extra read on cache-miss render
Adding the settings `runQuery` to `buildVmFromTxnWithLines` adds one single-row read on the cache-miss render path (the by-token path's comment at l.126 tracks read-count). Negligible (one row, cache-miss is rare). Worth a one-line acknowledgement so a future reader doesn't think the optimization regressed by accident.
**Recommendation:** One-line note in §C. *(Applied.)*

## 4. Refinements (Optional)
- Orphan logo-blob cleanup on replace remains an open plan-time decision (spec already flags it) — low volume, fine to defer.
- `verifyManagerPin` failing repeatedly will lock out the *manager's own* record (ADR-002 lockout) — correct per policy, but worth a UI affordance (clear error) so a fat-fingered price edit doesn't silently lock the booth. Plan-time UI detail.

## 5. Duplication Analysis
### Existing code to leverage (all confirmed present)
| Code | Location | How to use |
|------|----------|------------|
| `createStaff` action | `auth/actions.ts:118` | Extend with `managerPin` + `verifyManagerPin` |
| `resetStaffPin` two-layer verify | `auth/actions.ts:236` | Source of the `verifyManagerPin` extraction |
| `_getStaffPinHash_internal` / `_recordFailedAttempt_internal` | `auth/internal.ts:55/169` | Inside `verifyManagerPin` |
| `_getComponentsForProducts_internal` | `catalog/internal.ts:30` | `listAllProducts` linkage |
| `buildVmFromTxnWithLines` | `receipts/internal.ts:99` | Single branding injection point |
| `_listActiveManagers_internal` | via `staff/public.ts:listActiveManagers` | Last-manager guard |
| `mgr/telegram-chats.tsx` | `src/routes/mgr/` | Manager-portal route template |
| `PinSheet` | `src/components/pos/` | Inline manager-PIN gate |

## 6. Phase / Wave Accuracy
Spec defers waves to the plan (correct). No ordering issue: schema (pos_settings fields) → backend (gate helper → staff/product/receipt mutations + un-hardcode) → frontend. The `verifyManagerPin` extraction must land before/with the first PIN-gated consumer.

## 8. Git Workflow Assessment
Squash-PR convention (repo standard). Spec's rollback (additive schema, default-fallback) is sound. Deployment order backend-before-frontend stated. ✅

## 10. Testing Plan Assessment
**Verdict: Adequate for a spec.** Gate-tier rejection tests, last-manager invariant, hash-strip, component replace-set, cache-purge + default-fallback, and a sell-after-create behavioural are all named. Plan stage must turn these into concrete `convex-test` cases (edge-runtime config per the project's vitest setup). One add: a regression test that `_getSettings_internal`'s existing `founders_summary_enabled` consumers are unaffected by the added fields.

## 11. Edge Cases to Address
- [x] Last active manager (deactivate + demote) — covered
- [x] Self-deactivate — covered
- [x] Deactivated staff's live session — auto-invalidates
- [x] Absent `pos_settings` row → hardcoded defaults — covered
- [ ] Logo upload of a non-image / oversized blob — add client-side type/size guard (plan-time)
- [ ] Component editor: product with zero components (valid? a product that decrements nothing) — decide at plan time

## 12. Approval Conditions
**To approve:** none blocking.
**Applied before proceeding:** Improvements 1–6 (inline spec edits).

---

*Generated by /staffreview*
