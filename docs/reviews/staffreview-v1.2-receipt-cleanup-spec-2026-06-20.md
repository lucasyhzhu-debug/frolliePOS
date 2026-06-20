# Staff Review: v1.2 #13 Receipt Cleanup (SPEC)

**Date:** 2026-06-20
**Plan:** `docs/superpowers/specs/2026-06-20-v1.2-receipt-cleanup-design.md`
**Reviewers:** Staff Developer (Implementation) + Principal Developer (Architecture)
**Plan Structure:** ✅ Validated (spec-stage — file-list, decisions, tests, out-of-scope, risks all present)

---

## 1. Summary

**Overall Assessment:** Approve

A tight, well-grounded cleanup spec. Every load-bearing claim was verified against code
(`template.ts`, `escpos.ts`, `settings/internal.ts`, the test files, and the manual-BCA
invoice-leak path). The one architectural decision with teeth — fixing the manual-BCA `QRIS`
method leak — was confirmed to be a real bug and correctly scoped to `confirmed_via:"manual_bca"`
only. No Critical issues. Three improvements were folded into the spec inline during this review.

## 2. Critical Issues (Must Fix)

None.

## 3. Improvements (Recommended) — all folded into the spec

| # | Improvement | Impact | Effort |
|---|-------------|--------|--------|
| 1 | Add a `manual` (manager-PIN, `source:"manual"`) regression test asserting it still shows its real invoice method, not "Transfer Bank (manual)" | H | L |
| 2 | Note that the manual-BCA method fix is NOT retroactive to already-cached receipts (24h TTL self-heal) | M | L |
| 3 | Make the no-RRN + no-invoice (`"—"`) payment-line cases explicit test requirements on both renderers | M | L |

### Improvement 1 — lock the `manual_bca` scoping
`confirmed_via` has four values (`webhook|polling|manual|manual_bca`). Only `manual_bca` cancels
its paying invoice; the manager-PIN `manual` override keeps a real QRIS/BCA invoice that *is* the
correct method. A regression test that a `manual` txn renders `QRIS` (not the manual-transfer
label) blocks a future over-broad branch. **Folded into Tests §E.**

### Improvement 2 — cache non-retroactivity
The fix changes rendered output, but `pos_receipt_html_cache` (24h TTL) still serves old HTML for
already-rendered `manual_bca` receipts (showing `QRIS`). No forced purge is warranted for a label
change; they self-heal in ≤24h. **Folded into Risks.**

### Improvement 3 — payment-line edge shapes
`payment_method` can be a real method, a method without RRN, or `"—"` (no invoice). The single-line
collapse must be tested for all three on both renderers to prevent a trailing ` · ` dangling when
`rrn` is absent. **Folded into Tests §E.**

## 4. Refinements (Optional)

- `escpos.test.ts:20-21` has a comment referencing the emoji footer (`"Terima kasih! 💛"`); after
  the `SAMPLE_RECEIPT` footer → `"Thank you!"` change, refresh that comment (the emoji-absence
  assertion stays valid but vacuous). Trivial.

## 5. Duplication Analysis

### Existing code to leverage
| Code | Location | How to use |
|------|----------|------------|
| `ReceiptViewModel` single contract | `convex/receipts/template.ts` | Both renderers stay method-agnostic; only the upstream label derivation changes |
| `STATUS_LABELS` | `template.ts:52` | Keep exported — print query still reads `.label` for refund states |
| `confirmed_via` on full txn doc | `_getPaidTxnWithLinesForReceipt_internal` (returns `ctx.db.get` result) | Already present at runtime — no aggregate change, only a param-type widen |

### Potential duplication risks
- None. The method-label decision stays in one place (`buildVmFromTxnWithLines`); the two renderers
  do not duplicate the branch.

## 6. Phase / Wave Accuracy

Single-PR, ~5-file change. Natural ordering: settings default → method-label (internal) → both
renderers → tests → CHANGELOG. No parallelism needed.

## 7. Specialist Agent Recommendations

| Phase | Recommended Agent | Rationale |
|-------|-------------------|-----------|
| Implementation | `convex-expert` (or general) | Pure renderer/label edits + vitest; no schema/index work |

## 8. Git Workflow Assessment

Feature branch off synced `main` (pipeline-enforced). One squash PR. Pre-push: `npm run typecheck`
+ `npx vitest run` (receipts + escpos suites) + `npm run build`. Rollback = revert the single PR
(no schema migration, no data change). Deployment: renderers ship FE+BE together via the standard
atomic build (no mutation↔action rename → no deploy-skew hazard).

## 9. Documentation Checkpoints

| Phase | Docs to update |
|-------|----------------|
| Implementation | `docs/CHANGELOG.md` (rule #9). No SCHEMA.md change (no schema delta). No API_REFERENCE change (signatures stable). |

### CHANGELOG draft
~~~markdown
## v1.2 #13 — Receipt cleanup
- Paid receipts no longer print the "LUNAS" / "[ LUNAS ]" status badge (refund-state labels kept).
- Payment line collapsed to a single "{method} · {RRN}" line (no RRN → method only).
- Manual-BCA sales now render "Transfer Bank (manual)" instead of the leaked cancelled-QRIS method.
- Receipt footer default → "Thank you!"; business-name default already "FROLLIE".
- Prod pos_settings row (business name / footer) updated via /mgr/receipt — owner-owned ops step.
- Renderer change is not retroactive to receipts already cached (24h TTL self-heals).
~~~

## 10. Testing Plan Assessment

**Verdict:** Adequate

### Planned tests
| Layer | What | Test type | Status |
|-------|------|-----------|--------|
| HTML renderer | paid → no badge; refund states keep badge; payment-line shapes | vitest | planned |
| Thermal renderer | paid → no `[ LUNAS ]`; refund states keep `[ … ]`; one-line payment; footer | vitest | planned |
| Method label | `manual_bca` → "Transfer Bank (manual)" no RRN (both renderers) | vitest | planned |
| Method label | `manual` (PIN override) → real invoice method (scoping lock) | vitest | planned |
| Print query | `getReceiptForPrint` still returns label string | convex-test | planned |

### Regression risk
- `template.test.ts:31-36`, `escpos.test.ts:5-22` assert `LUNAS` present — both flip to absent for
  paid. Expected and listed.

## 11. Edge Cases to Address

- [x] `manual_bca` with NO prior invoice (`"—"`) → still labels "Transfer Bank (manual)" (branch
      precedes invoice read).
- [x] No-RRN method → no dangling ` · `.
- [x] `manual` vs `manual_bca` disambiguation (scoping test).
- [x] Refund-state badges preserved on both renderers.
- [x] Cached-receipt non-retroactivity acknowledged.

## 12. Approval Conditions

**To approve:** none outstanding (no Criticals).
**Folded in during review:** Improvements 1–3 (now in the spec).

**Verdict:** ✅ Approved — proceed to writing-plans.

---

*Generated by /staffreview*
