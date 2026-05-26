import { describe, expect, test } from "vitest";
import {
  escapeHtml,
  formatIdr,
  renderApproval,
  renderShiftSummary,
  renderCustom,
  makeNonce,
} from "./telegramHtml";

describe("escapeHtml", () => {
  test("escapes ampersand first to avoid double-encoding", () => {
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  test("escapes less-than and greater-than", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  test("leaves other characters alone (single quotes, double quotes, slashes, unicode)", () => {
    expect(escapeHtml("It's \"fine\" — Citra/Bayu — ✅")).toBe(
      "It's \"fine\" — Citra/Bayu — ✅",
    );
  });

  test("escapes combined edge case", () => {
    expect(escapeHtml("<a href=\"x\">&copy;</a>")).toBe(
      "&lt;a href=\"x\"&gt;&amp;copy;&lt;/a&gt;",
    );
  });
});

describe("formatIdr", () => {
  test("formats integers with id-ID thousands separator (dots)", () => {
    expect(formatIdr(50000)).toBe("50.000");
    expect(formatIdr(4275000)).toBe("4.275.000");
  });

  test("rounds non-integers", () => {
    expect(formatIdr(49999.7)).toBe("50.000");
  });
});

describe("renderApproval", () => {
  test("includes escaped reason and Approve/Deny buttons with shared nonce", () => {
    const result = renderApproval(
      { action_type: "refund", amount_idr: 50000, reason: "<bad> & evil" },
      "deadbeef",
    );
    expect(result.text).toContain("Refund approval");
    expect(result.text).toContain("Rp 50.000");
    expect(result.text).toContain("&lt;bad&gt; &amp; evil");
    expect(result.inline_keyboard).toEqual([
      [
        { text: "Approve ✅", callback_data: "approve:deadbeef" },
        { text: "Deny ❌", callback_data: "deny:deadbeef" },
      ],
    ]);
  });

  test("uses correct action label for manual_pay and neg_stock", () => {
    expect(
      renderApproval({ action_type: "manual_pay", amount_idr: 1, reason: "x" }, "n").text,
    ).toContain("Manual payment override");
    expect(
      renderApproval({ action_type: "neg_stock", amount_idr: 1, reason: "x" }, "n").text,
    ).toContain("Negative stock acknowledgment");
  });
});

describe("renderShiftSummary", () => {
  test("produces formatted text and NO inline_keyboard (one-way)", () => {
    const result = renderShiftSummary({
      staff_name: "Citra",
      sales_idr: 4275000,
      txn_count: 42,
      hours: 8,
    });
    expect(result.text).toContain("Citra · shift closed");
    expect(result.text).toContain("Rp 4.275.000");
    expect(result.text).toContain("42");
    expect(result.text).toContain("8.0");
    expect(result.inline_keyboard).toBeUndefined();
  });

  test("escapes the staff name", () => {
    const result = renderShiftSummary({
      staff_name: "<bobby>",
      sales_idr: 1,
      txn_count: 1,
      hours: 1,
    });
    expect(result.text).toContain("&lt;bobby&gt;");
    expect(result.text).not.toContain("<bobby>");
  });
});

describe("renderCustom", () => {
  test("escapes text and omits buttons when include_buttons is false", () => {
    const result = renderCustom({ text: "<x>", include_buttons: false }, "n");
    expect(result.text).toBe("&lt;x&gt;");
    expect(result.inline_keyboard).toBeUndefined();
  });

  test("attaches test buttons when include_buttons is true", () => {
    const result = renderCustom({ text: "hi", include_buttons: true }, "abc");
    expect(result.inline_keyboard).toEqual([
      [
        { text: "Test A", callback_data: "test_a:abc" },
        { text: "Test B", callback_data: "test_b:abc" },
      ],
    ]);
  });
});

describe("makeNonce", () => {
  test("produces 8-character lowercase hex", () => {
    const nonce = makeNonce();
    expect(nonce).toMatch(/^[0-9a-f]{8}$/);
  });

  test("is non-deterministic across calls", () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).not.toBe(b);
  });
});
