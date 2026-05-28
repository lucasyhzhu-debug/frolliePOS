import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

describe("seed/actions.bootstrap", () => {
  it("first call creates Lucas as S-0001, role manager, with hashed PIN 1111", async () => {
    const t = convexTest(schema);
    const r = await t.action(internal.seed.actions.bootstrap, {});
    expect(r.staffCode).toBe("S-0001");
    const lucas = await t.run((ctx) => ctx.db.get(r.staffId as Id<"staff">));
    expect(lucas?.name).toBe("Lucas");
    expect(lucas?.role).toBe("manager");
    expect(lucas?.pin_hash.startsWith("$argon2id$")).toBe(true);
  });

  it("refuses to run when staff table is non-empty", async () => {
    const t = convexTest(schema);
    await t.run((ctx) => ctx.db.insert("staff", {
      name: "X", pin_hash: "x", role: "staff", active: true, created_at: Date.now(),
    }));
    await expect(t.action(internal.seed.actions.bootstrap, {})).rejects.toThrow(/already_bootstrapped/);
  });

  it("logs staff.bootstrapped audit row with actor_id=system", async () => {
    const t = convexTest(schema);
    await t.action(internal.seed.actions.bootstrap, {});
    const audit = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "staff.bootstrapped"))
        .collect(),
    );
    expect(audit.length).toBe(1);
    expect(audit[0].actor_id).toBe("system");
  });
});
