import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

// We don't want the test suite to fire real HTTP calls to api.telegram.org for
// answerCallbackQuery / editMessageText. Stub global fetch to return success.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
    ),
  );
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_CHAT_ID", "-1");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "test-secret");
});

describe("telegram webhook security", () => {
  test("returns 401 when secret header is missing", async () => {
    const t = convexTest(schema);
    const response = await t.fetch("/telegram-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(response.status).toBe(401);
  });

  test("returns 401 when secret header is wrong", async () => {
    const t = convexTest(schema);
    const response = await t.fetch("/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "WRONG",
      },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(response.status).toBe(401);
  });

  test("returns 400 on malformed JSON", async () => {
    const t = convexTest(schema);
    const response = await t.fetch("/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });
});

describe("telegram webhook callback handling", () => {
  test("inserts an inbound log row on valid callback_query", async () => {
    const t = convexTest(schema);
    const response = await t.fetch("/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 42,
        callback_query: {
          id: "cbq-1",
          from: { id: 99, username: "tester" },
          message: { message_id: 7, chat: { id: -1 } },
          data: "approve:abc123",
        },
      }),
    });
    expect(response.status).toBe(200);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("telegram_log").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: "in",
      update_id: 42,
      callback_data: "approve:abc123",
      from_user: "@tester",
      message_id: 7,
    });
  });

  test("dedupes a duplicate update_id (Telegram retry)", async () => {
    const t = convexTest(schema);
    const headers = {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "test-secret",
    };
    const body = JSON.stringify({
      update_id: 100,
      callback_query: {
        id: "cbq-2",
        from: { id: 99, username: "tester" },
        message: { message_id: 8, chat: { id: -1 } },
        data: "deny:xyz",
      },
    });

    const r1 = await t.fetch("/telegram-webhook", { method: "POST", headers, body });
    const r2 = await t.fetch("/telegram-webhook", { method: "POST", headers, body });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("telegram_log")
        .withIndex("by_update_id", (q) => q.eq("update_id", 100))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("uses first_name fallback when username is absent", async () => {
    const t = convexTest(schema);
    await t.fetch("/telegram-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "test-secret",
      },
      body: JSON.stringify({
        update_id: 200,
        callback_query: {
          id: "cbq-3",
          from: { id: 99, first_name: "Sari" },
          message: { message_id: 9, chat: { id: -1 } },
          data: "approve:nn",
        },
      }),
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("telegram_log")
        .withIndex("by_update_id", (q) => q.eq("update_id", 200))
        .collect(),
    );
    expect(rows[0].from_user).toBe("Sari");
  });
});

describe("recordCallback mutation direct (mutation-level dedupe)", () => {
  test("the second call with the same update_id is a no-op", async () => {
    const t = convexTest(schema);
    const args = {
      update_id: 555,
      callback_data: "approve:x",
      from_user: "@x",
      message_id: 1,
      payload_json: "{}",
    };
    await t.mutation(internal.telegram.webhook.recordCallback, args);
    await t.mutation(internal.telegram.webhook.recordCallback, args);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("telegram_log")
        .withIndex("by_update_id", (q) => q.eq("update_id", 555))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });
});
