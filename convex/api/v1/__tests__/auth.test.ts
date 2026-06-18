// convex/api/v1/__tests__/auth.test.ts
import { convexTest } from "convex-test";
import schema from "../../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../../_generated/api";

async function issue(t: any, over: Partial<{ endpointAllowList: string[]; rateLimitRpm: number }> = {}) {
  return await t.mutation(internal.api.v1.internal._issueApiToken_internal, {
    label: "test",
    endpointAllowList: over.endpointAllowList ?? ["/api/v1/transactions"],
    rateLimitRpm: over.rateLimitRpm ?? 60,
  });
}

describe("verifyBearerToken (via the transactions route)", () => {
  it("401 when Authorization header is missing", async () => {
    const t = convexTest(schema);
    const res = await t.fetch("/api/v1/transactions", { method: "GET" });
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });
  it("200 with a valid token", async () => {
    const t = convexTest(schema);
    const { rawToken } = await issue(t);
    const res = await t.fetch("/api/v1/transactions", {
      method: "GET", headers: { Authorization: `Bearer ${rawToken}` },
    });
    expect(res.status).toBe(200);
  });
  it("403 when the path is not allow-listed", async () => {
    const t = convexTest(schema);
    const { rawToken } = await issue(t, { endpointAllowList: ["/api/v1/refunds"] });
    const res = await t.fetch("/api/v1/transactions", {
      method: "GET", headers: { Authorization: `Bearer ${rawToken}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("ENDPOINT_NOT_ALLOWED");
  });
  it("401 for a revoked token", async () => {
    const t = convexTest(schema);
    const { rawToken } = await issue(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("api_tokens").first();
      await ctx.db.patch(row!._id, { revokedAt: Date.now() });
    });
    const res = await t.fetch("/api/v1/transactions", {
      method: "GET", headers: { Authorization: `Bearer ${rawToken}` },
    });
    expect(res.status).toBe(401);
  });
  it("429 once the RPM bucket is exceeded", async () => {
    const t = convexTest(schema);
    const { rawToken } = await issue(t, { rateLimitRpm: 1 });
    const h = { Authorization: `Bearer ${rawToken}` };
    expect((await t.fetch("/api/v1/transactions", { method: "GET", headers: h })).status).toBe(200);
    const res2 = await t.fetch("/api/v1/transactions", { method: "GET", headers: h });
    expect(res2.status).toBe(429);
    expect(res2.headers.get("Retry-After")).toBeTruthy();
  });
});
