import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderWithLocale as render, screen, fireEvent } from "@/test-utils";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { SESSION_KEY } from "@/lib/storage-keys";

const FAKE_SESSION_ID = "session_abc";

let mockSessionReturn: unknown = {
  sessionId: FAKE_SESSION_ID,
  staff: { _id: "m1", name: "Mgr One", role: "manager" },
};
let mockRows: unknown = [];
let lastArgs: { sessionId: string; limit?: number; action?: string } | null = null;

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  return {
    ...actual,
    useQuery: (query: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      let name = "";
      try {
        name = getFunctionName(query as Parameters<typeof getFunctionName>[0]);
      } catch {
        name = "";
      }
      if (name.includes("audit")) {
        lastArgs = args as typeof lastArgs;
        return mockRows;
      }
      if (name.includes("getSession")) return mockSessionReturn;
      return undefined;
    },
  };
});

import MgrAudit from "../audit";

const ROW = {
  _id: "a1",
  _creationTime: 0,
  created_at: 1_717_000_000_000,
  action: "refund.committed",
  actor_name: "Mgr One",
  actor_id: "m1",
  entity_type: "pos_refunds",
  entity_id: "r1",
  source: "booth_inline",
  reason: "customer changed mind",
};

function renderRoute() {
  const convex = new ConvexReactClient("https://example.convex.cloud");
  return render(
    <ConvexProvider client={convex}>
      <MemoryRouter initialEntries={["/mgr/audit"]}>
        <Routes>
          <Route path="/mgr/audit" element={<MgrAudit />} />
          <Route path="/" element={<div data-testid="home-redirect">HOME</div>} />
        </Routes>
      </MemoryRouter>
    </ConvexProvider>,
  );
}

describe("MgrAudit (/mgr/audit)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "m1", name: "Mgr One", role: "manager" },
    };
    mockRows = [ROW];
    lastArgs = null;
    localStorage.setItem(SESSION_KEY, FAKE_SESSION_ID);
  });

  it("renders audit rows for a manager", () => {
    renderRoute();
    expect(screen.getByText("refund.committed")).toBeInTheDocument();
    expect(screen.getAllByText("Mgr One").length).toBeGreaterThan(0);
  });

  it("redirects a non-manager to home", () => {
    mockSessionReturn = {
      sessionId: FAKE_SESSION_ID,
      staff: { _id: "x", name: "Staff", role: "staff" },
    };
    renderRoute();
    expect(screen.getByTestId("home-redirect")).toBeInTheDocument();
  });

  it("passes the action filter to the query", () => {
    renderRoute();
    fireEvent.change(screen.getByTestId("audit-filter"), {
      target: { value: "refund.committed" },
    });
    expect(lastArgs?.action).toBe("refund.committed");
  });

  it("bumps limit on Load more", () => {
    mockRows = Array.from({ length: 100 }, (_, i) => ({ ...ROW, _id: `a${i}` }));
    renderRoute();
    expect(lastArgs?.limit).toBe(100);
    fireEvent.click(screen.getByTestId("audit-load-more"));
    expect(lastArgs?.limit).toBe(200);
  });
});
