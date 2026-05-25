# 021. Receipt URL via Convex HTTP action

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Receipts

## Context

After payment, the customer wants a viewable receipt — to send to themselves via WhatsApp, to expense, to keep. A signed URL pointing to a public-ish web page is the cleanest delivery: no app install, no email gate, just a link they can open anywhere.

## Decision

`GET /r/<receipt_token>` is served by a **Convex HTTP action** that returns static HTML. **No auth required** — the token IS the capability. Token = 32-byte URL-safe random per transaction. One token per transaction.

## Alternatives considered

- **PDF generation.** Rejected: bigger file, harder to render in WhatsApp link previews, no value over HTML for the receipt format we ship.
- **External hosting (S3 + signed URL).** Rejected: extra service for a job Convex HTTP actions handle natively.
- **Numeric receipt numbers as URL paths (e.g., `/r/R-2026-0058`).** Rejected: enumerable — anyone could iterate receipt numbers to view receipts they didn't make. Random token closes the enumeration surface.

## Consequences

- *Easier:* one URL pattern, customer-friendly. WhatsApp share-link previews render naturally.
- *Token is the capability:* long enough to be unguessable (32-byte URL-safe ≈ 256 bits of entropy). Leakage of one receipt's URL exposes only that receipt — no enumeration possible.
- *Schema:* `pos_transactions.receipt_token` (unique, indexed). Receipt number (`R-YYYY-NNNN`) is the human-readable identifier shown ON the receipt; the token is for URL access.
- *HTML retention:* see [ADR-022](./022-receipt-html-retention-24h.md).
- *Related:* receipt template content driven by `pos_settings` (business name, address, NPWP, header/footer copy) — see ReceiptConfig screen and the strategic-foundations PPN note.
