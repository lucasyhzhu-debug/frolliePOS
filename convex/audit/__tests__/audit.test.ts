import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { seedStaff } from "../../auth/__tests__/auth.test";

async function seedManager(t: ReturnType<typeof convexTest>) {
  return seedStaff(t, "AuditMgr", "9999", "manager");
}

async function seedRegularStaff(t: ReturnType<typeof convexTest>) {
  return seedStaff(t, "AuditStaff", "1111", "staff");
}

async function loginAs(t: ReturnType<typeof convexTest>, staffId: any, pin: string) {
  const { sessionId } = await t.action(api.auth.actions.loginWithPin, {
    staffId, pin, deviceId: "dev-audit", idempotencyKey: crypto.randomUUID(),
  });
  return sessionId;
}

describe("logAudit", () => {
  it("appends an audit row visible via _list_internal", async () => {
    const t = convexTest(schema);

    const staffId = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "Citra",
        pin_hash: "$argon2id$dummy",
        role: "staff",
        active: true,
        created_at: Date.now(),
      })
    );

    await t.mutation(internal.audit.internal.__test_log, {
      actor_id: staffId,
      action: "staff.login",
      entity_type: "staff",
      entity_id: staffId,
      source: "booth_inline",
    });

    const rows = await t.query(internal.audit.internal._list_internal, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "staff.login",
      entity_type: "staff",
      source: "booth_inline",
    });
  });
});

describe("audit.list — manager-only gate (Fix 4)", () => {
  it("manager session can read audit log", async () => {
    const t = convexTest(schema);
    const mgrId = await seedManager(t);
    const mgrSession = await loginAs(t, mgrId, "9999");

    // Seed one audit row via internal
    await t.mutation(internal.audit.internal.__test_log, {
      actor_id: mgrId,
      action: "test.action",
      entity_type: "staff",
      source: "booth_inline",
    });

    const rows = await t.query(api.audit.public.list, {
      sessionId: mgrSession,
      limit: 10,
    });
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("non-manager session is rejected", async () => {
    const t = convexTest(schema);
    const staffId = await seedRegularStaff(t);
    const staffSession = await loginAs(t, staffId, "1111");

    await expect(
      t.query(api.audit.public.list, { sessionId: staffSession, limit: 10 })
    ).rejects.toThrow(/manager/i);
  });
});
