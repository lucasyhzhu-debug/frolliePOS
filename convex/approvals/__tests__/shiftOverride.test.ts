"use node";

/**
 * Task 4: requestShiftOverride action tests.
 *
 * Session-less: the action is triggered by a blocked/stranded booth staffer
 * who has no session. It resolves the outlet from the deviceId, checks for an
 * active pos_shifts hold, and either creates a shift_override approval request
 * (sending a Telegram card) or returns { noHold: true }.
 *
 * Seeding: inline via t.run (no shared _helpers.ts — those don't exist for shifts).
 * Telegram: fetch is stubbed at globalThis level so sendTemplate is a no-op
 * returning { ok: true, result: { message_id: 1 } }.
 */

import { convexTest } from "convex-test";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import schema from "../../schema";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

// ---------------------------------------------------------------------------
// Telegram fetch stub (matches managerOverride.test.ts pattern)
// ---------------------------------------------------------------------------
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
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.POS_BASE_URL;
});

// ---------------------------------------------------------------------------
// Seed helpers (inline — no shared _helpers.ts)
// ---------------------------------------------------------------------------

/**
 * Seed an open outlet with a bound device and an active shift hold.
 * Also seeds a bare telegramChats row (no outlet_id) for the single-outlet
 * Telegram routing fallback in resolveOutletChatId.
 */
async function seedOutletAndOpenShift(
  t: ReturnType<typeof convexTest>,
  deviceId = "d-shift-override-1",
): Promise<{ outletId: Id<"outlets">; deviceId: string }> {
  const outletId: Id<"outlets"> = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      is_open: true,
      code: "PKW",
      name: "Pakuwon",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    } as any);
    await ctx.db.insert("registered_devices", {
      device_id: deviceId,
      label: "Test Device",
      activated_at: Date.now(),
      active: true,
      outlet_id: outletId,
    } as any);
    const holder = await ctx.db.insert("staff", {
      name: "Stranded Sisca",
      code: "S-ST1",
      role: "staff",
      active: true,
      pin_hash: "x",
      created_at: Date.now(),
    });
    await ctx.db.insert("pos_shifts", {
      outlet_id: outletId,
      device_id: deviceId,
      staff_id: holder,
      started_at: Date.now() - 60_000,
      started_via: "sop",
      ended_at: null,
      ended_via: null,
      open_count: null,
      close_count: null,
      outgoing_uncounted: null,
      steps: [],
      summary: null,
      prev_shift_id: null,
      created_at: Date.now() - 60_000,
    } as any);
    // Bare managers chat (no outlet_id) → single-outlet Telegram routing fallback
    await ctx.db.insert("telegramChats", {
      chatId: "-100managers",
      chatType: "supergroup",
      title: "Mgrs",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    return outletId;
  });
  return { outletId, deviceId };
}

/**
 * Seed an open outlet with a bound device but NO active shift hold.
 */
async function seedOutletClosedNoShift(
  t: ReturnType<typeof convexTest>,
  deviceId = "d-shift-override-2",
): Promise<{ outletId: Id<"outlets">; deviceId: string }> {
  const outletId: Id<"outlets"> = await t.run(async (ctx: any) => {
    const outletId = await ctx.db.insert("outlets", {
      is_open: true,
      code: "PKW2",
      name: "Pakuwon2",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    } as any);
    await ctx.db.insert("registered_devices", {
      device_id: deviceId,
      label: "Test Device 2",
      activated_at: Date.now(),
      active: true,
      outlet_id: outletId,
    } as any);
    return outletId;
  });
  return { outletId, deviceId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("requestShiftOverride", () => {
  it("creates a pending shift_override and dedups on repeat (different idempotency key)", async () => {
    const t = convexTest(schema);
    const { deviceId } = await seedOutletAndOpenShift(t);

    // r1: first request — creates the approval row + sends Telegram card
    const r1 = await t.action(api.approvals.actions.requestShiftOverride, {
      deviceId,
      idempotencyKey: "r1",
    });
    expect("requestId" in r1).toBe(true);
    if (!("requestId" in r1)) throw new Error("expected requestId in r1");

    // r2: same shift, different idempotency key → dedup guard returns same requestId
    const r2 = await t.action(api.approvals.actions.requestShiftOverride, {
      deviceId,
      idempotencyKey: "r2",
    });
    expect("requestId" in r2).toBe(true);
    if (!("requestId" in r2)) throw new Error("expected requestId in r2");

    expect(r2.requestId).toBe(r1.requestId);

    // Exactly one shift_override row was created
    const rows = await t.run((ctx) =>
      ctx.db.query("pos_approval_requests").collect(),
    );
    const overrides = rows.filter((r) => r.kind === "shift_override");
    expect(overrides.length).toBe(1);
    expect(overrides[0].status).toBe("pending");
    expect(overrides[0].notified_at).toBeTruthy();
  });

  it("no-ops with { noHold: true } when the booth has no active hold", async () => {
    const t = convexTest(schema);
    const { deviceId } = await seedOutletClosedNoShift(t);

    const r = await t.action(api.approvals.actions.requestShiftOverride, {
      deviceId,
      idempotencyKey: "r3",
    });
    expect(r).toMatchObject({ noHold: true });

    // No approval request rows created
    const rows = await t.run((ctx) =>
      ctx.db.query("pos_approval_requests").collect(),
    );
    expect(rows.length).toBe(0);
  });
});
