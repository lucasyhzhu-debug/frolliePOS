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

async function seedOutlet(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    } as any)
  ) as any;
}

async function seedSku(t: ReturnType<typeof convexTest>, sku: string, outletId: any) {
  return await t.run(async (ctx) =>
    ctx.db.insert("pos_inventory_skus", {
      sku,
      name: `Sku ${sku}`,
      unit: "piece",
      low_threshold: 0,
      active: true,
      created_at: Date.now(),
      outlet_id: outletId,
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

  it("no drift → audited skip per-outlet, no Telegram", async () => {
    // v2.0 Spec-4 Task 6: sendStockRecon now iterates all active outlets.
    // no_drift is audited per-outlet (continues loop); the outer action returns
    // { ok: true, outlets: N } not { skipped: "no_drift" }.
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const sku = await seedSku(t, "A", outletId);
    // ledger == cache → no drift
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: sku,
        qty: 0,
        source: "stock_in",
        created_at: 1,
        outlet_id: outletId,
      } as never),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: sku,
        on_hand: 0,
        updated_at: Date.now(),
        outlet_id: outletId,
      } as never),
    );

    const r = await t.action(
      internal.inventory.cronActions.sendStockReconResilient,
      { attempt: 0 },
    );
    // Now returns { ok: true, outlets: 1 } — per-outlet skip is audited inside the loop.
    expect(r).toMatchObject({ ok: true, outlets: 1 });
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

  it("role_unbound → audited skip per-outlet, no Telegram", async () => {
    // v2.0 Spec-4 Task 6: role_unbound is now per-outlet (loop continues).
    // The outer action returns { ok: true, outlets: 1 } not { skipped: "role_unbound" }.
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const sku = await seedSku(t, "A", outletId);
    // drift: ledger=5, cache=7
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: sku,
        qty: 5,
        source: "stock_in",
        created_at: 1,
        outlet_id: outletId,
      } as never),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: sku,
        on_hand: 7,
        updated_at: Date.now(),
        outlet_id: outletId,
      } as never),
    );
    // No telegramChats binding for "inventory" role.

    const r = await t.action(
      internal.inventory.cronActions.sendStockReconResilient,
      { attempt: 0 },
    );
    // Now returns { ok: true, outlets: 1 } — per-outlet skip is audited inside the loop.
    expect(r).toMatchObject({ ok: true, outlets: 1 });
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
    const outletId = await seedOutlet(t);
    const sku = await seedSku(t, "A", outletId);
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: sku,
        qty: 5,
        source: "stock_in",
        created_at: 1,
        outlet_id: outletId,
      } as never),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: sku,
        on_hand: 7,
        updated_at: Date.now(),
        outlet_id: outletId,
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
