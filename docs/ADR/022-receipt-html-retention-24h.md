# 022. Receipt HTML retention: 24h; data: forever

**Date:** 2026-05-21
**Status:** Accepted
**Group:** Receipts

## Context

The rendered HTML for a receipt is regenerable from the underlying transaction data. The transaction data itself is permanent (audit log, financial record). Storing every receipt's HTML blob forever is wasteful when we can rebuild on demand.

## Decision

Rendered receipt HTML cached for 24 hours (Convex storage / KV). Expired links redirect to an "ask staff to re-send" page that staff can hit Re-send on, generating a fresh URL with a new token. Underlying transaction data is permanent.

## Alternatives considered

- **Cache forever.** Rejected: storage bloat. At even modest scale (100 receipts/day × 365 days × 5 years = 180k blobs) the cumulative size adds up for no operational benefit.
- **No caching, regenerate on every load.** Rejected: slow when the same customer reopens the link multiple times within minutes (refresh, re-share, etc.).
- **Cache only on first access (lazy).** Considered. Default is to cache on first generate (at sale completion) since that's also when the customer is most likely to open it.

## Consequences

- *Easier:* common case (customer opens link within hours) is fast. Storage stays bounded.
- *Old links:* customers asking for receipts months after the fact get a "link expired" page that staff can resolve via History → Re-send. New token + fresh HTML cache.
- *Refunds for ancient transactions still work* — they read from transaction data, not the HTML cache.
- *Implementation:* Convex storage entry keyed by token, with `expires_at = created_at + 24h`. Scheduled reaper cleans expired entries.
