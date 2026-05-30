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

it("audits skip + returns {skipped: 'role_unbound'} when the founders role is unbound (no retry storm)", async () => {
  // No telegramChats row → role pre-check returns role_unbound, audited as such.
  // Fix I-6 (CLAUDE.md rule #12): unbound role no longer throws — it audits and
  // skips, distinguishing config errors from real Telegram 5xx (send_failed).
  const t = convexTest(schema);
  // No pos_settings row → defaults to enabled.
  const res = await t.action(internal.telegram.foundersSummary.sendFoundersSummary, {});
  expect(res).toEqual({ skipped: "role_unbound" });
  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(
    audit.some(
      (r) =>
        r.action === "founders.summary_skipped" &&
        r.metadata != null &&
        (JSON.parse(r.metadata) as { reason: string }).reason === "role_unbound",
    ),
  ).toBe(true);
  // Crucially: NO send_failed audit row (the misleading conflation Fix I-6 corrected).
  expect(
    audit.some(
      (r) =>
        r.action === "founders.summary_skipped" &&
        r.metadata != null &&
        (JSON.parse(r.metadata) as { reason: string }).reason === "send_failed",
    ),
  ).toBe(false);
});

// ─── sendFoundersSummaryResilient ─────────────────────────────────────────────

it("resilient wrapper: surfaces role_unbound skip cleanly (no retry, no throw)", async () => {
  // No telegramChats → pre-check skip. The wrapper passes the skip return
  // through without scheduling a retry (config errors don't recover by waiting).
  const t = convexTest(schema);
  const res = await t.action(
    internal.telegram.foundersSummary.sendFoundersSummaryResilient,
    { attempt: 0 },
  );
  expect(res).toEqual({ skipped: "role_unbound" });
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
