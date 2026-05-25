import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import LoginRoute from "./login";

describe("Login route", () => {
  beforeEach(() => localStorage.clear());

  it("renders the staff list heading", () => {
    const convex = new ConvexReactClient("https://example.convex.cloud");
    render(
      <ConvexProvider client={convex}>
        <MemoryRouter initialEntries={["/login"]}>
          <LoginRoute />
        </MemoryRouter>
      </ConvexProvider>,
    );
    expect(screen.getByRole("heading", { name: /who's working/i })).toBeInTheDocument();
  });
});
