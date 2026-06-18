import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("sendErrorAlert", () => {
  it("skips silently when ops role unbound", async () => {
    const t = convexTest(schema);
    const reportId = await t.run(async (ctx) =>
      ctx.db.insert("pos_error_reports", {
        kind: "crash", message: "boom", signature: "sig", alerted: true, created_at: 0,
      }),
    );
    const res = await t.action(internal.ops.actions.sendErrorAlert, { reportId });
    expect(res).toEqual({ skipped: "role_unbound" });
  });
});
