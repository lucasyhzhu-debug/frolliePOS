import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

export async function seedStaff(
  t: ReturnType<typeof convexTest>,
  name: string,
  pin: string,
  role: "staff" | "manager" = "staff",
) {
  // Tests reuse the same hashing routine as production (no parallel
  // hashing impl). Route through the Node action so jsdom doesn't try
  // to evaluate it.
  return await t.action(internal.authActions._seedHashedStaff_internal, {
    name, pin, role,
  });
}

describe("getActiveStaff", () => {
  it("returns active staff only, name+role+_id (no pin_hash)", async () => {
    const t = convexTest(schema);
    await seedStaff(t, "Citra", "1234");
    await seedStaff(t, "Bayu", "5678");
    await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "Old", pin_hash: "x", role: "staff", active: false, created_at: 0,
      })
    );

    const rows = await t.query(api.auth.public.getActiveStaff, {});
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveProperty("pin_hash");
    expect(rows.map((s: { name: string }) => s.name).sort()).toEqual(["Bayu", "Citra"]);
  });
});

describe("getSession", () => {
  it("returns the active session shape", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Citra", "1234");
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-1",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      })
    );
    const s = await t.query(api.auth.public.getSession, { sessionId });
    expect(s).not.toBeNull();
    expect(s!.staff.name).toBe("Citra");
  });

  it("returns null for ended sessions", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Citra", "1234");
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "dev-1",
        started_at: Date.now() - 60_000,
        ended_at: Date.now(),
        end_reason: "manual_lock",
      })
    );
    const s = await t.query(api.auth.public.getSession, { sessionId });
    expect(s).toBeNull();
  });

  it("returns null when staff has been deactivated", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Citra", "1234");
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("staff_sessions", {
        staff_id: staffId, device_id: "dev-1",
        started_at: Date.now(), ended_at: null, end_reason: null,
      })
    );
    await t.run(async (ctx) => ctx.db.patch(staffId, { active: false }));
    const s = await t.query(api.auth.public.getSession, { sessionId });
    expect(s).toBeNull();
  });
});

describe("loginWithPin (action)", () => {
  it("creates a session on correct PIN + logs staff.login", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Citra", "1234");

    const { sessionId, role } = await t.action(api.authActions.loginWithPin, {
      staffId, pin: "1234", deviceId: "dev-1", idempotencyKey: crypto.randomUUID(),
    });

    expect(role).toBe("staff");
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.ended_at).toBeNull();

    const audits = await t.query(internal.audit.internal._list_internal, { action: "staff.login" });
    expect(audits).toHaveLength(1);
  });

  it("idempotent — same key returns cached response + skips argon2", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Citra", "1234");
    const key = crypto.randomUUID();

    const first = await t.action(api.authActions.loginWithPin, {
      staffId, pin: "1234", deviceId: "dev-1", idempotencyKey: key,
    });
    const second = await t.action(api.authActions.loginWithPin, {
      staffId, pin: "1234", deviceId: "dev-1", idempotencyKey: key,
    });
    expect(second.sessionId).toBe(first.sessionId);

    // Only one staff.login audit row (second call short-circuited on cache)
    const audits = await t.query(internal.audit.internal._list_internal, { action: "staff.login" });
    expect(audits).toHaveLength(1);
  });

  it("rejects wrong PIN + logs staff.failed_pin + bumps fail_count", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Citra", "1234");

    await expect(
      t.action(api.authActions.loginWithPin, {
        staffId, pin: "0000", deviceId: "dev-1", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/INVALID_PIN/);

    const attempt = await t.run(async (ctx) =>
      ctx.db.query("pos_auth_attempts").withIndex("by_staff", (q) => q.eq("staff_id", staffId)).unique()
    );
    expect(attempt?.fail_count).toBe(1);

    const audits = await t.query(internal.audit.internal._list_internal, { action: "staff.failed_pin" });
    expect(audits).toHaveLength(1);
  });

  it("locks out after 3 fails for 60s", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Citra", "1234");

    for (let i = 0; i < 3; i++) {
      await t.action(api.authActions.loginWithPin, {
        staffId, pin: "0000", deviceId: "dev-1", idempotencyKey: `wrong-${i}`,
      }).catch(() => void 0);
    }

    // 4th attempt (even with correct PIN) should be locked out
    await expect(
      t.action(api.authActions.loginWithPin, {
        staffId, pin: "1234", deviceId: "dev-1", idempotencyKey: "lockout-test",
      })
    ).rejects.toThrow(/LOCKED_OUT/);

    const audits = await t.query(internal.audit.internal._list_internal, { action: "staff.locked_out" });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("logout (mutation)", () => {
  it("sets ended_at + end_reason on the session", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Citra", "1234");
    const { sessionId } = await t.action(api.authActions.loginWithPin, {
      staffId, pin: "1234", deviceId: "dev-1", idempotencyKey: "login-1",
    });

    await t.mutation(api.auth.public.logout, {
      sessionId, idempotencyKey: "logout-1",
    });

    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.ended_at).toBeTypeOf("number");
    expect(session?.end_reason).toBe("manual_lock");
  });
});

// ---------------------------------------------------------------------------
// Fix 7 — fail_count resets after lockout expires
// ---------------------------------------------------------------------------
describe("Fix 7: fail_count resets after lockout expires", () => {
  it("single wrong PIN after expired lockout sets fail_count=1, not re-locked", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Dini", "1234");

    // Trigger a lockout by failing 3 times
    for (let i = 0; i < 3; i++) {
      await t.action(api.authActions.loginWithPin, {
        staffId, pin: "0000", deviceId: "dev-1", idempotencyKey: `fix7-wrong-${i}`,
      }).catch(() => void 0);
    }

    // Fast-forward: set locked_until to the past to simulate expiry
    await t.run(async (ctx) => {
      const attempt = await ctx.db
        .query("pos_auth_attempts")
        .withIndex("by_staff", (q) => q.eq("staff_id", staffId))
        .first();
      if (attempt) {
        await ctx.db.patch(attempt._id, { locked_until: Date.now() - 1 });
      }
    });

    // Now one wrong PIN — should increment from 1, NOT from 3
    await t.action(api.authActions.loginWithPin, {
      staffId, pin: "0000", deviceId: "dev-1", idempotencyKey: "fix7-after-expire",
    }).catch(() => void 0);

    const attempt = await t.run(async (ctx) =>
      ctx.db.query("pos_auth_attempts").withIndex("by_staff", (q) => q.eq("staff_id", staffId)).first()
    );
    // fail_count should be 1 (reset to fresh cycle), NOT 4 (stale + 1)
    expect(attempt?.fail_count).toBe(1);
    // Should NOT be locked
    expect(attempt?.locked_until).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix 10 — _recordFailedAttempt_internal is idempotent with derived key
// ---------------------------------------------------------------------------
describe("Fix 10: _recordFailedAttempt_internal is idempotent", () => {
  it("same derived key does not double-increment fail_count", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Eko", "5678");

    const derivedKey = "fix10-base-key:failed";

    // Call twice with the same derived idempotencyKey
    await t.mutation(internal.auth.internal._recordFailedAttempt_internal, {
      idempotencyKey: derivedKey,
      staffId,
      deviceId: "dev-1",
    });
    await t.mutation(internal.auth.internal._recordFailedAttempt_internal, {
      idempotencyKey: derivedKey,
      staffId,
      deviceId: "dev-1",
    });

    const attempt = await t.run(async (ctx) =>
      ctx.db.query("pos_auth_attempts").withIndex("by_staff", (q) => q.eq("staff_id", staffId)).first()
    );
    // Idempotent: fail_count is 1, not 2
    expect(attempt?.fail_count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 14 — probe attempts during lockout are audit-logged
// ---------------------------------------------------------------------------
describe("Fix 14: probe during lockout emits staff.locked_out audit row", () => {
  it("each probe while locked emits an additional staff.locked_out audit row", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Fahri", "9999");

    // Trigger lockout
    for (let i = 0; i < 3; i++) {
      await t.action(api.authActions.loginWithPin, {
        staffId, pin: "0000", deviceId: "dev-1", idempotencyKey: `fix14-wrong-${i}`,
      }).catch(() => void 0);
    }

    const auditsBefore = await t.query(internal.audit.internal._list_internal, { action: "staff.locked_out" });
    // Lockout was set — at least 1 audit row from the 3rd failure
    expect(auditsBefore.length).toBeGreaterThanOrEqual(1);

    // Probe while locked (correct PIN doesn't matter — lock blocks before verify)
    await t.action(api.authActions.loginWithPin, {
      staffId, pin: "9999", deviceId: "dev-1", idempotencyKey: "fix14-probe-1",
    }).catch(() => void 0);

    const auditsAfter = await t.query(internal.audit.internal._list_internal, { action: "staff.locked_out" });
    // Probe should have added another audit row
    expect(auditsAfter.length).toBeGreaterThan(auditsBefore.length);
  });
});

// ---------------------------------------------------------------------------
// Fix 5 — stale cached session triggers fresh login
// ---------------------------------------------------------------------------
describe("Fix 5: cache hit with ended session triggers fresh login", () => {
  it("force-ended session causes retry with same key to return a new sessionId", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Gita", "4321");
    const key = "fix5-idem-key";

    // First login — caches the result
    const first = await t.action(api.authActions.loginWithPin, {
      staffId, pin: "4321", deviceId: "dev-1", idempotencyKey: key,
    });

    // Simulate force-logout: end the session
    await t.run(async (ctx) => {
      await ctx.db.patch(first.sessionId, { ended_at: Date.now(), end_reason: "force_logout" as const });
    });

    // Retry with the SAME key — cache is stale, should create a new session
    const second = await t.action(api.authActions.loginWithPin, {
      staffId, pin: "4321", deviceId: "dev-1", idempotencyKey: key,
    });

    // Must be a DIFFERENT session
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.role).toBe("staff");

    // New session must be active
    const newSession = await t.run(async (ctx) => ctx.db.get(second.sessionId));
    expect(newSession?.ended_at).toBeNull();
  });
});
