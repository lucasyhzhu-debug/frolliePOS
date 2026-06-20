# Staff review — v1.2 #13 Receipt cleanup

**Branch:** `worktree-v12-receipt-cleanup` · **Base:** main (`fa9a173`) · **Head:** `9b22c67`
**Reviewer lens:** Senior-engineer architectural review through the deep-module / surface-API lens (ADR-034).
**Date:** 2026-06-20

---

## Summary

**Module-depth verdict: unchanged (correctly so).** The change is exemplary deep-module hygiene: it adds the one method-aware branch at the single upstream derivation point (`buildVmFromTxnWithLines` in `receipts/internal.ts`) and leaves both renderers (`template.ts` HTML, `escpos.ts` thermal) method-agnostic. The `ReceiptViewModel` remains the single seam between data assembly and rendering — neither renderer learned anything new about payment provenance. The public/external API surface (ADR-034 Layer 2) is untouched; the only interface widening is on a private `internalQuery` helper's param type, which is appropriate, not a leak. Tests are green (54 passing across `convex/receipts` + `escpos`), typecheck premise holds, and the plan's load-bearing promise — **no `convex/transactions/internal.ts` change** — is confirmed clean. This is a tight, well-scoped, well-tested cleanup. No critical or important issues. A couple of refinements around a now-confirmed rule-of-three on the manual-BCA label and a casing-drift nitpick.

---

## Critical Issues

None.

---

## Improvements

### I1 — `manual_bca` label is now a confirmed rule-of-three; flag the extraction candidate (don't necessarily fix now)

The receipt's hardcoded `"Transfer Bank (manual)"` (`receipts/internal.ts:63`) is the **third** independent place this concept is labelled in the codebase:

1. `src/lib/pos-labels.ts:34` — `CONFIRMED_VIA_LABEL.manual_bca → "history.confirmedManualBca"` (history detail card).
2. `src/routes/sale/charge-success.tsx:116` — `manual_bca → t("chargeSuccess.methodBankTransfer")` (charge-success screen).
3. `convex/receipts/internal.ts:63` — `"Transfer Bank (manual)"` (printed/digital receipt).

The rule-of-three threshold is reached. **However, extraction here is NOT a simple consolidation**, because the three labels live on opposite sides of a deliberate architectural boundary:

- (1) and (2) are **on-screen** surfaces and are i18n-keyed (ADR-049 — resolve via `t()`).
- (3) is the **printed receipt**, which `pos-labels.ts:1-5` explicitly carves out: *"The PRINTED receipt (escpos/template) keeps its own labels and is out of i18n scope."* The receipt body stays Indonesian per ADR-049, and the footer-only English move in this PR respects that.

So a naive shared constant would either drag the receipt into the i18n dictionary (violating the documented receipt-out-of-scope rule) or force the on-screen surfaces to consume a raw string (losing their `t()` keying). The correct future extraction is a **provenance→canonical-key map** with two resolvers (one `t()`-based for screens, one literal for the receipt), not a single shared string. That is more than this cleanup PR should take on.

**Recommendation:** leave as-is, but drop a one-line POC-tradeoff comment at `receipts/internal.ts:63` noting the deliberate duplication and the i18n-boundary reason, so the next reviewer who greps `Transfer Bank` doesn't re-derive this. This matches the house "annotate deliberate omissions inline" practice.

---

## Refinements

### R1 — Renderer-symmetry divergence (HTML middot `·` vs thermal ASCII `-`) is justified AND documented

This is the focus-area question, and the answer is clean. The divergence is intentional and traceable:

- Plan §"Global Constraints" calls it out: *"The HTML payment separator is a middot `·`; the thermal separator must be an ASCII hyphen `-` (a middot would be silently folded away). Deliberate per-medium divergence."*
- The thermal code self-documents the reason at `escpos.ts:79-80`: `ascii()` strips anything outside `\x20-\x7E`, so a middot would vanish on the print head.
- The CHANGELOG entry records both forms.

No accidental drift. **Could a shared helper reduce duplication without coupling the renderers?** No — and it shouldn't. The two "join method + rrn with a separator" expressions are one line each, use *different* separators by physical-medium necessity, and live in two runtime worlds (V8-safe server template vs browser thermal encoder). A shared `joinPaymentLine(method, rrn, sep)` helper would (a) need to live in a shared V8-safe module both can import, (b) save ~zero lines, and (c) couple two renderers the architecture deliberately keeps independent. There is no third consumer of the payment-line join. This is correctly left un-extracted.

### R2 — Widened `txn` param type is the right call, not a Doc-shape leak

`buildVmFromTxnWithLines` adds `confirmed_via?: "webhook" | "polling" | "manual" | "manual_bca" | null` to its already-narrowed structural `txn` param (`receipts/internal.ts:36`). Worth checking this isn't a "caller must now know the Doc shape" leak (ADR-034 Layer 3 — data is private). It isn't, for three reasons:

1. The param type was **already** a hand-narrowed structural subset of the txn doc (7 fields, not `Doc<"pos_transactions">`), so widening it by one field follows the established local convention rather than reaching for the full Doc.
2. The literal union **exactly mirrors** `transactions/schema.ts:38-42` (`webhook | polling | manual | manual_bca`, optional). The `| null` tolerance is defensive belt-and-braces. Verified byte-for-byte.
3. Both callers (`_buildViewModel_internal`, `_renderReceiptByToken_internal`) feed the output of `_getPaidTxnWithLines*_internal`, which returns the **full** `ctx.db.get(...)` doc (`transactions/internal.ts:428,454`). So `confirmed_via` is present at runtime and the structurally-widened type is satisfied without any caller-side change. This is the plan's verify-first claim #2, confirmed.

This is intra-module structural typing, not an external-contract widening. Appropriate.

### R3 — Graft integrity: no new assumption that complicates the v1.1+ Frollie Pro graft

The external API surface (`convex/api/v1/`) is untouched. The receipt renderers and `buildVmFromTxnWithLines` are POS-internal (ADR-034 Layer 3 — freely evolvable). Sourcing the payment label from `txn.confirmed_via` (the txn's own provenance) rather than from a possibly-cancelled `pos_xendit_invoices` row actually **reduces** coupling — the receipt no longer depends on the lifecycle state of a dead invoice. Nothing here pins a shape the Frollie Pro sales-sync contract consumes (that contract keys off `receiptNumber`/`staffCode`/etc., not receipt-render strings). Graft is clean.

### R4 — Plan fidelity: built == planned, no scope creep

Walked the diff against all 5 plan tasks:

- **Task 1 (English footer default):** `RECEIPT_DEFAULTS.footer_text → "Thank you!"` + `SAMPLE_RECEIPT` match. Propagation tested via the real no-`pos_settings`-row path (not a tautological const assertion), plus business-name `"FROLLIE"` co-asserted. ✓
- **Task 2 (HTML — drop paid badge, one-line payment):** `statusBadge` guarded on `status === "paid"`; refund states keep their badge (tested for both `SEBAGIAN DIKEMBALIKAN` and `DIKEMBALIKAN`); payment block collapsed; `STATUS_LABELS` still exported. ✓
- **Task 3 (thermal — same):** `_status`→`status` rename, paid-badge suppressed, one-line ASCII payment, refund-badge test added. ✓
- **Task 4 (manual_bca label):** branch added; param type widened; the **scoping-lock test** for manager-PIN `manual` (keeps real invoice method/RRN) is present — this is the important guard that the `manual_bca` fix doesn't bleed onto the `manual` override. ✓
- **Task 5 (CHANGELOG + verification):** dated entry present, includes the non-retroactive-cache + owner-owned-ops notes. ✓

**Plan's NO-`convex/transactions/internal.ts`-change promise: confirmed** — `git diff main..HEAD -- convex/transactions/internal.ts` is empty. The full-doc-returning helpers made the param-widen sufficient.

No shortcuts spotted: the badge-suppression is gated strictly on `paid` (refund signal preserved), the manual-BCA branch *skips* the now-irrelevant invoice read rather than reading-then-ignoring (a small efficiency win on that path), and the tests assert the previously-leaked `qris-rrn-xyz` is dropped.

### R5 — Over/under-engineering: the `manual_bca` branch is right-sized

The branch is an `if/else` that swaps a hardcoded label for the invoice read. It does **not** over-abstract into a provenance-label table (which would be premature given R1's two-resolver complication). It does **not** under-build (the scoping test proves `manual` is unaffected). The only note is R1's deferred extraction, already captured. The `"—"` em-dash placeholder for the no-invoice case is preserved unchanged.

---

## Nitpicks

### N1 — Casing drift: receipt `"Transfer Bank (manual)"` vs on-screen `"Transfer bank (manual)"`

The receipt label capitalises **B**ank (`receipts/internal.ts:63`), while both on-screen surfaces use lowercase **b**ank (`id.ts:60` `"Transfer bank (manual)"`, `id.ts:759` `"Transfer bank (manual)"`). This is almost certainly unintentional rather than a deliberate per-medium choice — the receipt body is otherwise Indonesian, so neither casing is "more correct" by locale here, but the inconsistency across surfaces for the same concept will read as sloppy if anyone compares a screen to a printout. Cheap to align to the existing on-screen `"Transfer bank (manual)"`. Non-blocking.

### N2 — Stale interface comment on `ReceiptSettings.footer_text`

`template.ts:20` still documents the field as `// v0.5.3b configurable; default "Terima kasih! 💛"`. The default moved to `"Thank you!"` this PR. Trivially stale; update the inline comment to avoid future confusion. Non-blocking.

### N3 — PR-A vintage comments now slightly misleading post-cleanup

`receipts/internal.ts:127-133` and `template.ts:4-5` carry "PR A: refunds[] always empty / PR B populates" scaffolding notes from the original receipt build-out. They're not introduced by this PR and not in scope, but the `_buildViewModel_internal` docstring claiming `refunds[]` "is always empty" is factually wrong today (refunds are populated). Worth a sweep in a future touch; not this PR's job. Noted for completeness only.

---

## Verdict

**Approve.** Architecturally disciplined, fully tested, faithful to the plan, zero graft risk. The single substantive follow-up (R1/I1 — annotate the now-confirmed rule-of-three on the manual-BCA label and defer the two-resolver extraction) and the N1 casing nitpick are the only things worth touching, and none block merge.
