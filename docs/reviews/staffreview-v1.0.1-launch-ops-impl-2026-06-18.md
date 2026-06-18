# Staff Review: Launch-Day Ops Observability — IMPLEMENTATION (v1.0.1)

**Date:** 2026-06-18
**Branch:** worktree-v101-launch-ops · **Base:** 5ed93b4 · **Head:** 8dd8b4e
**Plan:** `docs/superpowers/plans/2026-06-17-v1.0.1-launch-ops-observability.md`
**Prior gates:** `staffreview-v1.0.1-launch-ops-observability-2026-06-17.md` (spec), `...-plan-2026-06-17.md` (plan)
**Lens:** Deep modules / surface APIs (ADR-034); plan-to-impl fidelity; Frollie Pro graft integrity
**Reviewer:** Senior engineer (architecture)

---

## Summary

**Verdict on module depth: UNCHANGED (depth preserved).** The new `convex/ops/` module is a textbook deep module — a single one-line public surface (`POST /ops/error`) over a substantial, well-hidden implementation (signature normalization, dedup, storm-cap, scheduled alerting). The sales ticker rides the existing single paid-confirmation funnel and reuses the established cross-module `internal.ts` read pattern, so it widens no boundary that wasn't already wide. `telegram/send.ts` grew exactly as its add-a-kind contract prescribes — two literals, two payload objects, two switch cases — with no leakage of caller-side table knowledge. The implementation faithfully matches the plan and the prior reviews' corrections are all present.

The single substantive gap is a **product/ops gap, not an architectural one**: the ticker's documented off-switch (`txn_ticker_enabled`) has no write path, so the launch-day "turn it off if it's noisy" promise can only be honored via the Convex dashboard. Everything else is refinement.

This is a clean, ship-ready change. No Critical issues.

---

## Critical Issues

None.

The money path is untouched: the ticker is a single `ctx.scheduler.runAfter(0, ...)` at the tail of the `awaiting_payment → paid` branch of `_confirmPaid_internal`, after the `payment.confirmed` audit write. A Telegram failure runs in its own transaction and cannot roll back a paid sale (verified — `_confirmPaid_internal` is a mutation; the scheduled action is out-of-band). The line-status guard guarantees one schedule per txn. Webhook auth stays first and unchanged; the 401 bot-scanner path writes no report (verified in `webhook.ts` — the try/catch is strictly post-auth). All four prior-review corrections are in the code:

- **Scheduled, not inline, ticker** — `transactions/internal.ts:306`.
- **Silent skips, no audit** — `txnTicker.ts` returns `{ skipped: ... }` with zero `logAudit` calls; toggle/role/not-found all silent.
- **Auth-path-only webhook reporting** — `webhook.ts:30` rejects before the reporting try/catch is ever entered.
- **httpAction transport, not a public mutation** — `ops/http.ts` is an `httpAction`; the client uses raw `fetch` + `keepalive`, never the Convex client (correct: a crash may have torn the client down).

---

## Improvements

### I1 — Ticker off-switch is documented but unimplemented (launch-safety gap)

`docs/RUNBOOK.md:248` and `docs/SCHEMA.md:562` both promise the ticker is disabled via "a manager-session settings write" / "`/mgr/...` settings." **No such write exists.** Grep across `convex/` finds `txn_ticker_enabled` only in the schema definition, the read-default (`settings/internal.ts:20`), and the read in `txnTicker.ts:39` — there is no mutation that sets it, and no `/mgr` settings route surfaces it.

For most settings this would be a nit, but this feature's entire safety story is "ship it on by default, kill it if it's spamming the Managers channel mid-launch." Right now the only kill switch is editing the prod row through the Convex dashboard/CLI under launch-day pressure. Two acceptable resolutions:

1. **Preferred:** add a one-line manager-session mutation in `settings/` (mirrors the existing receipt-config session-write tier per business rule #22 — low-stakes config, manager-session not PIN) and note the exact command/route in RUNBOOK §9.5.
2. **Minimum:** correct the docs to say the off-switch is a Convex-dashboard row edit (and document the exact field), so the runbook isn't lying on launch day.

Leaving the docs as-is is the worst option — it reads as implemented and will waste minutes at exactly the wrong moment.

### I2 — `ops/actions.ts` carries an unnecessary `"use node"`

`sendErrorAlert` uses only `ctx.runQuery` / `ctx.runAction` — no Node built-ins, no `crypto.subtle`, no `Buffer`. Its sibling `telegram/txnTicker.ts` does the same work and is explicitly annotated `// V8-safe — no "use node"`. The `"use node"` on `ops/actions.ts:1` forces this action onto the Node runtime for no reason, costing cold-start latency on the alert path and contradicting the deliberate runtime choice made for the structurally-identical ticker action. Drop it unless a Node dependency is added later. (Note: `telegram/send.ts` legitimately needs `"use node"` for `fetch`-to-Telegram + argon-adjacent helpers per the module's existing convention; the `runAction` boundary means `sendErrorAlert` does not inherit that requirement.)

### I3 — Payment-path errors can double-report (BE action + FE hook)

A QR/VA creation failure is reported twice: once server-side in `payments/actions.ts` (`reportPaymentError`, `kind:"payment"`) when Xendit rejects, and once client-side in `sale/charge.tsx:219` (`kind:"payment"`, `route:"useXenditPayment"`) when the action throws back to the UI. The two rows have different routes/signatures, so neither dedup window collapses them, and the global storm-cap will let both through if they're the first alerts in the cooldown. The operator sees the same failure as two Ops alerts.

This is defensible (server sees Xendit's raw error; client sees the user-facing throw) and the storm-cap bounds the blast radius, so it's an Improvement, not a Critical. If you want one alert per failure, prefer the **server-side** report (richer error, fires even when the FE never receives the response) and downgrade the FE payment catch to toast-only — or accept the duplication and add a one-line comment at both sites noting it's intentional belt-and-suspenders.

### I4 — Storm-cap "by_created + filter(alerted)" scans suppressed rows

`_recordError_internal`'s storm-cap query walks `by_created` descending and `.filter(q => q.eq("alerted", true))`. Convex `.filter` is a post-index scan, so during an error storm (many `alerted:false` rows piling up in the same window) this walks every suppressed row newer than the last alerted one to find `.first()`. For one booth-day the volume is trivially small and this is fine, but if the ops pipe ever sees real traffic this is an unbounded scan. A dedicated `by_alerted_created` index (`["alerted","created_at"]`) makes it an O(1) `withIndex(...).order("desc").first()`. Cheap to add now, awkward to retrofit under load. Flagging as the one place the design quietly assumes low volume.

---

## Refinements

### R1 — `errorSignature` ignores `stack`; two different bugs at the same line collapse

`normalizeMessage` strips digits/hex, then `errorSignature = djb2(kind|route|normalizedMessage)`. Two genuinely distinct errors that share a normalized message at the same route (e.g. two different `TypeError: Cannot read properties of undefined` from different call sites on `/sale`) dedup into one signature and one alert. That's the intended trade (dedup volatility) and correct for launch noise reduction — just noting the stack is deliberately not part of the key, so distinct-root-cause-same-message errors are intentionally merged. No change; documented here so a future reader doesn't "fix" it.

### R2 — djb2 over crypto for the dedup key: correct call

Using djb2 (V8-safe, sync, no `crypto.subtle`) for a non-security dedup key is the right choice and matches the Global Constraint. The key is never a secret and never authenticates anything; a cryptographic hash would be over-engineering and would drag the mutation toward async crypto. Endorsed.

### R3 — In-memory client dedup (`recentlySent` Map, 10s, cap 200→clear): appropriately minimal

The client-side dedup is a sensible belt to the server's suspenders, and the `size > 200 → clear()` is a fine crude memory bound for a single-device PWA. The `clear()` (vs LRU eviction) momentarily widens the dedup window after a flush, but for a 200-entry map on one booth device that's noise. No change.

### R4 — `_getTxnForTicker_internal` returns a minimal projection: good module hygiene

The ticker reads a purpose-built narrow projection (`receipt_number, total, staff_id, confirmed_via, lines[{name,qty}]`) rather than pulling the full txn+lines doc across the action boundary. This is exactly the deep-module discipline ADR-034 wants — the consumer doesn't learn the txn table's shape, only the five fields it needs. Same for the `instrumentFromInvoice` reuse: it's a pure exported helper, not a table reach.

### R5 — Cross-module reads in `txnTicker.ts` are all sanctioned `internal.ts` calls

The ticker reads from five modules — `settings._getSettings_internal`, `telegram.chatRegistry.getChatIdByRole`, `transactions._getTxnForTicker_internal`, `auth._listStaffNames_internal`, `payments._getPaidInvoiceForTxn_internal` — plus imports the pure `instrumentFromInvoice` helper from `payments/internal.ts`. Every one goes through an owning module's published internal surface (or a pure helper import), never a raw `ctx.db.query("other_table")`. This is the established pattern (identical in shape to `foundersSummary.ts` and `transactions/internal.ts`'s own catalog/inventory reads), not a new leak. The `instrumentFromInvoice` import specifically is a pure function with no DB access — importing it is the documented Layer-1 "talk through public/internal exports" rule, and it's already imported the same way by `transactions/internal.ts`. No boundary violation.

---

## Graft integrity (Frollie Pro v1.1+)

Clean. `pos_error_reports` is POS-only telemetry, explicitly commented as "NOT audit_log," lives in its own `ops/schema.ts` fragment, and is never referenced by `convex/api/v1/`. It introduces no stable-string-ID commitments, no cross-deployment assumptions, and nothing that the external API surface must now honor. The `ops` Telegram role and the two new template kinds are internal-comms plumbing, invisible to any consumer. When the Frollie Pro cross-deployment sync lands, this module is inert with respect to it — it can evolve or be deleted without touching the graft. No lock-in.

One forward note (not a blocker): if Frollie Pro ever wants centralized error telemetry, the right move is a `/api/v1/` outbound endpoint over `pos_error_reports`, not exposing the table — the current shape doesn't foreclose that.

---

## Plan fidelity

High. The 14-task plan was executed essentially verbatim, including the documented forward-reference ordering (T3 schedules T6's action). Spot-checks against the plan:

- Schema, lib (djb2/normalize/truncate + constants), `_recordError_internal` dedup+storm-cap, `ops` role, both renderers + `sendTemplate` kinds, `sendErrorAlert`, `/ops/error` httpAction, settings read-default, `sendTxnTicker` + `_getTxnForTicker_internal`, the `_confirmPaid_internal` hook, BE reporting (action + webhook, auth-only), FE `reportOps` + `opsEndpoint`, and the 4 wiring sites — all present and matching.
- The prior plan-review's two signature fixes (`_listStaffNames_internal` args `{}` + `.find`; `_getPaidInvoiceForTxn_internal` arg `transactionId`) are correctly applied in `txnTicker.ts`.
- The 4 FE sites match the plan's intent (global `error`/`unhandledrejection` in `main.tsx`; crash in `RouteErrorBoundary` with an error-identity `useRef` guard per the plan refinement; payment in `charge.tsx`; mutation in `sale/index.tsx`). The plan speculated the mutation site might be `useCart`; the implementer correctly located it at the sale-route commit catch instead. Reasonable deviation, not scope creep.
- Docs (SCHEMA, RUNBOOK §5/§9, RUNBOOK-telegram, CLAUDE.md role table, CHANGELOG) updated.

No scope creep. The only fidelity gap is I1: the runbook/SCHEMA describe an off-switch write the code doesn't provide — the plan's Task 14 wrote the doc prose, but no task ever added the corresponding mutation, and the plan-review's Task 14 sign-off didn't catch the missing setter.

---

## Over / under-engineering

Calibrated well. djb2 (R2), the minimal client dedup (R3), the narrow txn projection (R4), and the fire-and-forget no-retry stance are all right-sized for a one-booth launch. The only under-built spot is I1 (missing off-switch) and the only place that quietly bets on low volume is I4 (filter-scan storm-cap). Nothing is gold-plated.

---

*Generated by senior-engineer architectural review.*
