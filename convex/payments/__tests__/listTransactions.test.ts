import { describe, it, expect } from "vitest";
import { buildListTransactionsUrl } from "../xendit";

describe("payments/xendit buildListTransactionsUrl", () => {
  it("targets /transactions with the updated[gte] date-time window and no settlement_status filter", () => {
    // RFC3339 date-time, NOT a bare YYYY-MM-DD: Xendit rejects date-only with a
    // 400 `updated/gte must match format "date-time"` (issue #66 live-verify).
    const url = buildListTransactionsUrl({ settledAfterIso: "2026-06-03T00:00:00.000Z" });
    expect(url).toContain("/transactions");
    // updated[gte] (bracket notation, URL-encoded as updated%5Bgte%5D) — windows
    // on settlement-posting updates so late-settling old txns self-heal (G5).
    // The date-time value (incl. colons) must round-trip through URL encoding.
    expect(decodeURIComponent(url)).toContain("updated[gte]=2026-06-03T00:00:00.000Z");
    expect(url).not.toMatch(/created\[gte\]/); // switched off created-window (would miss late settlements)
    expect(url).not.toMatch(/settlement_status=/); // confirmed: no such query filter exists
  });
  it("threads the after_id pagination cursor when provided", () => {
    const url = buildListTransactionsUrl({ settledAfterIso: "2026-06-03T00:00:00.000Z", afterId: "txn_123" });
    expect(url).toContain("after_id=txn_123");
  });
});
