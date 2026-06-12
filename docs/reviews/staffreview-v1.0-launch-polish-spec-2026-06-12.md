# Staff Review: v1.0 Launch — polish slice + production go-live (spec)

**Date:** 2026-06-12
**Plan:** `docs/superpowers/specs/2026-06-12-v1.0-launch-polish-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (spec-level: scope, parts, gates, success criteria, risks, rollback-equivalent all present; per-file detail correctly deferred to the plan)

---

## 1. Summary

**Overall Assessment:** Revise (one Critical, four Improvements — all cheap edits)

The spec is sound in shape: bounded polish slice, ordered ops checklist, money path untouched. The one launch-blocking gap is that **no step deploys current `main` to prod** — `savory-zebra-800` was last deployed 2026-06-03, so v0.6.1 (auth hardening), v0.7 (settlements + cron), and the e8e85a5 settlements fix are not in prod, and the polish slice itself has no route to staff without a deploy step. Remaining findings are factual corrections verified against code.

## 2. Critical Issues (Must Fix)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | No prod deploy step — prod backend/frontend are 9 days stale and the polish slice never ships | Deployment | Part 2 (missing step) |

### Issue 1: Missing prod deploy between Part 1 and Part 2

Prod Convex (`savory-zebra-800`) was deployed once, at the 2026-06-03 cutover. Since then `main` gained v0.6.1 (ADR-046 auth hardening), v0.7 (settlements module + `settlement-sync` cron), and `e8e85a5` (RFC3339 fix, issue #66). None of that is in prod. The Part 2 checklist (Telegram check, seeding, smoke test) would run against a stale backend, and the Part 1 polish slice would never reach the booth.

**Recommendation:** Add step **2-0 "Deploy current main to prod"** as the first gate of Part 2: merge the polish slice to `main` → `npx convex deploy` (backend) → Vercel prod deploy → verify in the prod dashboard that the `settlement-sync` and `founders-shift-summary` crons are registered and `/payments/webhook` still answers (401 wrong-token probe). Everything else in Part 2 runs against this deploy.

## 3. Improvements (Recommended)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | `createStaff` requires manager-set initial PIN — spec says "staff sets PIN on first login" | M | L |
| 2 | Managers-role Telegram test: use `/activatepos` (real, harmless) instead of a fabricated approval card | M | L |
| 3 | SKU admin route is `/mgr/products`; audit-loop route list should name exact live routes | L | L |
| 4 | Smoke-test refund step must reflect ADR-038 semantics (refund row + manual transfer + `markRefundSettled` ack) | M | L |

### Improvement 1: Initial staff PINs

`convex/auth/actions.ts:126` — `createStaff` args include `pin` (4 digits, set by the manager at creation, PIN-gated by `verifyManagerPinOrThrow`). There is no "set PIN on first login" flow. Correct sequence: manager creates staff with a temporary PIN → staff rotates it via `/account` change-PIN at first login. Fix §2b and carry into the runbook.

### Improvement 2: Managers-role send test

A "test approval card" requires fabricating an approval request in prod. `/activatepos` (v0.5.7) is a real managers-group command with a harmless side effect (6-digit setup code, 1h TTL) — it round-trips webhook → role lookup → reply in one shot. Use it as the managers-role verification. `inventory` role: passive check (binding listed) is sufficient; alerts fire from real conditions.

### Improvement 3: Exact route list for the audit sweep

Verified live routes for the staff-critical loop: `/sale`, `/sale/charge`, `/sale/charge-success`, `/sale/drafts`, `/sale/voucher`, `/history`, `/history/$txnId`, `/refund`, `/refund/$txnId`, `/stock`, `/stock/in`, `/stock/recount`, `/stock/$skuId`. SKU creation lives at `/mgr/products` (PIN-gated `catalog.actions.createInventorySku`), not a separate SKU-admin route. Pin these in the spec so the plan's audit table is exhaustive.

### Improvement 4: Refund smoke-test semantics

Per ADR-038, a refund is a `pos_refunds` row (manager-PIN) + a manual bank transfer + a manager-session `markRefundSettled` ack — no money moves via Xendit. The smoke test should: create the refund (booth PIN path) → skip the real transfer (own money, Rp 1.000) → mark settled → confirm the refund badge on `/history/$txnId`. This exercises the full funnel including the settle ack.

## 4. Refinements (Optional)

- Note the exact gate commands in the spec: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e` (Playwright/chromium; `test:e2e:install` on first run).
- Founders summary fires tonight at 22:00 WIB regardless — the on-demand run (§2a) will double-send today; acceptable, or note it.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `RouteErrorBoundary` | `src/components/layout/RouteErrorBoundary.tsx` | Already wired; spec correctly marks the v1.0 backlog item stale |
| Sonner toast pattern | throughout `src/routes/*` | The fix bucket's error-surfacing mechanism — extend, don't invent |
| `/activatepos` | `convex/telegram/commands.ts` | Managers-role send test + runbook device-dead recovery |
| `seed:reset` dev fixture | `convex/seed/` | Audit sweep runs against dev seed — no new fixtures needed |

### Potential duplication risks
- None — the slice adds presentation states only; no new helpers expected.

## 6. Phase / Wave Accuracy

| Phase | Assessment | Notes |
|-------|------------|-------|
| Part 1 audit → fix → gate | Good | Audit-first keeps the fix bucket evidence-bound |
| Part 2 ops checklist | Needs adjustment | Insert deploy step 2-0 (Critical 1); 2a–2e order otherwise correct |

**Ordering issues:** deploy must precede every Part 2 step.
**Missing phases:** none beyond the deploy step.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Part 1 audit sweep | `Explore` / main session | Read-heavy state cataloguing |
| Part 1 fixes | `ui-component-builder` or main session | Empty/error states in existing shadcn idiom |
| Part 2 ops | main session (human-in-loop) | Prod actions, Lucas does seeding |

## 8. Git Workflow Assessment

| Check | Status |
|-------|--------|
| Feature branch specified | ⚠️ implied — plan must name `feat/v1.0-launch-polish` |
| Branch naming follows convention | ✅ |
| Merge strategy documented | ✅ squash-PR (repo convention) |

Commit checkpoints: audit findings table (docs) → fix bucket (one commit per screen or per category) → runbook section → PROGRESS/CHANGELOG. Pre-push: typecheck + lint + vitest + e2e (all named in spec §1c).

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Part 1 | none (presentation only) |
| Part 2d | `docs/RUNBOOK.md` (booth-ops prod section) |
| Part 2e | `docs/CHANGELOG.md`, `docs/PROGRESS.md` (+ regenerated `progress.html`) |

### CHANGELOG draft
~~~markdown
## 2026-06-12 — v1.0.0 launch
- Empty/error/offline-state polish across the staff-critical loop (sale, charge, drafts, history, refund, stock)
- Booth operations runbook (prod) in docs/RUNBOOK.md
- Production go-live: paper system retired at the Pakuwon Mall booth
~~~

## 10. Testing Plan Assessment

**Verdict:** Adequate (for a spec)

| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| Frontend | empty/error/offline states per screen | vitest component tests where states are conditional renders | planned (plan to detail) |
| Integration | full suite green | vitest + Playwright e2e | planned (§1c gate) |
| Prod | money loop | live Rp 1.000 smoke test incl. refund funnel + settle ack | planned (§2c) |

### Missing test coverage (must add in plan)
| # | Missing test | Why it matters | Approach |
|---|--------------|----------------|----------|
| 1 | Per-fix component tests for new empty/error states | The slice lands hours before first sale | Each fix bucket item ships with a render test of the new state |

### Regression risk
- Existing route tests (e.g. `history/__tests__`, `refund/__tests__`) may assert on current empty-state markup — expect snapshot/text updates.

## 11. Edge Cases to Address

- [ ] Offline mid-charge (QR already minted, network drops) — audit must capture what the screen shows
- [ ] `/history` with zero transactions on a manager-picked past day vs staff same-day
- [ ] `/stock` with zero SKUs (fresh prod before seeding — exactly the state Lucas sees on launch morning)
- [ ] Smoke test: webhook latency > expectation — manual-override path is the documented fallback, not a re-scan

## 12. Approval Conditions

**To approve, address:**
1. Add deploy step 2-0 (Critical 1).

**Recommended before implementation:**
1. Fix initial-PIN wording (§2b + runbook).
2. Swap managers-role test to `/activatepos`; inventory = passive check.
3. Pin the exact audit-loop route list; SKU admin = `/mgr/products`.
4. Rewrite smoke-test refund step per ADR-038 (include `markRefundSettled`).

---

*Generated by /staffreview*
