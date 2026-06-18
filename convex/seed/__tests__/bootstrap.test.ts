import { describe, it, expect, beforeEach } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import { Id } from "../../_generated/dataModel";

describe("seed/actions.bootstrap", () => {
  // SEC-03: bootstrap now requires BOOTSTRAP_MANAGER_PIN. Set a valid default
  // for the existing behavioural tests; the SEC-03 block below toggles it.
  beforeEach(() => {
    process.env.BOOTSTRAP_MANAGER_PIN = "1234";
  });

  it("first call creates Lucas as S-0001, role manager, with hashed PIN", async () => {
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

describe("SEC-03: bootstrap env PIN", () => {
  it("throws when BOOTSTRAP_MANAGER_PIN is absent", async () => {
    const t = convexTest(schema);
    delete process.env.BOOTSTRAP_MANAGER_PIN;
    await expect(t.action(internal.seed.actions.bootstrap, {})).rejects.toThrow("BOOTSTRAP_PIN_REQUIRED");
  });

  it("throws when BOOTSTRAP_MANAGER_PIN is not 4 digits", async () => {
    const t = convexTest(schema);
    process.env.BOOTSTRAP_MANAGER_PIN = "abc";
    await expect(t.action(internal.seed.actions.bootstrap, {})).rejects.toThrow("BOOTSTRAP_PIN_REQUIRED");
  });

  it("seeds manager with must_change_pin=true using the env PIN", async () => {
    const t = convexTest(schema);
    process.env.BOOTSTRAP_MANAGER_PIN = "8642";
    await t.action(internal.seed.actions.bootstrap, {});
    const mgr = await t.run((ctx) =>
      ctx.db.query("staff").withIndex("by_code", (q) => q.eq("code", "S-0001")).unique());
    expect(mgr?.must_change_pin).toBe(true);
  });
});
