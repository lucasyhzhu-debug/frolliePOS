import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { toast } from "sonner";
import { SESSION_KEY } from "@/lib/storage-keys";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

const FAKE_SESSION_ID = "session_mgr";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "mgr_1", name: "Bos", role: "manager" },
};
const mockGenerate = vi.fn();

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (query: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      let name = "";
      try { name = getFunctionName(query as Parameters<typeof getFunctionName>[0]); } catch { name = ""; }
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: (mut: unknown) => {
      let name = "";
      try { name = getFunctionName(mut as Parameters<typeof getFunctionName>[0]); } catch { name = ""; }
      if (name.includes("generateDeviceSetupCode")) return mockGenerate;
      return vi.fn().mockResolvedValue({});
    },
  };
});

import MgrDeviceSetup from "../device-setup";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/device-setup"]}>
        <Routes>
          <Route path="/mgr/device-setup" element={<MgrDeviceSetup />} />
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("MgrDeviceSetup (/mgr/device-setup)", () => {
  beforeAll(() => { vi.stubEnv("VITE_CONVEX_URL", "https://test.convex.cloud"); });
  afterAll(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    localStorage.clear();
    mockSessionReturn = { sessionId: FAKE_SESSION_ID, staff: { _id: "mgr_1", name: "Bos", role: "manager" } };
    mockGenerate.mockReset();
    mockGenerate.mockResolvedValue({ code: "123456", expiresAt: Date.now() + 3_600_000 });
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("manager: clicking generate mints and shows the code + countdown with a UUID key", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /generate setup code/i }));
    expect(await screen.findByTestId("setup-code")).toHaveTextContent("123456");
    expect(screen.getByTestId("setup-countdown")).toBeInTheDocument();
    const call = mockGenerate.mock.calls[0][0];
    expect(call.sessionId).toBe(FAKE_SESSION_ID);
    expect(typeof call.idempotencyKey).toBe("string");
    expect(call.idempotencyKey.length).toBeGreaterThan(0);
  });

  it("regenerate mints again with a different key", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /generate setup code/i }));
    await screen.findByTestId("setup-code");
    fireEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(2));
    const k1 = mockGenerate.mock.calls[0][0].idempotencyKey;
    const k2 = mockGenerate.mock.calls[1][0].idempotencyKey;
    expect(k1).not.toBe(k2);
  });

  it("non-manager is redirected to /", async () => {
    mockSessionReturn = { sessionId: FAKE_SESSION_ID, staff: { _id: "s_1", name: "Andi", role: "staff" } };
    renderRoute();
    expect(await screen.findByText("HOME")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /generate setup code/i })).not.toBeInTheDocument();
  });

  it("mutation failure surfaces a toast.error", async () => {
    mockGenerate.mockReset();
    mockGenerate.mockRejectedValue(new Error("Network down"));
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: /generate setup code/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByTestId("setup-code")).not.toBeInTheDocument();
  });
});
