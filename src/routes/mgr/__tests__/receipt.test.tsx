import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent, waitFor } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

/**
 * /mgr/receipt logo-validation smoke test (slice 2 inline-messaging).
 *
 * Mocking pattern mirrors products.test.tsx: useQuery dispatched by
 * FunctionReference name. The route makes two queries:
 *   - useSession's getSession             → mockSessionReturn
 *   - settings.public.getReceiptConfig    → mockConfigReturn
 */

const FAKE_SESSION_ID = "session_abc";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "staff_1", name: "Lucy", role: "manager" },
};

let mockConfigReturn: unknown = {
  business_name: "Frollie",
  address: "Pakuwon Mall",
  contact: "+62 812 0000 0000",
  instagram_handle: "@frollie",
  footer_text: "Thank you!",
  logo_storage_id: null,
  logo_url: null,
};

// useIdempotency returns undefined in jsdom (IDB-backed), which disables the
// logo pick path (the !uploadKey guard). Mock to a stable key so onPickLogo
// reaches the type-check before any network. clearIntent is also imported.
vi.mock("@/hooks/useIdempotency", () => ({
  useIdempotency: () => "key1",
  clearIntent: vi.fn(),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

// Per-test override for generateLogoUploadUrl; default resolves normally.
// Reassign in a test to simulate async upload failure.
let mockGenerateLogoUploadUrl: () => Promise<unknown> = () =>
  Promise.resolve({ uploadUrl: "https://example.convex.cloud/upload/test" });

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (query: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      let name = "";
      try {
        name = getFunctionName(
          query as Parameters<typeof getFunctionName>[0],
        );
      } catch {
        name = "";
      }
      if (name.includes("getReceiptConfig")) return mockConfigReturn;
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
    useMutation: (ref: unknown) => {
      let name = "";
      try {
        name = getFunctionName(ref as Parameters<typeof getFunctionName>[0]);
      } catch {
        name = "";
      }
      if (name.includes("generateLogoUploadUrl")) {
        return (...args: unknown[]) => mockGenerateLogoUploadUrl(...args as []);
      }
      return vi.fn().mockResolvedValue({});
    },
    useAction: () => vi.fn().mockResolvedValue({}),
  };
});

import Receipt from "../receipt";

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/receipt"]}>
        <Routes>
          <Route path="/mgr/receipt" element={<Receipt />} />
          <Route path="/" element={<div>HOME_PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("MgrReceipt route (/mgr/receipt)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    toastError.mockClear();
    toastSuccess.mockClear();
    // Reset upload mock to the default (success) path before each test.
    mockGenerateLogoUploadUrl = () =>
      Promise.resolve({ uploadUrl: "https://example.convex.cloud/upload/test" });
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "staff_1", name: "Lucy", role: "manager" },
    };
    mockConfigReturn = {
      business_name: "Frollie",
      address: "Pakuwon Mall",
      contact: "+62 812 0000 0000",
      instagram_handle: "@frollie",
      footer_text: "Thank you!",
      logo_storage_id: null,
      logo_url: null,
    };
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("shows an inline FieldMessage (not a toast) when a non-image file is picked", () => {
    renderRoute();

    // The hidden file input
    const input = document.getElementById("logo-input") as HTMLInputElement;
    expect(input).not.toBeNull();

    const nonImageFile = new File(["data"], "test.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [nonImageFile] } });

    // Inline FieldMessage should appear with the EN logoNotImage text
    const msg = screen.getByText("Pick an image file.");
    expect(msg).toBeInTheDocument();
    expect(msg.closest("[role='alert']")).not.toBeNull();

    // toast.error must NOT be called — validation is inline
    expect(toastError).not.toHaveBeenCalled();
  });

  it("fires toast.error (not inline FieldMessage) when the async upload rejects", async () => {
    // Make generateLogoUploadUrl throw so control lands in the catch block.
    mockGenerateLogoUploadUrl = () => Promise.reject(new Error("network error"));

    renderRoute();

    const input = document.getElementById("logo-input") as HTMLInputElement;
    expect(input).not.toBeNull();

    // Valid image under MAX_LOGO_BYTES — passes all 3 sync guards.
    const validImage = new File(["x"], "logo.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [validImage] } });

    // The catch is async — wait for toast.error to be called.
    await waitFor(() => expect(toastError).toHaveBeenCalled());

    // Must use toast (async path), NOT inline FieldMessage.
    expect(toastError).toHaveBeenCalledWith("Logo upload failed. Try again.");
    expect(document.getElementById("logo.file-error")).toBeNull();
  });
});
