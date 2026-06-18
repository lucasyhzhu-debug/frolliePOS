import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import * as reportOpsModule from "@/lib/reportOps";

// Mock react-router's error/location hooks so we can drive the boundary
// directly without standing up a full router (idiom: partial-mock, override
// only the hooks under test).
const mockError = { current: undefined as unknown };
vi.mock("react-router", () => ({
  useRouteError: () => mockError.current,
  useLocation: () => ({ pathname: "/sale" }),
}));

import { RouteErrorBoundary } from "../RouteErrorBoundary";

const CHUNK_ERR = new Error("Failed to fetch dynamically imported module: /assets/sale-abc.js");

function setOnline(online: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
}

describe("RouteErrorBoundary chunk-load reload guard", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    reload = vi.fn();
    // window.location.reload is non-configurable in jsdom — redefine it.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
  });

  afterEach(() => {
    setOnline(true);
    mockError.current = undefined;
  });

  it("reloads once on a chunk-load error when online", () => {
    setOnline(true);
    mockError.current = CHUNK_ERR;
    render(<RouteErrorBoundary />);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload on a chunk-load error when offline — shows the fallback", () => {
    setOnline(false);
    mockError.current = CHUNK_ERR;
    render(<RouteErrorBoundary />);
    expect(reload).not.toHaveBeenCalled();
    // Falls through to the friendly fallback instead of a browser error page.
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  it("does NOT reload for a non-chunk error (renders fallback) regardless of connectivity", () => {
    setOnline(true);
    mockError.current = new Error("some unrelated runtime error");
    render(<RouteErrorBoundary />);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });
});

describe("RouteErrorBoundary reportOps wiring", () => {
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sessionStorage.clear();
    reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
  });

  afterEach(() => {
    setOnline(true);
    mockError.current = undefined;
    vi.restoreAllMocks();
  });

  it("reports a genuine (non-chunk) crash via reportOps exactly once", () => {
    setOnline(true);
    const spy = vi.spyOn(reportOpsModule, "reportOps").mockImplementation(() => {});
    const err = new Error("genuine runtime crash");
    mockError.current = err;
    const { rerender } = render(<RouteErrorBoundary />);
    // Re-render with the same error should NOT double-report.
    rerender(<RouteErrorBoundary />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "crash", error: err }),
    );
  });

  it("does NOT call reportOps for a chunk-load error", () => {
    setOnline(false); // offline so it doesn't reload, falls through to fallback
    const spy = vi.spyOn(reportOpsModule, "reportOps").mockImplementation(() => {});
    mockError.current = CHUNK_ERR;
    render(<RouteErrorBoundary />);
    expect(spy).not.toHaveBeenCalled();
  });
});
