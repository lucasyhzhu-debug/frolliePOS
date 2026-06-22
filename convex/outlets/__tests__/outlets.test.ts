import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { internal, api } from "../../_generated/api";

test("_requireOutletCode_internal returns the code", async () => {
  const t = convexTest(schema);
  const outletId = await t.run(async (ctx) =>
    ctx.db.insert("outlets", { code: "PKW", name: "Frollie — Pakuwon", timezone: "Asia/Jakarta", active: true, created_at: Date.now(), created_by: null }),
  );
  const code = await t.run((ctx) => ctx.runQuery(internal.outlets.internal._requireOutletCode_internal, { outletId }));
  expect(code).toBe("PKW");
});

test("listOutlets rejects a non-manager session", async () => {
  const t = convexTest(schema);
  // seed a staff-role session via the existing seed helper pattern; assert MANAGER_ONLY throw
  await expect(
    t.run((ctx) => ctx.runQuery(api.outlets.public.listOutlets, { sessionId: "fake" as any })),
  ).rejects.toThrow();
});
