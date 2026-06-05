import { convexTest } from "convex-test";
import { describe, it, expect, vi, beforeEach } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { buildActivatePosCommand } from "../activatePos";
import { buildCommandMatcher } from "../commands";
import { buildRegistryCommands } from "../registryCommands";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("POS_BASE_URL", "https://pos.example.com");
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, result: { message_id: 7 } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

async function seedManagersChat(t: ReturnType<typeof convexTest>, chatId: string) {
  await t.run((ctx) =>
    ctx.db.insert("telegramChats", {
      chatId,
      chatType: "supergroup",
      title: "Frollie · Managers",
      role: "managers",
      registeredAt: Date.now(),
      lastSeenAt: Date.now(),
    }),
  );
}

describe("handleActivatePos", () => {
  it("issues a code and sends the reply when the command comes from the managers chat", async () => {
    const t = convexTest(schema);
    await seedManagersChat(t, "-100managers");

    await t.action(internal.telegram.activatePos.handleActivatePos, {
      chatId: "-100managers",
      chatTitle: "Frollie · Managers",
      fromId: 4242,
    });

    const rows = await t.run((ctx) => ctx.db.query("pending_device_setups").collect());
    expect(rows.length).toBe(1);
    expect(rows[0].issued_via).toBe("telegram");
    const code = rows[0].setup_code;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.chat_id).toBe("-100managers");
    expect(body.text).toContain(code);
    expect(body.text).toContain("https://pos.example.com/activate");
  });

  it("does nothing when the command comes from a non-managers chat", async () => {
    const t = convexTest(schema);
    await seedManagersChat(t, "-100managers");

    await t.action(internal.telegram.activatePos.handleActivatePos, {
      chatId: "-100intruder",
      chatTitle: "Some Other Group",
      fromId: 1,
    });

    const rows = await t.run((ctx) => ctx.db.query("pending_device_setups").collect());
    expect(rows.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when no chat is bound to the managers role", async () => {
    const t = convexTest(schema);
    await t.action(internal.telegram.activatePos.handleActivatePos, {
      chatId: "-100whoever",
      chatTitle: "Whoever",
      fromId: 1,
    });
    const rows = await t.run((ctx) => ctx.db.query("pending_device_setups").collect());
    expect(rows.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("buildActivatePosCommand", () => {
  it("registers a single 'activatepos' command that schedules the action", async () => {
    const scheduled: Array<unknown> = [];
    const fakeScheduler = {
      runAfter: vi.fn(async (_delay: number, _ref: unknown, args: unknown) => {
        scheduled.push(args);
      }),
    } as any;
    const cmds = buildActivatePosCommand(fakeScheduler);
    expect(cmds.map((c) => c.name)).toEqual(["activatepos"]);
    await cmds[0].dispatch({
      chatId: "-100managers",
      chatType: "supergroup",
      title: "Frollie · Managers",
      fromId: 4242,
      text: "/activatepos",
    });
    expect(fakeScheduler.runAfter).toHaveBeenCalledTimes(1);
    expect(scheduled[0]).toEqual({
      chatId: "-100managers",
      chatTitle: "Frollie · Managers",
      fromId: 4242,
    });
  });
});

describe("webhook registry includes /activatepos", () => {
  it("matches /activatepos and /activatepos@Bot, rejects trailing args", () => {
    const fakeScheduler = { runAfter: vi.fn() } as any;
    const registrations = [
      ...buildRegistryCommands(fakeScheduler),
      ...buildActivatePosCommand(fakeScheduler),
    ];
    const matcher = buildCommandMatcher(registrations);
    expect(matcher("/activatepos")?.command.name).toBe("activatepos");
    expect(matcher("/activatepos@FrolliePOS_Bot")?.command.name).toBe("activatepos");
    expect(matcher("/activatepos 123")).toBeNull();
  });
});
