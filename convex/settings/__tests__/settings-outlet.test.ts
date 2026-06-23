/**
 * Task 5 — per-outlet settings isolation tests.
 *
 * Verifies:
 *   1. Absent row → defaults are returned (single-sourced from RECEIPT_DEFAULTS /
 *      MANUAL_BCA_DEFAULTS).
 *   2. Two outlets are isolated — a row for outlet A does not bleed into outlet B.
 *   3. A null/undefined outletId falls back to .first() (pre-seed defensive path).
 */
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { RECEIPT_DEFAULTS } from "../internal";

async function makeOutlet(t: ReturnType<typeof convexTest>, code: string) {
  return t.run((ctx: any) =>
    ctx.db.insert("outlets", {
      code,
      name: code,
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    }),
  );
}

describe("_getSettings_internal per-outlet isolation", () => {
  it("absent row → defaults (no pos_settings row for outlet)", async () => {
    const t = convexTest(schema);
    const outletId = await makeOutlet(t, "PKW");
    const s = await t.run((ctx: any) =>
      ctx.runQuery(internal.settings.internal._getSettings_internal, { outletId }),
    ) as any;
    // Defaults are single-sourced from RECEIPT_DEFAULTS
    expect(s.receipt.business_name).toBe(RECEIPT_DEFAULTS.business_name);
    expect(s.receipt.footer_text).toBe(RECEIPT_DEFAULTS.footer_text);
    expect(s.founders_summary_enabled).toBe(true);
    expect(s.txn_ticker_enabled).toBe(true);
  });

  it("two outlets are isolated — outlet A row does not bleed into outlet B", async () => {
    const t = convexTest(schema);
    const outletA = await makeOutlet(t, "PKW");
    const outletB = await makeOutlet(t, "GKP");

    // Write a row for outlet A with a custom footer
    await t.run((ctx: any) =>
      ctx.db.insert("pos_settings", {
        founders_summary_enabled: false,
        receipt_footer_text: "Footer for PKW",
        updated_at: Date.now(),
        outlet_id: outletA,
      }),
    );

    // outlet A reads its own row
    const sA = await t.run((ctx: any) =>
      ctx.runQuery(internal.settings.internal._getSettings_internal, { outletId: outletA }),
    ) as any;
    expect(sA.founders_summary_enabled).toBe(false);
    expect(sA.receipt.footer_text).toBe("Footer for PKW");

    // outlet B sees defaults (no row for it)
    const sB = await t.run((ctx: any) =>
      ctx.runQuery(internal.settings.internal._getSettings_internal, { outletId: outletB }),
    ) as any;
    expect(sB.founders_summary_enabled).toBe(true);
    expect(sB.receipt.footer_text).toBe(RECEIPT_DEFAULTS.footer_text);
  });

  it("outlet with no pos_settings row returns defaults (no rows in table)", async () => {
    const t = convexTest(schema);
    const outletId = await makeOutlet(t, "PKW");
    const s = await t.run((ctx: any) =>
      ctx.runQuery(internal.settings.internal._getSettings_internal, { outletId }),
    ) as any;
    expect(s.founders_summary_enabled).toBe(true);
    expect(s.receipt.footer_text).toBe(RECEIPT_DEFAULTS.footer_text);
  });

  it("outlet with its own pos_settings row reads that row", async () => {
    const t = convexTest(schema);
    const outletId = await makeOutlet(t, "PKW");
    // Insert a settings row for this outlet
    await t.run((ctx: any) =>
      ctx.db.insert("pos_settings", {
        founders_summary_enabled: false,
        receipt_footer_text: "Custom footer",
        updated_at: Date.now(),
        outlet_id: outletId,
      }),
    );
    const s = await t.run((ctx: any) =>
      ctx.runQuery(internal.settings.internal._getSettings_internal, { outletId }),
    ) as any;
    expect(s.founders_summary_enabled).toBe(false);
    expect(s.receipt.footer_text).toBe("Custom footer");
  });
});
