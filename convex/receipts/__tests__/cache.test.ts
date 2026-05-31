import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { describe, it, expect } from "vitest";

describe("receipts cache helpers", () => {
  it("write + get round-trip returns html", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.receipts.internal._writeCacheEntry_internal, {
      token: "tok-roundtrip",
      html: "<p>cached</p>",
    });
    const got = await t.query(internal.receipts.internal._getCachedReceipt_internal, {
      token: "tok-roundtrip",
    });
    expect(got?.html).toBe("<p>cached</p>");
  });

  it("write sets expires_at = now + 24h", async () => {
    const t = convexTest(schema);
    const before = Date.now();
    await t.mutation(internal.receipts.internal._writeCacheEntry_internal, {
      token: "tok-ttl", html: "<p>x</p>",
    });
    const after = Date.now();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("pos_receipt_html_cache")
        .withIndex("by_token", (q) => q.eq("token", "tok-ttl"))
        .unique();
      expect(row).toBeTruthy();
      const expected_min = before + 24 * 60 * 60 * 1000;
      const expected_max = after + 24 * 60 * 60 * 1000;
      expect(row!.expires_at).toBeGreaterThanOrEqual(expected_min);
      expect(row!.expires_at).toBeLessThanOrEqual(expected_max);
    });
  });

  it("expired entry returns null from get", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("pos_receipt_html_cache", {
        token: "tok-expired", html: "<p>stale</p>",
        expires_at: Date.now() - 1000,
      });
    });
    const got = await t.query(internal.receipts.internal._getCachedReceipt_internal, {
      token: "tok-expired",
    });
    expect(got).toBeNull();
  });

  it("write replaces existing entry (idempotent upsert)", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.receipts.internal._writeCacheEntry_internal, {
      token: "tok-replace", html: "<p>v1</p>",
    });
    await t.mutation(internal.receipts.internal._writeCacheEntry_internal, {
      token: "tok-replace", html: "<p>v2</p>",
    });
    const got = await t.query(internal.receipts.internal._getCachedReceipt_internal, {
      token: "tok-replace",
    });
    expect(got?.html).toBe("<p>v2</p>");

    // exactly one row remains
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("pos_receipt_html_cache")
        .withIndex("by_token", (q) => q.eq("token", "tok-replace"))
        .collect();
      expect(rows.length).toBe(1);
    });
  });
});
