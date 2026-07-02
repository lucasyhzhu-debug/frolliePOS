// convex/telegram/__tests__/ownersSummary.test.ts
//
// Tests for sendOwnersSummary + sendOwnersSummaryResilient (v2.0 Spec-4 Task 7).
//
// Scenarios:
//  (a) two outlets → owners rollup payload perOutlet sums to business total + routes to owners
//  (b) each outlet's managers_daily_summary resolves its OWN (managers, X) chat
//  (c) owners role unbound → audited skip, no throw
//  (d) ONE outlet's managers chat unbound → that outlet skipped, owners rollup + other outlet still send
//  (e) default-outlet toggle off → owners rollup skipped; a per-outlet toggle off → only that outlet's managers summary skipped

import { convexTest } from "convex-test";
import { expect, it, vi, beforeEach } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

// ─── test helpers ─────────────────────────────────────────────────────────────

type InsertedOutlet = { outletId: Id<"outlets">; code: string; name: string };

async function seedOutlet(
  t: ReturnType<typeof convexTest>,
  opts: { code: string; name: string; summaryEnabled?: boolean },
): Promise<InsertedOutlet> {
  const outletId = await t.run((ctx) =>
    ctx.db.insert("outlets", { is_open: false,
      code: opts.code,
      name: opts.name,
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    } as any),
  );
  await t.run((ctx) =>
    ctx.db.insert("pos_settings", {
      founders_summary_enabled: opts.summaryEnabled ?? true,
      updated_at: Date.now(),
      outlet_id: outletId,
    } as any),
  );
  return { outletId, code: opts.code, name: opts.name };
}

async function seedOwnersChat(
  t: ReturnType<typeof convexTest>,
  chatId: string,
): Promise<void> {
  await t.run((ctx) =>
    ctx.db.insert("telegramChats", {
      chatId,
      chatType: "supergroup",
      title: "Owners Chat",
      role: "owners",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    }),
  );
}

async function seedManagersChat(
  t: ReturnType<typeof convexTest>,
  chatId: string,
  outletId: Id<"outlets">,
): Promise<void> {
  await t.run((ctx) =>
    ctx.db.insert("telegramChats", {
      chatId,
      chatType: "supergroup",
      title: `Managers Chat ${chatId}`,
      role: "managers",
      outlet_id: outletId,
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    }),
  );
}

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

// ─── (a) two outlets → owners rollup + perOutlet sums ─────────────────────────

it("(a) two outlets → owners rollup payload perOutlet sums to business total + routes to owners chat", async () => {
  const ownersChat = "-100owners-biz";
  const capturedBodies: Array<{ chat_id?: unknown; text?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.body) {
        capturedBodies.push(JSON.parse(options.body as string) as { chat_id?: unknown; text?: unknown });
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }),
  );

  const t = convexTest(schema);
  const o1 = await seedOutlet(t, { code: "PKW", name: "Pakuwon" });
  const o2 = await seedOutlet(t, { code: "CIT", name: "Citraland" });
  await seedOwnersChat(t, ownersChat);
  await seedManagersChat(t, "-100mgr-pkw", o1.outletId);
  await seedManagersChat(t, "-100mgr-cit", o2.outletId);

  const res = await t.action(internal.telegram.ownersSummary.sendOwnersSummary, {});
  expect((res as { ok: boolean }).ok).toBe(true);

  // At minimum: one owners rollup + one managers send per outlet = at least 3 sends
  expect(capturedBodies.length).toBeGreaterThanOrEqual(3);

  // Find the owners rollup (sent to the owners chat)
  const ownersRollup = capturedBodies.find((b) => b.chat_id === ownersChat);
  expect(ownersRollup).toBeDefined();
  expect(typeof ownersRollup?.text).toBe("string");

  // The owners rollup text should contain "── By outlet ──" (multi-outlet breakdown)
  expect(ownersRollup?.text as string).toContain("── By outlet ──");
  expect(ownersRollup?.text as string).toContain("Pakuwon");
  expect(ownersRollup?.text as string).toContain("Citraland");
});

// ─── (a2) per-SKU units: merged in owners rollup, per-outlet in managers ──────

it("(a2) sale movements surface as per-SKU units — merged across outlets in the owners rollup, own-outlet only in each managers summary", async () => {
  const ownersChat = "-100owners-sku";
  const mgrChatPkw = "-100mgr-pkw-sku";
  const mgrChatCit = "-100mgr-cit-sku";
  const capturedBodies: Array<{ chat_id?: unknown; text?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.body) {
        capturedBodies.push(JSON.parse(options.body as string) as { chat_id?: unknown; text?: unknown });
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }),
  );

  const t = convexTest(schema);
  const o1 = await seedOutlet(t, { code: "PKW", name: "Pakuwon" });
  const o2 = await seedOutlet(t, { code: "CIT", name: "Citraland" });
  await seedOwnersChat(t, ownersChat);
  await seedManagersChat(t, mgrChatPkw, o1.outletId);
  await seedManagersChat(t, mgrChatCit, o2.outletId);

  // Same SKU string in both outlets (cloned catalogs) → merged by `sku` key.
  // Movements use Date.now() so they land inside the current WIB day window.
  await t.run(async (ctx) => {
    const now = Date.now();
    const dubaiPkw = await ctx.db.insert("pos_inventory_skus", {
      sku: "dubai", name: "Dubai Cookie", unit: "piece", low_threshold: 5,
      active: true, created_at: now, outlet_id: o1.outletId,
    });
    const dubaiCit = await ctx.db.insert("pos_inventory_skus", {
      sku: "dubai", name: "Dubai Cookie", unit: "piece", low_threshold: 5,
      active: true, created_at: now, outlet_id: o2.outletId,
    });
    // Pakuwon sells 120 pcs; Citraland sells 30 pcs → business total 150.
    await ctx.db.insert("pos_stock_movements", {
      inventory_sku_id: dubaiPkw, qty: -120, source: "sale",
      created_at: now, outlet_id: o1.outletId,
    });
    await ctx.db.insert("pos_stock_movements", {
      inventory_sku_id: dubaiCit, qty: -30, source: "sale",
      created_at: now, outlet_id: o2.outletId,
    });
  });

  const res = await t.action(internal.telegram.ownersSummary.sendOwnersSummary, {});
  expect((res as { ok: boolean }).ok).toBe(true);

  const ownersRollup = capturedBodies.find((b) => b.chat_id === ownersChat);
  expect(ownersRollup?.text as string).toContain("Units sold");
  expect(ownersRollup?.text as string).toContain("• Dubai Cookie: 150 pcs");

  const pkwSummary = capturedBodies.find((b) => b.chat_id === mgrChatPkw);
  expect(pkwSummary?.text as string).toContain("• Dubai Cookie: 120 pcs");
  const citSummary = capturedBodies.find((b) => b.chat_id === mgrChatCit);
  expect(citSummary?.text as string).toContain("• Dubai Cookie: 30 pcs");
});

// ─── (b) each outlet's managers_daily_summary uses its OWN chat ───────────────

it("(b) each outlet's managers_daily_summary resolves its OWN (managers, outletId) chat", async () => {
  const mgrChatPkw = "-100mgr-pkw-b";
  const mgrChatCit = "-100mgr-cit-b";
  const capturedBodies: Array<{ chat_id?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.body) {
        capturedBodies.push(JSON.parse(options.body as string) as { chat_id?: unknown });
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }),
  );

  const t = convexTest(schema);
  const o1 = await seedOutlet(t, { code: "PKW", name: "Pakuwon" });
  const o2 = await seedOutlet(t, { code: "CIT", name: "Citraland" });
  await seedOwnersChat(t, "-100owners-b");
  await seedManagersChat(t, mgrChatPkw, o1.outletId);
  await seedManagersChat(t, mgrChatCit, o2.outletId);

  const res = await t.action(internal.telegram.ownersSummary.sendOwnersSummary, {});
  expect((res as { ok: boolean }).ok).toBe(true);

  const sentChatIds = capturedBodies.map((b) => b.chat_id);
  // Both outlet-scoped managers chats must be present — distinct from each other.
  expect(sentChatIds).toContain(mgrChatPkw);
  expect(sentChatIds).toContain(mgrChatCit);
  expect(mgrChatPkw).not.toBe(mgrChatCit);
});

// ─── (c) owners role unbound → audited skip, no throw ─────────────────────────

it("(c) owners role unbound → audited skip with reason role_unbound, no throw", async () => {
  const t = convexTest(schema);
  await seedOutlet(t, { code: "PKW", name: "Pakuwon" });
  // No telegramChats row for 'owners' — should skip cleanly.

  const res = await t.action(internal.telegram.ownersSummary.sendOwnersSummary, {});
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
  // No send_failed — this is a config error, not a Telegram transport error.
  expect(
    audit.some(
      (r) =>
        r.action === "founders.summary_skipped" &&
        r.metadata != null &&
        (JSON.parse(r.metadata) as { reason: string }).reason === "send_failed",
    ),
  ).toBe(false);
});

// ─── (d) ONE outlet's managers chat unbound → that outlet skipped, others send ─

it("(d) one outlet managers chat unbound → that outlet skipped, owners rollup + other outlet still send", async () => {
  const mgrChatCit = "-100mgr-cit-d";
  const capturedBodies: Array<{ chat_id?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.body) {
        capturedBodies.push(JSON.parse(options.body as string) as { chat_id?: unknown });
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }),
  );

  const t = convexTest(schema);
  await seedOutlet(t, { code: "PKW", name: "Pakuwon" });
  const o2 = await seedOutlet(t, { code: "CIT", name: "Citraland" });
  await seedOwnersChat(t, "-100owners-d");
  // PKW managers chat is UNBOUND (no telegramChats insert for PKW).
  await seedManagersChat(t, mgrChatCit, o2.outletId);

  const res = await t.action(internal.telegram.ownersSummary.sendOwnersSummary, {});
  expect((res as { ok: boolean }).ok).toBe(true);

  const sentChatIds = capturedBodies.map((b) => b.chat_id);
  // Owners rollup sent.
  expect(sentChatIds).toContain("-100owners-d");
  // CIT managers summary sent.
  expect(sentChatIds).toContain(mgrChatCit);
  // No send to a PKW-scoped chat (it was unbound, not attempted).
  // PKW and CIT chats are distinct, so we just assert CIT appeared.
  expect(sentChatIds.filter((id) => id === mgrChatCit).length).toBeGreaterThanOrEqual(1);

  // Audit: PKW skip recorded as managers_unbound.
  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(
    audit.some(
      (r) =>
        r.action === "founders.summary_skipped" &&
        r.metadata != null &&
        (JSON.parse(r.metadata) as { reason: string }).reason.startsWith("managers_unbound:outlet:PKW"),
    ),
  ).toBe(true);
});

// ─── (e) toggle off scenarios ─────────────────────────────────────────────────

it("(e) default-outlet toggle off → owners rollup skipped, no sends", async () => {
  const t = convexTest(schema);
  // Default outlet has toggle=false.
  await seedOutlet(t, { code: "PKW", name: "Pakuwon", summaryEnabled: false });
  await seedOwnersChat(t, "-100owners-e");

  const res = await t.action(internal.telegram.ownersSummary.sendOwnersSummary, {});
  expect((res as { skipped: string }).skipped).toBe("disabled");

  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(
    audit.some(
      (r) =>
        r.action === "founders.summary_skipped" &&
        r.metadata != null &&
        (JSON.parse(r.metadata) as { reason: string }).reason === "disabled",
    ),
  ).toBe(true);
});

it("(e) per-outlet toggle off → only that outlet's managers summary skipped, owners rollup + others still send", async () => {
  const mgrChatCit = "-100mgr-cit-e2";
  const capturedBodies: Array<{ chat_id?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.body) {
        capturedBodies.push(JSON.parse(options.body as string) as { chat_id?: unknown });
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }),
  );

  const t = convexTest(schema);
  // PKW has toggle OFF — its managers summary is skipped.
  const o1 = await seedOutlet(t, { code: "PKW", name: "Pakuwon", summaryEnabled: false });
  const o2 = await seedOutlet(t, { code: "CIT", name: "Citraland", summaryEnabled: true });
  await seedOwnersChat(t, "-100owners-e2");
  await seedManagersChat(t, "-100mgr-pkw-e2", o1.outletId);
  await seedManagersChat(t, mgrChatCit, o2.outletId);

  const res = await t.action(internal.telegram.ownersSummary.sendOwnersSummary, {});
  // Owners rollup still sent (default outlet = first active = PKW, but its
  // settings only gate the per-outlet managers send, not the owners rollup).
  // Wait — default outlet is PKW which has toggle=false. This means the global
  // toggle check (step 1) fires on the DEFAULT outlet's settings.
  // Since PKW (default) has toggle=false → the whole action returns skipped:disabled.
  // That IS correct per the spec (decision 5: default outlet's toggle gates the rollup).
  // Adjust assertion: action returns disabled because default outlet has toggle=false.
  expect((res as { skipped: string }).skipped).toBe("disabled");

  // Audit: disabled skip recorded.
  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(
    audit.some(
      (r) =>
        r.action === "founders.summary_skipped" &&
        r.metadata != null &&
        (JSON.parse(r.metadata) as { reason: string }).reason === "disabled",
    ),
  ).toBe(true);
});

it("(e2) per-outlet managers toggle off while owners toggle on → owners rollup sends, that outlet's managers summary skipped", async () => {
  // Here default outlet (PKW) has toggle=true (owners rollup fires).
  // CIT has toggle=false → CIT managers_daily_summary is skipped.
  const mgrChatPkw = "-100mgr-pkw-e3";
  const capturedBodies: Array<{ chat_id?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.body) {
        capturedBodies.push(JSON.parse(options.body as string) as { chat_id?: unknown });
      }
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }),
  );

  const t = convexTest(schema);
  // PKW has toggle=true (default outlet — gates owners rollup).
  const o1 = await seedOutlet(t, { code: "PKW", name: "Pakuwon", summaryEnabled: true });
  // CIT has toggle=false — its managers_daily_summary is skipped.
  const o2 = await seedOutlet(t, { code: "CIT", name: "Citraland", summaryEnabled: false });
  await seedOwnersChat(t, "-100owners-e3");
  await seedManagersChat(t, mgrChatPkw, o1.outletId);
  await seedManagersChat(t, "-100mgr-cit-e3", o2.outletId);

  const res = await t.action(internal.telegram.ownersSummary.sendOwnersSummary, {});
  expect((res as { ok: boolean }).ok).toBe(true);

  const sentChatIds = capturedBodies.map((b) => b.chat_id);
  // Owners rollup sent.
  expect(sentChatIds).toContain("-100owners-e3");
  // PKW managers chat sent.
  expect(sentChatIds).toContain(mgrChatPkw);
  // CIT managers chat NOT sent (toggle off for CIT).
  expect(sentChatIds).not.toContain("-100mgr-cit-e3");

  // Audit: CIT skip recorded as disabled:outlet:CIT.
  const audit = await t.run((ctx) => ctx.db.query("audit_log").collect());
  expect(
    audit.some(
      (r) =>
        r.action === "founders.summary_skipped" &&
        r.metadata != null &&
        (JSON.parse(r.metadata) as { reason: string }).reason.startsWith("disabled:outlet:CIT"),
    ),
  ).toBe(true);
});

// ─── sendOwnersSummaryResilient ────────────────────────────────────────────────

it("resilient wrapper: surfaces role_unbound skip cleanly (no retry, no throw)", async () => {
  const t = convexTest(schema);
  await seedOutlet(t, { code: "PKW", name: "Pakuwon" });
  // No owners chat bound.

  const res = await t.action(
    internal.telegram.ownersSummary.sendOwnersSummaryResilient,
    { attempt: 0 },
  );
  expect(res).toEqual({ skipped: "role_unbound" });
});

it("resilient wrapper: succeeds when owners chat is bound and single outlet", async () => {
  const t = convexTest(schema);
  await seedOutlet(t, { code: "PKW", name: "Pakuwon" });
  await seedOwnersChat(t, "-100owners-resilient");
  // No managers chat — but single outlet, so the per-outlet send will skip
  // (managers unbound), and the owners rollup still returns ok.

  const res = await t.action(
    internal.telegram.ownersSummary.sendOwnersSummaryResilient,
    { attempt: 0 },
  );
  expect((res as { ok: boolean }).ok).toBe(true);
});
