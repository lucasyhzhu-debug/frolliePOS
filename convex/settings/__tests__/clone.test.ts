import { convexTest } from "convex-test";
import { test, expect } from "vitest";
import schema from "../../schema";

test("cloneSettingsRow copies source row + applies overrides into target", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const src = await ctx.db.insert("outlets", { code: "SRC", name: "Src", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const tgt = await ctx.db.insert("outlets", { code: "TGT", name: "Tgt", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const owner = await ctx.db.insert("staff", { name: "O", code: "O1", role: "owner", pin_hash: "x", active: true, created_at: 1 } as any);
    await ctx.db.insert("pos_settings", { founders_summary_enabled: true, receipt_business_name: "Frollie SRC", manual_bca_enabled: true, manual_bca_account_number: "111", updated_at: 1, outlet_id: src } as any);

    const { cloneSettingsRow } = await import("../lib");
    await cloneSettingsRow(ctx, { sourceOutletId: src, targetOutletId: tgt, now: 5, ownerStaffId: owner, overrides: { receipt_business_name: "Frollie TGT" } });

    const row = await ctx.db.query("pos_settings").withIndex("by_outlet", (q) => q.eq("outlet_id", tgt)).first();
    expect(row?.receipt_business_name).toBe("Frollie TGT");     // override applied
    expect(row?.manual_bca_account_number).toBe("111");          // copied from source
    expect(row?.updated_by).toBe(owner);
  });
});

test("cloneSettingsRow: explicit undefined overrides do not clobber source values", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    const src = await ctx.db.insert("outlets", { code: "SRC2", name: "Src2", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const tgt = await ctx.db.insert("outlets", { code: "TGT2", name: "Tgt2", timezone: "Asia/Jakarta", active: true, created_at: 1, created_by: null } as any);
    const owner = await ctx.db.insert("staff", { name: "O2", code: "O2", role: "owner", pin_hash: "x", active: true, created_at: 1 } as any);
    // Source has receipt_business_name set — the clone should preserve it when the
    // override value is explicitly `undefined` (not "omitted", but explicitly set).
    await ctx.db.insert("pos_settings", { founders_summary_enabled: true, receipt_business_name: "Keep This", updated_at: 1, outlet_id: src } as any);

    const { cloneSettingsRow } = await import("../lib");
    // Passing receipt_business_name: undefined must NOT clobber the cloned "Keep This" value.
    await cloneSettingsRow(ctx, {
      sourceOutletId: src,
      targetOutletId: tgt,
      now: 5,
      ownerStaffId: owner,
      overrides: { receipt_business_name: undefined },
    });

    const row = await ctx.db.query("pos_settings").withIndex("by_outlet", (q: any) => q.eq("outlet_id", tgt)).first();
    expect(row?.receipt_business_name).toBe("Keep This"); // NOT overwritten by undefined
  });
});
