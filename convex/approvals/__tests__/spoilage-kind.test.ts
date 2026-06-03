import { describe, it, expect } from "vitest";
import { validateContext } from "../kinds";

describe("validateContext spoilage", () => {
  const good = {
    spoilage_event_id: "abc123",
    lines: [{ inventory_sku_id: "sku1", sku_code: "DUBAI", qty: 2 }],
    total_qty: 2,
    reason: "dropped on floor",
  };
  it("accepts well-formed context", () => {
    expect(validateContext("spoilage" as never, good)).toEqual(good);
  });
  it("rejects total_qty mismatch", () => {
    expect(() => validateContext("spoilage" as never, { ...good, total_qty: 99 })).toThrow(/total_qty/);
  });
  it("rejects empty lines", () => {
    expect(() => validateContext("spoilage" as never, { ...good, lines: [], total_qty: 0 })).toThrow(/lines/);
  });
  it("rejects empty reason", () => {
    expect(() => validateContext("spoilage" as never, { ...good, reason: "" })).toThrow(/reason/);
  });
});
