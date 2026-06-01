import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import { seedManagerSession } from "./_helpers";

describe("staff.listStaff", () => {
  it("never returns pin_hash", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Sari",
      pin: "1111",
      role: "staff",
    });
    const rows = await t.query(api.staff.public.listStaff, { sessionId });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).not.toHaveProperty("pin_hash");
  });
});

describe("auth.createStaff (PIN-gated)", () => {
  it("creates a staffer when the manager PIN is correct", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const res = await t.action(api.auth.actions.createStaff, {
      idempotencyKey: "c1", sessionId, name: "Sari", role: "staff",
      pin: "1234", managerPin: "9999",
    });
    expect(res.name).toBe("Sari");
    const rows = await t.query(api.staff.public.listStaff, { sessionId });
    expect(rows.some((r) => r.name === "Sari")).toBe(true);
  });

  it("rejects a wrong manager PIN", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    await expect(
      t.action(api.auth.actions.createStaff, {
        idempotencyKey: "c2", sessionId, name: "Sari", role: "staff",
        pin: "1234", managerPin: "0000",
      }),
    ).rejects.toThrow(/INVALID_PIN/);
  });
});

describe("staff role + name edits", () => {
  it("renames a staffer (session-gated)", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const sId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Sari", pin: "1111", role: "staff",
    });
    await t.mutation(api.staff.public.updateStaffName, {
      idempotencyKey: "n1", sessionId, staffId: sId, name: "Sari W.",
    });
    const rows = await t.query(api.staff.public.listStaff, { sessionId });
    expect(rows.find((r) => r._id === sId)?.name).toBe("Sari W.");
  });

  it("refuses to demote the last active manager", async () => {
    const t = convexTest(schema);
    const { sessionId, managerId } = await seedManagerSession(t);
    await expect(
      t.action(api.staff.actions.setStaffRole, {
        idempotencyKey: "r1", sessionId, staffId: managerId, role: "staff", managerPin: "9999",
      }),
    ).rejects.toThrow(/LAST_ACTIVE_MANAGER/);
  });

  it("promotes a staffer to manager with PIN", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seedManagerSession(t);
    const sId = await t.action(internal.auth.actions._seedHashedStaff_internal, {
      name: "Sari", pin: "1111", role: "staff",
    });
    await t.action(api.staff.actions.setStaffRole, {
      idempotencyKey: "r2", sessionId, staffId: sId, role: "manager", managerPin: "9999",
    });
    const rows = await t.query(api.staff.public.listStaff, { sessionId });
    expect(rows.find((r) => r._id === sId)?.role).toBe("manager");
  });
});
