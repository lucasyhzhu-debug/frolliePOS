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
import { createHash } from "node:crypto";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { drainScheduled } from "../../__tests__/_helpers";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const MGR_CODE = "S-MGR1";
const MGR_PIN = "4242";

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

/**
 * Seed an approvable shift_override: open outlet + bound device + active hold +
 * a manager (real argon2 PIN hash via _seedHashedStaff_internal) + a pending
 * shift_override approval request with a KNOWN raw token (mirrors
 * spoilageApproval.test.ts seedApprovable — seed the request row directly via
 * _createRequest_internal rather than capturing the token off the send stub).
 */
async function seedApprovableOverride(
  t: ReturnType<typeof convexTest>,
  deviceId = "d-shift-override-approve",
): Promise<{
  outletId: Id<"outlets">;
  deviceId: string;
  holderId: Id<"staff">;
  shiftId: Id<"pos_shifts">;
  managerId: Id<"staff">;
  rawToken: string;
}> {
  const rawToken = "raw-token-shift-override-approve";

  // Manager with a real PIN hash (the approve path argon2-verifies it).
  const managerId = await t.action(
    internal.auth.actions._seedHashedStaff_internal,
    { name: "Manager Mira", pin: MGR_PIN, role: "manager" },
  );
  await t.run(async (ctx) => {
    await ctx.db.patch(managerId, { code: MGR_CODE });
  });

  const { outletId, shiftId, holderId } = await t.run(async (ctx: any) => {
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
    const holderId = await ctx.db.insert("staff", {
      name: "Stranded Sisca",
      code: "S-ST1",
      role: "staff",
      active: true,
      pin_hash: "x",
      created_at: Date.now(),
    });
    const shiftId = await ctx.db.insert("pos_shifts", {
      outlet_id: outletId,
      device_id: deviceId,
      staff_id: holderId,
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
    await ctx.db.insert("telegramChats", {
      chatId: "-100managers",
      chatType: "supergroup",
      title: "Mgrs",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    return { outletId, shiftId, holderId };
  });

  await t.mutation(internal.approvals.internal._createRequest_internal, {
    kind: "shift_override",
    entity_type: "pos_shifts",
    entity_id: shiftId as unknown as string,
    context: {
      shift_id: shiftId as unknown as string,
      device_id: deviceId,
      outlet_label: "Pakuwon",
      stranded_staff_name: "Stranded Sisca",
      shift_started_at: Date.now() - 60_000,
      sales_so_far_idr: 0,
      txn_count: 0,
    },
    triggered_by_event: "shift_override_request",
    triggered_at: Date.now(),
    token_hash: sha256Hex(rawToken),
    token_expires_at: Date.now() + 3_600_000,
    outletId,
  });

  return { outletId, deviceId, holderId, shiftId, managerId, rawToken };
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

describe("approveShiftOverride", () => {
  it("manager code+PIN with resultingState close closes the booth and ends the hold", async () => {
    const t = convexTest(schema);
    const { outletId, shiftId, rawToken } = await seedApprovableOverride(t);

    const res = await t.action(api.approvals.actions.approveShiftOverride, {
      token: rawToken,
      managerStaffCode: MGR_CODE,
      managerPin: MGR_PIN,
      resultingState: "close",
      idempotencyKey: "ovr-close-1",
    });
    expect(res).toEqual({ resolved: true });

    // Outlet closed.
    const status = await t.query(
      internal.outlets.status._getOutletStatus_internal,
      { outletId },
    );
    expect(status.is_open).toBe(false);

    // Hold force-ended via manager_override.
    const shift = await t.run((ctx) => ctx.db.get(shiftId));
    expect(shift?.ended_at).not.toBeNull();
    expect(shift?.ended_via).toBe("manager_override");

    // Request resolved.
    const reqRows = await t.run((ctx) =>
      ctx.db.query("pos_approval_requests").collect(),
    );
    expect(reqRows[0].status).toBe("resolved");

    // Drain the scheduled _sendSignoffSummary action (commit schedules it).
    await drainScheduled(t);
  });

  it("resultingState release ends the hold but leaves the booth open", async () => {
    const t = convexTest(schema);
    const { outletId, shiftId, rawToken } = await seedApprovableOverride(t);

    const res = await t.action(api.approvals.actions.approveShiftOverride, {
      token: rawToken,
      managerStaffCode: MGR_CODE,
      managerPin: MGR_PIN,
      resultingState: "release",
      idempotencyKey: "ovr-release-1",
    });
    expect(res).toEqual({ resolved: true });

    // Outlet stays open — release force-ends the holder without closing.
    const status = await t.query(
      internal.outlets.status._getOutletStatus_internal,
      { outletId },
    );
    expect(status.is_open).toBe(true);

    // Hold still force-ended.
    const shift = await t.run((ctx) => ctx.db.get(shiftId));
    expect(shift?.ended_at).not.toBeNull();
    expect(shift?.ended_via).toBe("manager_override");

    // Drain the scheduled _sendSignoffSummary action (commit schedules it).
    await drainScheduled(t);
  });

  it("rejects a non-manager code with NOT_MANAGER", async () => {
    const t = convexTest(schema);
    const { rawToken } = await seedApprovableOverride(t);

    // S-ST1 is the stranded staffer (role: "staff"), not a manager.
    await expect(
      t.action(api.approvals.actions.approveShiftOverride, {
        token: rawToken,
        managerStaffCode: "S-ST1",
        managerPin: MGR_PIN,
        resultingState: "close",
        idempotencyKey: "ovr-nonmgr",
      }),
    ).rejects.toThrow("NOT_MANAGER");
  });

  it("wrong PIN throws INVALID_PIN and writes no booth lockout row (SEC-07)", async () => {
    const t = convexTest(schema);
    const { managerId, rawToken } = await seedApprovableOverride(t);

    await expect(
      t.action(api.approvals.actions.approveShiftOverride, {
        token: rawToken,
        managerStaffCode: MGR_CODE,
        managerPin: "0000", // wrong
        resultingState: "close",
        idempotencyKey: "ovr-wrongpin",
      }),
    ).rejects.toThrow("INVALID_PIN");

    // SEC-07: off-booth miss never touches the booth lockout counter.
    const attempts = await t.run((ctx) =>
      ctx.db
        .query("pos_auth_attempts")
        .filter((q) => q.eq(q.field("staff_id"), managerId))
        .collect(),
    );
    expect(attempts.length).toBe(0);

    // The per-token PIN-attempt cap incremented instead.
    const reqRows = await t.run((ctx) =>
      ctx.db.query("pos_approval_requests").collect(),
    );
    expect((reqRows[0] as any).failed_pin_attempts).toBe(1);
  });
});
