// convex/api/v1/__tests__/request-log.test.ts
import { convexTest } from "convex-test";
import schema from "../../../schema";
import { describe, it, expect } from "vitest";
import { internal } from "../../../_generated/api";

describe("api_request_log", () => {
  it("writes one row per request, incl. unauthenticated attempts", async () => {
    const t = convexTest(schema);
    // unauthenticated → still logged with null token_id
    await t.fetch("/api/v1/transactions", { method: "GET" });
    // authenticated success
    const { rawToken } = await t.mutation(internal.api.v1.internal._issueApiToken_internal, {
      label: "frollie-pro-prod", endpointAllowList: ["/api/v1/transactions"], rateLimitRpm: 1000 });
    await t.fetch("/api/v1/transactions", { method: "GET", headers: { Authorization: `Bearer ${rawToken}` } });

    const rows = await t.run((ctx) => ctx.db.query("api_request_log").collect());
    expect(rows).toHaveLength(2);
    const unauth = rows.find((r: any) => r.http_status === 401);
    expect(unauth!.token_id).toBeUndefined();
    expect(unauth!.endpoint).toBe("/api/v1/transactions");
    const ok = rows.find((r: any) => r.http_status === 200);
    expect(ok!.token_id).toBeDefined();
    expect(typeof ok!.returned_count).toBe("number");
  });
});
