// convex/migrations/__tests__/telegramOutlet.test.ts
// TDD tests for Task 12: bindTelegramChatsToDefaultOutlet

import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedPkwOutlet(ctx: any) {
  return ctx.db.insert("outlets", {
    code: "PKW", name: "Frollie — Pakuwon", timezone: "Asia/Jakarta",
    active: true, created_at: Date.now(), created_by: null,
  });
}

async function seedChat(
  ctx: any,
  overrides: { chatId: string; role?: string; outlet_id?: any; archivedAt?: number },
) {
  return ctx.db.insert("telegramChats", {
    chatId: overrides.chatId, chatType: "group",
    title: "Test Chat " + overrides.chatId,
    role: overrides.role, outlet_id: overrides.outlet_id,
    registeredAt: Date.now(), lastSeenAt: Date.now(),
    archivedAt: overrides.archivedAt,
  });
}
describe("bindTelegramChatsToDefaultOutlet no PKW outlet", () => {
  it("throws DEFAULT_OUTLET_MISSING when no PKW outlet exists", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(internal.migrations.internal.bindTelegramChatsToDefaultOutlet, {}),
    ).rejects.toThrow("DEFAULT_OUTLET_MISSING");
  });
});

describe("bindTelegramChatsToDefaultOutlet managers + inventory binding", () => {
  it("stamps outlet_id on managers and inventory chats", async () => {
    const t = convexTest(schema);
    let outletId: string; let managersId: string; let inventoryId: string;
    await t.run(async (ctx) => {
      outletId = (await seedPkwOutlet(ctx)) as unknown as string;
      managersId = (await seedChat(ctx, { chatId: "chat-mgr-001", role: "managers" })) as unknown as string;
      inventoryId = (await seedChat(ctx, { chatId: "chat-inv-001", role: "inventory" })) as unknown as string;
    });
    await t.mutation(internal.migrations.internal.bindTelegramChatsToDefaultOutlet, {});
    await t.run(async (ctx) => {
      const mgr = await ctx.db.get(managersId as any);
      expect((mgr as any).outlet_id).toBe(outletId);
      const inv = await ctx.db.get(inventoryId as any);
      expect((inv as any).outlet_id).toBe(outletId);
    });
  });
});

describe("bindTelegramChatsToDefaultOutlet founders rebind", () => {
  it("rebinds founders role to owners and keeps outlet_id absent", async () => {
    const t = convexTest(schema);
    let foundersId: string;
    await t.run(async (ctx) => {
      await seedPkwOutlet(ctx);
      foundersId = (await seedChat(ctx, { chatId: "chat-founders-001", role: "founders" })) as unknown as string;
    });
    await t.mutation(internal.migrations.internal.bindTelegramChatsToDefaultOutlet, {});
    await t.run(async (ctx) => {
      const chat = await ctx.db.get(foundersId as any);
      expect((chat as any).role).toBe("owners");
      expect((chat as any).outlet_id).toBeUndefined();
    });
  });
});
describe("bindTelegramChatsToDefaultOutlet ops untouched", () => {
  it("leaves ops chat unchanged (no outlet_id, role stays ops)", async () => {
    const t = convexTest(schema);
    let opsId: string;
    await t.run(async (ctx) => {
      await seedPkwOutlet(ctx);
      opsId = (await seedChat(ctx, { chatId: "chat-ops-001", role: "ops" })) as unknown as string;
    });
    await t.mutation(internal.migrations.internal.bindTelegramChatsToDefaultOutlet, {});
    await t.run(async (ctx) => {
      const chat = await ctx.db.get(opsId as any);
      expect((chat as any).role).toBe("ops");
      expect((chat as any).outlet_id).toBeUndefined();
    });
  });
});

describe("bindTelegramChatsToDefaultOutlet idempotency", () => {
  it("re-running after managers already bound does not duplicate patches", async () => {
    const t = convexTest(schema);
    let outletId: string; let managersId: string; let foundersId: string;
    await t.run(async (ctx) => {
      outletId = (await seedPkwOutlet(ctx)) as unknown as string;
      managersId = (await seedChat(ctx, { chatId: "chat-mgr-002", role: "managers" })) as unknown as string;
      foundersId = (await seedChat(ctx, { chatId: "chat-founders-002", role: "founders" })) as unknown as string;
    });
    await t.mutation(internal.migrations.internal.bindTelegramChatsToDefaultOutlet, {});
    await t.mutation(internal.migrations.internal.bindTelegramChatsToDefaultOutlet, {});
    await t.run(async (ctx) => {
      const mgr = await ctx.db.get(managersId as any);
      expect((mgr as any).outlet_id).toBe(outletId);
      const founders = await ctx.db.get(foundersId as any);
      expect((founders as any).role).toBe("owners");
      expect((founders as any).outlet_id).toBeUndefined();
    });
  });

  it("archived chats are skipped even if role matches", async () => {
    const t = convexTest(schema);
    let archivedId: string;
    await t.run(async (ctx) => {
      await seedPkwOutlet(ctx);
      archivedId = (await seedChat(ctx, { chatId: "chat-arch-001", role: "managers", archivedAt: Date.now() })) as unknown as string;
    });
    await t.mutation(internal.migrations.internal.bindTelegramChatsToDefaultOutlet, {});
    await t.run(async (ctx) => {
      const chat = await ctx.db.get(archivedId as any);
      expect((chat as any).outlet_id).toBeUndefined();
    });
  });
});
describe("bindTelegramChatsToDefaultOutlet audit trail", () => {
  it("writes a telegram.chat_outlet_bound audit row for each patched chat", async () => {
    const t = convexTest(schema);
    let outletId: string;
    await t.run(async (ctx) => {
      outletId = (await seedPkwOutlet(ctx)) as unknown as string;
      await seedChat(ctx, { chatId: "chat-mgr-audit", role: "managers" });
      await seedChat(ctx, { chatId: "chat-inv-audit", role: "inventory" });
      await seedChat(ctx, { chatId: "chat-founders-audit", role: "founders" });
      await seedChat(ctx, { chatId: "chat-ops-audit", role: "ops" });
    });
    await t.mutation(internal.migrations.internal.bindTelegramChatsToDefaultOutlet, {});
    await t.run(async (ctx) => {
      const auditRows = await ctx.db
        .query("audit_log")
        .filter((q) => q.eq(q.field("action"), "telegram.chat_outlet_bound"))
        .collect();
      expect(auditRows).toHaveLength(3);
      const entityIds = auditRows.map((r) => r.entity_id);
      expect(entityIds).toContain("chat-mgr-audit");
      expect(entityIds).toContain("chat-inv-audit");
      expect(entityIds).toContain("chat-founders-audit");
      expect(entityIds).not.toContain("chat-ops-audit");
      for (const row of auditRows) {
        expect(row.actor_id).toBe("system");
        expect(row.source).toBe("system");
        expect(row.entity_type).toBe("telegramChats");
        expect(row.metadata).toBeDefined();
        const meta = JSON.parse(row.metadata as string);
        if (row.entity_id === "chat-founders-audit") {
          expect(meta.role).toBe("owners");
          expect(meta.rebound_from).toBe("founders");
        } else {
          expect(["managers", "inventory"]).toContain(meta.role);
          expect(meta.outlet_id).toBe(outletId);
        }
      }
    });
  });
});
