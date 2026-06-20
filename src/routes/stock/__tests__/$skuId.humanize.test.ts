import { describe, it, expect } from "vitest";
import { humanizeThresholdError } from "@/routes/stock/$skuId";

const t = ((k: string) => k) as never; // identity stub

describe("humanizeThresholdError", () => {
  it("maps MANAGER_ONLY", () =>
    expect(humanizeThresholdError(new Error("MANAGER_ONLY"), t)).toBe("stockDetail.errManagerOnly"));
  it("maps NON_INTEGER_THRESHOLD", () =>
    expect(humanizeThresholdError(new Error("NON_INTEGER_THRESHOLD"), t)).toBe("stockDetail.errInvalidValue"));
  it("maps NEGATIVE_THRESHOLD", () =>
    expect(humanizeThresholdError(new Error("NEGATIVE_THRESHOLD"), t)).toBe("stockDetail.errInvalidValue"));
  it("falls back", () =>
    expect(humanizeThresholdError(new Error("???"), t)).toBe("stockDetail.errSaveFailed"));
});
