# 039. Receipt-after-refund display contract

**Date:** 2026-05-31
**Status:** Accepted
**Group:** Receipts

## Context

[ADR-008](./008-refunds-as-new-rows.md) makes refunds new rows and computes transaction status on read; the original `pos_transactions` row is never mutated. [ADR-021](./021-receipt-url-convex-http-action.md) serves a public receipt at `GET /r/<token>` (token = the capability, one per transaction), and [ADR-022](./022-receipt-html-retention-24h.md) caches the rendered HTML for 24h, regenerating from permanent transaction data on miss.

These two facts collide the moment a refund is issued against a transaction whose receipt link is already in the customer's hands. The v0.5.1 staffreview flagged this as a Critical-2 blocker with four unanswered questions that **must** be locked before code:

1. Does a refund **mutate** the receipt?
2. Does a refund **invalidate the cache**?
3. Does the **original token stay valid** post-refund?
4. How are **partial-refund lines displayed**?

Without an explicit contract, the implementation could (a) leave a stale "PAID, full amount" receipt live after a refund — misleading the customer, or (b) mint a new token and orphan the link the customer already saved. Both are wrong.

## Decision

The public receipt is a **live projection of the transaction's current refund state**, served from a **stable token**, with the **original sale figures never mutated**. Four-part contract, answering the four questions in order:

### 1. Refund does NOT mutate the receipt's underlying data — it re-projects it

The receipt is rendered from transaction data + the set of `pos_refunds` rows referencing it, **computed at render time** (consistent with ADR-008's status-on-read). The original sale lines, prices, and totals on `pos_transactions` / `pos_transaction_lines` are immutable. A refund adds rows; the receipt renderer reads them and projects the current state. "Mutate the receipt" is the wrong mental model — the receipt has no stored truth of its own beyond the cached HTML blob.

### 2. Refund DOES invalidate the cached HTML — purge, don't update

On refund commit (the ledger write, at `settlement_status: pending` per [ADR-038](./038-refund-settlement-manual-v1.md)), the transaction's cached receipt HTML entry ([ADR-022](./022-receipt-html-retention-24h.md), keyed by token) is **purged**. The next load regenerates from current data, now reflecting the refund. We purge rather than eagerly re-render: the customer may never reopen the link, so lazy regeneration on next access is cheaper and always correct. A subsequent partial refund purges again. The settlement transition (`pending → settled`) does **not** purge — settlement is internal and invisible to the receipt (see point 4).

### 3. The original token stays valid — same URL, updated content

One token per transaction ([ADR-021](./021-receipt-url-convex-http-action.md)) is preserved through refunds. The link the customer already saved keeps working and now shows the refund. No new token is minted on refund (minting a new token is reserved for the 24h-expiry re-send path in ADR-022, which is an availability concern, not a content-change concern). Refunding does not expire or rotate the token.

### 4. Partial-refund line display: original preserved, refund annotated, settlement hidden

The receipt shows:

- A **status header** computed on read — `LUNAS` (paid) / `SEBAGIAN DIKEMBALIKAN` (partial refund) / `DIKEMBALIKAN` (refunded) — matching ADR-008's computed status.
- **Original sale lines at their original qty and price, unchanged.** A partially-refunded line is annotated (e.g. "2 dari 3 dikembalikan") rather than rewritten — the customer can still see what they originally bought and paid.
- A **refund summary block** below the original totals: refund amount(s), refund date(s), and the original total, ending in a computed **net retained** figure. Multiple partial refunds list as multiple entries.
- **Settlement status is NOT shown.** The customer-facing receipt reflects the refund *ledger* (a refund was issued) but never the internal `settlement_status` (`pending`/`settled`) from [ADR-038](./038-refund-settlement-manual-v1.md) — whether the operator has finished moving the cash out-of-band is internal bookkeeping, not the customer's concern. This keeps ADR-038's internal/external boundary clean.

## Alternatives considered

- **Mint a fresh token on refund, expire the old one.** Pros: a refunded receipt gets a "new" URL the staffer can re-share. Cons: silently breaks the link the customer already saved — they reopen it and get "expired" for a transaction that very much exists. Rejected: token stability is a customer-facing promise; refunds shouldn't break saved links.
- **Eagerly re-render the cached HTML on refund commit (update, don't purge).** Pros: next load is instant. Cons: wasted render for the common case where the customer never reopens; adds a render step inside the refund mutation's critical path. Rejected: lazy regenerate-on-miss (ADR-022's existing model) is simpler and always correct.
- **Rewrite the line to its post-refund qty/price (e.g. show "1 cookie" after refunding 2 of 3).** Pros: simpler single-number display. Cons: destroys the record of what the customer originally bought; a customer comparing the receipt to what they received at the counter would be confused. Rejected: original-preserved + annotated is the honest projection and matches ADR-008's "never lose the original."
- **Show settlement status on the public receipt.** Pros: customer sees "refund pending" vs "refund completed." Cons: leaks internal manual-settlement bookkeeping; "pending" on a customer receipt invites support questions about a process they have no visibility into. Rejected: settlement is a manager-side concern (ADR-038); the receipt reflects the ledger only.

## Consequences

- *Easier:* one stable URL through the transaction's whole life — sale, partial refund, full refund. Customers' saved links never break.
- *Easier:* the renderer has a single source of truth (transaction data + refund rows, computed on read). No "receipt state" to keep in sync.
- *Harder:* the refund mutation must purge the receipt cache entry as part of its commit. A missed purge leaves a stale "fully paid" receipt live for up to 24h — so cache purge is a **required step in the refund flow**, asserted by a test.
- *Harder:* the receipt template grows a refund-summary section and per-line refund annotations; the hardcoded v0.5.1 template (config UI deferred to v0.5.3) must include these from the start, not bolt them on later.
- *Breaks if wrong:* if a future change lets a refund mutate original line data (instead of adding rows), this contract and ADR-008 both break — the receipt would lose the original sale truth. The "original preserved, refund annotated" rule is load-bearing.
- *Migration if reversed:* none — the receipt is a projection; changing the projection is a renderer change, no stored data to migrate.

## Affects other ADRs

- **Extends [ADR-008](./008-refunds-as-new-rows.md):** applies status-on-read + original-preserved to the receipt surface specifically.
- **Extends [ADR-021](./021-receipt-url-convex-http-action.md):** confirms one-token-per-transaction survives refunds; refund never rotates the token.
- **Extends [ADR-022](./022-receipt-html-retention-24h.md):** adds refund commit as a cache-purge trigger, distinct from the 24h-expiry re-send path.
- **Relates to [ADR-038](./038-refund-settlement-manual-v1.md):** the receipt reflects the refund ledger; `settlement_status` is deliberately excluded from the customer-facing surface.
