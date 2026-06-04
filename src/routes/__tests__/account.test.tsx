import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

const FAKE_SESSION_ID = "session_abc";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Andi", role: "staff" },
};
const mockChangePin = vi.fn();
const mockNavigate = vi.fn();

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => mockNavigate };
});

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
    useAction: (fn: unknown) => {
      let name = "";
      try { name = getFunctionName(fn as Parameters<typeof getFunctionName>[0]); } catch { name = ""; }
      if (name.includes("changePin")) return mockChangePin;
      return vi.fn().mockResolvedValue({});
    },
  };
});

import AccountRoute from "../account";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/account"]}>
        <Routes>
          <Route path="/account" element={<AccountRoute />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

// Enter a 4-digit PIN via the keypad (NumericKeypad buttons are aria-label "Digit N").
function typePin(pin: string) {
  for (const d of pin) fireEvent.click(screen.getByLabelText(`Digit ${d}`));
}

describe("AccountRoute (/account change-PIN)", () => {
  beforeAll(() => { vi.stubEnv("VITE_CONVEX_URL", "https://test.convex.cloud"); });
  afterAll(() => { vi.unstubAllEnvs(); });
  beforeEach(() => {
    localStorage.clear();
    mockSessionReturn = { sessionId: FAKE_SESSION_ID, staff: { _id: "staff_1", name: "Andi", role: "staff" } };
    mockChangePin.mockReset();
    mockChangePin.mockResolvedValue({ changed: true });
    mockNavigate.mockReset();
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("happy path: calls changePin once with current/new + a UUID key, then navigates home", async () => {
    renderRoute();
    typePin("1111"); // current
    typePin("2222"); // new
    typePin("2222"); // confirm
    await waitFor(() => expect(mockChangePin).toHaveBeenCalledTimes(1));
    const call = mockChangePin.mock.calls[0][0];
    expect(call.sessionId).toBe(FAKE_SESSION_ID);
    expect(call.currentPin).toBe("1111");
    expect(call.newPin).toBe("2222");
    expect(typeof call.idempotencyKey).toBe("string");
    expect(call.idempotencyKey.length).toBeGreaterThan(0);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/", { replace: true }));
  });

  it("mismatched confirm shows an error and does not call changePin", async () => {
    renderRoute();
    typePin("1111");
    typePin("2222");
    typePin("3333"); // confirm != new
    expect(await screen.findByTestId("account-error")).toHaveTextContent(/tidak cocok/i);
    expect(mockChangePin).not.toHaveBeenCalled();
  });

  it("maps INVALID_PIN to friendly copy", async () => {
    mockChangePin.mockRejectedValue(new Error("Server Error: INVALID_PIN"));
    renderRoute();
    typePin("9999"); typePin("2222"); typePin("2222");
    expect(await screen.findByTestId("account-error")).toHaveTextContent(/PIN lama salah/i);
  });

  it("maps LOCKED_OUT:30 to a lockout message with the seconds", async () => {
    mockChangePin.mockRejectedValue(new Error("Server Error: LOCKED_OUT:30"));
    renderRoute();
    typePin("9999"); typePin("2222"); typePin("2222");
    expect(await screen.findByTestId("account-error")).toHaveTextContent(/30/);
  });

  it("SESSION_INVALID redirects to /login", async () => {
    mockChangePin.mockRejectedValue(new Error("Server Error: SESSION_INVALID"));
    renderRoute();
    typePin("1111"); typePin("2222"); typePin("2222");
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/login", { replace: true }));
  });

  it("maps SAME_PIN to friendly copy", async () => {
    mockChangePin.mockRejectedValue(new Error("Server Error: SAME_PIN"));
    renderRoute();
    typePin("1111"); typePin("1111"); typePin("1111");
    expect(await screen.findByTestId("account-error")).toHaveTextContent(/berbeda dari PIN lama/i);
  });

  it("maps NEW_PIN_INVALID to friendly copy", async () => {
    mockChangePin.mockRejectedValue(new Error("Server Error: NEW_PIN_INVALID"));
    renderRoute();
    typePin("1111"); typePin("2222"); typePin("2222");
    expect(await screen.findByTestId("account-error")).toHaveTextContent(/4 angka/i);
  });
});
