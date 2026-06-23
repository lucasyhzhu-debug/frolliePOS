import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { requireSession, requireCockpitSession, COCKPIT_IDLE_MS } from "../sessions";

async function seedOwnerCockpit(ctx: any, opts: { idleMsAgo?: number } = {}) {
  const staffId = await ctx.db.insert("staff", { name: "O", code: "S-9001", pin_hash: "h", role: "owner", active: true, created_at: Date.now() });
  const sid = await ctx.db.insert("staff_sessions", {
    staff_id: staffId, device_id: "owner-dev", kind: "cockpit",
    started_at: Date.now(), last_active_at: Date.now() - (opts.idleMsAgo ?? 0),
    ended_at: null, end_reason: null,
  });
  return { staffId, sid };
}

test("requireCockpitSession returns owner identity for a live cockpit session", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const { staffId, sid } = await seedOwnerCockpit(ctx);
    const r = await requireCockpitSession(ctx, sid);
    expect(r.staffId).toBe(staffId);
  });
});

test("requireCockpitSession rejects an idle-timed-out session", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const { sid } = await seedOwnerCockpit(ctx, { idleMsAgo: COCKPIT_IDLE_MS + 1000 });
    await expect(requireCockpitSession(ctx, sid)).rejects.toThrow("SESSION_IDLE_TIMEOUT");
  });
});

test("requireSession rejects a cockpit session with NOT_BOOTH_SESSION (C5 order)", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const { sid } = await seedOwnerCockpit(ctx);
    await expect(requireSession(ctx, sid)).rejects.toThrow("NOT_BOOTH_SESSION");
  });
});

// C5 defense-in-depth: the two cross-module internal resolvers back booth
// reporting/payments/receipts/refunds/settlements/vouchers/approvals. A cockpit
// session must never resolve a booth identity through them — it is rejected with
// the clear NOT_BOOTH_SESSION (not the misleading SESSION_NO_OUTLET).
test("_resolveSession_internal rejects a cockpit session with NOT_BOOTH_SESSION", async () => {
  const t = convexTest(schema);
  const sid = await t.run(async (ctx) => (await seedOwnerCockpit(ctx)).sid);
  await expect(
    t.run((ctx) => ctx.runQuery(internal.auth.internal._resolveSession_internal, { sessionId: sid })),
  ).rejects.toThrow("NOT_BOOTH_SESSION");
});

test("_resolveSessionRole_internal rejects a cockpit session with NOT_BOOTH_SESSION", async () => {
  const t = convexTest(schema);
  const sid = await t.run(async (ctx) => (await seedOwnerCockpit(ctx)).sid);
  await expect(
    t.run((ctx) => ctx.runQuery(internal.auth.internal._resolveSessionRole_internal, { sessionId: sid })),
  ).rejects.toThrow("NOT_BOOTH_SESSION");
});
