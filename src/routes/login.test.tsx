import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import LoginRoute from "./login";

describe("Login route", () => {
  beforeEach(() => localStorage.clear());

  it("renders the staff list heading", async () => {
    const convex = new ConvexReactClient("https://example.convex.cloud");
    render(
      <ConvexProvider client={convex}>
        <MemoryRouter initialEntries={["/login"]}>
          <LoginRoute />
        </MemoryRouter>
      </ConvexProvider>,
    );
    // deviceId starts null while IDB resolves; wait for it to settle and
    // the heading to appear.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /who's working/i })).toBeInTheDocument(),
    );
  });
});
