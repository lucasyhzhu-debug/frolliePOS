import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";
import { seedManagerSession } from "../../staff/__tests__/_helpers";

describe("settings.receiptConfig", () => {
  it("returns defaults when no row exists", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const cfg = await t.query(api.settings.public.getReceiptConfig, { sessionId });
    expect(cfg.business_name).toBe("FROLLIE");
    expect(cfg.logo_url).toBeNull();
  });

  it("persists an update and reads it back", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await t.mutation(api.settings.public.updateReceiptConfig, {
      idempotencyKey: "rc1",
      sessionId,
      business_name: "Frollie Booth",
      address: "Pakuwon",
      contact: "+62 8...",
      instagram_handle: "@frollie.id",
      footer_text: "Makasih!",
    });
    const cfg = await t.query(api.settings.public.getReceiptConfig, { sessionId });
    expect(cfg.business_name).toBe("Frollie Booth");
    expect(cfg.footer_text).toBe("Makasih!");
  });
});
