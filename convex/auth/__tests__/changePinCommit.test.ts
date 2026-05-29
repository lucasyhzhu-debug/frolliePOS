import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { internal } from "../../_generated/api";

async function seedStaff(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const staff = await ctx.db.insert("staff", {
      name: "Lucy", pin_hash: "old-hash", role: "staff", active: true, created_at: Date.now(),
    });
    const mgr = await ctx.db.insert("staff", {
      name: "Lucas", pin_hash: "mgr-hash", role: "manager", active: true, created_at: Date.now(),
    });
    return { staff, mgr };
  });
}

describe("_changePinCommit_internal", () => {
  it("actor=self: patches pin_hash, logs staff.pin_changed with actor_id=staff", async () => {
    const t = convexTest(schema);
    const s = await seedStaff(t);
    await t.mutation(internal.auth.internal._changePinCommit_internal, {
      staffId: s.staff, newPinHash: "new-hash", actor: { kind: "self" },
    });
    const after = await t.run((ctx) => ctx.db.get(s.staff));
    expect(after?.pin_hash).toBe("new-hash");
    const audit = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "staff.pin_changed"))
        .collect(),
    );
    expect(audit.length).toBe(1);
    expect(audit[0].actor_id).toBe(s.staff);
  });

  it("actor=manager_reset: patches pin_hash, clears pos_auth_attempts, logs staff.pin_reset with mgr_approver_id", async () => {
    const t = convexTest(schema);
    const s = await seedStaff(t);
    await t.run((ctx) =>
      ctx.db.insert("pos_auth_attempts", {
        staff_id: s.staff, fail_count: 3, locked_until: Date.now() + 60_000,
        last_attempt_at: Date.now(),
      }),
    );
    await t.mutation(internal.auth.internal._changePinCommit_internal, {
      staffId: s.staff, newPinHash: "new-hash",
      actor: { kind: "manager_reset", mgr_approver_id: s.mgr },
    });
    const after = await t.run((ctx) => ctx.db.get(s.staff));
    expect(after?.pin_hash).toBe("new-hash");
    const attempts = await t.run((ctx) =>
      ctx.db.query("pos_auth_attempts")
        .withIndex("by_staff", (q) => q.eq("staff_id", s.staff))
        .collect(),
    );
    expect(attempts.every((a) => a.fail_count === 0 && a.locked_until == null)).toBe(true);
    const audit = await t.run((ctx) =>
      ctx.db.query("audit_log")
        .withIndex("by_action_date", (q) => q.eq("action", "staff.pin_reset"))
        .collect(),
    );
    expect(audit.length).toBe(1);
    expect(audit[0].mgr_approver_id).toBe(s.mgr);
  });
});
