import { expect, it, describe } from "vitest";
import { validateContext, KIND_AUDIT, KIND_TEMPLATE } from "../kinds";

describe("APPROVAL_KINDS registry", () => {
  it("staff_pin_reset has empty context", () => {
    expect(validateContext("staff_pin_reset", undefined)).toEqual({});
  });
  it("manual_payment_override validates + normalizes context", () => {
    const ctx = validateContext("manual_payment_override", {
      txn_id: "t1", amount_idr: 50000, reason: "BCA", extra: "drop me",
    });
    expect(ctx).toEqual({ txn_id: "t1", amount_idr: 50000, reason: "BCA" });
  });
  it("rejects bad manual_payment context", () => {
    expect(() => validateContext("manual_payment_override", { txn_id: "t1", amount_idr: 1.5, reason: "x" }))
      .toThrow(/CONTEXT_INVALID/);
    expect(() => validateContext("manual_payment_override", { txn_id: "t1", amount_idr: 5, reason: "" }))
      .toThrow(/CONTEXT_INVALID/);
  });
  it("exposes audit + template maps per kind", () => {
    expect(KIND_AUDIT.manual_payment_override.resolved).toBe("manual_payment_override.resolved");
    expect(KIND_TEMPLATE.manual_payment_override).toBe("manual_payment_override");
  });
});

describe("shift_override kind", () => {
  const good = {
    shift_id: "shift123", device_id: "dev-1", outlet_label: "Block M",
    stranded_staff_name: "Sasi", shift_started_at: 1782526962094,
    sales_so_far_idr: 385000, txn_count: 5,
  };
  it("accepts a valid context", () => {
    expect(validateContext("shift_override", good)).toMatchObject({
      shift_id: "shift123", device_id: "dev-1", sales_so_far_idr: 385000, txn_count: 5,
    });
  });
  it("rejects empty shift_id", () => {
    expect(() => validateContext("shift_override", { ...good, shift_id: "" })).toThrow(/CONTEXT_INVALID/);
  });
  it("rejects non-integer sales", () => {
    expect(() => validateContext("shift_override", { ...good, sales_so_far_idr: 1.5 })).toThrow(/CONTEXT_INVALID/);
  });
  it("registers audit + template maps", () => {
    expect(KIND_AUDIT.shift_override.requested).toBe("shift_override.requested");
    expect(KIND_TEMPLATE.shift_override).toBe("shift_override");
  });
});
