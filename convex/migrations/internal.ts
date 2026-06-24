// convex/migrations/internal.ts
//
// Stream 9, Steps 0 & 2 — seed default outlet + batched idempotent backfill.
//
// ── Why this module ─────────────────────────────────────────────────────────
// v2.0 adds `outlet_id` to every OUTLET_SCOPED table. Existing rows (dev and
// prod) have no `outlet_id`. This module:
//   1. Seeds the single default outlet ("Frollie — Pakuwon", code "PKW").
//   2. Back-fills outlet_id on all OUTLET_SCOPED rows (where absent) using
//      paginate + per-page mutations so the job is resumable across Convex
//      action time limits.
//   3. Provides an assertion helper to verify the backfill is complete.
//
// ── Exclusion list (C1, CRITICAL) ──────────────────────────────────────────
// The following tables are NEVER touched by the backfill. They are either:
//   - infrastructure/financial (pos_settlements, audit_log, api_*,
//     pos_idempotency, pos_device_activation_attempts)
//   - telegram infra (telegram_log, telegramUpdates, telegramChats)
//   - staff-master and setup tables that are multi-outlet by nature or do
//     not carry outlet context (staff, pending_device_setups)
//
// ── Idempotency ─────────────────────────────────────────────────────────────
// Every page mutation checks `if (row.outlet_id != null) continue` before
// patching. Re-running the backfill is always safe.
//
// ── Order ──────────────────────────────────────────────────────────────────
// staff_sessions are stamped FIRST (before any reader could rely on the field).
// Then all other OUTLET_SCOPED tables. staff_outlet_access rows are inserted
// (not patched — they are a junction table, not a backfill of an existing field).
//
// ── ESLint ─────────────────────────────────────────────────────────────────
// This module is in OUTLET_FENCE_ALLOWLIST and ALLOWLIST — it legitimately
// performs full-table scans for migration purposes; the eslint fence is
// intentionally bypassed for this module only.

import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { logAudit } from "../audit/internal";

// ── Page size for all paginate calls ────────────────────────────────────────
const PAGE_SIZE = 100;

// ─── seedDefaultOutlet ───────────────────────────────────────────────────────

/**
 * Idempotent: if an outlet with code "PKW" already exists, return its _id.
 * Otherwise insert the default Pakuwon outlet and return the new _id.
 *
 * Safe to call multiple times — will never create a second PKW row.
 *
 * Run command (dev):  `npx convex run migrations/internal:seedDefaultOutlet`
 * Run command (prod): `npx convex run migrations/internal:seedDefaultOutlet --prod`
 */
export const seedDefaultOutlet = internalMutation({
  args: {},
  handler: async (ctx): Promise<Id<"outlets">> => {
    const existing = await ctx.db
      .query("outlets")
      .withIndex("by_code", (q) => q.eq("code", "PKW"))
      .first();
    if (existing) return existing._id;

    return ctx.db.insert("outlets", {
      code: "PKW",
      name: "Frollie — Pakuwon", // em-dash
      timezone: "Asia/Jakarta",
      active: true,
      created_at: Date.now(),
      created_by: null,
    });
  },
});

// ─── stripLegacyOutletDeviceId ───────────────────────────────────────────────

/**
 * One-off cleanup of the retired PR#124 `outlet_device_id` field on pos_settings.
 *
 * v2.0 dropped the field from the schema validator, but the existing prod row
 * still carried it — which blocked the schema push ("extra field"). The field is
 * re-tolerated as v.optional in settings/schema.ts so the deploy succeeds; this
 * mutation strips it from every pos_settings row (patch field → undefined removes
 * it) so the Task-12 enforce PR can drop the validator line cleanly.
 *
 * Idempotent (skips rows that no longer have the field). Returns rows stripped.
 *
 * v2.0 Task 12 (ENFORCE): the `outlet_device_id` validator line is now dropped
 * from settings/schema.ts (prod data was already cleared by this migration), so
 * the field is no longer on the typed Doc. We retain this function as a defensive
 * idempotent sweep — accessing the legacy field via an `unknown` cast and
 * patching with a cast literal, since TS no longer models it. Kept for break-glass
 * re-run / historical reference.
 *
 * Run command (prod): `npx convex run migrations/internal:stripLegacyOutletDeviceId --prod`
 */
export const stripLegacyOutletDeviceId = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const rows = await ctx.db.query("pos_settings").collect();
    let stripped = 0;
    for (const r of rows) {
      if ((r as unknown as { outlet_device_id?: string }).outlet_device_id !== undefined) {
        await ctx.db.patch(r._id, { outlet_device_id: undefined } as unknown as Partial<typeof r>);
        stripped++;
      }
    }
    return stripped;
  },
});

// ─── _stampPage_internal ────────────────────────────────────────────────────

/**
 * Per-page mutation that stamps outlet_id on a batch of document IDs.
 * Skips rows that already have an outlet_id (idempotent).
 * Used by backfillOutletId for every OUTLET_SCOPED table page.
 */
export const _stampPage_internal = internalMutation({
  args: {
    table: v.string(),
    docIds: v.array(v.string()),
    outletId: v.id("outlets"),
  },
  handler: async (ctx, { table: _table, docIds, outletId }): Promise<number> => {
    let stamped = 0;
    for (const rawId of docIds) {
      const id = rawId as Id<any>;
      const row = await ctx.db.get(id);
      if (!row) continue;
      if ((row as any).outlet_id != null) continue; // already stamped — skip
      await ctx.db.patch(id as any, { outlet_id: outletId } as any);
      stamped++;
    }
    return stamped;
  },
});

// ─── _saveCursor_internal ────────────────────────────────────────────────────

/**
 * Upsert the migration cursor for a given migration name.
 * `cursor` is null to start from the beginning; a string to resume.
 * `done` stamps completed_at.
 */
export const _saveCursor_internal = internalMutation({
  args: {
    name: v.string(),
    cursor: v.union(v.string(), v.null()),
    done: v.optional(v.boolean()),
  },
  handler: async (ctx, { name, cursor, done }): Promise<void> => {
    const now = Date.now();
    const existing = await ctx.db
      .query("migration_state")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        cursor,
        updated_at: now,
        ...(done ? { completed_at: now } : {}),
      });
    } else {
      await ctx.db.insert("migration_state", {
        name,
        cursor,
        created_at: now,
        updated_at: now,
        ...(done ? { completed_at: now } : {}),
      });
    }
  },
});

// ─── _insertStaffOutletAccess_internal ──────────────────────────────────────

/**
 * For each active staff member, insert a staff_outlet_access row linking them
 * to the default outlet — if no row already exists (by_staff_outlet index).
 * Idempotent. Called once during backfill.
 */
export const _insertStaffOutletAccess_internal = internalMutation({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }): Promise<number> => {
    const allStaff = await ctx.db
      .query("staff")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    let inserted = 0;
    for (const s of allStaff) {
      const existing = await ctx.db
        .query("staff_outlet_access")
        .withIndex("by_staff_outlet", (q) =>
          q.eq("staff_id", s._id).eq("outlet_id", outletId),
        )
        .first();
      if (existing) continue;
      await ctx.db.insert("staff_outlet_access", {
        staff_id: s._id,
        outlet_id: outletId,
        granted_at: Date.now(),
        granted_by: null,
      });
      inserted++;
    }
    return inserted;
  },
});

// ─── _stampSingletons_internal ──────────────────────────────────────────────

/**
 * Stamp the singleton tables: pos_settings and pos_recount_state.
 * These have at most 1 row (legacy singleton design) — no paginate needed.
 * Idempotent: skips rows that already have outlet_id.
 */
export const _stampSingletons_internal = internalMutation({
  args: { outletId: v.id("outlets") },
  handler: async (ctx, { outletId }): Promise<void> => {
    // pos_settings singleton
    const settings = await ctx.db.query("pos_settings").first();
    if (settings && settings.outlet_id == null) {
      await ctx.db.patch(settings._id, { outlet_id: outletId });
    }

    // pos_recount_state singleton(s) — was singleton, now one-per-outlet post v2.0
    const recountRows = await ctx.db.query("pos_recount_state").collect();
    for (const r of recountRows) {
      if (r.outlet_id == null) {
        await ctx.db.patch(r._id, { outlet_id: outletId });
      }
    }
  },
});

// ─── _stampRegisteredDevices_internal ───────────────────────────────────────

/**
 * Stamp registered_devices rows (not in OUTLET_SCOPED but listed in brief).
 * Full-table scan via paginate is not strictly needed for devices (typically
 * 1-5 rows in prod), but we use consistent paginate pattern for safety.
 * Idempotent.
 */
export const _stampRegisteredDevices_internal = internalMutation({
  args: { docIds: v.array(v.string()), outletId: v.id("outlets") },
  handler: async (ctx, { docIds, outletId }): Promise<number> => {
    let stamped = 0;
    for (const rawId of docIds) {
      const row = await ctx.db.get(rawId as Id<"registered_devices">);
      if (!row) continue;
      if (row.outlet_id != null) continue;
      await ctx.db.patch(row._id, { outlet_id: outletId });
      stamped++;
    }
    return stamped;
  },
});

// ─── backfillOutletId ────────────────────────────────────────────────────────

/**
 * Main backfill action — stamps outlet_id = <default outlet> on every
 * OUTLET_SCOPED table row where it is absent.
 *
 * NEVER touches the exclusion-list tables:
 *   pos_settlements, audit_log, api_tokens, api_rate_buckets,
 *   api_request_log, pos_idempotency, pos_device_activation_attempts,
 *   telegram_log, telegramUpdates, telegramChats, staff,
 *   pending_device_setups
 *
 * Order:
 *   1. staff_sessions (must be stamped before any reader relies on outlet_id)
 *   2. All other OUTLET_SCOPED tables (paginated)
 *   3. staff_outlet_access (insert, not patch)
 *   4. pos_settings + pos_recount_state singletons
 *   5. registered_devices
 *
 * Resumable: the migration_state cursor is persisted per-table.
 *
 * Run command (dev):  `npx convex run migrations/internal:backfillOutletId`
 * Run command (prod): `npx convex run migrations/internal:backfillOutletId --prod`
 */
export const backfillOutletId = internalAction({
  args: {
    cursor: v.optional(v.string()), // explicit resume cursor (unused — state is DB-side)
  },
  handler: async (ctx, _args): Promise<{
    ok: true;
    tablesProcessed: string[];
    totalStamped: number;
  }> => {
    // Step 0: ensure default outlet exists.
    const outletId = await ctx.runMutation(
      internal.migrations.internal.seedDefaultOutlet,
      {},
    );

    // OUTLET_SCOPED tables to backfill (in order). staff_sessions FIRST.
    // Exclusion list: pos_settlements, audit_log, api_tokens, api_rate_buckets,
    // api_request_log, pos_idempotency, pos_device_activation_attempts,
    // telegram_log, telegramUpdates, telegramChats, staff, pending_device_setups
    const tables: Array<{ name: string; tableName: string }> = [
      // Priority 1: staff_sessions (before any reader relies on outlet_id)
      { name: "staff_sessions:staff_sessions", tableName: "staff_sessions" },
      // Auth
      { name: "backfill:pos_auth_attempts", tableName: "pos_auth_attempts" },
      // Catalog
      { name: "backfill:pos_inventory_skus", tableName: "pos_inventory_skus" },
      { name: "backfill:pos_products", tableName: "pos_products" },
      { name: "backfill:pos_product_components", tableName: "pos_product_components" },
      // Transactions
      { name: "backfill:pos_transactions", tableName: "pos_transactions" },
      { name: "backfill:pos_transaction_lines", tableName: "pos_transaction_lines" },
      { name: "backfill:pos_receipt_counters", tableName: "pos_receipt_counters" },
      // Payments
      { name: "backfill:pos_xendit_invoices", tableName: "pos_xendit_invoices" },
      // Receipts
      { name: "backfill:pos_receipt_html_cache", tableName: "pos_receipt_html_cache" },
      // Refunds
      { name: "backfill:pos_refunds", tableName: "pos_refunds" },
      // Inventory
      { name: "backfill:pos_stock_movements", tableName: "pos_stock_movements" },
      { name: "backfill:pos_stock_levels", tableName: "pos_stock_levels" },
      { name: "backfill:pos_low_stock_alerts", tableName: "pos_low_stock_alerts" },
      { name: "backfill:pos_stock_drift_log", tableName: "pos_stock_drift_log" },
      // Vouchers
      { name: "backfill:pos_vouchers", tableName: "pos_vouchers" },
      { name: "backfill:pos_voucher_redemptions", tableName: "pos_voucher_redemptions" },
      // Approvals
      { name: "backfill:pos_approval_requests", tableName: "pos_approval_requests" },
      // Shifts
      { name: "backfill:pos_shift_events", tableName: "pos_shift_events" },
      // Ops
      { name: "backfill:pos_error_reports", tableName: "pos_error_reports" },
    ];

    let totalStamped = 0;
    const tablesProcessed: string[] = [];

    for (const { name: migName, tableName } of tables) {
      let cursor: string | null = null;
      let isDone = false;

      // Load any saved cursor for this migration segment.
      const savedState = await ctx.runQuery(
        internal.migrations.internal._loadCursor_internal,
        { name: migName },
      );
      if (savedState?.completed_at != null) {
        // Already completed in a prior run — skip.
        continue;
      }
      if (savedState?.cursor != null) {
        cursor = savedState.cursor;
      }

      while (!isDone) {
        const page = await ctx.runQuery(
          internal.migrations.internal._fetchPage_internal,
          { tableName, cursor, numItems: PAGE_SIZE },
        );

        const docIds: string[] = page.page.map((d: { _id: string }) => d._id);
        const stamped = await ctx.runMutation(
          internal.migrations.internal._stampPage_internal,
          { table: tableName, docIds, outletId },
        );
        totalStamped += stamped;
        cursor = page.continueCursor;
        isDone = page.isDone;

        // Persist cursor after each page so a timeout can resume here.
        await ctx.runMutation(
          internal.migrations.internal._saveCursor_internal,
          { name: migName, cursor, done: isDone ? true : undefined },
        );
      }

      tablesProcessed.push(tableName);
    }

    // Step 2: staff_outlet_access — insert rows for active staff → default outlet.
    await ctx.runMutation(
      internal.migrations.internal._insertStaffOutletAccess_internal,
      { outletId },
    );

    // Step 3: singleton tables (pos_settings, pos_recount_state).
    await ctx.runMutation(
      internal.migrations.internal._stampSingletons_internal,
      { outletId },
    );

    // Step 4: registered_devices — paginate and stamp.
    {
      let cursor: string | null = null;
      let isDone = false;
      const migName = "backfill:registered_devices";
      const savedState = await ctx.runQuery(
        internal.migrations.internal._loadCursor_internal,
        { name: migName },
      );
      if (savedState?.completed_at == null) {
        if (savedState?.cursor != null) cursor = savedState.cursor;
        while (!isDone) {
          const page = await ctx.runQuery(
            internal.migrations.internal._fetchPage_internal,
            { tableName: "registered_devices", cursor, numItems: PAGE_SIZE },
          );
          const docIds: string[] = page.page.map((d: { _id: string }) => d._id);
          const stamped = await ctx.runMutation(
            internal.migrations.internal._stampRegisteredDevices_internal,
            { docIds, outletId },
          );
          totalStamped += stamped;
          cursor = page.continueCursor;
          isDone = page.isDone;
          await ctx.runMutation(
            internal.migrations.internal._saveCursor_internal,
            { name: migName, cursor, done: isDone ? true : undefined },
          );
        }
        tablesProcessed.push("registered_devices");
      }
    }

    return { ok: true, tablesProcessed, totalStamped };
  },
});

// ─── _fetchPage_internal ─────────────────────────────────────────────────────

/**
 * Generic paginator — returns a page of documents from any table.
 * Used by backfillOutletId to iterate over every OUTLET_SCOPED table.
 * Returns the full document so callers can check outlet_id presence.
 */
export const _fetchPage_internal = internalQuery({
  args: {
    tableName: v.string(),
    cursor: v.union(v.string(), v.null()),
    numItems: v.number(),
  },
  handler: async (ctx, { tableName, cursor, numItems }): Promise<{
    page: Array<{ _id: string; outlet_id?: string }>;
    continueCursor: string;
    isDone: boolean;
  }> => {
    const result = await ctx.db
      .query(tableName as any)
      .paginate({ cursor: cursor as any, numItems });
    return {
      page: result.page.map((d: any) => ({ _id: d._id, outlet_id: d.outlet_id })),
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

// ─── _loadCursor_internal ────────────────────────────────────────────────────

/**
 * Load the migration state row for a given migration name.
 * Returns null if the migration has not started yet.
 */
export const _loadCursor_internal = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<{
    cursor: string | null;
    completed_at?: number;
  } | null> => {
    const row = await ctx.db
      .query("migration_state")
      .withIndex("by_name", (q) => q.eq("name", name))
      .first();
    if (!row) return null;
    return { cursor: row.cursor, completed_at: row.completed_at };
  },
});

// ─── assertZeroNullOutletIds ─────────────────────────────────────────────────

/**
 * Returns true when no OUTLET_SCOPED operational row has an absent outlet_id.
 *
 * Checks every OUTLET_SCOPED table (except exclusion-list tables) for rows
 * where outlet_id is null or undefined. A return value of true means the
 * backfill is complete and every row is stamped.
 *
 * Note: full-table scans — only safe on small dev datasets or as a
 * one-time verification after migration. Do NOT schedule this as a cron.
 */
export const assertZeroNullOutletIds = internalQuery({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    // v2.0 Task 12 (ENFORCE): excludes the 3 deliberately-OPTIONAL tables
    // (pos_auth_attempts, registered_devices, pos_error_reports — see their
    // schema comments). Their writers legitimately don't stamp outlet, so once
    // any new such row is written post-deploy a scan would falsely report the
    // migration "incomplete". This assert verifies the REQUIRED tables only.
    const outletScopedTables = [
      "staff_sessions",
      "pos_inventory_skus",
      "pos_products",
      "pos_product_components",
      "pos_transactions",
      "pos_transaction_lines",
      "pos_receipt_counters",
      "pos_xendit_invoices",
      "pos_receipt_html_cache",
      "pos_refunds",
      "pos_stock_movements",
      "pos_stock_levels",
      "pos_low_stock_alerts",
      "pos_stock_drift_log",
      "pos_vouchers",
      "pos_voucher_redemptions",
      "pos_approval_requests",
      "pos_shift_events",
      "pos_settings",
      "pos_recount_state",
    ] as const;

    for (const tableName of outletScopedTables) {
      const rows = await ctx.db.query(tableName as any).collect();
      for (const row of rows) {
        // v2.0 owner-auth: cockpit sessions (staff_sessions.kind="cockpit") are
        // deliberately outlet-less — like the 3 excluded tables, their writer
        // legitimately never stamps an outlet. Skip them so a re-run on a
        // deployment that has owner cockpit sessions doesn't falsely report the
        // booth backfill "incomplete".
        if (tableName === "staff_sessions" && (row as any).kind === "cockpit") continue;
        if ((row as any).outlet_id == null) return false;
      }
    }
    return true;
  },
});

// ─── bindTelegramChatsToDefaultOutlet ───────────────────────────────────────

/**
 * Migrates telegramChats rows for per-outlet routing (Spec 4 Task 12):
 *  - managers + inventory chats: stamp outlet_id = default PKW outlet
 *  - founders chat: rebind role to "owners", outlet_id stays absent (business-wide)
 *  - ops + dormant rows: untouched
 *
 * Idempotent: managers already stamped skip; founders->owners is naturally
 * idempotent (second run won't match the "founders" branch).
 *
 * Must run AFTER seedDefaultOutlet + backfillOutletId.
 *
 * Run command (dev):  npx convex run migrations/internal:bindTelegramChatsToDefaultOutlet
 * Run command (prod): npx convex run migrations/internal:bindTelegramChatsToDefaultOutlet --prod
 */
export const bindTelegramChatsToDefaultOutlet = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ ok: true }> => {
    const def = await ctx.db
      .query("outlets")
      .withIndex("by_code", (q) => q.eq("code", "PKW"))
      .unique();
    if (!def) throw new Error("DEFAULT_OUTLET_MISSING");

    const chats = await ctx.db.query("telegramChats").collect();
    for (const c of chats) {
      if (c.archivedAt !== undefined) continue;
      if (c.role === "managers" || c.role === "inventory") {
        if (c.outlet_id === def._id) continue; // already bound — idempotent skip
        await ctx.db.patch(c._id, { outlet_id: def._id });
        await logAudit(ctx, {
          actor_id: "system",
          action: "telegram.chat_outlet_bound",
          entity_type: "telegramChats",
          entity_id: c.chatId,
          source: "system",
          metadata: { role: c.role, outlet_id: def._id },
        });
      } else if (c.role === "founders") {
        // Rebind to "owners" (business-wide role). outlet_id stays absent.
        // Naturally idempotent: after rebind c.role === "owners", so this
        // branch won't match on a second run.
        await ctx.db.patch(c._id, { role: "owners" });
        await logAudit(ctx, {
          actor_id: "system",
          action: "telegram.chat_outlet_bound",
          entity_type: "telegramChats",
          entity_id: c.chatId,
          source: "system",
          metadata: { role: "owners", rebound_from: "founders" },
        });
      }
      // ops + dormant (no role): untouched — business-wide, no outlet scoping needed
    }

    return { ok: true };
  },
});
