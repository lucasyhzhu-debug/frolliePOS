import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

describe("_recordError_internal", () => {
  it("writes a row and marks first occurrence alerted", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.ops.internal._recordError_internal, {
      kind: "crash", message: "boom", route: "/sale",
    });
    const rows = await t.run(async (ctx) => ctx.db.query("pos_error_reports").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].alerted).toBe(true);
    expect(rows[0].signature).toBeTruthy();
  });

  it("dedupes same signature within window (second row not alerted)", async () => {
    const t = convexTest(schema);
    const args = { kind: "crash" as const, message: "boom", route: "/sale" };
    await t.mutation(internal.ops.internal._recordError_internal, args);
    await t.mutation(internal.ops.internal._recordError_internal, args);
    const rows = await t.run(async (ctx) => ctx.db.query("pos_error_reports").collect());
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.alerted)).toHaveLength(1);
  });

  it("storm-caps distinct signatures within cooldown", async () => {
    const t = convexTest(schema);
    await t.mutation(internal.ops.internal._recordError_internal, { kind: "crash", message: "boom-a" });
    await t.mutation(internal.ops.internal._recordError_internal, { kind: "crash", message: "boom-b" });
    const rows = await t.run(async (ctx) => ctx.db.query("pos_error_reports").collect());
    // distinct signatures, but second within 10s global cooldown → not alerted
    expect(rows.filter((r) => r.alerted)).toHaveLength(1);
  });
});
