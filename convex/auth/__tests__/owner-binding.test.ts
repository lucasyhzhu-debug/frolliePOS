import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

// issueOwnerTelegramBindLink is a "use node" action — it needs TELEGRAM_BOT_USERNAME.
process.env.TELEGRAM_BOT_USERNAME = "FrolliePOS_Bot";

async function seedOwnerTarget(t: ReturnType<typeof convexTest>) {
  return t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "Owner",
      code: "S-9100",
      pin_hash: "h",
      role: "owner",
      active: true,
      created_at: Date.now(),
    } as never),
  );
}

async function seedOwnerCockpitSession(t: ReturnType<typeof convexTest>) {
  const staffId = await t.run((ctx) =>
    ctx.db.insert("staff", {
      name: "Owner2",
      code: "S-9200",
      pin_hash: "h",
      role: "owner",
      active: true,
      created_at: Date.now(),
    } as never),
  );
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: "owner-dev",
      kind: "cockpit",
      started_at: Date.now(),
      last_active_at: Date.now(),
      ended_at: null,
      end_reason: null,
    } as never),
  );
  return { staffId, sessionId };
}

test("manager-PIN branch mints a bind deep-link with the raw token", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedManagerSession(t);
  const target = await seedOwnerTarget(t);
  const r = await t.action(api.auth.ownerActions.issueOwnerTelegramBindLink, {
    idempotencyKey: "bk1",
    targetStaffId: target,
    sessionId,
    managerPin: "9999",
  });
  expect(r.deepLink).toMatch(/^https:\/\/t\.me\/FrolliePOS_Bot\?start=.+/);
  // A binding row was written for the target.
  const binding = await t.run((ctx) =>
    ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_staff_kind", (q) => q.eq("staff_id", target).eq("kind", "telegram_bind"))
      .first(),
  );
  expect(binding).not.toBeNull();
});

test("manager-PIN branch rejects a wrong PIN (no link, no binding)", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedManagerSession(t);
  const target = await seedOwnerTarget(t);
  await expect(
    t.action(api.auth.ownerActions.issueOwnerTelegramBindLink, {
      idempotencyKey: "bk2",
      targetStaffId: target,
      sessionId,
      managerPin: "0000",
    }),
  ).rejects.toThrow(/INVALID_PIN/);
});

test("owner-cockpit-session branch mints a bind deep-link without a PIN", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedOwnerCockpitSession(t);
  const target = await seedOwnerTarget(t);
  const r = await t.action(api.auth.ownerActions.issueOwnerTelegramBindLink, {
    idempotencyKey: "bk3",
    targetStaffId: target,
    sessionId, // cockpit session, no managerPin
  });
  expect(r.deepLink).toMatch(/^https:\/\/t\.me\/FrolliePOS_Bot\?start=.+/);
});

test("a BOOTH session in the cockpit branch is rejected (cross-plane)", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedManagerSession(t); // booth session, no PIN
  const target = await seedOwnerTarget(t);
  await expect(
    t.action(api.auth.ownerActions.issueOwnerTelegramBindLink, {
      idempotencyKey: "bk4",
      targetStaffId: target,
      sessionId,
    }),
  ).rejects.toThrow("NOT_COCKPIT_SESSION");
});

test("neither managerPin nor session is rejected with BIND_AUTH_REQUIRED", async () => {
  const t = convexTest(schema);
  const target = await seedOwnerTarget(t);
  await expect(
    t.action(api.auth.ownerActions.issueOwnerTelegramBindLink, {
      idempotencyKey: "bk5",
      targetStaffId: target,
    }),
  ).rejects.toThrow("BIND_AUTH_REQUIRED");
});

test("replay returns the SAME deep-link without minting a second binding", async () => {
  const t = convexTest(schema);
  const { sessionId } = await seedManagerSession(t);
  const target = await seedOwnerTarget(t);
  const args = {
    idempotencyKey: "bk6",
    targetStaffId: target,
    sessionId,
    managerPin: "9999",
  };
  const first = await t.action(api.auth.ownerActions.issueOwnerTelegramBindLink, args);
  const second = await t.action(api.auth.ownerActions.issueOwnerTelegramBindLink, args);
  expect(second.deepLink).toBe(first.deepLink);
  const bindings = await t.run((ctx) =>
    ctx.db
      .query("owner_auth_bindings")
      .withIndex("by_staff_kind", (q) => q.eq("staff_id", target).eq("kind", "telegram_bind"))
      .collect(),
  );
  expect(bindings.length).toBe(1);
});
