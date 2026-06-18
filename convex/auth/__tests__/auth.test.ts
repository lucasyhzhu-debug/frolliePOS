import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";

// Wiring the lockout scheduler (Task 18) means hitting the 3rd failed PIN now
// schedules approvals.actions.notifyStaffLockout, which sends a Telegram message.
// Stub fetch + env so that scheduled send is offline and deterministic; tests
// that trip the lockout drain it with t.finishInProgressScheduledFunctions().
const realFetch = globalThis.fetch;
beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.TELEGRAM_CHAT_ID = "-1001234567";
  process.env.POS_BASE_URL = "https://pos.dev";
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).includes("telegram")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return realFetch(url as RequestInfo);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// runAfter(0) is dispatched via setTimeout(0): the job is still `pending` when the
// scheduling action returns, so a bare finishInProgressScheduledFunctions() would
// no-op. Yield one macrotask to let the timer move the job to `inProgress`, then drain.
async function drainScheduled(t: ReturnType<typeof convexTest>) {
  await new Promise((r) => setTimeout(r, 0));
  await t.finishInProgressScheduledFunctions();
}

export async function seedStaff(
  t: ReturnType<typeof convexTest>,
  name: string,
  pin: string,
  role: "staff" | "manager" = "staff",
) {
  // Tests reuse the same hashing routine as production (no parallel
  // hashing impl). Route through the Node action so jsdom doesn't try
  // to evaluate it.
  return await t.action(internal.auth.actions._seedHashedStaff_internal, {
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
        name: "Old", code: "S-0099", pin_hash: "x", role: "staff", active: false, created_at: 0,
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

    const { sessionId, role } = await t.action(api.auth.actions.loginWithPin, {
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

    const first = await t.action(api.auth.actions.loginWithPin, {
      staffId, pin: "1234", deviceId: "dev-1", idempotencyKey: key,
    });
    const second = await t.action(api.auth.actions.loginWithPin, {
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
      t.action(api.auth.actions.loginWithPin, {
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
      await t.action(api.auth.actions.loginWithPin, {
        staffId, pin: "0000", deviceId: "dev-1", idempotencyKey: `wrong-${i}`,
      }).catch(() => void 0);
    }
    // Drain the scheduled notifyStaffLockout (Task 18) so it doesn't fire after teardown.
    await drainScheduled(t);

    // 4th attempt (even with correct PIN) should be locked out
    await expect(
      t.action(api.auth.actions.loginWithPin, {
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
    const { sessionId } = await t.action(api.auth.actions.loginWithPin, {
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
      await t.action(api.auth.actions.loginWithPin, {
        staffId, pin: "0000", deviceId: "dev-1", idempotencyKey: `fix7-wrong-${i}`,
      }).catch(() => void 0);
    }
    await drainScheduled(t);

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
    await t.action(api.auth.actions.loginWithPin, {
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
// SEC-01: the failed-attempt counter must NOT dedupe on a client key — every
// wrong PIN increments, so lockout is reachable. (Replaces the old "Fix 10"
// idempotency test, which asserted the now-removed vulnerable dedupe.)
// ---------------------------------------------------------------------------
describe("SEC-01: failed-attempt counter increments unconditionally", () => {
  it("two calls increment fail_count to 2 (no dedupe)", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Eko", "5678");
    await t.mutation(internal.auth.internal._recordFailedAttempt_internal, {
      staffId, deviceId: "dev-1", countTowardLockout: true });
    await t.mutation(internal.auth.internal._recordFailedAttempt_internal, {
      staffId, deviceId: "dev-1", countTowardLockout: true });
    const attempt = await t.run((ctx) =>
      ctx.db.query("pos_auth_attempts").withIndex("by_staff", (q) => q.eq("staff_id", staffId)).first());
    expect(attempt?.fail_count).toBe(2);
  });

  it("third call locks the account", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Eko", "5678");
    for (let i = 0; i < 2; i++)
      await t.mutation(internal.auth.internal._recordFailedAttempt_internal, {
        staffId, deviceId: "dev-1", countTowardLockout: true });
    const r3 = await t.mutation(internal.auth.internal._recordFailedAttempt_internal, {
      staffId, deviceId: "dev-1", countTowardLockout: true });
    expect(r3.newly_locked).toBe(true);
    await drainScheduled(t);
  });

  it("countTowardLockout:false audits but never locks", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Eko", "5678");
    for (let i = 0; i < 5; i++)
      await t.mutation(internal.auth.internal._recordFailedAttempt_internal, {
        staffId, deviceId: "off-booth", countTowardLockout: false, source: "telegram_approval" });
    const attempt = await t.run((ctx) =>
      ctx.db.query("pos_auth_attempts").withIndex("by_staff", (q) => q.eq("staff_id", staffId)).first());
    expect(attempt ?? null).toBeNull(); // no lockout row written
    const audits = await t.run((ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "staff.failed_pin")).collect());
    expect(audits.length).toBe(5); // every off-booth miss is audited
  });

  it("action-level: 3 wrong logins with the SAME idempotencyKey still lock", async () => {
    // SEC-01 regression: pre-fix, a reused client key froze fail_count at 1 and
    // the account never locked. Now every miss counts; the 3rd throws LOCKED_OUT.
    // (A legit network-retry now over-counts by one — deliberate fail-safe.)
    const t = convexTest(schema);
    const staffId = await seedStaff(t, "Gita", "4321");
    const sameKey = "reused-client-key";
    await t.action(api.auth.actions.loginWithPin, {
      staffId, pin: "0000", deviceId: "dev-1", idempotencyKey: sameKey,
    }).catch(() => void 0);
    await t.action(api.auth.actions.loginWithPin, {
      staffId, pin: "0001", deviceId: "dev-1", idempotencyKey: sameKey,
    }).catch(() => void 0);
    await expect(
      t.action(api.auth.actions.loginWithPin, {
        staffId, pin: "0002", deviceId: "dev-1", idempotencyKey: sameKey,
      }),
    ).rejects.toThrow(/LOCKED_OUT/);
    await drainScheduled(t);
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
      await t.action(api.auth.actions.loginWithPin, {
        staffId, pin: "0000", deviceId: "dev-1", idempotencyKey: `fix14-wrong-${i}`,
      }).catch(() => void 0);
    }
    await drainScheduled(t);

    const auditsBefore = await t.query(internal.audit.internal._list_internal, { action: "staff.locked_out" });
    // Lockout was set — at least 1 audit row from the 3rd failure
    expect(auditsBefore.length).toBeGreaterThanOrEqual(1);

    // Probe while locked (correct PIN doesn't matter — lock blocks before verify)
    await t.action(api.auth.actions.loginWithPin, {
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
    const first = await t.action(api.auth.actions.loginWithPin, {
      staffId, pin: "4321", deviceId: "dev-1", idempotencyKey: key,
    });

    // Simulate force-logout: end the session
    await t.run(async (ctx) => {
      await ctx.db.patch(first.sessionId, { ended_at: Date.now(), end_reason: "force_logout" as const });
    });

    // Retry with the SAME key — cache is stale, should create a new session
    const second = await t.action(api.auth.actions.loginWithPin, {
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
