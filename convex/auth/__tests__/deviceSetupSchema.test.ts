import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";

describe("pending_device_setups schema — issuance paths", () => {
  it("accepts a Telegram-issued row with no issued_by and an optional from_id", async () => {
    const t = convexTest(schema);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("pending_device_setups", {
        setup_code: "123456",
        issued_via: "telegram",
        issued_by_telegram: { chat_title: "Frollie · Managers" }, // from_id absent (anonymous admin)
        expires_at: Date.now() + 3_600_000,
        consumed_at: null,
      }),
    );
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.issued_via).toBe("telegram");
    expect(row?.issued_by).toBeUndefined();
    expect(row?.issued_by_telegram?.from_id).toBeUndefined();
    expect(row?.issued_by_telegram?.chat_title).toBe("Frollie · Managers");
  });

  it("still accepts a legacy booth-issued row with issued_by set and no issued_via", async () => {
    const t = convexTest(schema);
    const staffId = await t.run(async (ctx) =>
      ctx.db.insert("staff", {
        name: "M", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
      }),
    );
    const id = await t.run(async (ctx) =>
      ctx.db.insert("pending_device_setups", {
        setup_code: "654321",
        issued_by: staffId,
        expires_at: Date.now() + 3_600_000,
        consumed_at: null,
      }),
    );
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.issued_by).toBe(staffId);
    expect(row?.issued_via).toBeUndefined();
  });

  it("accepts a registered_devices row with no activated_by", async () => {
    const t = convexTest(schema);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("registered_devices", {
        device_id: "dev-x", label: "Counter", activated_at: Date.now(), active: true,
      }),
    );
    const row = await t.run(async (ctx) => ctx.db.get(id));
    expect(row?.activated_by).toBeUndefined();
  });
});
