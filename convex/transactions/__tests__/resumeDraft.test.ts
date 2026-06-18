import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

describe("transactions/public — drafts", () => {
  it("listDrafts returns only status=draft for the session's staff, newest first", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const staff = await ctx.db.insert("staff", {
        name: "L", code: "S-0001", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
      });
      const session = await ctx.db.insert("staff_sessions", {
        staff_id: staff, device_id: "d", started_at: Date.now(),
        ended_at: null, end_reason: null,
      });
      const t1 = await ctx.db.insert("pos_transactions", {
        status: "draft", subtotal: 100, voucher_discount: 0, total: 100,
        flags: 0, staff_id: staff, created_at: Date.now() - 2000,
      });
      const t2 = await ctx.db.insert("pos_transactions", {
        status: "draft", subtotal: 200, voucher_discount: 0, total: 200,
        flags: 0, staff_id: staff, created_at: Date.now() - 1000,
      });
      await ctx.db.insert("pos_transactions", {
        status: "paid", subtotal: 300, voucher_discount: 0, total: 300,
        flags: 0, staff_id: staff, created_at: Date.now(),
      });
      return { session, t1, t2 };
    });

    const drafts = await t.query(api.transactions.public.listDrafts, { sessionId: setup.session });
    expect(drafts.length).toBe(2);
    expect(drafts[0]._id).toBe(setup.t2); // newest first
    expect(drafts[1]._id).toBe(setup.t1);
  });

  it("resumeDraft deletes the draft row and returns its lines", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const staff = await ctx.db.insert("staff", {
        name: "L", code: "S-0001", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
      });
      const session = await ctx.db.insert("staff_sessions", {
        staff_id: staff, device_id: "d", started_at: Date.now(),
        ended_at: null, end_reason: null,
      });
      const product = await ctx.db.insert("pos_products", {
        sku_family: "x", code: "X_1PC", name: "P", pack_label: "1pc", price_idr: 10_000,
        active: true, sort_order: 1, tax_rate: 0,
        created_at: Date.now(), updated_at: Date.now(),
      });
      const draft = await ctx.db.insert("pos_transactions", {
        status: "draft", subtotal: 10_000, voucher_discount: 0, total: 10_000,
        flags: 0, staff_id: staff, created_at: Date.now(),
      });
      await ctx.db.insert("pos_transaction_lines", {
        transaction_id: draft, product_id: product,
        product_code_snapshot: "P", product_name_snapshot: "P",
        unit_price_snapshot: 10_000, tax_rate_snapshot: 0,
        qty: 1, line_subtotal: 10_000,
      });
      return { session, draft };
    });

    const r = await t.mutation(api.transactions.public.resumeDraft, {
      sessionId: setup.session, draftId: setup.draft, idempotencyKey: `k-${Date.now()}`,
    });
    expect(r.lines.length).toBe(1);
    expect(r.lines[0].qty).toBe(1);

    const after = await t.run((ctx) => ctx.db.get(setup.draft));
    expect(after).toBeNull(); // draft row deleted
  });

  it("staffreview T6: race — two concurrent resumeDraft on same draftId, only one succeeds", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const staff = await ctx.db.insert("staff", {
        name: "L", code: "S-0001", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
      });
      const session = await ctx.db.insert("staff_sessions", {
        staff_id: staff, device_id: "d", started_at: Date.now(),
        ended_at: null, end_reason: null,
      });
      const draft = await ctx.db.insert("pos_transactions", {
        status: "draft", subtotal: 100, voucher_discount: 0, total: 100,
        flags: 0, staff_id: staff, created_at: Date.now(),
      });
      return { session, draft };
    });

    // Fire two concurrently with DIFFERENT idempotency keys so cache doesn't mask the race
    const [r1, r2] = await Promise.allSettled([
      t.mutation(api.transactions.public.resumeDraft, {
        sessionId: setup.session, draftId: setup.draft, idempotencyKey: "k-race-1",
      }),
      t.mutation(api.transactions.public.resumeDraft, {
        sessionId: setup.session, draftId: setup.draft, idempotencyKey: "k-race-2",
      }),
    ]);

    const successes = [r1, r2].filter((r) => r.status === "fulfilled").length;
    const failures = [r1, r2].filter((r) => r.status === "rejected").length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);

    const drafts = await t.run((ctx) =>
      ctx.db.query("pos_transactions")
        .withIndex("by_status_created", (q) => q.eq("status", "draft"))
        .collect(),
    );
    expect(drafts.length).toBe(0);
  });

  it("deleteDraft removes draft row and lines", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const staff = await ctx.db.insert("staff", {
        name: "L", code: "S-0001", pin_hash: "x", role: "manager", active: true, created_at: Date.now(),
      });
      const session = await ctx.db.insert("staff_sessions", {
        staff_id: staff, device_id: "d", started_at: Date.now(),
        ended_at: null, end_reason: null,
      });
      const draft = await ctx.db.insert("pos_transactions", {
        status: "draft", subtotal: 0, voucher_discount: 0, total: 0,
        flags: 0, staff_id: staff, created_at: Date.now(),
      });
      return { session, draft };
    });
    await t.mutation(api.transactions.public.deleteDraft, {
      sessionId: setup.session, draftId: setup.draft, idempotencyKey: `k-${Date.now()}`,
    });
    const after = await t.run((ctx) => ctx.db.get(setup.draft));
    expect(after).toBeNull();
  });

  it("C2: another staff member cannot resume a draft they don't own", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("staff", {
        name: "Owner", code: "S-0001", pin_hash: "x", role: "staff", active: true, created_at: Date.now(),
      });
      const intruder = await ctx.db.insert("staff", {
        name: "Intruder", code: "S-0002", pin_hash: "x", role: "staff", active: true, created_at: Date.now(),
      });
      const intruderSession = await ctx.db.insert("staff_sessions", {
        staff_id: intruder, device_id: "d", started_at: Date.now(),
        ended_at: null, end_reason: null,
      });
      const draft = await ctx.db.insert("pos_transactions", {
        status: "draft", subtotal: 100, voucher_discount: 0, total: 100,
        flags: 0, staff_id: owner, created_at: Date.now(),
      });
      return { intruderSession, draft };
    });

    await expect(
      t.mutation(api.transactions.public.resumeDraft, {
        sessionId: setup.intruderSession, draftId: setup.draft, idempotencyKey: "k-intrude-resume",
      }),
    ).rejects.toThrow("NOT_OWNER");

    // Owner's draft survives untouched.
    const after = await t.run((ctx) => ctx.db.get(setup.draft));
    expect(after).not.toBeNull();
  });

  it("C2: another staff member cannot delete a draft they don't own", async () => {
    const t = convexTest(schema);
    const setup = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("staff", {
        name: "Owner", code: "S-0001", pin_hash: "x", role: "staff", active: true, created_at: Date.now(),
      });
      const intruder = await ctx.db.insert("staff", {
        name: "Intruder", code: "S-0002", pin_hash: "x", role: "staff", active: true, created_at: Date.now(),
      });
      const intruderSession = await ctx.db.insert("staff_sessions", {
        staff_id: intruder, device_id: "d", started_at: Date.now(),
        ended_at: null, end_reason: null,
      });
      const draft = await ctx.db.insert("pos_transactions", {
        status: "draft", subtotal: 100, voucher_discount: 0, total: 100,
        flags: 0, staff_id: owner, created_at: Date.now(),
      });
      return { intruderSession, draft };
    });

    await expect(
      t.mutation(api.transactions.public.deleteDraft, {
        sessionId: setup.intruderSession, draftId: setup.draft, idempotencyKey: "k-intrude-delete",
      }),
    ).rejects.toThrow("NOT_OWNER");

    const after = await t.run((ctx) => ctx.db.get(setup.draft));
    expect(after).not.toBeNull();
  });
});
