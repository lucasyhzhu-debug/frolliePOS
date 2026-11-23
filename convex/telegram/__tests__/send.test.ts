import { convexTest } from "convex-test";
import { expect, it, vi, beforeEach } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 7 } }),
    })),
  );
});

it("routes by role and returns message_id", async () => {
  const t = convexTest(schema);
  // managers is outlet-scoped — insert an outlet + outlet-bound chat row
  const outletId = await t.run(async (ctx) => {
    const a = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    });
    await ctx.db.insert("telegramChats", {
      chatId: "-100managers",
      chatType: "supergroup",
      title: "M",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
      outlet_id: a,
    });
    return a;
  });
  const res = await t.action(api.telegram.send.sendTemplate, {
    role: "managers",
    kind: "manual_payment_override",
    payload: {
      amount_idr: 50000,
      reason: "BCA",
      requester_name: "L",
      approve_url: "https://x/approve/tok",
    },
    idempotencyKey: "send-1",
    outletId,
  });
  expect(res.message_id).toBe(7);
});

it("rejects a malformed manual_payment payload", async () => {
  const t = convexTest(schema);
  const outletId = await t.run(async (ctx) => {
    const a = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    });
    await ctx.db.insert("telegramChats", {
      chatId: "-1",
      chatType: "group",
      title: "M",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
      outlet_id: a,
    });
    return a;
  });
  await expect(
    t.action(api.telegram.send.sendTemplate, {
      role: "managers",
      kind: "manual_payment_override",
      payload: { reason: "missing amount + url" } as never,
      idempotencyKey: "send-2",
      outletId,
    }),
  ).rejects.toThrow();
});

it("audits telegram.send_failed when telegram returns ok:false", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: false, description: "Bad Request" }),
    })),
  );
  const t = convexTest(schema);
  const outletId = await t.run(async (ctx) => {
    const a = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    });
    await ctx.db.insert("telegramChats", {
      chatId: "-1",
      chatType: "group",
      title: "M",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
      outlet_id: a,
    });
    return a;
  });
  await expect(
    t.action(api.telegram.send.sendTemplate, {
      role: "managers",
      kind: "manual_payment_override",
      payload: {
        amount_idr: 1,
        reason: "x",
        requester_name: "L",
        approve_url: "https://x",
      },
      idempotencyKey: "send-3",
      outletId,
    }),
  ).rejects.toThrow();
  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(audit.some((r) => r.action === "telegram.send_failed")).toBe(true);
});

it("throws OUTLET_REQUIRED_FOR_ROLE when outletId missing for outlet-scoped role", async () => {
  const t = convexTest(schema);
  await t.run((ctx) =>
    ctx.db.insert("telegramChats", {
      chatId: "-100managers",
      chatType: "supergroup",
      title: "M",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    }),
  );
  await expect(
    t.action(api.telegram.send.sendTemplate, {
      role: "managers",
      kind: "manual_payment_override",
      payload: {
        amount_idr: 50000,
        reason: "BCA",
        requester_name: "L",
        approve_url: "https://x/approve/tok",
      },
      idempotencyKey: "send-4",
      // outletId intentionally omitted
    }),
  ).rejects.toThrow(/OUTLET_REQUIRED_FOR_ROLE:managers/);
});

it("throws TELEGRAM_SENDS_DISABLED and never calls Telegram when the switch is not \"true\"", async () => {
  vi.stubEnv("TELEGRAM_SENDS_ENABLED", "");
  const t = convexTest(schema);
  await expect(
    t.action(api.telegram.send.sendTemplate, {
      role: "owners",
      kind: "manual_payment_override",
      payload: {
        amount_idr: 50000,
        reason: "BCA",
        requester_name: "L",
        approve_url: "https://x/approve/tok",
      },
      idempotencyKey: "send-disabled-1",
      chatIdOverride: "-100any",
    }),
  ).rejects.toThrow("TELEGRAM_SENDS_DISABLED");
  expect(fetch).not.toHaveBeenCalled();
  // The guard runs before any write: no outbound debug-trail row.
  const logRows = await t.run((ctx) => ctx.db.query("telegram_log").collect());
  expect(logRows).toHaveLength(0);
  vi.unstubAllEnvs();
});
