import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { lazy, Suspense } from "react";

const Approve = lazy(() => import("@/routes/approve"));
const ApprovePin = lazy(() => import("@/routes/approve/pin"));
const Receipt = lazy(() => import("@/routes/receipt"));
const Activate = lazy(() => import("@/routes/activate"));

function publicRoutesAt(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Suspense fallback={<div>loading</div>}>
        <Routes>
          <Route path="/approve/:token" element={<Approve />} />
          <Route path="/approve/:token/pin" element={<ApprovePin />} />
          <Route path="/r/:receiptNumber" element={<Receipt />} />
          <Route path="/activate" element={<Activate />} />
        </Routes>
      </Suspense>
    </MemoryRouter>
  );
}

describe("public routes", () => {
  beforeEach(() => localStorage.clear());

  for (const path of ["/approve/tok-abc", "/approve/tok-abc/pin", "/r/R-2026-0001", "/activate"]) {
    it(`renders ${path} without auth`, () => {
      const convex = new ConvexReactClient("https://example.convex.cloud");
      const { container } = render(
        <ConvexProvider client={convex}>{publicRoutesAt(path)}</ConvexProvider>,
      );
      expect(container.textContent).not.toBe("");
    });
  }
});
