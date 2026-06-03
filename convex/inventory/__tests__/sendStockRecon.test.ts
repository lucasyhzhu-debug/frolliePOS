import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

// v0.6 Task R5 — cron-driven stock-recon Telegram dispatch.
//
// Mirrors convex/telegram/__tests__/foundersSummary.test.ts shape: fetch is
// mocked at globalThis level so sendTemplate is a no-op returning
// { message_id: 42 }. TELEGRAM_BOT_TOKEN env set per-test (sendTemplate throws
// on missing token before the fetch even fires).

async function seedSku(t: ReturnType<typeof convexTest>, sku: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("pos_inventory_skus", {
      sku,
      name: `Sku ${sku}`,
      unit: "piece",
      low_threshold: 0,
      active: true,
      created_at: Date.now(),
    } as never),
  );
}

describe("inventory.cronActions.sendStockReconResilient", () => {
  const realFetch = globalThis.fetch;
  const fetchMock = vi.fn();
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
      text: async () => "{}",
    } as never);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (prevToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = prevToken;
    }
    vi.restoreAllMocks();
  });

  it("no drift → audited skip, no Telegram", async () => {
    const t = convexTest(schema);
    const sku = await seedSku(t, "A");
    // ledger == cache → no drift
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: sku,
        qty: 0,
        source: "stock_in",
        created_at: 1,
      } as never),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: sku,
        on_hand: 0,
        updated_at: Date.now(),
      } as never),
    );

    const r = await t.action(
      internal.inventory.cronActions.sendStockReconResilient,
      { attempt: 0 },
    );
    expect(r).toMatchObject({ skipped: "no_drift" });
    expect(fetchMock).not.toHaveBeenCalled();

    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "stock.recon_skip"))
        .collect(),
    );
    expect(audits).toHaveLength(1);
    const meta = JSON.parse(audits[0].metadata as string);
    expect(meta.reason).toBe("no_drift");
  });

  it("role_unbound → audited skip, no Telegram", async () => {
    const t = convexTest(schema);
    const sku = await seedSku(t, "A");
    // drift: ledger=5, cache=7
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: sku,
        qty: 5,
        source: "stock_in",
        created_at: 1,
      } as never),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: sku,
        on_hand: 7,
        updated_at: Date.now(),
      } as never),
    );
    // No telegramChats binding for "inventory" role.

    const r = await t.action(
      internal.inventory.cronActions.sendStockReconResilient,
      { attempt: 0 },
    );
    expect(r).toMatchObject({ skipped: "role_unbound" });
    expect(fetchMock).not.toHaveBeenCalled();

    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "stock.recon_skip"))
        .collect(),
    );
    const unbound = audits.find(
      (a) => JSON.parse(a.metadata as string).reason === "role_unbound",
    );
    expect(unbound).toBeDefined();
  });

  it("drift + role bound → Telegram send invoked", async () => {
    const t = convexTest(schema);
    const sku = await seedSku(t, "A");
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: sku,
        qty: 5,
        source: "stock_in",
        created_at: 1,
      } as never),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: sku,
        on_hand: 7,
        updated_at: Date.now(),
      } as never),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("telegramChats", {
        chatId: "-1002",
        chatType: "group",
        title: "Inv",
        role: "inventory",
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
      } as never),
    );

    const r = await t.action(
      internal.inventory.cronActions.sendStockReconResilient,
      { attempt: 0 },
    );
    expect(r).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalled();
    // First fetch call should be to Telegram sendMessage with our chat_id.
    const firstCall = fetchMock.mock.calls[0];
    const url = firstCall[0] as string;
    expect(url).toContain("api.telegram.org");
    const body = JSON.parse((firstCall[1] as { body: string }).body) as {
      chat_id: string;
    };
    expect(body.chat_id).toBe("-1002");
  });
});
