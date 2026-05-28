import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
  process.env.TELEGRAM_CHAT_ID = "-1001234567";
  process.env.POS_BASE_URL = "https://pos.dev";
  // Stub fetch so the scheduled notifyStaffLockout's Telegram send is offline.
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

async function seedStaff(t: ReturnType<typeof convexTest>): Promise<Id<"staff">> {
  return await t.action(internal.auth.actions._seedHashedStaff_internal, {
    name: "Lucy",
    pin: "1234",
    role: "staff",
  });
}

async function countApprovalRows(
  t: ReturnType<typeof convexTest>,
  staffId: Id<"staff">,
): Promise<number> {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("pos_approval_requests")
      .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", staffId))
      .collect(),
  );
  return rows.length;
}

describe("auth lockout → scheduler trigger (Task 18)", () => {
  it("3rd failed attempt schedules notifyStaffLockout → an approval row is created", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t);

    // Three wrong-PIN logins. The 3rd trips the lockout and schedules notify.
    for (let i = 0; i < 3; i++) {
      await expect(
        t.action(api.auth.actions.loginWithPin, {
          idempotencyKey: `wrong-${i}`,
          staffId,
          pin: "0000",
          deviceId: "d",
        }),
      ).rejects.toThrow();
    }

    // runAfter(0) dispatches via setTimeout(0): yield one macrotask so the job
    // transitions pending → inProgress before we drain it.
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();

    expect(await countApprovalRows(t, staffId)).toBe(1);
    const req = await t.run((ctx) =>
      ctx.db
        .query("pos_approval_requests")
        .withIndex("by_subject_staff", (q) => q.eq("subject_staff_id", staffId))
        .first(),
    );
    expect(req?.kind).toBe("staff_pin_reset");
  });

  it("1st and 2nd failed attempts do NOT schedule notify (0 approval rows)", async () => {
    const t = convexTest(schema);
    const staffId = await seedStaff(t);

    for (let i = 0; i < 2; i++) {
      await expect(
        t.action(api.auth.actions.loginWithPin, {
          idempotencyKey: `wrong-${i}`,
          staffId,
          pin: "0000",
          deviceId: "d",
        }),
      ).rejects.toThrow();
    }

    // runAfter(0) dispatches via setTimeout(0): yield one macrotask so the job
    // transitions pending → inProgress before we drain it.
    await new Promise((r) => setTimeout(r, 0));
    await t.finishInProgressScheduledFunctions();

    expect(await countApprovalRows(t, staffId)).toBe(0);
  });
});
