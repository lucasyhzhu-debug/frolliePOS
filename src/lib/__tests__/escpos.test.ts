import { describe, it, expect } from "vitest";
import { encodeReceipt, SAMPLE_RECEIPT } from "../escpos";

describe("encodeReceipt", () => {
  it("produces bytes and embeds the receipt number + total (paid)", () => {
    const bytes = encodeReceipt(
      SAMPLE_RECEIPT.viewModel,
      SAMPLE_RECEIPT.status,
      SAMPLE_RECEIPT.statusLabel,
      "https://pos.example.com/r/tok_demo",
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(50);
    const text = new TextDecoder("ascii").decode(bytes);
    expect(text).toContain("R-2026-0042");
    expect(text).toContain("LUNAS");
    expect(text).toContain("Rp 325.000");
    expect(text).not.toMatch(/[\u{1F000}-\u{1FAFF}]/u);
  });

  it("starts with the ESC @ init sequence", () => {
    const bytes = encodeReceipt(
      SAMPLE_RECEIPT.viewModel, SAMPLE_RECEIPT.status, SAMPLE_RECEIPT.statusLabel, "https://x/r/t",
    );
    expect(bytes[0]).toBe(0x1b); // ESC
    expect(bytes[1]).toBe(0x40); // @
  });
});
