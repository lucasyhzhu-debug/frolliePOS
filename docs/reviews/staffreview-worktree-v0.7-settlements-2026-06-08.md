# Staffreview — v0.7 Xendit settlement reconciliation (Deep-Module Architecture)

**Reviewer lens:** Deep-Module / Surface-API discipline (ADR-034)
**Date:** 2026-06-08
**Base..Head:** `1ce3b6c..f825900`
**Scope:** new `convex/settlements/` module (schema/lib/internal/actions/cronActions/public + tests), `payments/xendit.ts` adapter extension, `convex/crons.ts`, `src/routes/settlements.tsx`, `src/routes/home.tsx`.

## Summary

**Verdict: genuinely deep.** `settlements/` is a textbook ADR-034 deep module — a narrow public surface (one query, `listSettlements`) over substantial hidden implementation (pure parse/aggregate in `lib.ts`, a single-writer upsert in `internal.ts`, a resilient cron in `cronActions.ts`, a PIN-gated action in `actions.ts`). No shallow pass-throughs, no aggregator anti-pattern, no module reaching into another module's tables. The Xendit row shape is interpreted in exactly one place (`lib.ts`); the HTTP surface lives where the rest of the Xendit protocol already lives (`payments/xendit.ts`). The single-writer invariant for `pos_settlements` holds: both the cron and manual entry funnel through `_upsertSettlementDay_internal`. The Task-0 shape corrections (fee-as-object → use `net_amount`; no `settlement_date` field → derive WIB date from `estimated_settlement_time`; `cashflow` filter) were integrated into the pure layer coherently, not bolted on. The graft hooks (`synced_to_frollie_pro_at`, `payload`) stay dormant as designed.

This is a clean, on-spec, well-tested phase. No Critical issues. A handful of Refinements and one Important follow-up worth tracking, mostly about a known KYB-gated risk (settlement-date derived from an *estimate*) and a couple of documentation/depth refinements.

## Critical Issues

None.

## Improvements (Important)

### I1. Upsert key derived from `estimated_settlement_time` can desync the settlement day (KYB-gated, but track it)

`lib.ts::wibCalendarDate` derives `settlement_date` from `estimated_settlement_time`, and that value becomes the `settlement_key` (`settle-${date}`) — the upsert identity. Per the Task-0 findings (`docs/xendit-reference/settlement-reconciliation.md:97-110`), `estimated_settlement_time` is an *estimate*; the real settlement can land on an adjacent calendar day. Consequences if the estimate drifts after a row is already written:

- The poll on day N keys a row to `settle-2026-06-05`; if Xendit later reports the same txns under an actual settlement on `2026-06-06`, the next poll writes a *second* row (`settle-2026-06-06`) and the first never gets corrected — net is double-counted across two day-rows.
- A manager's manual row keyed to the real bank date will never be superseded by a poll that keyed itself to the estimate date (the poll-wins-on-conflict guard only fires on a same-key collision).

This is **correctly gated behind KYB** (the auto-poll is built + shape-tested but not live-verified; manual entry is the launch path), and the xendit-reference doc flags it as a live-verification follow-up. So it is not a blocker for v0.7. But it is the single most load-bearing assumption in the auto-poll path and deserves to be an explicit named item in the KYB follow-up issue (Task 10), not just a doc footnote — phrase it as "verify `estimated_settlement_time` → settlement-day key stability; if it drifts, re-key on the post-settlement report date or reconcile by `reference_id`." The `payload` (raw rows) is stored precisely to enable that reconciliation, which is the right hook — but nothing consumes it yet, so the drift is currently silent.

## Refinements (Minor / Nitpick)

### R1 (Minor). `listSettlements` filter pushdown vs the plan's collect-then-filter — good deviation, but the index is under-used

The shipped `public.ts` improves on the plan (plan Task 7 did `.collect()` then JS-filter/sort; shipped pushes the range into `by_settlement_date` and uses `.order("desc")`). Correct call. One nuance: when **neither** `fromDate` nor `toDate` is supplied (the only call site today — the FE passes just `sessionId`), the `withIndex` callback returns `q` unconstrained, which is a full index scan ordered desc. That is fine for a booth's settlement volume (one row/day), and matches the repo pattern. No change needed; flagging only so a future reviewer doesn't mistake it for a bug. The comment block already explains the lexicographic-sort reliance well.

### R2 (Minor). `_auditSyncSkip_internal` lives in `internal.ts`; `internal.ts` doc-comment still references a future "Task 6"

`internal.ts:14` carries a stale planning note: *"Note: a separate `_auditSyncSkip_internal` will be added in Task 6."* — but `_auditSyncSkip_internal` is defined directly below it in the same file. Drop the forward-reference comment; it reads as if the helper is missing when it is present. Pure doc hygiene, no behavior.

### R3 (Minor). `mdr_amount` semantics: the field name says MDR, the value is total deductions

`aggregateSettledByDate` computes `mdr_amount = gross - net`, and `net = Xendit net_amount` ("amount after fees *and VAT*"). So `mdr_amount` is total Xendit deductions (MDR + any VAT/withholding), not MDR strictly. The FE labels it "Biaya Xendit" (Xendit fees), which is honest; ADR-012's schema language says `mdr_amount`. This is the *right* value to show (it reconciles gross−net to what actually hit the bank), but the field name now slightly overpromises. Not worth a rename in v0.7 (PPN is 0 today, so MDR == total deductions in practice). Worth a one-line note in SCHEMA.md that `mdr_amount` = `gross − net` (all Xendit deductions), so a future PKP flip doesn't surprise an accountant reading the column name. Low priority.

### R4 (Nitpick). Manual-entry rejects gross-but-zero-MDR? No — but double-check the degenerate-entry rule against early-settlement edge

`actions.ts:59` rejects `grossAmount < 1 || transactionCount < 1` as degenerate. Correct for a settled day. Just note that a `mdrAmount` of exactly `gross` (net = 0) is *allowed* (`net < 0` is the only NET reject). A zero-net settled day is economically near-impossible but not data-incoherent, so allowing it is defensible. No change; documenting the deliberate boundary so it isn't "fixed" later.

### R5 (Nitpick). `actions.ts` is `"use node"` yet does no node-only work

`enterSettlementManually` is marked `"use node"` (mirroring the voucher/other action template), but its only heavy call is `verifyManagerPinOrThrow` (argon2id), which *does* require node — so the directive is justified. Mentioning only to confirm it is not cargo-culted: the PIN verify is the node dependency. Correct as-is.

## ADR-034 conformance checklist

| Concern | Finding |
|---|---|
| Narrow public surface | ✅ One query (`listSettlements`). No public mutation; writes go through the PIN-gated action + internal writer. |
| Deep impl hidden | ✅ Parse/aggregate (`lib.ts`), upsert+audit (`internal.ts`), cron+retry (`cronActions.ts`), PIN-gate (`actions.ts`) all below the surface. |
| Single-writer invariant | ✅ `_upsertSettlementDay_internal` is the only `pos_settlements` writer; cron + manual both funnel through it. Verified by tests (no-dupe, poll-over-manual supersede, manual-over-poll plain patch). |
| Xendit shape in ONE place | ✅ Only `lib.ts::parseListTransactions` interprets row fields; `cronActions` and tests depend on the normalized `XenditTxnRow`, not raw Xendit keys. |
| Cross-module reads via sanctioned surfaces | ✅ Session via `internal.auth.internal._resolveSessionRole_internal` (existing internal surface, used identically by `transactions/public.ts`). PIN via `auth/verifyPin` (the funnel 6 other `actions.ts` import). Audit via `audit/internal.logAudit` (foundational allow-list). Retry/time via `lib/cronRetry` + `lib/time`. No cross-module `ctx.db` access. |
| List-Transactions reader home | ✅ Correctly lives in `payments/xendit.ts` (keeps the entire Xendit HTTP surface — endpoints, auth, headers — in one module, per OQ1). New `settlements/` does NOT own Xendit HTTP; it consumes the adapter. The btoa-vs-Buffer runtime split is handled deliberately (V8 `listTransactions` uses `btoa`; node create-charge funcs use `Buffer`; xendit.ts stays directive-free so the V8 cron can import it). |
| Graft integrity (v1.1) | ✅ `synced_to_frollie_pro_at` dormant; `payload` stores raw rows for future `reference_id` match-back (N1) without committing to a shape now. Nothing locks the cross-deployment integration. |
| Information leakage | ✅ FE consumes `Doc<"pos_settlements">` directly (internal POS surface, not the external API) — acceptable per ADR-034 Layer 1 (POS FE ↔ POS BE). `bca_account_destination` stores last-4 only (ADR-012). No external API surface touched. |

## Plan fidelity

- **Task-0 corrections integrated, not bolted on.** The plan's assumed shape (`fee: number`, `settlement_date` field, no cashflow) was replaced wholesale in `lib.ts` with the confirmed shape (fee object → `net_amount`; derive WIB date from `estimated_settlement_time`; `cashflow === "MONEY_IN"` filter). Tests, the xendit-reference doc, and the URL builder (`created[gte]`, no `settlement_status` query filter) were all updated consistently. This is coherent integration.
- **Single-writer + poll-wins-on-conflict** built exactly as planned, plus an extra test (manual-over-poll) the plan didn't enumerate — good.
- **`enterSettlementManually`** follows the `createVoucher` template (authCheck-before-cache, validate, verify-PIN, commit) and adds two validations beyond the plan: impossible-calendar-date round-trip and degenerate zero-gross/zero-count. Both are tested. Sensible hardening, in scope.
- **No scope creep.** Frontend is a read list + manager manual-entry sheet + the existing home tile relabel. No settlements editing/deletion, no external API endpoint, no Frollie-Pro sync — all correctly deferred.
- **Docs** (SCHEMA pos_settlements rewrite, audit verbs, ADR-012 amendment anchor, xendit-reference confirmed-shape section) are present.

## Over/under-engineering

Appropriately scoped for v1. The pure/impure split, the single writer, and the resilient cron are all warranted (cron talks to an external API → retry is not gold-plating; it reuses the shared `cronRetry` helper rather than reinventing). The `payload` raw-row store is the one piece of speculative scaffolding, but it is cheap (optional string) and directly serves the known v1.1 reconciliation need — justified. No over-engineering found. No under-engineering except the I1 estimate-drift gap, which is correctly KYB-deferred.

---

## STAFFREVIEW FINDINGS

### Critical
(none)

### Important
- **I1.** Auto-poll upsert key derives from `estimated_settlement_time` (an estimate). If the estimate drifts to an adjacent day after a row is written, net double-counts across two day-rows and a manual row keyed to the real bank date never gets superseded. Correctly KYB-gated and the `payload` raw-rows hook exists for reconciliation, but make this an explicit named line in the Task-10 KYB follow-up issue, not just a doc footnote.

### Minor
- **R1.** `listSettlements` with no date range is a full (desc-ordered) index scan — fine for booth volume, flagging so it's not later mistaken for a bug.
- **R2.** Stale forward-reference comment in `internal.ts:14` ("`_auditSyncSkip_internal` will be added in Task 6") — the helper is already present right below it; drop the note.
- **R3.** `mdr_amount` = `gross − net` = total Xendit deductions (incl. any VAT), not MDR strictly. FE label "Biaya Xendit" is honest; add a one-line SCHEMA.md note so a future PKP flip doesn't surprise an accountant reading the column name.

### Nitpick
- **R4.** Manual entry allows `net == 0` (mdr == gross); only `net < 0` rejects. Economically near-impossible but data-coherent — deliberate boundary, documenting so it isn't "fixed."
- **R5.** `actions.ts` `"use node"` directive is justified by the argon2id PIN verify, not cargo-culted. Correct as-is.

## STAFFREVIEW COMPLETE
