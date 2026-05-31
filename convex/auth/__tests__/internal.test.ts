import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("_resolveSession_internal — staff active gate (v0.5.1)", () => {
  it("returns null when the staff record is deactivated even though the session is open", async () => {
    const t = convexTest(schema);
    const staffId = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        code: "S-INACTIVE",
        name: "Inactive User",
        role: "staff",
        active: false,
        pin_hash: "x",
        created_at: Date.now(),
      }),
    );
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-inactive",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      }),
    );
    const result = await t.query(
      internal.auth.internal._resolveSession_internal,
      { sessionId },
    );
    expect(result).toBeNull();
  });

  it("returns the resolved session when the staff is active and session is open", async () => {
    const t = convexTest(schema);
    const staffId = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        code: "S-ACTIVE",
        name: "Active User",
        role: "staff",
        active: true,
        pin_hash: "x",
        created_at: Date.now(),
      }),
    );
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-active",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      }),
    );
    const result = await t.query(
      internal.auth.internal._resolveSession_internal,
      { sessionId },
    );
    expect(result).toEqual({ staffId, deviceId: "dev-active" });
  });
});
