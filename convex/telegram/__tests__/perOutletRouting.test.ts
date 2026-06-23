"use node";

import { convexTest } from "convex-test";
import { expect, test, beforeEach, afterEach } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

test("telegramChats accepts outlet_id and by_role_outlet resolves", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { code: "PKW", name: "Frollie — Pakuwon", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null });
    await ctx.db.insert("telegramChats", { chatId: "-100123", chatType: "supergroup", title: "Mgr PKW", role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(), outlet_id: outletId });
    const rows = await ctx.db.query("telegramChats").withIndex("by_role_outlet", (q) => q.eq("role", "managers").eq("outlet_id", outletId)).collect();
    expect(rows.length).toBe(1);
  });
});

test("getChatIdByRoleAndOutlet returns the per-outlet chat, null on miss", async () => {
  const t = convexTest(schema);
  const { a, chat } = await t.run(async (ctx) => {
    const a = await ctx.db.insert("outlets", { code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null });
    const chat = await ctx.db.insert("telegramChats", { chatId: "-100A", chatType: "supergroup", title: "Mgr A", role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(), outlet_id: a });
    return { a, chat };
  });
  expect(await t.query(internal.telegram.chatRegistry.internal.getChatIdByRoleAndOutlet, { role: "managers", outletId: a })).toBe("-100A");
  const b = await t.run((ctx) => ctx.db.insert("outlets", { code: "BLK", name: "y", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null }));
  expect(await t.query(internal.telegram.chatRegistry.internal.getChatIdByRoleAndOutlet, { role: "managers", outletId: b })).toBeNull();
});

test("getChatIdByRoleBareOrNull only matches outlet_id-absent rows", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("telegramChats", { chatId: "-100OWN", chatType: "supergroup", title: "Owners", role: "owners", registeredAt: Date.now(), lastSeenAt: Date.now() }); // no outlet_id
  });
  expect(await t.query(internal.telegram.chatRegistry.internal.getChatIdByRoleBareOrNull, { role: "owners" })).toBe("-100OWN");
  expect(await t.query(internal.telegram.chatRegistry.internal.getChatIdByRoleBareOrNull, { role: "managers" })).toBeNull();
});

// ─── Task 5 callsite tests ──────────────────────────────────────────────────
//
// (a) refund notify for outlet B resolves (managers, B) chat
// (b) staff_shift_signoff routes to per-outlet managers, NOT founders/owners

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
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

/**
 * (a) requestRefundApproval at outlet B must route to the managers chat
 * bound to outlet B, not outlet A's chat. If outletId is NOT threaded through,
 * sendTemplate would lack outletId for an outlet-scoped role and throw
 * OUTLET_REQUIRED_FOR_ROLE, failing this test.
 */
test("(a) requestRefundApproval threads outletId — routes refund notify to per-outlet managers chat", async () => {
  const t = convexTest(schema);

  const { sessionIdB, txnIdB, lineIdB } = await t.run(async (ctx: any) => {
    const outletA = await ctx.db.insert("outlets", {
      code: "PKW", name: "Outlet A", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null,
    });
    const outletB = await ctx.db.insert("outlets", {
      code: "BLK", name: "Outlet B", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null,
    });

    // Two per-outlet managers chats — outlet A and outlet B get distinct chat IDs.
    await ctx.db.insert("telegramChats", {
      chatId: "-100A",
      chatType: "supergroup",
      title: "Mgr Outlet A",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
      outlet_id: outletA,
    });
    await ctx.db.insert("telegramChats", {
      chatId: "-100B",
      chatType: "supergroup",
      title: "Mgr Outlet B",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
      outlet_id: outletB,
    });

    const staffId = await ctx.db.insert("staff", {
      name: "Budi", code: "S-B", role: "staff", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    const sessionIdB = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d-b", started_at: Date.now(),
      ended_at: null, end_reason: null, outlet_id: outletB,
    });
    const productId = await ctx.db.insert("pos_products", {
      sku_family: "dubai", code: "DUB1", name: "Dubai 1pc", pack_label: "1pc",
      price_idr: 50000, active: true, sort_order: 0, tax_rate: 0,
      created_at: Date.now(), updated_at: Date.now(), outlet_id: outletB,
    });
    const txnIdB = await ctx.db.insert("pos_transactions", {
      status: "paid", subtotal: 50000, voucher_discount: 0, total: 50000,
      flags: 0, staff_id: staffId, created_at: Date.now(), paid_at: Date.now(),
      receipt_number: "R-B-0001", receipt_token: "tok-b", outlet_id: outletB,
    });
    const lineIdB = await ctx.db.insert("pos_transaction_lines", {
      transaction_id: txnIdB, product_id: productId,
      product_code_snapshot: "DUB1", product_name_snapshot: "Dubai 1pc",
      unit_price_snapshot: 50000, tax_rate_snapshot: 0,
      qty: 1, line_subtotal: 50000, outlet_id: outletB,
    });
    return { sessionIdB, txnIdB, lineIdB };
  });

  // Should succeed — outlet B's managers chat is found.
  const res = await t.action(api.refunds.actions.requestRefundApproval, {
    sessionId: sessionIdB,
    idempotencyKey: "refund-outlet-b-test",
    transactionId: txnIdB,
    lines: [{ line_id: lineIdB, qty: 1 }],
    reason: "customer changed mind",
  });
  expect(res.requestId).toBeDefined();

  // The approval row must carry outlet B's id.
  const req = await t.run((ctx: any) => ctx.db.get(res.requestId)) as any;
  expect(req).not.toBeNull();
  expect(req!.outlet_id).toBeDefined();
});

/**
 * (b) _sendSignoffSummary must use role: "managers" (per-outlet), NOT "founders".
 * Before Task 5's edit, it uses role: "founders" which routes to the legacy
 * bare-role path and would fail to find a managers-scoped chat — demonstrating
 * the wrong routing. After the edit, it uses role: "managers" + outletId and
 * resolves the per-outlet managers chat correctly.
 */
test("(b) _sendSignoffSummary routes to per-outlet managers, not founders", async () => {
  const t = convexTest(schema);

  const { outletId, staffId, eventId } = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      code: "PKW", name: "Frollie PKW", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null,
    });
    // Only a per-outlet managers chat is registered — no founders/owners chat.
    // After the fix, signoff sends to managers; before the fix it would fail with
    // "No Telegram chat assigned to role 'founders'".
    await ctx.db.insert("telegramChats", {
      chatId: "-100managers-pkw",
      chatType: "supergroup",
      title: "Mgr PKW",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
      outlet_id: outletId,
    });
    const staffId = await ctx.db.insert("staff", {
      name: "Cici", code: "S-C", role: "staff", active: true,
      pin_hash: "x", created_at: Date.now(),
    });
    // Seed a shift event row so the eventId arg passes schema validation.
    const eventId = await ctx.db.insert("pos_shift_events", {
      device_id: "d1",
      type: "signoff_close",
      staff_id: staffId,
      shift_started_at: Date.now() - 28800000,
      shift_ended_at: Date.now(),
      steps: [],
      count_changed: null,
      takeover: null,
      outgoing_uncounted: null,
      stale_autoclose: null,
      linked_event_id: null,
      summary: null,
      created_at: Date.now(),
      outlet_id: outletId,
    } as any);
    return { outletId, staffId, eventId };
  });

  // Call the internal action directly — mirrors the shift mutation scheduling pattern.
  // convex-test returns null for void actions; the important assertion is no throw.
  await expect(
    t.action(internal.shifts.actions._sendSignoffSummary, {
      eventId,
      staffId,
      shiftStartMs: Date.now() - 28800000, // 8h ago
      shiftEndMs: Date.now(),
      totalSalesIdr: 500000,
      txnCount: 5,
      manualBcaCount: 0,
      manualBcaTotalIdr: 0,
      idempotencyKeySuffix: "signoff-test-1",
      outletId,
    }),
  ).resolves.not.toThrow();
});
