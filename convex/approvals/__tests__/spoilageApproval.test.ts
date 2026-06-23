"use node";

import { convexTest } from "convex-test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

/**
 * v0.6 Task S5 — off-booth spoilage approval path.
 *
 * Covers requestSpoilageApproval (manager-only requester, creates pending row,
 * sends Telegram card, audits spoilage.requested) AND approveSpoilage (token
 * auth before cache, argon2 PIN verify, commits via S3's _recordSpoilage_internal
 * with source="telegram_approval", resolves the approval row).
 *
 * Mirrors manualPayment.test.ts shape: fetch is mocked at globalThis level so
 * sendTemplate is a no-op returning { message_id: 42 }. POS_BASE_URL +
 * TELEGRAM_BOT_TOKEN env vars set per-test.
 */

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 42 } }),
    text: async () => "{}",
  })) as unknown as typeof fetch;
  process.env.POS_BASE_URL = "https://pos.example.com";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const MGR_CODE = "S-9";
const MGR_PIN = "9999";

// v2.0 Task 12 (ENFORCE): all the spoilage tables (skus, stock_levels, movements,
// sessions, approval requests) require outlet_id, and the spoilage commit reads
// stock_levels by (outlet_id, sku) — so every fixture must share ONE outlet. Seed
// it once per test and thread it through seedManager / seedSku / _createRequest.
async function seedOutlet(t: ReturnType<typeof convexTest>): Promise<Id<"outlets">> {
  return await t.run((ctx) =>
    ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta", active: true,
      created_at: Date.now(), created_by: null,
    } as any),
  );
}

async function seedManager(
  t: ReturnType<typeof convexTest>,
  outletId: Id<"outlets">,
): Promise<{
  managerId: Id<"staff">;
  sessionId: Id<"staff_sessions">;
}> {
  const managerId = await t.action(
    internal.auth.actions._seedHashedStaff_internal,
    { name: "Manager", pin: MGR_PIN, role: "manager" },
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(managerId, { code: MGR_CODE });
  });
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("staff_sessions", {
      staff_id: managerId,
      device_id: "mgr-device",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    } as any),
  );
  return { managerId, sessionId };
}

async function seedSku(
  t: ReturnType<typeof convexTest>,
  sku: string,
  onHand: number,
  outletId: Id<"outlets">,
): Promise<Id<"pos_inventory_skus">> {
  return await t.run(async (ctx) => {
    const skuId = await ctx.db.insert("pos_inventory_skus", {
      sku,
      name: `Sku ${sku.toUpperCase()}`,
      unit: "piece",
      low_threshold: 0,
      active: true,
      created_at: Date.now(),
      outlet_id: outletId,
    } as any);
    await ctx.db.insert("pos_stock_levels", {
      inventory_sku_id: skuId,
      on_hand: onHand,
      updated_at: Date.now(),
      outlet_id: outletId,
    } as any);
    return skuId;
  });
}

async function seedManagersChat(t: ReturnType<typeof convexTest>): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("telegramChats", {
      chatId: "-100managers",
      chatType: "supergroup",
      title: "Mgrs",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    });
  });
}

// ─── requestSpoilageApproval ────────────────────────────────────────────────

describe("requestSpoilageApproval", () => {
  it("creates a pending spoilage request and notifies managers", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const { managerId, sessionId } = await seedManager(t, outletId);
    await seedManagersChat(t);
    const skuA = await seedSku(t, "a", 10, outletId);

    const res = await t.action(api.approvals.actions.requestSpoilageApproval, {
      sessionId,
      lines: [{ inventory_sku_id: skuA, sku_code: "A", qty: 3 }],
      reason: "expired",
      idempotencyKey: "spoil-req-1",
    });

    expect(res.requestId).toBeDefined();

    const row = await t.run((ctx) => ctx.db.get(res.requestId));
    expect(row?.status).toBe("pending");
    expect(row?.kind).toBe("spoilage");
    expect(row?.requester_staff_id).toBe(managerId);
    expect(row?.notified_at).toBeTruthy();
    expect(row?.telegram_message_id).toBe(42);

    // Stock should NOT decrement at request time — commit happens at approve.
    const level = await t.run((ctx) =>
      ctx.db
        .query("pos_stock_levels")
        .withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuA))
        .first(),
    );
    expect(level?.on_hand).toBe(10);
  });

  it("idempotency replay returns the same requestId and doesn't re-fire fetch", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const { sessionId } = await seedManager(t, outletId);
    await seedManagersChat(t);
    const skuA = await seedSku(t, "a", 10, outletId);

    const r1 = await t.action(api.approvals.actions.requestSpoilageApproval, {
      sessionId,
      lines: [{ inventory_sku_id: skuA, sku_code: "A", qty: 2 }],
      reason: "broke",
      idempotencyKey: "k1",
    });

    const fetchSpy = vi.mocked(fetch);
    const callsBefore = fetchSpy.mock.calls.length;

    const r2 = await t.action(api.approvals.actions.requestSpoilageApproval, {
      sessionId,
      lines: [{ inventory_sku_id: skuA, sku_code: "A", qty: 2 }],
      reason: "broke",
      idempotencyKey: "k1",
    });

    expect(r2.requestId).toBe(r1.requestId);
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });

  it("rejects non-manager requesters with NOT_MANAGER", async () => {
    const t = convexTest(schema);
    const outletId = await seedOutlet(t);
    const skuA = await seedSku(t, "a", 10, outletId);
    await seedManagersChat(t);
    // Seed staff (not manager) + session.
    const sessionId = await t.run(async (ctx) => {
      const staffId = await ctx.db.insert("staff", {
        name: "Lucy",
        code: "S-1",
        role: "staff",
        active: true,
        pin_hash: "x",
        created_at: Date.now(),
      });
      return ctx.db.insert("staff_sessions", {
        staff_id: staffId,
        device_id: "d",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
        outlet_id: outletId,
      } as any);
    });

    await expect(
      t.action(api.approvals.actions.requestSpoilageApproval, {
        sessionId,
        lines: [{ inventory_sku_id: skuA, sku_code: "A", qty: 1 }],
        reason: "expired",
        idempotencyKey: "staff-req",
      }),
    ).rejects.toThrow("NOT_MANAGER");
  });
});

// ─── approveSpoilage ────────────────────────────────────────────────────────

async function seedApprovable(t: ReturnType<typeof convexTest>): Promise<{
  rawToken: string;
  requestId: Id<"pos_approval_requests">;
  managerId: Id<"staff">;
  skuA: Id<"pos_inventory_skus">;
  skuB: Id<"pos_inventory_skus">;
  eventId: string;
}> {
  const outletId = await seedOutlet(t);
  const { managerId } = await seedManager(t, outletId);
  const skuA = await seedSku(t, "a", 10, outletId);
  const skuB = await seedSku(t, "b", 5, outletId);

  const rawToken = "raw-token-spoilage-approve";
  const eventId = "evt-spoilage-1";

  const { requestId } = await t.mutation(
    internal.approvals.internal._createRequest_internal,
    {
      kind: "spoilage",
      requester_staff_id: managerId,
      entity_type: "pos_stock_movements",
      entity_id: eventId,
      context: {
        spoilage_event_id: eventId,
        lines: [
          { inventory_sku_id: skuA as unknown as string, sku_code: "A", qty: 3 },
          { inventory_sku_id: skuB as unknown as string, sku_code: "B", qty: 2 },
        ],
        total_qty: 5,
        reason: "expired batch",
      },
      reason: "expired batch",
      triggered_by_event: "spoilage_request",
      triggered_at: Date.now(),
      token_hash: sha256Hex(rawToken),
      token_expires_at: Date.now() + 3_600_000,
      outletId,
    },
  );

  return { rawToken, requestId, managerId, skuA, skuB, eventId };
}

describe("approveSpoilage", () => {
  it("commits the spoilage, decrements stock, resolves the request", async () => {
    const t = convexTest(schema);
    const { rawToken, requestId, skuA, skuB, eventId } = await seedApprovable(t);

    const res = await t.action(api.approvals.actions.approveSpoilage, {
      token: rawToken,
      managerStaffCode: MGR_CODE,
      managerPin: MGR_PIN,
      idempotencyKey: "appr-1",
    });
    expect(res.event_id).toBe(eventId);
    expect(res.line_count).toBe(2);
    expect(res.total_qty).toBe(5);

    // Movements written with source="spoilage" + grouped by event_id.
    const movs = await t.run((ctx) => ctx.db.query("pos_stock_movements").collect());
    expect(movs).toHaveLength(2);
    for (const m of movs) {
      expect(m.source).toBe("spoilage");
      expect(m.spoilage_event_id).toBe(eventId);
    }

    // Stock decremented.
    const lvlA = await t.run((ctx) =>
      ctx.db
        .query("pos_stock_levels")
        .withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuA))
        .first(),
    );
    expect(lvlA?.on_hand).toBe(7);
    const lvlB = await t.run((ctx) =>
      ctx.db
        .query("pos_stock_levels")
        .withIndex("by_sku", (q) => q.eq("inventory_sku_id", skuB))
        .first(),
    );
    expect(lvlB?.on_hand).toBe(3);

    // Request resolved.
    const req = await t.run((ctx) => ctx.db.get(requestId));
    expect(req?.status).toBe("resolved");

    // Audit: stock.spoilage row should record source=telegram_approval.
    const audits = await t.run((ctx) =>
      ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "stock.spoilage"))
        .collect(),
    );
    expect(audits.length).toBe(1);
    expect(audits[0].source).toBe("telegram_approval");
  });

  it("wrong PIN throws INVALID_PIN; off-booth miss writes no booth lockout row (SEC-07)", async () => {
    const t = convexTest(schema);
    const { rawToken, managerId } = await seedApprovable(t);

    await expect(
      t.action(api.approvals.actions.approveSpoilage, {
        token: rawToken,
        managerStaffCode: MGR_CODE,
        managerPin: "0000", // wrong
        idempotencyKey: "appr-wrong",
      }),
    ).rejects.toThrow("INVALID_PIN");

    // SEC-07: off-booth miss is audited but never touches the booth lockout counter.
    const attempts = await t.run((ctx) =>
      ctx.db
        .query("pos_auth_attempts")
        .filter((q) => q.eq(q.field("staff_id"), managerId))
        .collect(),
    );
    expect(attempts.length).toBe(0);
  });

  it("bad token throws TOKEN_INVALID", async () => {
    const t = convexTest(schema);
    await seedApprovable(t);

    await expect(
      t.action(api.approvals.actions.approveSpoilage, {
        token: "wrong-token-value",
        managerStaffCode: MGR_CODE,
        managerPin: MGR_PIN,
        idempotencyKey: "appr-badtok",
      }),
    ).rejects.toThrow("TOKEN_INVALID");
  });

  // Note: NO same-key replay test here. approveSpoilage mirrors approveRefund's
  // I5 envelope (token auth + state guards BEFORE cache lookup; CLAUDE.md rule
  // #21). After the first call resolves the request, a same-key retry hits the
  // state guard and throws REQUEST_RESOLVED *before* the cache check — by
  // design (the cached blob is unreachable once status flips to "resolved").
  // The replay-safety story for this envelope is owned by the inner _markResolved
  // and _recordFailedAttempt mutations' own withIdempotency caches, plus the
  // action-cache write that protects against the very narrow window between
  // commit and resolve (caught only via the same-key path inside that window).
});
