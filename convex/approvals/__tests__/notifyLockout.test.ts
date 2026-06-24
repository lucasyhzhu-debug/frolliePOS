import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.TELEGRAM_CHAT_ID = "-1001234567";
  process.env.POS_BASE_URL = "https://pos.dev";
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("approvals/actions.notifyStaffLockout", () => {
  it("creates pending request, sends Telegram, marks notified", async () => {
    const t = convexTest(schema);
    // Stub fetch for Telegram so the send doesn't hit the network.
    let telegramCalled = false;
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("telegram")) {
        telegramCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
          text: async () => "{}",
        } as unknown as Response;
      }
      return realFetch(url as RequestInfo);
    }) as typeof fetch;

    await t.run((ctx) =>
      (ctx.db as any).insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      }),
    );

    await t.run((ctx) =>
      ctx.db.insert("telegramChats", {
        chatId: "-100managers",
        chatType: "supergroup",
        title: "Frollie · Managers",
        role: "managers",
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
      }),
    );

    const staffId = await t.run((ctx) =>
      ctx.db.insert("staff", {
        name: "Lucy",
        code: "S-42",
        pin_hash: "x",
        role: "staff",
        active: true,
        created_at: Date.now(),
      }),
    );

    const r = await t.action(internal.approvals.actions.notifyStaffLockout, {
      staffId,
    });
    expect(r.skipped ?? false).toBe(false);

    const req = await t.run((ctx) =>
      ctx.db
        .query("pos_approval_requests")
        .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", staffId))
        .first(),
    );
    expect(req).not.toBeNull();
    expect(req?.kind).toBe("staff_pin_reset");
    expect(req?.status).toBe("pending");
    expect(req?.notified_at).toBeTruthy();
    expect(telegramCalled).toBe(true);
  });

  it("staffreview Improvement #5 (dedup): second call while pending+unexpired returns skipped, only 1 row", async () => {
    const t = convexTest(schema);
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 1 } }),
        text: async () => "{}",
      }) as unknown as Response) as typeof fetch;

    await t.run((ctx) =>
      (ctx.db as any).insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      }),
    );

    await t.run((ctx) =>
      ctx.db.insert("telegramChats", {
        chatId: "-100managers",
        chatType: "supergroup",
        title: "Frollie · Managers",
        role: "managers",
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
      }),
    );

    const staffId = await t.run((ctx) =>
      ctx.db.insert("staff", {
        name: "L",
        code: "S-1",
        pin_hash: "x",
        role: "staff",
        active: true,
        created_at: Date.now(),
      }),
    );

    const r1 = await t.action(internal.approvals.actions.notifyStaffLockout, {
      staffId,
    });
    expect(r1.skipped ?? false).toBe(false);

    const r2 = await t.action(internal.approvals.actions.notifyStaffLockout, {
      staffId,
    });
    expect(r2.skipped).toBe(true);
    expect(r2.reason).toBe("pending_request_exists");

    const reqs = await t.run((ctx) =>
      ctx.db
        .query("pos_approval_requests")
        .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", staffId))
        .collect(),
    );
    expect(reqs.length).toBe(1);
  });

  it("Telegram send failure deletes the request row so a retry isn't blocked (Fix I-2)", async () => {
    const t = convexTest(schema);
    // Stub fetch to throw on the Telegram URL, simulating a network / 5xx failure.
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("telegram")) {
        throw new Error("network down");
      }
      return realFetch(url as RequestInfo);
    }) as typeof fetch;

    await t.run((ctx) =>
      (ctx.db as any).insert("outlets", {
        code: "PKW", name: "x", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      }),
    );

    await t.run((ctx) =>
      ctx.db.insert("telegramChats", {
        chatId: "-100managers",
        chatType: "supergroup",
        title: "Frollie · Managers",
        role: "managers",
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
      }),
    );

    const staffId = await t.run((ctx) =>
      ctx.db.insert("staff", {
        name: "Lucy",
        code: "S-99",
        pin_hash: "x",
        role: "staff",
        active: true,
        created_at: Date.now(),
      }),
    );

    // The scheduled function must surface the failure (re-thrown after cleanup).
    await expect(
      t.action(internal.approvals.actions.notifyStaffLockout, { staffId }),
    ).rejects.toThrow();

    // No request row remains — the dedup guard won't block the next lockout cycle.
    const reqs = await t.run((ctx) =>
      ctx.db
        .query("pos_approval_requests")
        .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", staffId))
        .collect(),
    );
    expect(reqs.length).toBe(0);
  });

  it("v2.0 Spec-4: routes the PIN-reset card to the LOCKOUT DEVICE's outlet, not the default", async () => {
    const t = convexTest(schema);
    let sentChatId: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("telegram")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        sentChatId = body.chat_id;
        return {
          ok: true, status: 200,
          json: async () => ({ ok: true, result: { message_id: 1 } }),
          text: async () => "{}",
        } as unknown as Response;
      }
      return realFetch(url as RequestInfo);
    }) as typeof fetch;

    // Two outlets: A is the default (PKW), B is where the lockout happens (BLK).
    const { outletB } = await t.run(async (ctx) => {
      const outletA = await ctx.db.insert("outlets", {
        code: "PKW", name: "Pakuwon", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      });
      const outletB = await ctx.db.insert("outlets", {
        code: "BLK", name: "Block M", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      });
      // A managers chat bound to EACH outlet.
      await ctx.db.insert("telegramChats", {
        chatId: "-100mgrA", chatType: "supergroup", title: "Mgr A", role: "managers",
        registeredAt: Date.now(), lastSeenAt: Date.now(), outlet_id: outletA,
      });
      await ctx.db.insert("telegramChats", {
        chatId: "-100mgrB", chatType: "supergroup", title: "Mgr B", role: "managers",
        registeredAt: Date.now(), lastSeenAt: Date.now(), outlet_id: outletB,
      });
      // The failing device is bound to outlet B.
      await ctx.db.insert("registered_devices", {
        device_id: "dev-B", label: "Booth B", activated_at: Date.now(),
        active: true, outlet_id: outletB,
      });
      return { outletA, outletB };
    });

    const staffId = await t.run((ctx) =>
      ctx.db.insert("staff", {
        name: "Lucy", code: "S-42", pin_hash: "x", role: "staff",
        active: true, created_at: Date.now(),
      }),
    );

    const r = await t.action(internal.approvals.actions.notifyStaffLockout, {
      staffId,
      deviceId: "dev-B",
    });
    expect(r.skipped ?? false).toBe(false);

    // Routed to outlet B's managers chat — NOT outlet A (the default).
    expect(sentChatId).toBe("-100mgrB");

    // The approval request row is stamped with outlet B too.
    const req = await t.run((ctx) =>
      ctx.db
        .query("pos_approval_requests")
        .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", staffId))
        .first(),
    );
    expect(req?.outlet_id).toBe(outletB);
  });
});
