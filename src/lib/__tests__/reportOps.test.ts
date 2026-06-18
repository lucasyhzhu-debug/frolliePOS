import { describe, it, expect, vi, beforeEach } from "vitest";
import { opsEndpoint } from "../reportOps";

describe("opsEndpoint", () => {
  it("swaps .cloud → .site and appends /ops/error", () => {
    expect(opsEndpoint("https://savory-zebra-800.convex.cloud"))
      .toBe("https://savory-zebra-800.convex.site/ops/error");
  });
  it("is a no-op-safe transform for already-.site urls", () => {
    expect(opsEndpoint("https://x.convex.site")).toBe("https://x.convex.site/ops/error");
  });
  it("strips trailing slash before appending path", () => {
    expect(opsEndpoint("https://savory-zebra-800.convex.cloud/"))
      .toBe("https://savory-zebra-800.convex.site/ops/error");
  });
});

describe("reportOps", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not throw when called with a plain Error", async () => {
    // Import dynamically so env vars are already set by vitest.config define
    const { reportOps } = await import("../reportOps");
    expect(() => reportOps({ kind: "crash", error: new Error("boom") })).not.toThrow();
  });

  it("does not throw when called with a non-Error value", async () => {
    const { reportOps } = await import("../reportOps");
    expect(() => reportOps({ kind: "unhandled", error: "string error" })).not.toThrow();
  });

  it("does not throw when called with null", async () => {
    const { reportOps } = await import("../reportOps");
    expect(() => reportOps({ kind: "payment", error: null })).not.toThrow();
  });

  it("POSTs to the .site endpoint with kind/message/route + x-ops-token + keepalive", async () => {
    vi.stubEnv("VITE_CONVEX_URL", "https://savory-zebra-800.convex.cloud");
    vi.stubEnv("VITE_OPS_INGEST_TOKEN", "test-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { reportOps } = await import("../reportOps");
    // Unique message so the in-memory client dedup can't suppress this call.
    reportOps({ kind: "crash", error: new Error("boom-shape-test"), route: "/sale" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://savory-zebra-800.convex.site/ops/error");
    expect(opts.keepalive).toBe(true);
    expect(opts.headers["x-ops-token"]).toBe("test-token");
    const body = JSON.parse(opts.body as string);
    expect(body.kind).toBe("crash");
    expect(body.message).toBe("boom-shape-test");
    expect(body.route).toBe("/sale");

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is a no-op (no fetch) when the ops token is absent", async () => {
    vi.stubEnv("VITE_CONVEX_URL", "https://savory-zebra-800.convex.cloud");
    vi.stubEnv("VITE_OPS_INGEST_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { reportOps } = await import("../reportOps");
    reportOps({ kind: "crash", error: new Error("no-token-test"), route: "/sale" });

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});
