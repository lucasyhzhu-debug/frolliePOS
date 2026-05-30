import { describe, expect, test } from "vitest";
import {
  escapeHtml,
  formatIdr,
  renderManualPaymentApproval,
  renderFoundersSummary,
  renderStaffPinReset,
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

describe("renderManualPaymentApproval", () => {
  test("renders amount, requester, reason with URL button", () => {
    const result = renderManualPaymentApproval({
      amount_idr: 50000,
      reason: "<bad> & evil",
      requester_name: "Lucy",
      approve_url: "https://pos.dev/approve/tok",
    });
    expect(result.text).toContain("Manual payment approval");
    expect(result.text).toContain("Rp 50.000");
    expect(result.text).toContain("Lucy");
    expect(result.text).toContain("&lt;bad&gt; &amp; evil");
    expect(result.inline_keyboard).toEqual([
      [{ text: "Open approval →", url: "https://pos.dev/approve/tok" }],
    ]);
  });

  test("escapes requester name", () => {
    const result = renderManualPaymentApproval({
      amount_idr: 1,
      reason: "x",
      requester_name: "<hacker>",
      approve_url: "https://x",
    });
    expect(result.text).toContain("&lt;hacker&gt;");
    expect(result.text).not.toContain("<hacker>");
  });
});

describe("renderFoundersSummary", () => {
  test("produces formatted text with sales, txn count, flagged", () => {
    const result = renderFoundersSummary({
      dateLabel: "Selasa, 27 Mei",
      totalSalesIdr: 4275000,
      txnCount: 42,
      flaggedCount: 3,
    });
    expect(result.text).toContain("Selasa, 27 Mei");
    expect(result.text).toContain("Rp 4.275.000");
    expect(result.text).toContain("42");
    expect(result.text).toContain("3");
    expect(result.inline_keyboard).toBeUndefined();
  });

  test("escapes the dateLabel", () => {
    const result = renderFoundersSummary({
      dateLabel: "<test>",
      totalSalesIdr: 1,
      txnCount: 1,
      flaggedCount: 0,
    });
    expect(result.text).toContain("&lt;test&gt;");
    expect(result.text).not.toContain("<test>");
  });
});

describe("renderStaffPinReset", () => {
  test("renders HTML with staff name, code, locked-at, link", () => {
    const r = renderStaffPinReset({
      staff_name: "Lucy",
      staff_code: "S-0042",
      locked_at_iso: "2026-05-27T07:23:00Z",
      request_url: "https://pos.dev/approve/abc123",
    });
    expect(r.text).toContain("Lucy");
    expect(r.text).toContain("S-0042");
    expect(r.text).toContain("Tap to reset PIN");
    expect(r.text).toContain("https://pos.dev/approve/abc123");
    expect(r.text).toContain("60 minutes");
  });

  test("HTML-escapes staff name to prevent injection", () => {
    const r = renderStaffPinReset({
      staff_name: "<script>alert(1)</script>",
      staff_code: "S-9",
      locked_at_iso: "2026-05-27T07:23:00Z",
      request_url: "https://pos.dev/approve/x",
    });
    expect(r.text).not.toContain("<script>");
    expect(r.text).toContain("&lt;script&gt;");
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
