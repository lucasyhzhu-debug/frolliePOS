# Staff Review: Per-outlet Telegram routing (Spec 4)

**Date:** 2026-06-22
**Plan:** `docs/superpowers/specs/2026-06-21-per-outlet-telegram-routing-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (design spec — schema, routing algorithm, workstreams, migration, rollback, cross-refs all present)

---

## 1. Summary

**Overall Assessment:** Approve (after the inline edits below — applied at the gate).

The spec is architecturally sound: additive optional `outlet_id` on `telegramChats`, a two-tier
`(role, outlet_id)` resolver, business-vs-outlet `ROLE_SCOPE`, and an idempotent backfill. Grounding
against real code surfaced **two factual mismatches** (recount role, binder gating) and **one
load-bearing architectural gap** (the `chatIdOverride` callsites bypass the safety net). All resolved
inline with the user at the gate. The slice is correctly marked dependent on Spec 1 execution
(`outlets`, `outlet_id`, default-outlet migration, the lint fence) and composes cleanly with Spec 2
(`owner_otp` bypass untouched).

## 2. Critical Issues (resolved inline)

| # | Issue | Category | Location |
|---|-------|----------|----------|
| 1 | `chatIdOverride` callsites bypass the OUTLET_REQUIRED_FOR_ROLE safety net | Logic/Correctness | Routing algorithm + Stream 4 |
| 2 | Routing table mislabels `recount_notice` as `inventory` (code = `managers`) | Correctness | Routing table |
| 3 | Binder gating contradicts Spec 2 Q3 (owner cockpit-only vs `/mgr` manager-gated) | Cross-spec | Workstream 6 |

### Issue 1: `chatIdOverride` paths have no safety net
The spec's safety net is `sendTemplate` throwing `OUTLET_REQUIRED_FOR_ROLE` when `ROLE_SCOPE[role]==="outlet"`
and `outletId` is missing. But ~5 callsites resolve the chatId themselves and pass `chatIdOverride`,
which **short-circuits the resolver** (`send.ts:177`). Verified outlet-scoped override paths that
bypass the net: `telegram/dispatch.ts::dispatchRoleAlert` (low_stock `inventory/internal.ts:333` +
recount `inventory/public.ts:176`), `telegram/txnTicker.ts:47`, `inventory/cronActions.ts:91`, and the
new per-outlet `managers_daily_summary`. A missed outlet thread there is a **silent misroute**, not a
throw.
**Recommendation (applied):** each class-(b) callsite must call `getChatIdByRoleAndOutlet(role, outletId)`
explicitly; `dispatchRoleAlert` gains an `outletId` param; each gets its own per-outlet test (the fence
the safety net would otherwise provide). Documented in Stream 4 as "two classes of callsite".

### Issue 2: recount_notice role
Spec table said `inventory`; code (`inventory/public.ts:177`) sends to `managers`. Both are
outlet-scoped so routing is identical, but following the spec would silently move recounts to the
inventory chat. **Resolved:** preserve `managers` (decision A); table corrected.

### Issue 3: binder gating vs Spec 2
`/mgr/telegram-chats` is booth-manager-gated (`telegram-chats.tsx:395`); Spec 2 Q3 made `owner`
cockpit-only → an owner can't reach the binder. **Resolved (decision B/8):** keep the primitive
manager-session-gated in this slice; record "owners may act as booth managers" as a Spec-2 Q3
amendment and "cockpit binding surface" as a Spec-3 cross-ref — not built here.

## 3. Improvements (applied inline)

| # | Improvement | Impact |
|---|-------------|--------|
| 1 | Make `telegramChats` fence-exclusion explicit (`by_role_outlet` leads with `role`, not `outlet_id`) | M |
| 2 | `owner` (staff role) vs `owners` (chat role) naming-coherence note + ROLE_SCOPE has no `owner` key | M |
| 3 | Keep `founders_summary_enabled` field/mutation names (no schema rename) | M |
| 4 | Cron rename is server-only (not deploy-skew); sweep on-demand command docs | L |
| 5 | `managers_daily_summary` is a NEW kind union + switch case + renderer (decision 1 scope growth) | M |

## 4. Refinements
- Consider folding `dispatchRoleAlert`'s per-outlet resolution + the cron/ticker resolves into one
  shared `resolveOutletChat(role, outletId)` helper to avoid four copies of the two-tier lookup.

## 5. Duplication Analysis
- **Reuse:** `getChatIdByRole` JS-post-filter pattern (`chatRegistry/internal.ts:161`) is the template
  for `getChatIdByRoleAndOutlet`'s business path. `assignRoleArgs`/`assignRoleImpl` (shared between
  `internal.ts`/`public.ts`) is the single-source for the `outletId` extension — extend, don't fork.
  `dispatchRoleAlert` (`dispatch.ts`) is the shared low_stock/recount path — extend with `outletId`.
- **Risk:** four independent two-tier resolves (dispatch, ticker, drift cron, owners cron) — see
  Refinement above.

## 6. Phase / Wave Accuracy
Workstreams 1→7 map cleanly. Stream 5 grew (decision 1: dual-send). Stream 3/4 grew (safety-net gap).
Backfill (Stream 7) is blocked on Spec 1's default-outlet seed + `convex/migrations/` (does not exist
yet — confirmed). Ordering (schema → resolver → callsite sweep → backfill) is correct.

## 7. Specialist Agent Recommendations
| Area | Agent | Rationale |
|------|-------|-----------|
| Resolver + send.ts + callsite sweep | `convex-expert` | Convex query/index + optional-field-filter discipline |
| FE `/mgr/telegram-chats` outlet picker | `frontend-integrator` | React + Convex + i18n/inline-messaging fences |

## 8. Git Workflow Assessment
Squash-PR per repo convention. Commit boundaries: schema+index → resolver → sendTemplate arg →
callsite sweep → owners/managers summary → mgr surface+FE → backfill → docs. Pre-push: `npm run
typecheck && npm run lint && npx vitest run`. Rollback: additive/optional, redeploy prior schema;
`founders` alias kept through the window so a resolver rollback doesn't orphan the chat.

## 9. Documentation Checkpoints
`docs/SCHEMA.md` (`telegramChats.outlet_id` + `by_role_outlet`, new audit verb `telegram.chat_outlet_bound`,
new kinds `managers_daily_summary`), `docs/RUNBOOK-telegram.md` (role table: founders→owners, recount→managers
clarified), `CLAUDE.md` (KNOWN_TELEGRAM_ROLES recast, on-demand command rename), `docs/CHANGELOG.md`.

## 10. Testing Plan Assessment
**Verdict:** Adequate (spec names tests per workstream). Must-add (folded into plan): a per-outlet
resolution test for **each** class-(b) chatIdOverride path (no safety net); single-outlet-fallback
LIVE-fence test; business-rollup + per-outlet-managers dual-send; one-outlet-unbound partial-skip.

## 11. Edge Cases
- [x] Transitional window (Step 1 deployed, Step 2 not run): single-outlet fallback keeps routing live.
- [x] One outlet's managers chat unbound during daily cron → skip that outlet only.
- [x] `owner_otp` with `role:"owner"` never hits ROLE_SCOPE (chatIdOverride short-circuits).
- [x] Dormant managers chat (role assigned, outlet_id not yet bound) → fallback during window.

## 12. Approval Conditions
**Addressed at gate:** Issues 1–3 + Improvements 1–5 edited into the spec; all 8 decisions recorded in
"Resolved decisions". **Ready to plan.**

---

*Generated by /staffreview*
