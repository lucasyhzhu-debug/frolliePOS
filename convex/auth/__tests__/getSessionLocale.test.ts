import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

describe("getSession surfaces locale", () => {
  it("returns staff.locale, defaulting to 'en' when absent", async () => {
    const t = convexTest(schema);
    const { sessionId, staffNoLocale } = await t.run(async (ctx) => {
      const staffNoLocale = await ctx.db.insert("staff", {
        name: "A",
        code: "S-0001",
        role: "staff",
        active: true,
        pin_hash: "x",
        created_at: Date.now(),
      });
      const sessionId = await ctx.db.insert("staff_sessions", {
        staff_id: staffNoLocale,
        device_id: "d1",
        started_at: Date.now(),
        ended_at: null,
        end_reason: null,
      });
      return { sessionId, staffNoLocale };
    });

    const res = await t.query(api.auth.public.getSession, { sessionId });
    expect(res?.staff.locale).toBe("en"); // absent ⇒ default

    await t.run(async (ctx) => ctx.db.patch(staffNoLocale, { locale: "id" }));
    const res2 = await t.query(api.auth.public.getSession, { sessionId });
    expect(res2?.staff.locale).toBe("id");
  });
});
