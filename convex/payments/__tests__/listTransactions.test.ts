import { describe, it, expect } from "vitest";
import { buildListTransactionsUrl } from "../xendit";

describe("payments/xendit buildListTransactionsUrl", () => {
  it("targets /transactions with the created[gte] date window and no settlement_status filter", () => {
    const url = buildListTransactionsUrl({ settledAfterIso: "2026-06-01" });
    expect(url).toContain("/transactions");
    // created[gte] is URL-encoded as created%5Bgte%5D by URLSearchParams
    expect(decodeURIComponent(url)).toContain("created[gte]=2026-06-01");
    expect(url).not.toMatch(/settlement_status=/); // confirmed: no such query filter exists
  });
  it("threads the after_id pagination cursor when provided", () => {
    const url = buildListTransactionsUrl({ settledAfterIso: "2026-06-01", afterId: "txn_123" });
    expect(url).toContain("after_id=txn_123");
  });
});
