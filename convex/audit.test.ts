import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

describe("logAudit", () => {
  it("appends an audit row visible via list", async () => {
    const t = convexTest(schema, modules);

    const staffId = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "Citra",
        pin_hash: "$argon2id$dummy",
        role: "staff",
        active: true,
        created_at: Date.now(),
      })
    );

    await t.mutation(internal.audit.__test_log, {
      actor_id: staffId,
      action: "staff.login",
      entity_type: "staff",
      entity_id: staffId,
      source: "booth_inline",
    });

    const rows = await t.query(api.audit.list, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "staff.login",
      entity_type: "staff",
      source: "booth_inline",
    });
  });
});
