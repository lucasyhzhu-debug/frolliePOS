/**
 * Tests for /mgr/telegram-chats — manager-gated Telegram chat registry admin.
 *
 * Mock strategy (follows charge.test.tsx pattern):
 *   - useQuery: vi.fn() with mockImplementation that routes by call index.
 *     Reset with mockReset() before each render + re-set via mockImplementation.
 *   - useMutation: vi.fn() — returns a fresh wrapper per test.
 *   - useAction: vi.fn() — returns sendTest stub.
 *   - useSession: vi.fn() → mockSessionFn.
 *   - useNavigate: mocked via react-router.
 *
 * The component renders three useQuery calls per tree:
 *   Call 0 = settings (FoundersSummaryToggle)
 *   Call 1 = settings (TxnTickerToggle — same args shape, same stub)
 *   Call 2 = chats (MgrTelegramChatsInner)
 *
 * For useMutation, the call order per tree render (depth-first):
 *   Component order: FoundersSummaryToggle → TxnTickerToggle → MgrTelegramChatsInner → ChatCard*
 *   Mutation call 0 = setFoundersSummaryEnabled (FoundersSummaryToggle)
 *   Mutation call 1 = setTxnTickerEnabled       (TxnTickerToggle)
 *   Mutation call 2 = assignRole  (ChatCard)
 *   Mutation call 3 = archiveChat (ChatCard)
 *   Mutation call 4 = restoreChat (ChatCard)
 *
 * We track call index with a module-level counter and reset it before each
 * test by calling resetCounters(). The mock captures the slot at call time
 * via a closure — so re-renders see the same delegation.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import type { Doc } from "../../../convex/_generated/dataModel";

// jsdom does not implement scrollIntoView — Radix UI Select uses it when
// opening the dropdown. Without this polyfill the Select open animation
// throws a TypeError and the test fails unrelated to the feature under test.
if (typeof window !== "undefined" && !window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

// ---------- mocks (hoisted by Vite) ------------------------------------------

const mockNavigate = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({ status: "none", sessionId: null, staff: null })),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: vi.fn(() => undefined),
    useMutation: vi.fn(() => vi.fn().mockResolvedValue({ ok: true })),
    useAction: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// ---------- import mocks + component -----------------------------------------

import * as convexReact from "convex/react";
import * as useSessionModule from "@/hooks/useSession";
import MgrTelegramChats from "./telegram-chats";

const mockUseQuery = convexReact.useQuery as Mock;
const mockUseMutation = convexReact.useMutation as Mock;
const mockUseAction = convexReact.useAction as Mock;
const mockUseSession = useSessionModule.useSession as Mock;

// ---------- shared stubs -----------------------------------------------------

// Per-test named stubs — tests swap these via mockReturnValue / mockImplementation
let stubAssignRole: ReturnType<typeof vi.fn>;
let stubArchiveChat: ReturnType<typeof vi.fn>;
let stubRestoreChat: ReturnType<typeof vi.fn>;
let stubSetFounders: ReturnType<typeof vi.fn>;
let stubSetTicker: ReturnType<typeof vi.fn>;
let stubSendTest: ReturnType<typeof vi.fn>;

// ---------- helpers ----------------------------------------------------------

const activeManagerSession = {
  status: "active" as const,
  sessionId: "sess-mgr" as Doc<"staff_sessions">["_id"],
  staff: { _id: "staffId" as Doc<"staff">["_id"], name: "Siti", role: "manager" as const },
};

const baseChat: Doc<"telegramChats"> = {
  _id: "chat1" as Doc<"telegramChats">["_id"],
  _creationTime: Date.now(),
  chatId: "123456",
  chatType: "group",
  title: "Frollie Managers",
  role: "managers",
  registeredAt: Date.now() - 60_000,
  lastSeenAt: Date.now() - 30_000,
};

/**
 * Set up useQuery to return settings and chats by dispatching on args shape.
 *
 * useQuery receives (apiRef, args):
 *   - settings query args: {} (no sessionId, no includeArchived)
 *   - chats query args: { sessionId, includeArchived } (has "includeArchived")
 *
 * Because Convex API proxy objects are not identity-stable, we dispatch on
 * args shape rather than identity. This is re-render-safe.
 */
function setupQueryMock(settings: unknown, chats: unknown) {
  mockUseQuery.mockImplementation((_api: unknown, args: unknown) => {
    if (args !== null && typeof args === "object" && "includeArchived" in (args as object)) {
      return chats;
    }
    return settings;
  });
}

/**
 * Set up useMutation to return named stubs by call order.
 * The mutation call order per render tree (depth-first):
 *   0 = setFoundersSummaryEnabled (FoundersSummaryToggle)
 *   1 = setTxnTickerEnabled       (TxnTickerToggle)
 *   2 = assignRole  (ChatCard)
 *   3 = archiveChat (ChatCard)
 *   4 = restoreChat (ChatCard)
 */
function setupMutationMock() {
  let mutIdx = 0;
  const order = [stubSetFounders, stubSetTicker, stubAssignRole, stubArchiveChat, stubRestoreChat];
  mockUseMutation.mockImplementation(() => {
    const slot = mutIdx % order.length;
    mutIdx++;
    // Return a stable wrapper function. On re-renders React calls useMutation
    // again — modulo wraps so we cycle through the same stubs.
    return (...args: unknown[]) => order[slot](...args);
  });
}

function renderPage() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/telegram-chats"]}>
        <MgrTelegramChats />
      </MemoryRouter>
    </ConvexProvider>,
  );
}

// ---------- session guard tests ----------------------------------------------

describe("MgrTelegramChats — session guard", () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockReset();

    stubAssignRole = vi.fn().mockResolvedValue({ ok: true });
    stubArchiveChat = vi.fn().mockResolvedValue({ ok: true });
    stubRestoreChat = vi.fn().mockResolvedValue({ ok: true });
    stubSetFounders = vi.fn().mockResolvedValue({ ok: true });
    stubSetTicker = vi.fn().mockResolvedValue({ ok: true });
    stubSendTest = vi.fn().mockResolvedValue(undefined);

    mockUseAction.mockImplementation(() => (...args: unknown[]) => stubSendTest(...args));
    setupQueryMock({ founders_summary_enabled: true, txn_ticker_enabled: true }, []);
    setupMutationMock();
  });

  it("shows loading state while session is loading", () => {
    mockUseSession.mockReturnValue({ status: "loading", sessionId: null, staff: null });
    renderPage();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("redirects to / when session is none", () => {
    mockUseSession.mockReturnValue({ status: "none", sessionId: null, staff: null });
    renderPage();
    expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("redirects to / when role is staff (not manager)", () => {
    mockUseSession.mockReturnValue({
      status: "active",
      sessionId: "sess123",
      staff: { _id: "staffId", name: "Budi", role: "staff" },
    });
    renderPage();
    expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true });
  });

  it("renders page heading for an active manager", () => {
    mockUseSession.mockReturnValue(activeManagerSession);
    renderPage();
    expect(screen.getByRole("heading", { name: /telegram chats/i })).toBeInTheDocument();
  });
});

// ---------- chat list rendering tests ----------------------------------------

describe("MgrTelegramChats — chat list", () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockReset();

    stubAssignRole = vi.fn().mockResolvedValue({ ok: true });
    stubArchiveChat = vi.fn().mockResolvedValue({ ok: true });
    stubRestoreChat = vi.fn().mockResolvedValue({ ok: true });
    stubSetFounders = vi.fn().mockResolvedValue({ ok: true });
    stubSetTicker = vi.fn().mockResolvedValue({ ok: true });
    stubSendTest = vi.fn().mockResolvedValue(undefined);

    mockUseSession.mockReturnValue(activeManagerSession);
    mockUseAction.mockImplementation(() => (...args: unknown[]) => stubSendTest(...args));
    setupQueryMock({ founders_summary_enabled: true, txn_ticker_enabled: true }, undefined); // override per test
    setupMutationMock();
  });

  it("shows 'Loading chats…' while chats query is pending (undefined)", () => {
    setupQueryMock({ founders_summary_enabled: true }, undefined);
    renderPage();
    expect(screen.getByText(/loading chats/i)).toBeInTheDocument();
  });

  it("renders empty-state when mgrListChats returns []", () => {
    setupQueryMock({ founders_summary_enabled: true }, []);
    renderPage();
    expect(screen.getByText(/no registered telegram chats yet/i)).toBeInTheDocument();
    expect(screen.getByText(/invite the bot/i)).toBeInTheDocument();
    expect(screen.getByText(/\/register/)).toBeInTheDocument();
  });

  it("renders a chat card when mgrListChats returns rows", () => {
    setupQueryMock({ founders_summary_enabled: true }, [baseChat]);
    setupMutationMock();
    renderPage();
    expect(screen.getByText("Frollie Managers")).toBeInTheDocument();
    expect(screen.getByText("123456")).toBeInTheDocument();
    expect(screen.getByText("group")).toBeInTheDocument();
  });

  it("shows Active badge for a chat with a role and no error", () => {
    setupQueryMock({ founders_summary_enabled: true }, [baseChat]);
    setupMutationMock();
    renderPage();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("shows Dormant badge for a chat with no role", () => {
    setupQueryMock({ founders_summary_enabled: true }, [{ ...baseChat, role: undefined }]);
    setupMutationMock();
    renderPage();
    expect(screen.getByText("Dormant")).toBeInTheDocument();
  });

  it("shows Archived badge for an archived chat", () => {
    setupQueryMock({ founders_summary_enabled: true }, [
      { ...baseChat, archivedAt: Date.now() - 3_600_000 },
    ]);
    setupMutationMock();
    renderPage();
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });

  it("shows Archive button for active chats and Restore for archived chats", () => {
    setupQueryMock({ founders_summary_enabled: true }, [
      baseChat,
      {
        ...baseChat,
        _id: "chat2" as Doc<"telegramChats">["_id"],
        chatId: "654321",
        title: "Old Chat",
        archivedAt: Date.now() - 3_600_000,
      },
    ]);
    setupMutationMock();
    renderPage();
    expect(screen.getAllByRole("button", { name: /archive/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /restore/i }).length).toBeGreaterThan(0);
  });
});

// ---------- role assignment --------------------------------------------------

describe("MgrTelegramChats — role assignment", () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockReset();

    stubAssignRole = vi.fn().mockResolvedValue({ ok: true });
    stubArchiveChat = vi.fn().mockResolvedValue({ ok: true });
    stubRestoreChat = vi.fn().mockResolvedValue({ ok: true });
    stubSetFounders = vi.fn().mockResolvedValue({ ok: true });
    stubSetTicker = vi.fn().mockResolvedValue({ ok: true });
    stubSendTest = vi.fn().mockResolvedValue(undefined);

    mockUseSession.mockReturnValue(activeManagerSession);
    mockUseAction.mockImplementation(() => (...args: unknown[]) => stubSendTest(...args));
    setupQueryMock({ founders_summary_enabled: true, txn_ticker_enabled: true }, [baseChat]);
    setupMutationMock();
  });

  it("calls mgrAssignRole with sessionId, chatId, and new role when select changes", async () => {
    renderPage();

    const trigger = screen.getByRole("combobox", { name: /role select/i });
    fireEvent.click(trigger);

    await waitFor(() => expect(screen.getByText("founders")).toBeInTheDocument());
    fireEvent.click(screen.getByText("founders"));

    await waitFor(() => expect(stubAssignRole).toHaveBeenCalledTimes(1));

    const args = stubAssignRole.mock.calls[0][0] as Record<string, unknown>;
    expect(args.sessionId).toBe("sess-mgr");
    expect(args.chatId).toBe("123456");
    expect(args.role).toBe("founders");
    expect(typeof args.idempotencyKey).toBe("string");
    expect((args.idempotencyKey as string).length).toBeGreaterThan(0);
  });

  it("generates a UUID-shaped idempotencyKey per call", async () => {
    renderPage();

    const trigger = screen.getByRole("combobox", { name: /role select/i });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByText("founders")).toBeInTheDocument());
    fireEvent.click(screen.getByText("founders"));

    await waitFor(() => expect(stubAssignRole).toHaveBeenCalledTimes(1));
    const key = stubAssignRole.mock.calls[0][0].idempotencyKey as string;
    expect(key).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

// ---------- founders summary toggle ------------------------------------------

describe("MgrTelegramChats — founders summary toggle", () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockReset();

    stubAssignRole = vi.fn().mockResolvedValue({ ok: true });
    stubArchiveChat = vi.fn().mockResolvedValue({ ok: true });
    stubRestoreChat = vi.fn().mockResolvedValue({ ok: true });
    stubSetFounders = vi.fn().mockResolvedValue({ ok: true });
    stubSetTicker = vi.fn().mockResolvedValue({ ok: true });
    stubSendTest = vi.fn().mockResolvedValue(undefined);

    mockUseSession.mockReturnValue(activeManagerSession);
    mockUseAction.mockImplementation(() => (...args: unknown[]) => stubSendTest(...args));
    // No chats for founders toggle tests — isolates the toggle
    setupQueryMock({ founders_summary_enabled: true, txn_ticker_enabled: true }, []);
    setupMutationMock();
  });

  it("renders founders toggle in checked state when founders_summary_enabled is true", () => {
    setupQueryMock({ founders_summary_enabled: true }, []);
    setupMutationMock();
    renderPage();
    const toggle = screen.getByRole("switch", { name: /founders summary toggle/i });
    expect(toggle).toBeChecked();
  });

  it("renders founders toggle in unchecked state when founders_summary_enabled is false", () => {
    setupQueryMock({ founders_summary_enabled: false }, []);
    setupMutationMock();
    renderPage();
    const toggle = screen.getByRole("switch", { name: /founders summary toggle/i });
    expect(toggle).not.toBeChecked();
  });

  it("calls setFoundersSummaryEnabled(false) when toggled off (was true)", async () => {
    setupQueryMock({ founders_summary_enabled: true }, []);
    setupMutationMock();
    renderPage();

    const toggle = screen.getByRole("switch", { name: /founders summary toggle/i });
    fireEvent.click(toggle);

    await waitFor(() => expect(stubSetFounders).toHaveBeenCalledTimes(1));
    const args = stubSetFounders.mock.calls[0][0] as Record<string, unknown>;
    expect(args.enabled).toBe(false);
    expect(args.sessionId).toBe("sess-mgr");
    expect(typeof args.idempotencyKey).toBe("string");
    expect((args.idempotencyKey as string).length).toBeGreaterThan(0);
  });

  it("calls setFoundersSummaryEnabled(true) when toggled on (was false)", async () => {
    setupQueryMock({ founders_summary_enabled: false, txn_ticker_enabled: true }, []);
    setupMutationMock();
    renderPage();

    const toggle = screen.getByRole("switch", { name: /founders summary toggle/i });
    fireEvent.click(toggle);

    await waitFor(() => expect(stubSetFounders).toHaveBeenCalledTimes(1));
    const args = stubSetFounders.mock.calls[0][0] as Record<string, unknown>;
    expect(args.enabled).toBe(true);
  });
});

// ---------- sales ticker toggle ----------------------------------------------

describe("MgrTelegramChats — sales ticker toggle", () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockReset();
    stubAssignRole = vi.fn().mockResolvedValue({ ok: true });
    stubArchiveChat = vi.fn().mockResolvedValue({ ok: true });
    stubRestoreChat = vi.fn().mockResolvedValue({ ok: true });
    stubSetFounders = vi.fn().mockResolvedValue({ ok: true });
    stubSetTicker = vi.fn().mockResolvedValue({ ok: true });
    stubSendTest = vi.fn().mockResolvedValue(undefined);
    mockUseSession.mockReturnValue(activeManagerSession);
    mockUseAction.mockImplementation(() => (...args: unknown[]) => stubSendTest(...args));
    setupMutationMock();
  });

  it("renders the ticker switch checked when txn_ticker_enabled is true", () => {
    setupQueryMock({ founders_summary_enabled: true, txn_ticker_enabled: true }, []);
    renderPage();
    const toggle = screen.getByRole("switch", { name: /sales ticker toggle/i });
    expect(toggle).toBeChecked();
  });

  it("renders the ticker switch unchecked when txn_ticker_enabled is false", () => {
    setupQueryMock({ founders_summary_enabled: true, txn_ticker_enabled: false }, []);
    renderPage();
    const toggle = screen.getByRole("switch", { name: /sales ticker toggle/i });
    expect(toggle).not.toBeChecked();
  });

  it("calls setTxnTickerEnabled(false) when toggled off (was true)", async () => {
    setupQueryMock({ founders_summary_enabled: true, txn_ticker_enabled: true }, []);
    renderPage();
    fireEvent.click(screen.getByRole("switch", { name: /sales ticker toggle/i }));
    await waitFor(() =>
      expect(stubSetTicker).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      ),
    );
  });

  it("calls setTxnTickerEnabled(true) when toggled on (was false)", async () => {
    setupQueryMock({ founders_summary_enabled: true, txn_ticker_enabled: false }, []);
    renderPage();
    fireEvent.click(screen.getByRole("switch", { name: /sales ticker toggle/i }));
    await waitFor(() =>
      expect(stubSetTicker).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
  });
});
