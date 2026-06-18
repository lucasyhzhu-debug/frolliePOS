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
});
