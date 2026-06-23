import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

// staff.code is REQUIRED (schema.ts:7); staff_sessions needs ended_at + end_reason
// (required null-unions, schema.ts:26-32). Mirrors convex/staff/__tests__/_helpers.ts.
// v2.0 Task 12 (ENFORCE): staff_sessions.outlet_id is required.
async function seed(t: ReturnType<typeof convexTest>) {
  const outletId = await t.run(async (ctx) =>
    ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    } as any),
  );
  return t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "A", code: "S-0002", role: "staff", active: true, pin_hash: "x", created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d1", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: outletId,
    } as any);
    return { staffId, sessionId };
  });
}
// NOTE: setOwnLocale takes no staffId arg (self-derived from session), so "staffer A
// cannot set B's locale" is structurally impossible — no cross-staff negative test needed.

describe("setOwnLocale", () => {
  it("patches the caller's own staff row + writes an audit row", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seed(t);
    const res = await t.mutation(api.staff.public.setOwnLocale, {
      idempotencyKey: "k1", sessionId, locale: "id",
    });
    expect(res).toEqual({ ok: true });
    const after = await t.run((ctx) => ctx.db.get(staffId));
    expect(after?.locale).toBe("id");
    const audit = await t.run((ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "staff.locale_set")).collect());
    expect(audit.length).toBe(1);
    expect(audit[0].actor_id).toBe(staffId);
  });

  it("rejects an invalid session", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seed(t);
    await t.run((ctx) => ctx.db.patch(sessionId, { ended_at: Date.now() }));
    await expect(
      t.mutation(api.staff.public.setOwnLocale, { idempotencyKey: "k2", sessionId, locale: "id" }),
    ).rejects.toThrow();
  });

  it("deduplicates on repeated idempotencyKey", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seed(t);
    await t.mutation(api.staff.public.setOwnLocale, {
      idempotencyKey: "k3", sessionId, locale: "en",
    });
    // second call with same key — should succeed (cached) without writing another audit row
    const res2 = await t.mutation(api.staff.public.setOwnLocale, {
      idempotencyKey: "k3", sessionId, locale: "en",
    });
    expect(res2).toEqual({ ok: true });
    const audit = await t.run((ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "staff.locale_set")).collect());
    // idempotency cache returns the earlier result — only 1 audit row
    expect(audit.length).toBe(1);
    const after = await t.run((ctx) => ctx.db.get(staffId));
    expect(after?.locale).toBe("en");
  });
});
