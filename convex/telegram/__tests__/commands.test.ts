import { describe, it, expect, vi } from "vitest";
import { buildCommandMatcher, type CommandRegistration } from "../commands";

function reg(name: string): CommandRegistration {
  return { name, dispatch: vi.fn().mockResolvedValue(undefined) };
}

describe("buildCommandMatcher", () => {
  it("returns null match for an empty registry", async () => {
    const matcher = buildCommandMatcher([]);
    const result = matcher("/anything");
    expect(result).toBeNull();
  });

  it("matches /name and /name@BotUsername exactly", async () => {
    const ping = reg("ping");
    const matcher = buildCommandMatcher([ping]);
    expect(matcher("/ping")?.command.name).toBe("ping");
    expect(matcher("/ping@MyBot")?.command.name).toBe("ping");
    expect(matcher("/ping@_under_score_bot")?.command.name).toBe("ping");
  });

  it("does NOT match commands with trailing args (strict mode)", () => {
    const ping = reg("ping");
    const matcher = buildCommandMatcher([ping]);
    expect(matcher("/ping now")).toBeNull();
    expect(matcher("ping")).toBeNull();
    expect(matcher("/ping@MyBot extra")).toBeNull();
  });

  it("dispatches in registration order — first match wins", () => {
    const a = reg("a");
    const b = reg("a"); // same name (would be a bug, but tests precedence)
    const matcher = buildCommandMatcher([a, b]);
    const m = matcher("/a");
    expect(m?.command).toBe(a);
    expect(m?.command).not.toBe(b);
  });

  it("matching is case-sensitive — /PING does NOT match the 'ping' registration", () => {
    // Documents the intentional Telegram-convention behavior. The in-app
    // command list always sends lowercase, so case-sensitivity keeps the
    // matcher predictable. Manual typing of /PING returns null — callers
    // can lowercase `text` upstream if they want lenient matching.
    const ping = reg("ping");
    const matcher = buildCommandMatcher([ping]);
    expect(matcher("/ping")?.command.name).toBe("ping");
    expect(matcher("/PING")).toBeNull();
    expect(matcher("/Ping")).toBeNull();
  });

  // v2.0 owner-auth (C1): the `/start <token>` deep-link binding needs a command
  // that head-matches with a trailing token. `acceptsArgs: true` opts a single
  // command into head-only matching; strict commands are unchanged.
  it("acceptsArgs command matches with a trailing token; strict commands still don't", () => {
    const start: CommandRegistration = {
      name: "start",
      acceptsArgs: true,
      dispatch: vi.fn().mockResolvedValue(undefined),
    };
    const ping = reg("ping");
    const matcher = buildCommandMatcher([start, ping]);
    expect(matcher("/start")?.command.name).toBe("start");
    expect(matcher("/start abc123")?.command.name).toBe("start");
    expect(matcher("/start@FrolliePOS_Bot abc123")?.command.name).toBe("start");
    expect(matcher("/ping now")).toBeNull(); // strict unchanged
  });

  it("acceptsArgs still rejects a different command name with the same prefix", () => {
    // `/started` must NOT match a `start` acceptsArgs registration — the head
    // boundary is the command name followed by EOL, @bot, or whitespace.
    const start: CommandRegistration = {
      name: "start",
      acceptsArgs: true,
      dispatch: vi.fn().mockResolvedValue(undefined),
    };
    const matcher = buildCommandMatcher([start]);
    expect(matcher("/started")).toBeNull();
    expect(matcher("/startx token")).toBeNull();
  });
});
