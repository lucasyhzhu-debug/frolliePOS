// convex/telegram/__tests__/resolveOutletChat.test.ts
//
// TDD: resolveOutletChatId helper — fence validation
// Covers: single-outlet bare-row fallback fires; two-outlet must throw.
// Uses convex-test + the thin internalAction wrapper so we can exercise the
// helper end-to-end without constructing an ActionCtx manually.

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";

test("single-outlet fallback: resolves bare managers row when exactly one outlet active", async () => {
  const t = convexTest(schema);
  const outletId = await t.run(async (ctx) => {
    const a = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW",
      name: "Frollie — Pakuwon",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    });
    // Bare managers row — no outlet_id (transitional window)
    await ctx.db.insert("telegramChats", {
      chatId: "-100BARE",
      chatType: "supergroup",
      title: "Mgr",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    return a;
  });

  const result = await t.action(
    internal.telegram.resolveOutletChat._resolveOutletChatId_test_internal,
    { role: "managers", outletId },
  );
  expect(result).toBe("-100BARE");
});

test("two-outlet fence: throws when two active outlets and no concrete outlet row", async () => {
  const t = convexTest(schema);
  const outletId = await t.run(async (ctx) => {
    const a = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW",
      name: "x",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    });
    await ctx.db.insert("outlets", { is_open: false,
      code: "BLK",
      name: "y",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    });
    // Bare managers row — no outlet_id
    await ctx.db.insert("telegramChats", {
      chatId: "-100BARE",
      chatType: "supergroup",
      title: "Mgr",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    return a;
  });

  await expect(
    t.action(
      internal.telegram.resolveOutletChat._resolveOutletChatId_test_internal,
      { role: "managers", outletId },
    ),
  ).rejects.toThrow(/No Telegram chat assigned to role 'managers'/);
});

test("concrete outlet row: resolves directly without touching fallback", async () => {
  const t = convexTest(schema);
  const outletId = await t.run(async (ctx) => {
    const a = await ctx.db.insert("outlets", { is_open: false,
      code: "PKW",
      name: "x",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    });
    await ctx.db.insert("outlets", { is_open: false,
      code: "BLK",
      name: "y",
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    });
    // Concrete per-outlet row
    await ctx.db.insert("telegramChats", {
      chatId: "-100CONCRETE",
      chatType: "supergroup",
      title: "Mgr PKW",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
      outlet_id: a,
    });
    return a;
  });

  const result = await t.action(
    internal.telegram.resolveOutletChat._resolveOutletChatId_test_internal,
    { role: "managers", outletId },
  );
  expect(result).toBe("-100CONCRETE");
});
