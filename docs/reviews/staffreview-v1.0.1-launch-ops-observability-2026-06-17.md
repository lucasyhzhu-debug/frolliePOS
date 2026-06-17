# Staff Review: Launch-Day Ops Observability (v1.0.1)

**Date:** 2026-06-17
**Plan:** `docs/superpowers/specs/2026-06-17-launch-ops-observability-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (design spec — Scope/Design/Testing/Risks/Touch-points all present; deployment & env covered)

---

## 1. Summary

**Overall Assessment:** Revise (fold findings into spec before planning)

Solid, well-grounded slice. The transport decision (httpAction over public mutation) is correct and well-argued, the ticker hook point is verified single-fire, and the toggle uses the established optional-field/read-default no-migration pattern. No data-loss / security / correctness Criticals. Six Improvements must be folded in before the plan — chiefly (a) the ticker must **not** reuse the founders audit-skip pattern (per-txn volume = audit-log spam), and (b) reuse the existing `_getPaidInvoiceForTxn_internal` rather than minting new internals.

## 2. Critical Issues (Must Fix)

None. (No data loss, security hole, or correctness bug. The Evidence-Before-Mitigation gate §4.9 is N/A — this is net-new observability, not a flake/race fix.)

## 3. Improvements (Recommended — fold into spec)

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Ticker must NOT audit per-txn skips (audit-log spam) | H | L |
| 2 | Reuse `_getPaidInvoiceForTxn_internal` for instrument, don't mint new | M | L |
| 3 | Error-alert `sendTemplate` idempotencyKey = error-report row `_id` | M | L |
| 4 | Webhook reporting: only genuine processing failures, never 401/signature rejects | H | L |
| 5 | Storm-cap query: pin the index/scan approach explicitly | M | L |
| 6 | Don't report `isChunkLoadError` from global handlers either, not just the boundary | M | L |

### Improvement 1: Ticker skip must not audit per-transaction
The spec says `sendTxnTicker` mirrors `foundersSummary.ts`, which audits skips (`_auditFoundersSkip_internal`) on `disabled` / `role_unbound`. Founders runs **once daily** — a ticker runs **once per sale** (dozens–hundreds/day). Reusing the audit-skip pattern would flood `audit_log` with `disabled`/`role_unbound` rows. **Recommendation:** ticker skips **silently** (just `return { skipped }`); audit **only** genuine send failures (already covered by `sendTemplate`'s `_auditSendFailed_internal`). Keep the narrow-catch role-resolve pattern, drop the skip-audit.

### Improvement 2: Reuse `_getPaidInvoiceForTxn_internal`
`convex/payments/internal.ts:15-18` documents an existing `_getPaidInvoiceForTxn_internal` query, and `instrumentFromInvoice(Pick<Doc,"method">)` (lines 20-27) is the pure post-processor. The ticker's instrument derivation should call these, not a new query. For the txn header (receipt_number/total/staff_id) a small `_getTxnForTicker_internal` is still warranted, but don't duplicate the invoice lookup. (Memory `v053a-reporting`: this exact query was de-duped once already — don't re-fork it.)

### Improvement 3: Simpler, collision-proof alert idempotency key
Spec proposes `"ops_error:" + signature + ":" + bucketedTimestamp` — `bucketedTimestamp` is underspecified and `Date.now()` math in the action is avoidable. Since `_recordError_internal` already decides exactly-once-per-window which row gets `alerted: true`, schedule the alert with that **row `_id`** and use `idempotencyKey: "ops_error:" + reportId`. Guaranteed unique per alert, re-alerts naturally across windows (each is a new row), no timestamp bucketing. Cleaner and removes a `Date.now()` from the hot path.

### Improvement 4: Webhook reporting scope
`convex/payments/webhook.ts` returns `401` on bad/missing `x-callback-token` (expected internet noise) and `200` otherwise. **Only report genuine processing failures** (a parse/confirm exception on an authenticated callback) — never the 401/signature-reject path, or the Ops channel fills with bot-scanner noise. Reporting must be wrapped so it cannot alter the returned status code.

### Improvement 5: Storm-cap query shape
"most recent `alerted:true` row within cooldown" — the `by_created` index is on `created_at` only. Specify: `.withIndex("by_created").order("desc").filter(q => q.eq(q.field("alerted"), true)).first()`, compare its `created_at` to `now - GLOBAL_ALERT_COOLDOWN_MS`. Fine at booth volume; note a dedicated `by_alerted_created` index as the scale follow-up if the table grows. (Avoids a silent full-table scan masquerading as O(1).)

### Improvement 6: Chunk-load errors in global handlers
The spec correctly skips `isChunkLoadError` in `RouteErrorBoundary`, but `window.onerror` / `unhandledrejection` will *also* catch chunk-load failures (stale deploy/offline). Apply the same `isChunkLoadError` guard in the global handlers, else every stale-deploy reload pings Ops.

## 4. Refinements (Optional)
- Cap client-side in-memory dedup `Set` size (clear on reload is fine; just don't grow unbounded in a long session).
- `renderTxnTicker`: truncate to first N line items + "…+M more" so a 20-line wholesale order doesn't post a wall of text.
- Consider `disable_notification: true` on ticker sends (Managers get a silent feed, not 100 buzzes); keep `system_error` loud.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `instrumentFromInvoice` | `convex/payments/internal.ts:20` | Ticker instrument label (pure, V8-safe) |
| `_getPaidInvoiceForTxn_internal` | `convex/payments/internal.ts` | Active-invoice lookup for ticker — don't re-fork |
| `_listStaffNames_internal` | `convex/auth/internal.ts` | Staff name for ticker |
| `getChatIdByRole` + narrow-catch | `convex/telegram/foundersSummary.ts:88-103` | Role-resolve race-safe pattern for both new actions |
| `constantTimeEqual` | `convex/lib/constantTimeEqual.ts` | `x-ops-token` compare |
| `_getSettings_internal` read-default | `convex/settings/internal.ts` | `txn_ticker_enabled` default-true |
| `isChunkLoadError` | `src/lib/chunkLoadError.ts` | Skip-noise guard (boundary + global) |
| `_auditSendFailed_internal` | `convex/telegram/internal.ts` | Send-failure audit (both new kinds) |

### Duplication risks
- Minting a new invoice-lookup query (see Imp. 2).
- Re-implementing the resilient-retry wrapper for error alerts — **don't**; error alerts are explicitly no-retry (spec is right; just don't copy `*Resilient`).

## 6. Phase / Wave Accuracy
Spec is pre-plan; ordering guidance for the plan: schema (ops table + settings field + root compose) → ops module (lib→internal→actions→http) → telegram (config role, send kinds, renderers, txnTicker) → ticker hook in `_confirmPaid_internal` → BE reporting → FE reporting → runbook+docs. Schema-before-consumers; telegram kinds before the actions that send them.

## 7. Specialist Agent Recommendations
| Area | Agent | Rationale |
|------|-------|-----------|
| Convex ops module + ticker | `convex-expert` | httpAction/mutation/action split, indexes, V8-safety |
| FE reporting wiring | `frontend-integrator` | hook/boundary wiring, fetch keepalive |
| Post-impl review | `/triple-review` then `/simplify xhigh` | repo standard close-out |

## 8. Git Workflow Assessment
| Check | Status |
|-------|--------|
| Feature branch | ✅ (pipeline worktree) |
| Squash-merge convention | ✅ |
| Pre-push typecheck/test | ⚠️ ensure plan lists `npm run typecheck` + `npx vitest` per commit |
| Rollback | ✅ runbook §9 (Vercel rollback / convex deploy prior) |
| Deployment order | ⚠️ plan must state: set both env vars on dev+prod BEFORE FE deploy, else `/ops/error` 204s silently |
| Migration safety | ✅ optional field + new table, no migration |

## 9. Documentation Checkpoints
| Area | Docs |
|------|------|
| Schema | `docs/SCHEMA.md` — `pos_error_reports`, `pos_settings.txn_ticker_enabled` |
| Telegram | `docs/RUNBOOK-telegram.md` — `ops` role + new template kinds; CLAUDE.md role table |
| Env | `docs/RUNBOOK.md §5` — `OPS_INGEST_TOKEN` / `VITE_OPS_INGEST_TOKEN` |
| Ops | `docs/RUNBOOK.md §9` — smoke + hot-fix + rollback |
| Changelog | `docs/CHANGELOG.md` |

## 10. Testing Plan Assessment
**Verdict:** Adequate (with additions)

Add to the spec's test list:
- **Webhook regression:** adding BE reporting does NOT change returned status codes (200 success, 401 bad token); 401 path does NOT report.
- **Global handler chunk-load guard:** `isChunkLoadError` suppresses report in `window.onerror` too.
- **Ticker no-audit:** disabled/role_unbound skip writes **no** `audit_log` row (guards against Imp. 1 regressing).
- **Manual-confirm instrument:** `confirmed_via === "manual"` with no invoice → "Manual" (not crash on null).

## 11. Edge Cases to Address
- [ ] Manual override with no Xendit invoice → instrument label (Imp. covered).
- [ ] Pre-login crash → report with absent staff_code/device_id (optional fields).
- [ ] Telegram role unbound at launch → ticker/alert skip silently, booth unaffected.
- [ ] `keepalive` fetch body ≤ 64KB (stack truncation keeps under).
- [ ] Chunk-load error online → reload (no report); offline → fallback (no report).
- [ ] Settings row absent in prod → `txn_ticker_enabled` defaults true.

## 12. Approval Conditions
**To approve (fold into spec before planning):** Improvements 1–6.
**Recommended:** Refinements (esp. `disable_notification` on ticker, line-item truncation).

---

*Generated by /staffreview*
