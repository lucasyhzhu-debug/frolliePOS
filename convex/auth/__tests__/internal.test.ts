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
    const sessionId = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { is_open: false,
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as any);
      return ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-inactive",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any);
    });
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
    const outletId = await t.run(async (ctx) =>
      ctx.db.insert("outlets", { is_open: false,
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as any),
    );
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-active",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any),
    );
    const result = await t.query(
      internal.auth.internal._resolveSession_internal,
      { sessionId },
    );
    // v2.0 Task 12 (ENFORCE): _resolveSession_internal now also returns outlet_id.
    expect(result).toEqual({ staffId, deviceId: "dev-active", outlet_id: outletId });
  });

  it("returns null when the session has ended even if the staff is still active", async () => {
    const t = convexTest(schema);
    const staffId = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        code: "S-ENDED",
        name: "Locked User",
        role: "staff",
        active: true,
        pin_hash: "x",
        created_at: Date.now(),
      }),
    );
    const sessionId = await t.run(async (ctx) => {
      const outletId = await ctx.db.insert("outlets", { is_open: false,
        code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      } as any);
      return ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-ended",
        started_at: Date.now() - 60_000,
        ended_at: Date.now() - 10_000,
        end_reason: "manual_lock",
        outlet_id: outletId,
      } as any);
    });
    const result = await t.query(
      internal.auth.internal._resolveSession_internal,
      { sessionId },
    );
    expect(result).toBeNull();
  });
});
