/**
 * Tests for CockpitLoginRoute (v2.0 owner-auth WS6, ADR-052).
 *
 * Mock strategy (follows src/routes/login.test.tsx):
 *   - convex/react: useAction discriminated by FunctionReference identity so each
 *     of the four owner actions (requestOwnerOtp / verifyOwnerOtp / quickPinLogin /
 *     registerRememberedDevice) gets its own vi.fn() stub.
 *   - useDeviceId / useIdempotency / useSession stubbed (no IDB / device side-effects).
 *   - sonner stubbed so we can assert errors are inline (FieldMessage), never a toast.
 *
 * The route owns a phase machine: a remembered-device token routes to the quick-PIN
 * phase first; otherwise identifier → otp → (optional) remember. Errors surface via
 * FieldMessage (role=alert), success via role=status — never a toast (ADR-048).
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderWithLocale as render, screen, waitFor, fireEvent } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import CockpitLoginRoute from "../login";
import { REMEMBER_DEVICE_TOKEN_KEY } from "@/lib/storage-keys";

// ─── module mocks (hoisted by Vite) ──────────────────────────────────────────

const {
  mockRequestOtp,
  mockVerifyOtp,
  mockQuickLogin,
  mockRegisterRemembered,
  mockStoreCockpitSession,
} = vi.hoisted(() => ({
  mockRequestOtp: vi.fn().mockResolvedValue({ ok: true }),
  mockVerifyOtp: vi.fn().mockResolvedValue({ sessionId: "kn7ses000000000000000000000" }),
  mockQuickLogin: vi.fn().mockResolvedValue({ sessionId: "kn7ses000000000000000000000" }),
  mockRegisterRemembered: vi.fn().mockResolvedValue({ rememberToken: "remember-raw-token" }),
  mockStoreCockpitSession: vi.fn(),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useAction: vi.fn(() => undefined),
    useMutation: vi.fn(() => undefined),
  };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/hooks/useDeviceId", () => ({
  useDeviceId: vi.fn(() => "test-device-id"),
}));

vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: vi.fn(() => "test-idem-key"),
  clearIntent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/hooks/useSession", () => ({
  useSession: vi.fn(() => ({ status: "none", sessionId: null, staff: null })),
  storeCockpitSession: (...args: unknown[]) => mockStoreCockpitSession(...args),
}));

// ─── setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  localStorage.clear();
  vi.clearAllMocks();
  // Re-arm default resolved values (clearAllMocks wipes implementations).
  mockRequestOtp.mockResolvedValue({ ok: true });
  mockVerifyOtp.mockResolvedValue({ sessionId: "kn7ses000000000000000000000" });
  mockQuickLogin.mockResolvedValue({ sessionId: "kn7ses000000000000000000000" });
  mockRegisterRemembered.mockResolvedValue({ rememberToken: "remember-raw-token" });

  const convexReact = await import("convex/react");
  // `api` is `anyApi` (a Proxy) — every property access mints a fresh reference, so
  // identity comparison can't work. Discriminate on the canonical function name.
  (convexReact.useAction as Mock).mockImplementation((ref: unknown) => {
    const name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
    if (name.includes("requestOwnerOtp")) return mockRequestOtp;
    if (name.includes("verifyOwnerOtp")) return mockVerifyOtp;
    if (name.includes("quickPinLogin")) return mockQuickLogin;
    if (name.includes("registerRememberedDevice")) return mockRegisterRemembered;
    return vi.fn();
  });
});

function renderCockpit() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/cockpit/login"]}>
        <Routes>
          <Route path="/cockpit/login" element={<CockpitLoginRoute />} />
          <Route path="/cockpit" element={<div data-testid="cockpit-home" />} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

/** Click the on-screen keypad digits (aria-label "Digit N" in EN locale). */
function typeDigits(code: string) {
  for (const d of code) {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`digit ${d}`, "i") }));
  }
}

// ─── identifier → OTP request ────────────────────────────────────────────────

describe("Cockpit login — identifier phase", () => {
  it("starts at the identifier phase when no remembered-device token", async () => {
    renderCockpit();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
    expect(mockRequestOtp).not.toHaveBeenCalled();
  });

  it("submitting an identifier requests an OTP and advances to the code phase", async () => {
    renderCockpit();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/email or staff code/i), {
      target: { value: "lucas@frollie.id" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));

    await waitFor(() => expect(mockRequestOtp).toHaveBeenCalledTimes(1));
    expect(mockRequestOtp).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: "lucas@frollie.id", deviceId: "test-device-id" }),
    );
    // Advances to the 6-digit code phase.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /enter your code/i })).toBeInTheDocument(),
    );
  });

  it("OTP_COOLDOWN shows an inline cooldown error and fires NO toast", async () => {
    mockRequestOtp.mockRejectedValueOnce(new Error("OTP_COOLDOWN:30"));
    renderCockpit();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/email or staff code/i), {
      target: { value: "lucas@frollie.id" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/30/));
    // Stays on the identifier phase (no advance).
    expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument();
    const { toast } = await import("sonner");
    expect(toast.error).not.toHaveBeenCalled();
  });
});

// ─── OTP verify ───────────────────────────────────────────────────────────────

describe("Cockpit login — OTP verify", () => {
  async function advanceToOtp() {
    renderCockpit();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/email or staff code/i), {
      target: { value: "lucas@frollie.id" },
    });
    fireEvent.click(screen.getByRole("button", { name: /send code/i }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /enter your code/i })).toBeInTheDocument(),
    );
  }

  it("a valid OTP stores the cockpit session and offers the remember-device step", async () => {
    await advanceToOtp();
    typeDigits("123456");

    await waitFor(() => expect(mockVerifyOtp).toHaveBeenCalledTimes(1));
    expect(mockVerifyOtp).toHaveBeenCalledWith(
      expect.objectContaining({ code: "123456", identifier: "lucas@frollie.id" }),
    );
    expect(mockStoreCockpitSession).toHaveBeenCalledWith("kn7ses000000000000000000000");
    // No remembered token yet → offered the remember-device enrolment phase.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /remember this device/i })).toBeInTheDocument(),
    );
  });

  it("OTP_INVALID shows a generic inline error and stays on the code phase", async () => {
    mockVerifyOtp.mockRejectedValueOnce(new Error("OTP_INVALID"));
    await advanceToOtp();
    typeDigits("000000");

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: /enter your code/i })).toBeInTheDocument();
    expect(mockStoreCockpitSession).not.toHaveBeenCalled();
    const { toast } = await import("sonner");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("enrolling a quick-PIN in the remember step stores the token and navigates to the cockpit", async () => {
    await advanceToOtp();
    typeDigits("123456");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /remember this device/i })).toBeInTheDocument(),
    );
    typeDigits("445566");

    await waitFor(() => expect(mockRegisterRemembered).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(REMEMBER_DEVICE_TOKEN_KEY)).toBe("remember-raw-token");
    await waitFor(() => expect(screen.getByTestId("cockpit-home")).toBeInTheDocument());
  });

  it("skipping the remember step navigates to the cockpit (session already stored)", async () => {
    await advanceToOtp();
    typeDigits("123456");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /remember this device/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    await waitFor(() => expect(screen.getByTestId("cockpit-home")).toBeInTheDocument());
    expect(mockRegisterRemembered).not.toHaveBeenCalled();
  });
});

// ─── quick-PIN fast path (remembered device) ─────────────────────────────────

describe("Cockpit login — quick-PIN fast path", () => {
  it("a remembered-device token routes to the quick-PIN phase first", async () => {
    localStorage.setItem(REMEMBER_DEVICE_TOKEN_KEY, "remember-raw-token");
    renderCockpit();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /quick pin/i })).toBeInTheDocument(),
    );
    // Did NOT start by requesting an OTP.
    expect(mockRequestOtp).not.toHaveBeenCalled();
  });

  it("a valid quick-PIN logs in and navigates straight to the cockpit (no remember step)", async () => {
    localStorage.setItem(REMEMBER_DEVICE_TOKEN_KEY, "remember-raw-token");
    renderCockpit();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /quick pin/i })).toBeInTheDocument(),
    );
    typeDigits("445566");

    await waitFor(() => expect(mockQuickLogin).toHaveBeenCalledTimes(1));
    expect(mockQuickLogin).toHaveBeenCalledWith(
      expect.objectContaining({ rememberToken: "remember-raw-token", quickPin: "445566" }),
    );
    expect(mockStoreCockpitSession).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByTestId("cockpit-home")).toBeInTheDocument());
  });

  it("a quick-PIN LOCKED_OUT surfaces the cooldown inline and does not log in", async () => {
    mockQuickLogin.mockRejectedValueOnce(new Error("LOCKED_OUT:60"));
    localStorage.setItem(REMEMBER_DEVICE_TOKEN_KEY, "remember-raw-token");
    renderCockpit();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /quick pin/i })).toBeInTheDocument(),
    );
    typeDigits("000000");

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/60/));
    expect(mockStoreCockpitSession).not.toHaveBeenCalled();
    const { toast } = await import("sonner");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("the 'use a login code instead' escape switches to the identifier phase", async () => {
    localStorage.setItem(REMEMBER_DEVICE_TOKEN_KEY, "remember-raw-token");
    renderCockpit();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /quick pin/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /use a login code instead/i }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /sign in/i })).toBeInTheDocument(),
    );
  });
});
