// convex/telegram/__tests__/foundersSummary.test.ts
//
// Tests for sendFoundersSummary + sendFoundersSummaryResilient (Task 24).

import { convexTest } from "convex-test";
import { expect, it, vi, beforeEach } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    })),
  );
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
});

// ─── sendFoundersSummary ──────────────────────────────────────────────────────

it("no-ops with audited skip when the founders toggle is off", async () => {
  const t = convexTest(schema);
  await t.run((ctx) =>
    ctx.db.insert("pos_settings", {
      founders_summary_enabled: false,
      updated_at: Date.now(),
    }),
  );
  const res = await t.action(
    internal.telegram.foundersSummary.sendFoundersSummary,
    {},
  );
  expect((res as { skipped: string }).skipped).toBe("disabled");
  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(
    audit.some((r) => r.action === "founders.summary_skipped"),
  ).toBe(true);
});

it("sends successfully when toggle is on and founders chat is bound", async () => {
  const t = convexTest(schema);
  // Toggle defaults to true (no row needed), but insert a row to be explicit.
  await t.run((ctx) =>
    ctx.db.insert("pos_settings", {
      founders_summary_enabled: true,
      updated_at: Date.now(),
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("telegramChats", {
      chatId: "-100founders",
      chatType: "supergroup",
      title: "F",
      role: "founders",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    }),
  );
  const res = await t.action(
    internal.telegram.foundersSummary.sendFoundersSummary,
    {},
  );
  expect((res as { ok: boolean }).ok).toBe(true);
});

it("defaults to enabled when pos_settings row is absent", async () => {
  // No pos_settings row → founders_summary_enabled defaults to true.
  const t = convexTest(schema);
  await t.run((ctx) =>
    ctx.db.insert("telegramChats", {
      chatId: "-100founders",
      chatType: "supergroup",
      title: "F",
      role: "founders",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    }),
  );
  const res = await t.action(
    internal.telegram.foundersSummary.sendFoundersSummary,
    {},
  );
  expect((res as { ok: boolean }).ok).toBe(true);
});

it("audits skip + throws (no retry storm) when the founders role is unbound (non-transient)", async () => {
  // No telegramChats row → getChatIdByRole throws (non-transient, no "no available workers")
  const t = convexTest(schema);
  // No pos_settings row → defaults to enabled.
  await expect(
    t.action(internal.telegram.foundersSummary.sendFoundersSummary, {}),
  ).rejects.toThrow();
  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(
    audit.some(
      (r) =>
        r.action === "founders.summary_skipped" &&
        r.metadata != null &&
        (JSON.parse(r.metadata) as { reason: string }).reason === "send_failed",
    ),
  ).toBe(true);
});

// ─── sendFoundersSummaryResilient ─────────────────────────────────────────────

it("resilient wrapper: throws immediately on non-transient error (no retry loop)", async () => {
  // No telegramChats → non-transient throw from sendFoundersSummary.
  // The wrapper must surface it, not loop.
  const t = convexTest(schema);
  await expect(
    t.action(internal.telegram.foundersSummary.sendFoundersSummaryResilient, {
      attempt: 0,
    }),
  ).rejects.toThrow();
});

it("resilient wrapper: succeeds when founders chat is bound", async () => {
  const t = convexTest(schema);
  await t.run((ctx) =>
    ctx.db.insert("telegramChats", {
      chatId: "-100founders",
      chatType: "supergroup",
      title: "F",
      role: "founders",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    }),
  );
  const res = await t.action(
    internal.telegram.foundersSummary.sendFoundersSummaryResilient,
    { attempt: 0 },
  );
  expect((res as { ok: boolean }).ok).toBe(true);
});
