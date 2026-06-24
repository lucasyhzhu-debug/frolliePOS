import { describe, it, expect, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../../schema";
import { api, internal } from "../../../_generated/api";
import { parseCommand } from "../internal";
import type { Id } from "../../../_generated/dataModel";

// ─── seedOutlet helper ────────────────────────────────────────────────────────

async function seedOutlet(
  t: ReturnType<typeof convexTest>,
  code: string = "PKW",
): Promise<Id<"outlets">> {
  return t.run(async (ctx) =>
    ctx.db.insert("outlets", {
      code,
      name: `Outlet ${code}`,
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    } as any),
  );
}

// ─── PART A: parseCommand (pure) ─────────────────────────────────────────────
//
// parseCommand only knows the two registry built-ins (/register, /start). It
// accepts an optional @BotName suffix and surrounding whitespace, and rejects
// trailing args (typo protection). Feature commands like /pack are matched
// elsewhere (commands.ts), so parseCommand returns null for them.

describe("parseCommand", () => {
  it("/register → 'register'", () => {
    expect(parseCommand("/register")).toBe("register");
  });

  it("/start → 'start'", () => {
    expect(parseCommand("/start")).toBe("start");
  });

  it("/register@SomeBot → 'register'", () => {
    expect(parseCommand("/register@SomeBot")).toBe("register");
  });

  it("surrounding whitespace still matches", () => {
    expect(parseCommand("  /register  ")).toBe("register");
    expect(parseCommand("\t/start\n")).toBe("start");
  });

  it("/pack → null (not a registry built-in)", () => {
    expect(parseCommand("/pack")).toBeNull();
  });

  it("/register with trailing args → null", () => {
    expect(parseCommand("/register now")).toBeNull();
  });

  it("plain text 'hello' → null", () => {
    expect(parseCommand("hello")).toBeNull();
  });

  it("/registerx (no boundary) → null", () => {
    expect(parseCommand("/registerx")).toBeNull();
  });
});

// ─── PART B: registry mechanics via convex-test ──────────────────────────────

const NOW = 1_700_000_000_000;

/** Seed an active telegramChats row directly, optionally with a role and outlet_id. */
async function seedRow(
  t: ReturnType<typeof convexTest>,
  opts: { chatId: string; role?: string; archivedAt?: number; title?: string; outletId?: Id<"outlets"> },
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("telegramChats", {
      chatId: opts.chatId,
      chatType: "supergroup" as const,
      title: opts.title ?? `Chat ${opts.chatId}`,
      role: opts.role,
      outlet_id: opts.outletId,
      registeredAt: NOW,
      lastSeenAt: NOW,
      archivedAt: opts.archivedAt,
    });
  });
}

/** Seed a staff + active session pair. role defaults to "manager". */
async function seedSession(
  t: ReturnType<typeof convexTest>,
  opts: {
    name?: string;
    code?: string;
    role?: "staff" | "manager";
    deviceId?: string;
  } = {},
): Promise<{ staffId: Id<"staff">; sessionId: Id<"staff_sessions"> }> {
  // v2.0 Task 12 (ENFORCE): staff_sessions.outlet_id is required.
  const outletId = await t.run(async (ctx) =>
    ctx.db.insert("outlets", {
      code: "PKW", name: "x", timezone: "Asia/Jakarta",
      active: true, created_at: Date.now(), created_by: null,
    } as any),
  );
  return await t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: opts.name ?? "Mgr",
      code: opts.code ?? "S-0001",
      role: opts.role ?? "manager",
      active: true,
      pin_hash: "x",
      created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId,
      device_id: opts.deviceId ?? "dev-test",
      started_at: Date.now(),
      ended_at: null,
      end_reason: null,
      outlet_id: outletId,
    } as any);
    return { staffId, sessionId };
  });
}

describe("getChatIdByRole lookup chain", () => {
  it("returns active chat (archivedAt === undefined), skips archived — prod gotcha regression", async () => {
    // Regression for the Convex optional-field filter gotcha: .eq("archivedAt", undefined)
    // can pass in convex-test but diverge in prod. The safe pattern is broader index +
    // JS post-filter on r.archivedAt === undefined. This test seeds both archived and
    // active rows for the same role to assert only the active one is returned.
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("telegramChats", {
        chatId: "-1000",
        chatType: "supergroup" as const,
        title: "Old Managers",
        role: "managers",
        registeredAt: Date.now() - 10 * 86_400_000,
        lastSeenAt: Date.now() - 10 * 86_400_000,
        archivedAt: Date.now() - 5 * 86_400_000,
      });
      await ctx.db.insert("telegramChats", {
        chatId: "-2000",
        chatType: "supergroup" as const,
        title: "Current Managers",
        role: "managers",
        registeredAt: Date.now(),
        lastSeenAt: Date.now(),
      });
    });
    const chatId = await t.query(
      internal.telegram.chatRegistry.internal.getChatIdByRole,
      { role: "managers" },
    );
    expect(chatId).toBe("-2000");
  });

  it("returns chatId of an active row matching the role", async () => {
    const t = convexTest(schema);
    await seedRow(t, { chatId: "-100111", role: "managers" });
    const chatId = await t.query(
      internal.telegram.chatRegistry.internal.getChatIdByRole,
      { role: "managers" },
    );
    expect(chatId).toBe("-100111");
  });

  it("throws when no row and no env fallback", async () => {
    const t = convexTest(schema);
    await expect(
      t.query(internal.telegram.chatRegistry.internal.getChatIdByRole, {
        role: "managers",
      }),
    ).rejects.toThrow(/No Telegram chat assigned to role 'managers'/);
  });

  it("falls back to TELEGRAM_CHAT_ID when env role matches and no row exists", async () => {
    vi.stubEnv("TELEGRAM_FALLBACK_ROLE", "managers");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-100999");
    try {
      const t = convexTest(schema);
      const chatId = await t.query(
        internal.telegram.chatRegistry.internal.getChatIdByRole,
        { role: "managers" },
      );
      expect(chatId).toBe("-100999");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("prefers an active table row over the env fallback (JS post-filter skips archived)", async () => {
    vi.stubEnv("TELEGRAM_FALLBACK_ROLE", "managers");
    vi.stubEnv("TELEGRAM_CHAT_ID", "-100999");
    try {
      const t = convexTest(schema);
      await seedRow(t, { chatId: "-100111", role: "managers" });
      const chatId = await t.query(
        internal.telegram.chatRegistry.internal.getChatIdByRole,
        { role: "managers" },
      );
      expect(chatId).toBe("-100111");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("role uniqueness / slot freeing", () => {
  it("getChatIdByRole resolves to the active holder; archiving frees the slot", async () => {
    const t = convexTest(schema);
    await seedRow(t, { chatId: "-100AAA", role: "managers" });
    await seedRow(t, { chatId: "-100BBB" }); // dormant, no role

    expect(
      await t.query(internal.telegram.chatRegistry.internal.getChatIdByRole, {
        role: "managers",
      }),
    ).toBe("-100AAA");

    await t.mutation(internal.telegram.chatRegistry.internal.archiveChat, {
      chatId: "-100AAA",
    });
    await expect(
      t.query(internal.telegram.chatRegistry.internal.getChatIdByRole, { role: "managers" }),
    ).rejects.toThrow(/No Telegram chat assigned to role 'managers'/);
  });
});

describe("archiveChat", () => {
  it("sets archivedAt, clears role, and frees the role slot", async () => {
    const t = convexTest(schema);
    await seedRow(t, { chatId: "-100ARC", role: "managers" });

    await t.mutation(internal.telegram.chatRegistry.internal.archiveChat, {
      chatId: "-100ARC",
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("telegramChats")
        .withIndex("by_chatId", (q) => q.eq("chatId", "-100ARC"))
        .unique(),
    );
    expect(row?.archivedAt).toEqual(expect.any(Number));
    expect(row?.role).toBeUndefined();

    await expect(
      t.query(internal.telegram.chatRegistry.internal.getChatIdByRole, {
        role: "managers",
      }),
    ).rejects.toThrow();
  });
});

describe("restoreChat", () => {
  it("clears archivedAt", async () => {
    const t = convexTest(schema);
    await seedRow(t, { chatId: "-100RES", archivedAt: NOW });

    await t.mutation(internal.telegram.chatRegistry.internal.restoreChat, {
      chatId: "-100RES",
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("telegramChats")
        .withIndex("by_chatId", (q) => q.eq("chatId", "-100RES"))
        .unique(),
    );
    expect(row?.archivedAt).toBeUndefined();
  });
});

describe("touchChatLastSeen", () => {
  it("is a no-op on an unknown chatId (no insert)", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.telegram.chatRegistry.internal.touchChatLastSeen, {
      chatId: "-100UNKNOWN",
    });
    const all = await t.run(async (ctx) =>
      ctx.db.query("telegramChats").collect(),
    );
    expect(all).toHaveLength(0);
  });

  it("updates lastSeenAt on an existing active row", async () => {
    const t = convexTest(schema);
    const id = await seedRow(t, { chatId: "-100TOUCH" });

    await t.mutation(internal.telegram.chatRegistry.internal.touchChatLastSeen, {
      chatId: "-100TOUCH",
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.lastSeenAt).toBeGreaterThan(NOW);
  });

  it("is a no-op on an archived row", async () => {
    const t = convexTest(schema);
    const id = await seedRow(t, { chatId: "-100ARCH", archivedAt: NOW });

    await t.mutation(internal.telegram.chatRegistry.internal.touchChatLastSeen, {
      chatId: "-100ARCH",
    });

    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.lastSeenAt).toBe(NOW); // unchanged
  });
});

describe("upsertChatRow three states", () => {
  const args = {
    chatType: "supergroup" as const,
    title: "Upsert Group",
    registeredBy: 7,
  };

  it("none → inserted", async () => {
    const t = convexTest(schema);
    const res = await t.mutation(
      internal.telegram.chatRegistry.internal.upsertChatRow,
      { chatId: "-100UP1", ...args },
    );
    expect(res).toEqual({ status: "inserted" });
  });

  it("existing-no-role → dormant", async () => {
    const t = convexTest(schema);
    await seedRow(t, { chatId: "-100UP2" }); // no role
    const res = await t.mutation(
      internal.telegram.chatRegistry.internal.upsertChatRow,
      { chatId: "-100UP2", ...args },
    );
    expect(res).toEqual({ status: "dormant" });
  });

  it("existing-with-role → live", async () => {
    const t = convexTest(schema);
    await seedRow(t, { chatId: "-100UP3", role: "managers" });
    const res = await t.mutation(
      internal.telegram.chatRegistry.internal.upsertChatRow,
      { chatId: "-100UP3", ...args },
    );
    expect(res).toEqual({ status: "live", role: "managers" });
  });
});

describe("seedFromEnvWrite allowlist guard", () => {
  it("throws 'Unknown telegram role' for an unknown role (not in KNOWN_TELEGRAM_ROLES)", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(internal.telegram.chatRegistry.internal.seedFromEnvWrite, {
        chatId: "-100SEED",
        chatType: "supergroup",
        title: "Seed Group",
        role: "anything",
      }),
    ).rejects.toThrow(/Unknown telegram role/);
  });
});

// ─── PART C: mgr* (manager-session gated) surface ────────────────────────────

describe("mgrAssignRole — manager-session gate + role uniqueness + idempotency", () => {
  it("assigns a role for a manager session (outlet-scoped role requires outletId)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    const outletId = await seedOutlet(t);
    await seedRow(t, { chatId: "-100MGR1" });

    await t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
      idempotencyKey: "mgr-assign-k1",
      sessionId,
      chatId: "-100MGR1",
      role: "managers",
      outletId,
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("telegramChats")
        .withIndex("by_chatId", (q) => q.eq("chatId", "-100MGR1"))
        .unique(),
    );
    expect(row?.role).toBe("managers");
    expect(row?.outlet_id).toBe(outletId);
  });

  it("staff session → MANAGER_ONLY", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t, { role: "staff" });
    const outletId = await seedOutlet(t, "BLK");
    await seedRow(t, { chatId: "-100MGR2" });

    await expect(
      t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
        idempotencyKey: "mgr-assign-k2",
        sessionId,
        chatId: "-100MGR2",
        role: "managers",
        outletId,
      }),
    ).rejects.toThrow(/MANAGER_ONLY/);
  });

  it("rejects an unknown role (not in KNOWN_TELEGRAM_ROLES)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    await seedRow(t, { chatId: "-100MGR3" });

    await expect(
      t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
        idempotencyKey: "mgr-assign-k3",
        sessionId,
        chatId: "-100MGR3",
        role: "definitely-not-a-real-role",
      }),
    ).rejects.toThrow(/Unknown telegram role/);
  });

  it("role uniqueness — same (role, outlet) pair cannot have two holders without forceReassign", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    const outletId = await seedOutlet(t);
    await seedRow(t, { chatId: "-100A", role: "managers", outletId });
    await seedRow(t, { chatId: "-100B" });

    await expect(
      t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
        idempotencyKey: "mgr-assign-uniq",
        sessionId,
        chatId: "-100B",
        role: "managers",
        outletId,
      }),
    ).rejects.toThrow(/already held by chat/);
  });

  it("same idempotencyKey is deduped — second call replays cached result, no double-write", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    const outletId = await seedOutlet(t);
    await seedRow(t, { chatId: "-100IDEM1" });
    await seedRow(t, { chatId: "-100IDEM2" });

    const KEY = "mgr-assign-dedup";

    // First call: assigns "managers" to -100IDEM1.
    await t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
      idempotencyKey: KEY,
      sessionId,
      chatId: "-100IDEM1",
      role: "managers",
      outletId,
    });

    // Second call WITH SAME KEY but DIFFERENT chatId. If withIdempotency works,
    // the handler is skipped entirely and -100IDEM2 stays dormant.
    await t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
      idempotencyKey: KEY,
      sessionId,
      chatId: "-100IDEM2",
      role: "managers",
      outletId,
    });

    const a = await t.run((ctx) =>
      ctx.db
        .query("telegramChats")
        .withIndex("by_chatId", (q) => q.eq("chatId", "-100IDEM1"))
        .unique(),
    );
    const b = await t.run((ctx) =>
      ctx.db
        .query("telegramChats")
        .withIndex("by_chatId", (q) => q.eq("chatId", "-100IDEM2"))
        .unique(),
    );
    expect(a?.role).toBe("managers");
    expect(b?.role).toBeUndefined(); // second call deduped — never ran
  });

  // ─── Task 9: 5 new TDD scenarios ───────────────────────────────────────────

  it("Task9-1: outlet-scoped role (managers) without outletId → OUTLET_REQUIRED_FOR_ROLE", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    await seedRow(t, { chatId: "-100T9-1" });

    await expect(
      t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
        idempotencyKey: "mgr-t9-1",
        sessionId,
        chatId: "-100T9-1",
        role: "managers",
        // outletId intentionally absent
      }),
    ).rejects.toThrow(/OUTLET_REQUIRED_FOR_ROLE/);
  });

  it("Task9-2: business role (owners) with outletId → OUTLET_NOT_ALLOWED_FOR_ROLE", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    const outletId = await seedOutlet(t);
    await seedRow(t, { chatId: "-100T9-2" });

    await expect(
      t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
        idempotencyKey: "mgr-t9-2",
        sessionId,
        chatId: "-100T9-2",
        role: "owners",
        outletId,
      }),
    ).rejects.toThrow(/OUTLET_NOT_ALLOWED_FOR_ROLE/);
  });

  it("Task9-3: two manager chats can bind the SAME role to DIFFERENT outlets (no collision)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    const outletA = await seedOutlet(t, "PKW");
    const outletB = await seedOutlet(t, "BLK");
    await seedRow(t, { chatId: "-100T9-3A", role: "managers", outletId: outletA });
    await seedRow(t, { chatId: "-100T9-3B" });

    // This must NOT throw — different outlets means no uniqueness collision.
    await t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
      idempotencyKey: "mgr-t9-3",
      sessionId,
      chatId: "-100T9-3B",
      role: "managers",
      outletId: outletB,
    });

    const rowB = await t.run((ctx) =>
      ctx.db
        .query("telegramChats")
        .withIndex("by_chatId", (q) => q.eq("chatId", "-100T9-3B"))
        .unique(),
    );
    expect(rowB?.role).toBe("managers");
    expect(rowB?.outlet_id).toBe(outletB);
  });

  it("Task9-4: same (managers, outletX) twice without forceReassign → 'already held' for that pair", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    const outletId = await seedOutlet(t);
    await seedRow(t, { chatId: "-100T9-4A", role: "managers", outletId });
    await seedRow(t, { chatId: "-100T9-4B" });

    await expect(
      t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
        idempotencyKey: "mgr-t9-4",
        sessionId,
        chatId: "-100T9-4B",
        role: "managers",
        outletId,
      }),
    ).rejects.toThrow(/already held by chat/);
  });

  it("Task9-5: role: null clears both role and outlet_id on the row", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    const outletId = await seedOutlet(t);
    await seedRow(t, { chatId: "-100T9-5", role: "managers", outletId });

    await t.mutation(api.telegram.chatRegistry.public.mgrAssignRole, {
      idempotencyKey: "mgr-t9-5",
      sessionId,
      chatId: "-100T9-5",
      role: null,
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("telegramChats")
        .withIndex("by_chatId", (q) => q.eq("chatId", "-100T9-5"))
        .unique(),
    );
    expect(row?.role).toBeUndefined();
    expect(row?.outlet_id).toBeUndefined();
  });
});

describe("mgrListChats — manager-session gate", () => {
  it("returns rows for a manager session", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    await seedRow(t, { chatId: "-100L1", role: "managers" });
    await seedRow(t, { chatId: "-100L2" });

    const rows = await t.query(api.telegram.chatRegistry.public.mgrListChats, {
      sessionId,
      includeArchived: false,
    });
    expect(rows.map((r) => r.chatId).sort()).toEqual(["-100L1", "-100L2"]);
  });

  it("staff session → MANAGER_ONLY", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t, { role: "staff" });
    await expect(
      t.query(api.telegram.chatRegistry.public.mgrListChats, {
        sessionId,
        includeArchived: false,
      }),
    ).rejects.toThrow(/MANAGER_ONLY/);
  });
});

describe("mgrArchiveChat — manager-session gate", () => {
  it("archives a chat for a manager session", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    await seedRow(t, { chatId: "-100ARCMGR", role: "managers" });

    await t.mutation(api.telegram.chatRegistry.public.mgrArchiveChat, {
      idempotencyKey: "mgr-arc-k1",
      sessionId,
      chatId: "-100ARCMGR",
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("telegramChats")
        .withIndex("by_chatId", (q) => q.eq("chatId", "-100ARCMGR"))
        .unique(),
    );
    expect(row?.archivedAt).toEqual(expect.any(Number));
    expect(row?.role).toBeUndefined();
  });

  it("staff session → MANAGER_ONLY", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t, { role: "staff" });
    await seedRow(t, { chatId: "-100ARCST" });
    await expect(
      t.mutation(api.telegram.chatRegistry.public.mgrArchiveChat, {
        idempotencyKey: "mgr-arc-k2",
        sessionId,
        chatId: "-100ARCST",
      }),
    ).rejects.toThrow(/MANAGER_ONLY/);
  });
});

describe("mgrRestoreChat — manager-session gate", () => {
  it("restores an archived chat for a manager session", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t);
    await seedRow(t, { chatId: "-100RSMGR", archivedAt: NOW });

    await t.mutation(api.telegram.chatRegistry.public.mgrRestoreChat, {
      idempotencyKey: "mgr-rs-k1",
      sessionId,
      chatId: "-100RSMGR",
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("telegramChats")
        .withIndex("by_chatId", (q) => q.eq("chatId", "-100RSMGR"))
        .unique(),
    );
    expect(row?.archivedAt).toBeUndefined();
  });

  it("staff session → MANAGER_ONLY", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t, { role: "staff" });
    await seedRow(t, { chatId: "-100RSST", archivedAt: NOW });
    await expect(
      t.mutation(api.telegram.chatRegistry.public.mgrRestoreChat, {
        idempotencyKey: "mgr-rs-k2",
        sessionId,
        chatId: "-100RSST",
      }),
    ).rejects.toThrow(/MANAGER_ONLY/);
  });
});

describe("mgrSendTest — action-safe manager-session gate", () => {
  it("staff session → MANAGER_ONLY (no Telegram call fires)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t, { role: "staff" });
    await seedRow(t, { chatId: "-100TEST" });

    // Track fetch calls to confirm the action throws BEFORE the Telegram call.
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    try {
      await expect(
        t.action(api.telegram.chatRegistry.public.mgrSendTest, {
          sessionId,
          chatId: "-100TEST",
        }),
      ).rejects.toThrow(/MANAGER_ONLY/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("manager session + missing chat → ConvexError 'No registered Telegram chat'", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedSession(t); // manager
    // No seedRow — chat doesn't exist.

    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    try {
      await expect(
        t.action(api.telegram.chatRegistry.public.mgrSendTest, {
          sessionId,
          chatId: "-100MISSING",
        }),
      ).rejects.toThrow(/No registered Telegram chat/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
