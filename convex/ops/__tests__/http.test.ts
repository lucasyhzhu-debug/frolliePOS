import { describe, it, expect, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";

const TEST_TOKEN = "test-ops-token-1234";

beforeEach(() => {
  process.env.OPS_INGEST_TOKEN = TEST_TOKEN;
});

describe("/ops/error httpAction", () => {
  it("204s on bad token, no row written", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/ops/error", {
      method: "POST",
      headers: { "x-ops-token": "wrong-token", "content-type": "application/json" },
      body: JSON.stringify({ kind: "crash", message: "boom" }),
    });
    expect(res.status).toBe(204);
    const rows = await t.run(async (ctx) => ctx.db.query("pos_error_reports").collect());
    expect(rows).toHaveLength(0);
  });

  it("204s when OPS_INGEST_TOKEN not set", async () => {
    delete process.env.OPS_INGEST_TOKEN;
    const t = convexTest(schema);
    const res = await t.fetch("/ops/error", {
      method: "POST",
      headers: { "x-ops-token": TEST_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ kind: "crash", message: "boom" }),
    });
    expect(res.status).toBe(204);
    const rows = await t.run(async (ctx) => ctx.db.query("pos_error_reports").collect());
    expect(rows).toHaveLength(0);
  });

  it("204s on oversized body", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/ops/error", {
      method: "POST",
      headers: { "x-ops-token": TEST_TOKEN, "content-type": "application/json" },
      body: "x".repeat(17_000),
    });
    expect(res.status).toBe(204);
  });

  it("204s on bad JSON", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/ops/error", {
      method: "POST",
      headers: { "x-ops-token": TEST_TOKEN, "content-type": "application/json" },
      body: "not-json{",
    });
    expect(res.status).toBe(204);
  });

  it("204s on unknown kind", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/ops/error", {
      method: "POST",
      headers: { "x-ops-token": TEST_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ kind: "unknown-kind", message: "boom" }),
    });
    expect(res.status).toBe(204);
  });

  it("204s when message missing", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/ops/error", {
      method: "POST",
      headers: { "x-ops-token": TEST_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ kind: "crash" }),
    });
    expect(res.status).toBe(204);
  });

  it("200s and writes row with valid token + payload", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/ops/error", {
      method: "POST",
      headers: { "x-ops-token": TEST_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ kind: "crash", message: "real error", route: "/sale" }),
    });
    expect(res.status).toBe(200);
    const rows = await t.run(async (ctx) => ctx.db.query("pos_error_reports").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("real error");
    expect(rows[0].route).toBe("/sale");
  });
});
