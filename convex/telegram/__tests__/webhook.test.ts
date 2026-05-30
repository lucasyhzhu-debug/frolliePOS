import { describe, it, expect, vi } from "vitest";
import { decideWebhookOutcome } from "../webhook";
import { buildCommandMatcher, type CommandRegistration } from "../commands";

function makeDispatchMock() {
  return vi.fn().mockResolvedValue(undefined);
}

function makeDeps(opts: {
  recordIfNewReturns?: boolean;
  dispatchMock?: ReturnType<typeof vi.fn>;
  commandName?: string;
}) {
  const dispatch = opts.dispatchMock ?? makeDispatchMock();
  const cmd: CommandRegistration = { name: opts.commandName ?? "example", dispatch };
  return {
    deps: {
      recordIfNew: vi.fn().mockResolvedValue(opts.recordIfNewReturns ?? true),
      match: buildCommandMatcher([cmd]),
    },
    dispatch,
  };
}

const SECRET = "expected-secret";

// v2: the webhook builds a MessageContext, so real envelopes always carry chat.id.
// This helper keeps every test message realistic (id + type + title).
function body(updateId: number, text?: string) {
  return {
    update_id: updateId,
    message: {
      ...(text !== undefined ? { text } : {}),
      chat: { id: -1001234567890, type: "supergroup", title: "Ops Group" },
      from: { id: 42 },
    },
  };
}

describe("decideWebhookOutcome", () => {
  // Tests 1-3: auth
  it("test 1: returns 401 when expectedSecret env is unset", async () => {
    const { deps } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: "any",
      expectedSecret: undefined,
      body: body(1, "/example"),
      deps,
    });
    expect(result.status).toBe(401);
  });

  it("test 2: returns 401 when providedSecret is null/missing", async () => {
    const { deps } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: null,
      expectedSecret: SECRET,
      body: body(1, "/example"),
      deps,
    });
    expect(result.status).toBe(401);
  });

  it("test 3: returns 401 when secrets do not match", async () => {
    const { deps } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: "wrong",
      expectedSecret: SECRET,
      body: body(1, "/example"),
      deps,
    });
    expect(result.status).toBe(401);
  });

  // Tests 4-5: command match
  it("test 4: matches /example and dispatches", async () => {
    const { deps, dispatch } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(1, "/example"),
      deps,
    });
    expect(result.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("test 5: matches /example@MyBot and dispatches", async () => {
    const { deps, dispatch } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(2, "/example@MyBot"),
      deps,
    });
    expect(result.status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  // Tests 6-7: non-command
  it("test 6: non-command text (hello) does NOT dispatch — 200 ok", async () => {
    const { deps, dispatch } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(3, "hello"),
      deps,
    });
    expect(result.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("test 7: missing message field — 200 ok, no dispatch", async () => {
    const { deps, dispatch } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: { update_id: 4 },
      deps,
    });
    expect(result.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Test 8: trailing args
  it("test 8: trailing args (/example now please) — no dispatch, recordIfNew NOT called", async () => {
    const { deps, dispatch } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(5, "/example now please"),
      deps,
    });
    expect(result.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
    expect(deps.recordIfNew).not.toHaveBeenCalled();
  });

  // Tests 9-10: idempotency
  it("test 9: recordIfNew returns false (duplicate) — no dispatch", async () => {
    const { deps, dispatch } = makeDeps({ recordIfNewReturns: false });
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(6, "/example"),
      deps,
    });
    expect(result.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
    expect(deps.recordIfNew).toHaveBeenCalledTimes(1);
  });

  it("test 10: recordIfNew commits BEFORE dispatch runs (ordering)", async () => {
    const callOrder: string[] = [];
    const recordIfNew = vi.fn().mockImplementation(async () => {
      callOrder.push("record");
      return true;
    });
    const dispatch = vi.fn().mockImplementation(async () => {
      callOrder.push("dispatch");
    });
    const cmd: CommandRegistration = { name: "example", dispatch };
    const deps = { recordIfNew, match: buildCommandMatcher([cmd]) };
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(7, "/example"),
      deps,
    });
    expect(result.status).toBe(200);
    expect(callOrder).toEqual(["record", "dispatch"]);
  });

  // Test 11: recordIfNew false with all-else-valid → still no dispatch
  it("test 11: recordIfNew false, command matched — still no dispatch", async () => {
    const { deps, dispatch } = makeDeps({ recordIfNewReturns: false });
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(8, "/example@MyBot"),
      deps,
    });
    expect(result.status).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
  });

  // Test 12: C3 — dispatch throws AFTER recordIfNew commits → still 200 + warn
  it("test 12 (C3 fix): dispatch throws AFTER recordIfNew commits — still returns 200, logs warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dispatch = vi.fn().mockRejectedValue(new Error("downstream blew up"));
    const cmd: CommandRegistration = { name: "example", dispatch };
    const deps = {
      recordIfNew: vi.fn().mockResolvedValue(true),
      match: buildCommandMatcher([cmd]),
    };
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(9, "/example"),
      deps,
    });
    expect(result.status).toBe(200);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // ── v2: MessageContext + onNonCommandMessage ────────────────────────────────

  it("test 13 (v2): dispatch receives the parsed MessageContext", async () => {
    const seen: unknown[] = [];
    const dispatch = vi.fn().mockImplementation(async (msg: unknown) => { seen.push(msg); });
    const cmd: CommandRegistration = { name: "example", dispatch };
    const deps = { recordIfNew: vi.fn().mockResolvedValue(true), match: buildCommandMatcher([cmd]) };
    await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(10, "/example"),
      deps,
    });
    expect(seen[0]).toMatchObject({
      chatId: "-1001234567890",
      chatType: "supergroup",
      title: "Ops Group",
      fromId: 42,
      text: "/example",
    });
  });

  it("test 14 (v2): non-command text calls onNonCommandMessage (best-effort touch)", async () => {
    const onNonCommandMessage = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(11, "good morning"),
      deps: { ...deps, onNonCommandMessage },
    });
    expect(result.status).toBe(200);
    expect(onNonCommandMessage).toHaveBeenCalledTimes(1);
    expect(onNonCommandMessage.mock.calls[0]![0]).toMatchObject({ chatId: "-1001234567890" });
  });

  it("test 15 (v2): unknown slash command does NOT touch (typo, not activity)", async () => {
    const onNonCommandMessage = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(12, "/unknown"),
      deps: { ...deps, onNonCommandMessage },
    });
    expect(result.status).toBe(200);
    expect(onNonCommandMessage).not.toHaveBeenCalled();
  });

  it("test 16 (v2): onNonCommandMessage that throws never breaks the 200 ACK", async () => {
    const onNonCommandMessage = vi.fn().mockRejectedValue(new Error("touch failed"));
    const { deps } = makeDeps({});
    const result = await decideWebhookOutcome({
      providedSecret: SECRET,
      expectedSecret: SECRET,
      body: body(13, "hello"),
      deps: { ...deps, onNonCommandMessage },
    });
    expect(result.status).toBe(200);
  });
});
