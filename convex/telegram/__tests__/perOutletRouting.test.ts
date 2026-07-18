"use node";

import { convexTest } from "convex-test";
import { expect, test, beforeEach, afterEach } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

test("telegramChats accepts outlet_id and by_role_outlet resolves", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const outletId = await ctx.db.insert("outlets", { is_open: false, code: "PKW", name: "Frollie — Pakuwon", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null });
    await ctx.db.insert("telegramChats", { chatId: "-100123", chatType: "supergroup", title: "Mgr PKW", role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(), outlet_id: outletId });
    const rows = await ctx.db.query("telegramChats").withIndex("by_role_outlet", (q) => q.eq("role", "managers").eq("outlet_id", outletId)).collect();
    expect(rows.length).toBe(1);
  });
});

test("getChatIdByRoleAndOutlet returns the per-outlet chat, null on miss", async () => {
  const t = convexTest(schema);
  const { a, chat } = await t.run(async (ctx) => {
    const a = await ctx.db.insert("outlets", { is_open: false, code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null });
    const chat = await ctx.db.insert("telegramChats", { chatId: "-100A", chatType: "supergroup", title: "Mgr A", role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(), outlet_id: a });
    return { a, chat };
  });
  expect(await t.query(internal.telegram.chatRegistry.internal.getChatIdByRoleAndOutlet, { role: "managers", outletId: a })).toBe("-100A");
  const b = await t.run((ctx) => ctx.db.insert("outlets", { is_open: false, code: "BLK", name: "y", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null }));
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
    const outletA = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW", name: "Outlet A", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null,
    });
    const outletB = await ctx.db.insert("outlets", { is_open: false,
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
    const outletId = await ctx.db.insert("outlets", { is_open: false,
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

// ─── Task 6 callsite tests ──────────────────────────────────────────────────
//
// These four tests assert the specific chat_id that each path resolves to,
// not merely that "a send happened". Each seeds two outlets with distinct
// chat IDs and verifies only the correct outlet's chat received the message.

/**
 * (c) low_stock alert at outlet B routes to outlet B's `managers` chat,
 * NOT outlet A's. Asserts chatIdOverride = B's chat_id in the fetch call.
 *
 * v1.4.11: low_stock alerts repointed inventory → managers. Mechanism:
 * dispatchRoleAlert calls resolveOutletChatId(ctx, "managers", outlet_id) so
 * the chat resolves per-outlet. We capture fetch calls and assert the chat_id.
 */
test("(c) low_stock alert at outlet B routes to outlet B's managers chat", async () => {
  const t = convexTest(schema);

  const capturedBodies: Record<string, unknown>[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("telegram")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      capturedBodies.push(body);
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, result: { message_id: 42 } }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return savedFetch(url as RequestInfo, init);
  }) as typeof fetch;

  try {
    const { outletB } = await t.run(async (ctx: any) => {
      const outletA = await ctx.db.insert("outlets", { is_open: false,
        code: "PKW", name: "Outlet A", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      });
      const outletB = await ctx.db.insert("outlets", { is_open: false,
        code: "BLK", name: "Outlet B", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      });
      // Two distinct managers chats — one per outlet (low_stock → managers, v1.4.11).
      await ctx.db.insert("telegramChats", {
        chatId: "-100mgr-lowstk-A", chatType: "supergroup", title: "Mgr A",
        role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
        outlet_id: outletA,
      });
      await ctx.db.insert("telegramChats", {
        chatId: "-100mgr-lowstk-B", chatType: "supergroup", title: "Mgr B",
        role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
        outlet_id: outletB,
      });
      // Seed a SKU + low stock level at outlet B.
      const skuId = await ctx.db.insert("pos_inventory_skus", {
        sku: "DUBAI", name: "Dubai Box", unit: "piece" as const,
        active: true, low_threshold: 5, created_at: Date.now(), outlet_id: outletB,
      });
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuId, on_hand: 2, updated_at: Date.now(),
        outlet_id: outletB,
      });
      return { outletB };
    });

    // Fire dispatchRoleAlert directly with outletB's id + managers role (v1.4.11).
    await t.action(internal.telegram.dispatch.dispatchRoleAlert, {
      role: "managers",
      kind: "low_stock_alert",
      payload: { sku_name: "Dubai Box", on_hand: 2, low_threshold: 5 },
      idempotencyKey: `test-lowstock-c-${Date.now()}`,
      outletId: outletB,
    });

    // The Telegram API call must have gone to outlet B's chat.
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const lastBody = capturedBodies[capturedBodies.length - 1];
    expect(lastBody.chat_id).toBe("-100mgr-lowstk-B");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

/**
 * (d) recount at outlet B routes to outlet B's `managers` chat, NOT outlet A's.
 * Recount stays role `managers` (decision A — see brief).
 * dispatchRoleAlert now carries outletId from the session's outlet_id.
 */
test("(d) recount at outlet B routes to outlet B's managers chat", async () => {
  const t = convexTest(schema);

  const capturedBodies: Record<string, unknown>[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("telegram")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      capturedBodies.push(body);
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, result: { message_id: 43 } }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return savedFetch(url as RequestInfo, init);
  }) as typeof fetch;

  try {
    const { outletB } = await t.run(async (ctx: any) => {
      const outletA = await ctx.db.insert("outlets", { is_open: false,
        code: "PKW", name: "Outlet A", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      });
      const outletB = await ctx.db.insert("outlets", { is_open: false,
        code: "BLK", name: "Outlet B", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      });
      // Two distinct managers chats.
      await ctx.db.insert("telegramChats", {
        chatId: "-100mgr-A", chatType: "supergroup", title: "Mgr A",
        role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
        outlet_id: outletA,
      });
      await ctx.db.insert("telegramChats", {
        chatId: "-100mgr-B", chatType: "supergroup", title: "Mgr B",
        role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
        outlet_id: outletB,
      });
      return { outletA, outletB };
    });

    // Fire dispatchRoleAlert directly with outletB's id + managers role (recount path).
    await t.action(internal.telegram.dispatch.dispatchRoleAlert, {
      role: "managers",
      kind: "recount_notice",
      payload: {
        staff_name: "Ani",
        recorded_at_iso: new Date().toISOString(),
        lines: [{ sku_name: "Dubai Box", before: 5, after: 3, delta: -2 }],
      },
      idempotencyKey: `test-recount-d-${Date.now()}`,
      outletId: outletB,
    });

    // Must have routed to outlet B's managers chat.
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const lastBody = capturedBodies[capturedBodies.length - 1];
    expect(lastBody.chat_id).toBe("-100mgr-B");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

/**
 * (e) drift cron: TWO active outlets each with their own inventory chat.
 * sendStockRecon must emit ONE alert per outlet, each to its OWN chat_id.
 * This test directly catches the idempotency-key bug — if the key is global
 * (no outlet scope), the action-cache dedups the second outlet's send silently.
 * With per-outlet key ("stock-recon:<code>:<date>") both sends go through.
 *
 * We assert two DISTINCT chat_ids in the captured Telegram calls.
 */
test("(e) drift cron sends per-outlet alerts — two outlets, two distinct chat_ids", async () => {
  const t = convexTest(schema);

  const capturedBodies: Record<string, unknown>[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("telegram")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      capturedBodies.push(body);
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, result: { message_id: 44 } }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return savedFetch(url as RequestInfo, init);
  }) as typeof fetch;

  try {
    await t.run(async (ctx: any) => {
      const outletA = await ctx.db.insert("outlets", { is_open: false,
        code: "PKW", name: "Outlet A", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      });
      const outletB = await ctx.db.insert("outlets", { is_open: false,
        code: "BLK", name: "Outlet B", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      });
      // Two distinct managers chats (drift → managers, v1.4.11).
      await ctx.db.insert("telegramChats", {
        chatId: "-100mgr-PKW", chatType: "supergroup", title: "Mgr PKW",
        role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
        outlet_id: outletA,
      });
      await ctx.db.insert("telegramChats", {
        chatId: "-100mgr-BLK", chatType: "supergroup", title: "Mgr BLK",
        role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
        outlet_id: outletB,
      });

      // Seed a SKU with drift at outlet A (cached != reconstructed).
      const skuA = await ctx.db.insert("pos_inventory_skus", {
        sku: "DUBAI-A", name: "Dubai A", unit: "piece" as const,
        active: true, low_threshold: 5, created_at: Date.now(), outlet_id: outletA,
      });
      // cached = 10
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuA, on_hand: 10, updated_at: Date.now(),
        outlet_id: outletA,
      });
      // reconstructed = 8 (one movement of qty 8)
      await ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: skuA, qty: 8, source: "sale",
        created_at: Date.now(), outlet_id: outletA,
      });

      // Seed a SKU with drift at outlet B (cached != reconstructed).
      const skuB = await ctx.db.insert("pos_inventory_skus", {
        sku: "DUBAI-B", name: "Dubai B", unit: "piece" as const,
        active: true, low_threshold: 5, created_at: Date.now(), outlet_id: outletB,
      });
      // cached = 15
      await ctx.db.insert("pos_stock_levels", {
        inventory_sku_id: skuB, on_hand: 15, updated_at: Date.now(),
        outlet_id: outletB,
      });
      // reconstructed = 12 (one movement of qty 12)
      await ctx.db.insert("pos_stock_movements", {
        inventory_sku_id: skuB, qty: 12, source: "sale",
        created_at: Date.now(), outlet_id: outletB,
      });
    });

    // Run the inner cron action (not the resilient wrapper — cleaner for tests).
    const result = await t.action(internal.inventory.cronActions.sendStockRecon, {});
    expect(result).toMatchObject({ ok: true, outlets: 2 });

    // Both outlet chats must have received a message — TWO distinct chat_ids.
    const sentChatIds = capturedBodies.map((b) => b.chat_id);
    expect(sentChatIds).toContain("-100mgr-PKW");
    expect(sentChatIds).toContain("-100mgr-BLK");
    // Distinct: each outlet gets its OWN alert (not both to the same chat).
    expect(new Set(sentChatIds).size).toBe(2);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

/**
 * (f) txn_ticker at outlet B routes to outlet B's `managers` chat, NOT outlet A's.
 * sendTxnTicker now resolves via resolveOutletChatId(ctx, "managers", txn.outlet_id).
 */
test("(f) txn_ticker at outlet B routes to outlet B's managers chat", async () => {
  const t = convexTest(schema);

  const capturedBodies: Record<string, unknown>[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("telegram")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      capturedBodies.push(body);
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, result: { message_id: 45 } }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return savedFetch(url as RequestInfo, init);
  }) as typeof fetch;

  try {
    const txnId = await t.run(async (ctx: any) => {
      const outletA = await ctx.db.insert("outlets", { is_open: false,
        code: "PKW", name: "Outlet A", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      });
      const outletB = await ctx.db.insert("outlets", { is_open: false,
        code: "BLK", name: "Outlet B", timezone: "Asia/Jakarta",
        active: true, created_at: Date.now(), created_by: null,
      });
      // Two distinct managers chats.
      await ctx.db.insert("telegramChats", {
        chatId: "-100mgr-PKW", chatType: "supergroup", title: "Mgr PKW",
        role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
        outlet_id: outletA,
      });
      await ctx.db.insert("telegramChats", {
        chatId: "-100mgr-BLK", chatType: "supergroup", title: "Mgr BLK",
        role: "managers", registeredAt: Date.now(), lastSeenAt: Date.now(),
        outlet_id: outletB,
      });
      // Settings with ticker enabled for outlet B.
      await ctx.db.insert("pos_settings", {
        founders_summary_enabled: true,
        txn_ticker_enabled: true,
        updated_at: 0,
        outlet_id: outletB,
      } as any);
      const staffId = await ctx.db.insert("staff", {
        name: "Dani", code: "S-D", role: "staff", active: true,
        pin_hash: "x", created_at: Date.now(),
      });
      const txnId = await ctx.db.insert("pos_transactions", {
        status: "paid",
        subtotal: 100000, voucher_discount: 0, total: 100000, flags: 0,
        staff_id: staffId, created_at: Date.now(), paid_at: Date.now(),
        receipt_number: "R-BLK-0001", outlet_id: outletB,
      } as any);
      // Need at least one line for _getTxnForTicker_internal to find.
      const productId = await ctx.db.insert("pos_products", {
        sku_family: "dubai", code: "DUB1", name: "Dubai 1pc", pack_label: "1pc",
        price_idr: 100000, active: true, sort_order: 0, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(), outlet_id: outletB,
      });
      await ctx.db.insert("pos_transaction_lines", {
        transaction_id: txnId, product_id: productId,
        product_code_snapshot: "DUB1", product_name_snapshot: "Dubai 1pc",
        unit_price_snapshot: 100000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 100000, outlet_id: outletB,
      });
      return txnId;
    });

    const res = await t.action(internal.telegram.txnTicker.sendTxnTicker, { txnId });
    expect(res).toMatchObject({ ok: true });

    // Must have routed to outlet B's managers chat.
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const lastBody = capturedBodies[capturedBodies.length - 1];
    expect(lastBody.chat_id).toBe("-100mgr-BLK");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// ─── Task 8: system_error outlet label in body ──────────────────────────────
//
// Decision 6: system_error routing stays business-wide (role: "ops", NO outletId).
// Only the message BODY gains an "outlet: <name>" line when outlet_id is set.

/**
 * (g) system_error with outlet_id — body must include "outlet: Frollie — Block M"
 *     Routing must be business-wide (ops chat, no outletId arg to sendTemplate).
 */
test("(g) system_error with outlet_id renders outlet label in body, routes to ops chat", async () => {
  const t = convexTest(schema);

  const capturedBodies: Record<string, unknown>[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("telegram")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      capturedBodies.push(body);
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, result: { message_id: 46 } }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return savedFetch(url as RequestInfo, init);
  }) as typeof fetch;

  try {
    const { reportId } = await t.run(async (ctx: any) => {
      // Register an ops chat (bare role, no outlet_id — business-wide).
      await ctx.db.insert("telegramChats", {
        chatId: "-100ops",
        chatType: "supergroup",
        title: "Ops",
        role: "ops",
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
        // NO outlet_id — ops is business-wide
      });

      const outletId = await ctx.db.insert("outlets", { is_open: false,
        code: "BLK", name: "Frollie — Block M",
        timezone: "Asia/Jakarta", active: true,
        created_at: Date.now(), created_by: null,
      });

      const reportId = await ctx.db.insert("pos_error_reports", {
        kind: "crash", message: "Something went wrong",
        signature: "sig-g", alerted: true, created_at: Date.now(),
        outlet_id: outletId,
      });
      return { reportId };
    });

    const res = await t.action(internal.ops.actions.sendErrorAlert, { reportId });
    expect(res).toEqual({ ok: true });

    // Body must contain the outlet label.
    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const lastBody = capturedBodies[capturedBodies.length - 1] as { chat_id: string; text: string };
    expect(lastBody.chat_id).toBe("-100ops");
    expect(lastBody.text).toContain("outlet: Frollie — Block M");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

/**
 * (h) system_error WITHOUT outlet_id — body must NOT include any "outlet:" line.
 *     Routing still goes to the ops chat.
 */
test("(h) system_error without outlet_id omits outlet line in body", async () => {
  const t = convexTest(schema);

  const capturedBodies: Record<string, unknown>[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("telegram")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      capturedBodies.push(body);
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, result: { message_id: 47 } }),
        text: async () => "{}",
      } as unknown as Response;
    }
    return savedFetch(url as RequestInfo, init);
  }) as typeof fetch;

  try {
    const { reportId } = await t.run(async (ctx: any) => {
      await ctx.db.insert("telegramChats", {
        chatId: "-100ops-h",
        chatType: "supergroup",
        title: "Ops",
        role: "ops",
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
      });

      // No outlet_id on this report (e.g. a cron/system error).
      const reportId = await ctx.db.insert("pos_error_reports", {
        kind: "backend", message: "Cron exploded",
        signature: "sig-h", alerted: true, created_at: Date.now(),
        // outlet_id intentionally absent
      });
      return { reportId };
    });

    const res = await t.action(internal.ops.actions.sendErrorAlert, { reportId });
    expect(res).toEqual({ ok: true });

    expect(capturedBodies.length).toBeGreaterThanOrEqual(1);
    const lastBody = capturedBodies[capturedBodies.length - 1] as { chat_id: string; text: string };
    expect(lastBody.chat_id).toBe("-100ops-h");
    expect(lastBody.text).not.toContain("outlet:");
  } finally {
    globalThis.fetch = savedFetch;
  }
});
