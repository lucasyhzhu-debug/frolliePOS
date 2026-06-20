import { describe, it, expect } from "vitest";
import { encodeReceipt, instagramUrl, SAMPLE_RECEIPT } from "../escpos";

describe("encodeReceipt", () => {
  it("produces bytes and embeds the receipt number + total (paid)", () => {
    const bytes = encodeReceipt(
      SAMPLE_RECEIPT.viewModel,
      SAMPLE_RECEIPT.status,
      SAMPLE_RECEIPT.statusLabel,
    );
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(50);
    const text = new TextDecoder("ascii").decode(bytes);
    expect(text).toContain("R-2026-0042");
    expect(text).toContain("LUNAS");
    // Money formatted via src/lib/format.rp (no floats):
    expect(text).toContain("Rp 325.000");
    // Footer follow caption derives from the instagram_handle setting:
    expect(text).toContain("Follow @frollie.id");
    // Footer default is the English "Thank you!" (v1.2 #13):
    expect(text).toContain("Thank you!");
  });

  it("starts with the ESC @ init sequence", () => {
    const bytes = encodeReceipt(
      SAMPLE_RECEIPT.viewModel, SAMPLE_RECEIPT.status, SAMPLE_RECEIPT.statusLabel,
    );
    expect(bytes[0]).toBe(0x1b); // ESC
    expect(bytes[1]).toBe(0x40); // @
  });

  it("omits the address line when the setting is blank", () => {
    const vm = { ...SAMPLE_RECEIPT.viewModel, settings: { ...SAMPLE_RECEIPT.viewModel.settings, address: "" } };
    const text = new TextDecoder("ascii").decode(encodeReceipt(vm, "paid", "LUNAS"));
    expect(text).not.toContain("Pakuwon");
  });
});

describe("instagramUrl", () => {
  it("derives a full URL from an @handle", () => {
    expect(instagramUrl("@frollie.id")).toBe("https://www.instagram.com/frollie.id/");
  });
  it("derives from a bare handle", () => {
    expect(instagramUrl("frollie.id")).toBe("https://www.instagram.com/frollie.id/");
  });
  it("passes through an explicit URL unchanged", () => {
    expect(instagramUrl("https://linktr.ee/frollie")).toBe("https://linktr.ee/frollie");
  });
  it("returns null for an empty or @-only handle", () => {
    expect(instagramUrl("")).toBeNull();
    expect(instagramUrl("  @  ")).toBeNull();
  });
});
