# EN/ID Language Picker (#1 i18n) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a per-staff EN/ID language toggle (flag-backed, on the home `YOU` group) backed by a zero-dependency typed i18n dictionary, then extract every user-facing string in `src/` into keyed `{en, id}` pairs.

**Architecture:** A ~80-line client-side i18n layer (`src/lib/i18n/`): an `en` dictionary that is the source of truth for keys, an `id` dictionary typed against it (missing key = `tsc` error), a pure `t(locale, key, params?)` with `{param}` interpolation and a minimal `_one`/`_other` plural rule. A `LocaleProvider` (mounted in `main.tsx`) holds runtime locale and seeds it from the logged-in staffer's saved preference on the login transition. The preference persists on the `staff` row via a self-only `setOwnLocale` mutation. The home toggle flips locale optimistically and writes the preference.

**Tech Stack:** React 19 + TypeScript, Convex 1.31.7 (`withIdempotency` + `requireSession` + `logAudit`), Vitest + convex-test + Testing Library, Tailwind 4 semantic tokens, Framer Motion (grid variants). Workflow tool for the extraction fan-out.

## Global Constraints

- **Zero new dependencies** — no `react-i18next`/`react-intl`. (`npm ls react-i18next` must stay empty.)
- **English is the default**; absent `staff.locale` ⇒ English.
- **`src/lib/format.ts` is untouched** — currency AND dates stay `id-ID`/`Asia/Jakarta` (money is integer rupiah, business rule #14; dates are locale-data, out of scope).
- **Scope = `src/` (React tree) only.** No `convex/` user copy is keyed (receipts `convex/receipts/template.ts` + `src/lib/escpos.ts`, Telegram `convex/lib/telegramHtml.ts` stay as-is).
- **Semantic Tailwind tokens only** (`bg-card`, `text-muted-foreground`, etc.) — no raw palette literals, except national flag colors inside the SVG flag components (ADR-047).
- **Public mutations** carry `idempotencyKey` + `withIdempotency` + a real `authCheck` (rule #20).
- **State-changing writes** emit `logAudit` (rule #4); `audit_log.action` is a free `v.string()` (no enum to edit).
- **ADR number = ADR-049** (highest existing = 048).
- **Flags are inline SVG, never emoji** — Windows renders 🇬🇧/🇮🇩 as bare letters.
- **Guard every Framer Motion interaction with `useReducedMotion`** (full no-op).

---

### Task 1: i18n core — types, dictionaries (seed), pure `t()`

**Files:**
- Create: `src/lib/i18n/types.ts`
- Create: `src/lib/i18n/dictionaries/en.ts`
- Create: `src/lib/i18n/dictionaries/id.ts`
- Create: `src/lib/i18n/t.ts`
- Create: `src/lib/i18n/index.ts`
- Test: `src/lib/i18n/__tests__/t.test.ts`

**Interfaces:**
- Produces: `Locale = "en" | "id"`; `TranslationKey = keyof typeof en`; `TParams = Record<string, string | number>`; `t(locale: Locale, key: TranslationKey, params?: TParams): string`; the `en` and `id` dictionary objects; barrel re-exports from `index.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/i18n/__tests__/t.test.ts
import { describe, it, expect } from "vitest";
import { t } from "../t";
import { en } from "../dictionaries/en";
import { id } from "../dictionaries/id";

describe("t()", () => {
  it("looks up a plain key per locale", () => {
    expect(t("en", "home.newSale")).toBe("New sale");
    expect(t("id", "home.newSale")).toBe("Penjualan baru");
  });

  it("interpolates {params}", () => {
    expect(t("en", "locale.toggleLabel", { current: "English", next: "Bahasa" }))
      .toBe("Language: English. Tap to switch to Bahasa.");
  });

  it("selects English plural by count, Indonesian stays _other", () => {
    expect(t("en", "home.catalogSummary_other", { count: 1, skus: 1 })).toBe("1 product · 1 SKUs");
    expect(t("en", "home.catalogSummary_other", { count: 12, skus: 3 })).toBe("12 products · 3 SKUs");
    expect(t("id", "home.catalogSummary_other", { count: 1, skus: 1 })).toBe("1 produk · 1 SKU");
  });

  it("leaves unknown {params} braces intact", () => {
    expect(t("en", "home.newSale", { unused: "x" })).toBe("New sale");
  });
});

describe("dictionary parity", () => {
  it("en and id have identical keysets", () => {
    expect(Object.keys(id).sort()).toEqual(Object.keys(en).sort());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/i18n/__tests__/t.test.ts`
Expected: FAIL — cannot find module `../t` / `../dictionaries/en`.

- [ ] **Step 3: Write the dictionaries (seed) + types + `t()`**

```ts
// src/lib/i18n/dictionaries/en.ts
// en is the SOURCE OF TRUTH for keys. `as const` makes keyof typeof en the literal union.
// Plural keys come in _one/_other pairs; callers reference the _other variant + pass {count}.
export const en = {
  // common (shared verbs — dedup target during extraction)
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.confirm": "Confirm",
  "common.loading": "Loading…",
  // home
  "home.newSale": "New sale",
  "home.startCart": "start a cart",
  "home.changePin": "Change PIN",
  "home.changePinHint": "change your PIN",
  "home.group.sell": "SELL",
  "home.group.stock": "STOCK",
  "home.group.you": "YOU",
  "home.group.mgr": "MANAGER",
  "home.catalogSummary_one": "{count} product · {skus} SKUs",
  "home.catalogSummary_other": "{count} products · {skus} SKUs",
  "home.recountNudge": "Time to recount stock — tap to start",
  "home.awaitingPayment_one": "{count} payment unfinished — tap to continue",
  "home.awaitingPayment_other": "{count} payments unfinished — tap to continue",
  // locale toggle
  "locale.english": "English",
  "locale.bahasa": "Bahasa",
  "locale.toggleLabel": "Language: {current}. Tap to switch to {next}.",
  "locale.saveFailed": "Couldn't save language. Try again.",
} as const;
```

```ts
// src/lib/i18n/dictionaries/id.ts
import { en } from "./en";

// Typed against en's keys: a missing OR mistyped key is a tsc error (excess-property + missing both caught).
export const id: Record<keyof typeof en, string> = {
  "common.cancel": "Batal",
  "common.save": "Simpan",
  "common.confirm": "Konfirmasi",
  "common.loading": "Memuat…",
  "home.newSale": "Penjualan baru",
  "home.startCart": "mulai keranjang",
  "home.changePin": "Ubah PIN",
  "home.changePinHint": "ubah PIN Anda",
  "home.group.sell": "JUAL",
  "home.group.stock": "STOK",
  "home.group.you": "ANDA",
  "home.group.mgr": "MANAJER",
  "home.catalogSummary_one": "{count} produk · {skus} SKU",
  "home.catalogSummary_other": "{count} produk · {skus} SKU",
  "home.recountNudge": "Saatnya menghitung ulang stok — ketuk untuk mulai",
  "home.awaitingPayment_one": "{count} pembayaran belum selesai — ketuk untuk lanjutkan",
  "home.awaitingPayment_other": "{count} pembayaran belum selesai — ketuk untuk lanjutkan",
  "locale.english": "English",
  "locale.bahasa": "Bahasa",
  "locale.toggleLabel": "Bahasa: {current}. Ketuk untuk ganti ke {next}.",
  "locale.saveFailed": "Gagal menyimpan bahasa. Coba lagi.",
};
```

```ts
// src/lib/i18n/types.ts
import { en } from "./dictionaries/en";

export type Locale = "en" | "id";
export type TranslationKey = keyof typeof en;
export type TParams = Record<string, string | number>;
```

```ts
// src/lib/i18n/t.ts
import { en } from "./dictionaries/en";
import { id } from "./dictionaries/id";
import type { Locale, TParams, TranslationKey } from "./types";

const DICTS: Record<Locale, Record<string, string>> = { en, id };

function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_m, k) =>
    k in params ? String(params[k]) : `{${k}}`,
  );
}

/**
 * Pure translation lookup. Plural rule (the only grammar): keys authored as
 * `${base}_one` / `${base}_other`; callers reference the `_other` key and pass a
 * numeric `count`. English swaps to `_one` when count === 1; Indonesian (analytic)
 * always uses `_other`.
 */
export function t(locale: Locale, key: TranslationKey, params?: TParams): string {
  const dict = DICTS[locale];
  let k: string = key;
  if (
    params &&
    typeof params.count === "number" &&
    locale === "en" &&
    params.count === 1 &&
    key.endsWith("_other")
  ) {
    const oneKey = key.slice(0, -"_other".length) + "_one";
    if (oneKey in dict) k = oneKey;
  }
  const template = dict[k] ?? en[k as TranslationKey] ?? k;
  return interpolate(template, params);
}
```

```ts
// src/lib/i18n/index.ts
export { en } from "./dictionaries/en";
export { id } from "./dictionaries/id";
export { t } from "./t";
export type { Locale, TranslationKey, TParams } from "./types";
export { LocaleProvider, useT, useLocale } from "./context"; // added in Task 2
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/i18n/__tests__/t.test.ts`
Expected: PASS (5 tests). Note: `index.ts` re-exports `./context` which doesn't exist yet — if the test imports only `../t`/`../dictionaries/*` (it does), this is fine. If `tsc` complains about the missing `./context` export, comment that one line until Task 2, then restore.

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n
git commit -m "feat(v1.2 #1): i18n core — typed en/id dicts + pure t() with plural rule"
```

---

### Task 2: LocaleProvider, `useT`/`useLocale`, mount + login-seed

**Files:**
- Create: `src/lib/i18n/context.tsx`
- Modify: `src/main.tsx:38-45` (wrap `<RouterProvider>` in `<LocaleProvider>`)
- Test: `src/lib/i18n/__tests__/context.test.tsx`

**Interfaces:**
- Consumes: `t` from Task 1; `useSession` (`src/hooks/useSession.ts`) — its `status:"active"` staff type gains `locale` in Task 3 (this task compiles against the post-Task-3 type; if implemented first, temporarily read `("locale" in session.staff ? ... : "en")`).
- Produces: `LocaleProvider`; `useT(): (key, params?) => string`; `useLocale(): [Locale, (l: Locale) => void]`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/lib/i18n/__tests__/context.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { LocaleProvider, useLocale, useT } from "../context";

// useSession is the seed source; default to no active session (English default).
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ status: "none", sessionId: null, staff: null }),
}));

function Probe() {
  const t = useT();
  const [locale, setLocale] = useLocale();
  return (
    <div>
      <span data-testid="label">{t("home.newSale")}</span>
      <span data-testid="locale">{locale}</span>
      <button onClick={() => setLocale("id")}>switch</button>
    </div>
  );
}

describe("LocaleProvider", () => {
  it("defaults to English and switches on setLocale", () => {
    render(<LocaleProvider><Probe /></LocaleProvider>);
    expect(screen.getByTestId("locale").textContent).toBe("en");
    expect(screen.getByTestId("label").textContent).toBe("New sale");
    act(() => { screen.getByText("switch").click(); });
    expect(screen.getByTestId("locale").textContent).toBe("id");
    expect(screen.getByTestId("label").textContent).toBe("Penjualan baru");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/i18n/__tests__/context.test.tsx`
Expected: FAIL — cannot find module `../context`.

- [ ] **Step 3: Implement the provider**

```tsx
// src/lib/i18n/context.tsx
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { useSession } from "@/hooks/useSession";
import { t as translate } from "./t";
import type { Locale, TParams, TranslationKey } from "./types";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: TranslationKey, params?: TParams) => string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("en");
  const session = useSession();
  const prevStatus = useRef(session.status);
  const savedLocale = session.status === "active" ? session.staff.locale : null;

  // LOGIN-TRANSITION SEED (not continuous sync): apply the staffer's saved locale
  // only when the session transitions into "active". Afterwards the toggle is the
  // single writer, so an optimistic flip is never clobbered by a getSession refetch.
  useEffect(() => {
    const became = prevStatus.current !== "active" && session.status === "active";
    prevStatus.current = session.status;
    if (became) setLocale(savedLocale ?? "en");
    else if (session.status === "none") setLocale("en"); // reset on logout
  }, [session.status, savedLocale]);

  const t = useCallback(
    (key: TranslationKey, params?: TParams) => translate(locale, key, params),
    [locale],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, t]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useT() {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useT must be used within LocaleProvider");
  return ctx.t;
}

export function useLocale(): [Locale, (l: Locale) => void] {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error("useLocale must be used within LocaleProvider");
  return [ctx.locale, ctx.setLocale];
}
```

- [ ] **Step 4: Mount the provider in `main.tsx`**

Modify `src/main.tsx` — wrap the router (NOT the Toaster, which is fine either side):

```tsx
import { LocaleProvider } from "@/lib/i18n";
// ...
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConvexProvider client={convex}>
      <LocaleProvider>
        <RouterProvider router={router} />
      </LocaleProvider>
      <Toaster position="top-center" richColors closeButton />
    </ConvexProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run src/lib/i18n/__tests__/context.test.tsx && npm run typecheck`
Expected: PASS. (Restore the `./context` re-export line in `index.ts` if it was commented in Task 1.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/i18n/context.tsx src/lib/i18n/index.ts src/main.tsx src/lib/i18n/__tests__/context.test.tsx
git commit -m "feat(v1.2 #1): LocaleProvider + useT/useLocale, login-transition seed, mount in main"
```

---

### Task 3: Backend — `staff.locale` schema + session projection + `useSession` type

**Files:**
- Modify: `convex/auth/schema.ts:5` (add `locale` to `staff` table)
- Modify: `convex/auth/public.ts:33-38` (add `locale` to `getSession` projection)
- Modify: `src/hooks/useSession.ts:21-26` (add `locale` to active-staff type)
- Modify: `docs/SCHEMA.md` (document `staff.locale`)
- Test: `convex/auth/__tests__/getSessionLocale.test.ts`

**Interfaces:**
- Produces: `getSession` returns `staff.locale: "en" | "id"`; `SessionState` active `staff.locale: "en" | "id"`.

- [ ] **Step 1: Write the failing test**

```ts
// convex/auth/__tests__/getSessionLocale.test.ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

describe("getSession surfaces locale", () => {
  it("returns staff.locale, defaulting to 'en' when absent", async () => {
    const t = convexTest(schema);
    const { sessionId, staffNoLocale } = await t.run(async (ctx) => {
      const staffNoLocale = await ctx.db.insert("staff", {
        // staff.code is REQUIRED (convex/auth/schema.ts:7, ADR-034); omit ⇒ insert fails.
        name: "A", code: "S-0001", role: "staff", active: true, pin_hash: "x", created_at: Date.now(),
      });
      const sessionId = await ctx.db.insert("staff_sessions", {
        // ended_at + end_reason are REQUIRED unions (schema.ts:26-32); pass null for active.
        staff_id: staffNoLocale, device_id: "d1", started_at: Date.now(),
        ended_at: null, end_reason: null,
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
```

> Adjust the `staff` / `staff_sessions` insert shape to match the real required columns in `convex/auth/schema.ts` (e.g. `must_change_pin`, `code` may be required). Read the schema before running.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/auth/__tests__/getSessionLocale.test.ts`
Expected: FAIL — `res.staff.locale` is `undefined` (not yet projected).

- [ ] **Step 3: Add the schema field**

In `convex/auth/schema.ts`, inside `staff: defineTable({ ... })`, add:

```ts
    // v1.2 #1 (i18n): per-staff UI language. Absent ⇒ English default (ADR-049).
    locale: v.optional(v.union(v.literal("en"), v.literal("id"))),
```

- [ ] **Step 4: Add to the `getSession` projection**

In `convex/auth/public.ts`, the `getSession` returned `staff` object (currently `_id`, `name`, `role`, `must_change_pin`):

```ts
      staff: {
        _id: staff._id,
        name: staff.name,
        role: staff.role,
        must_change_pin: staff.must_change_pin ?? false,
        locale: staff.locale ?? "en", // v1.2 #1: absent ⇒ English
      },
```

- [ ] **Step 5: Add to the `useSession` active-staff type**

In `src/hooks/useSession.ts`, the `status: "active"` staff type:

```ts
      staff: {
        _id: Id<"staff">;
        name: string;
        role: "staff" | "manager";
        must_change_pin: boolean;
        locale: "en" | "id"; // v1.2 #1
      };
```

- [ ] **Step 6: Run test + typecheck + document**

Run: `npx vitest run convex/auth/__tests__/getSessionLocale.test.ts && npm run typecheck`
Expected: PASS. Add a `staff.locale` row to the `staff` table section of `docs/SCHEMA.md`.

- [ ] **Step 7: Commit**

```bash
git add convex/auth/schema.ts convex/auth/public.ts src/hooks/useSession.ts docs/SCHEMA.md convex/auth/__tests__/getSessionLocale.test.ts
git commit -m "feat(v1.2 #1): staff.locale schema + getSession projection + useSession type"
```

---

### Task 4: `setOwnLocale` mutation (self-only, staff-session)

**Files:**
- Modify: `convex/staff/public.ts` (add `setOwnLocale`)
- Test: `convex/staff/__tests__/setOwnLocale.test.ts`

**Interfaces:**
- Consumes: `withIdempotency`, `requireSession` (`convex/auth/sessions.ts` → `{ staffId, deviceId, role }`), `logAudit`.
- Produces: `api.staff.public.setOwnLocale({ idempotencyKey, sessionId, locale }) → { ok: true }`. **No `staffId` arg** — patches the session's own staff row only.

- [ ] **Step 1: Write the failing test**

```ts
// convex/staff/__tests__/setOwnLocale.test.ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../schema";
import { api } from "../../_generated/api";

// staff.code is REQUIRED (schema.ts:7); staff_sessions needs ended_at + end_reason
// (required null-unions, schema.ts:26-32). Mirrors convex/staff/__tests__/_helpers.ts.
async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const staffId = await ctx.db.insert("staff", {
      name: "A", code: "S-0002", role: "staff", active: true, pin_hash: "x", created_at: Date.now(),
    });
    const sessionId = await ctx.db.insert("staff_sessions", {
      staff_id: staffId, device_id: "d1", started_at: Date.now(),
      ended_at: null, end_reason: null,
    });
    return { staffId, sessionId };
  });
}
// NOTE: setOwnLocale takes no staffId arg (self-derived from session), so "staffer A
// cannot set B's locale" is structurally impossible — no cross-staff negative test needed.

describe("setOwnLocale", () => {
  it("patches the caller's own staff row + writes an audit row", async () => {
    const t = convexTest(schema);
    const { staffId, sessionId } = await seed(t);
    const res = await t.mutation(api.staff.public.setOwnLocale, {
      idempotencyKey: "k1", sessionId, locale: "id",
    });
    expect(res).toEqual({ ok: true });
    const after = await t.run((ctx) => ctx.db.get(staffId));
    expect(after?.locale).toBe("id");
    const audit = await t.run((ctx) =>
      ctx.db.query("audit_log").filter((q) => q.eq(q.field("action"), "staff.locale_set")).collect());
    expect(audit.length).toBe(1);
    expect(audit[0].actor_id).toBe(staffId);
  });

  it("rejects an invalid session", async () => {
    const t = convexTest(schema);
    const { sessionId } = await seed(t);
    await t.run((ctx) => ctx.db.patch(sessionId, { ended_at: Date.now() }));
    await expect(
      t.mutation(api.staff.public.setOwnLocale, { idempotencyKey: "k2", sessionId, locale: "id" }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/staff/__tests__/setOwnLocale.test.ts`
Expected: FAIL — `api.staff.public.setOwnLocale` is not a function.

- [ ] **Step 3: Implement the mutation**

Add to `convex/staff/public.ts` (the `mutation`, `withIdempotency`, `logAudit`, `requireSession` imports already exist; ensure `requireSession` is imported alongside `requireManagerSession`):

```ts
/**
 * Self-service UI language preference. v1.2 #1 (i18n, ADR-049). Staff-session,
 * SELF-ONLY — staff_id is derived from the session, never an arg, so a staffer can
 * only set their own locale (rule #22 low-stakes config; no manager-PIN).
 */
export const setOwnLocale = mutation({
  args: {
    idempotencyKey: v.string(),
    sessionId: v.id("staff_sessions"),
    locale: v.union(v.literal("en"), v.literal("id")),
  },
  handler: withIdempotency<
    { idempotencyKey: string; sessionId: Id<"staff_sessions">; locale: "en" | "id" },
    { ok: true }
  >(
    "staff.setOwnLocale",
    async (ctx, args) => {
      const { staffId, deviceId } = await requireSession(ctx, args.sessionId);
      await ctx.db.patch(staffId, { locale: args.locale });
      await logAudit(ctx, {
        actor_id: staffId,
        action: "staff.locale_set",
        entity_type: "staff",
        entity_id: staffId,
        source: "booth_inline",
        device_id: deviceId,
        metadata: { locale: args.locale },
      });
      return { ok: true as const };
    },
    {
      staffIdFromArgs: (_a) => undefined, // self-derived from session, not args
      authCheck: async (ctx, args) => {
        await requireSession(ctx, args.sessionId);
      },
    },
  ),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/staff/__tests__/setOwnLocale.test.ts && npm run typecheck`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add convex/staff/public.ts convex/staff/__tests__/setOwnLocale.test.ts
git commit -m "feat(v1.2 #1): setOwnLocale self-only mutation (staff-session, audited)"
```

---

### Task 5: Flag SVGs + `LocaleToggle` + home `YOU`-group wiring

**Files:**
- Create: `src/components/pos/flags/FlagGB.tsx`, `src/components/pos/flags/FlagID.tsx`, `src/components/pos/flags/index.ts`
- Create: `src/components/pos/LocaleToggle.tsx`
- Modify: `src/routes/home.tsx` (render `LocaleToggle` as a `YOU`-group cell; swap the home strings shown below to `t(...)`)
- Test: `src/components/pos/__tests__/LocaleToggle.test.tsx`

**Interfaces:**
- Consumes: `useLocale`, `useT` (Task 2); `api.staff.public.setOwnLocale` (Task 4); `useSession`; `Card`; `motion`/`useReducedMotion`; `gridItemVariants`.
- Produces: `<LocaleToggle />`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/pos/__tests__/LocaleToggle.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

const setOwnLocale = vi.fn().mockResolvedValue({ ok: true });
vi.mock("convex/react", () => ({ useMutation: () => setOwnLocale }));
vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({ status: "active", sessionId: "s1", staff: { _id: "st1", name: "A", role: "staff", must_change_pin: false, locale: "en" } }),
}));

import { LocaleProvider } from "@/lib/i18n";
import { LocaleToggle } from "../LocaleToggle";

describe("LocaleToggle", () => {
  it("shows the active language and flips + persists on tap", async () => {
    render(<LocaleProvider><LocaleToggle /></LocaleProvider>);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false"); // en
    await act(async () => { sw.click(); });
    expect(sw).toHaveAttribute("aria-checked", "true"); // optimistic → id
    expect(setOwnLocale).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", locale: "id" }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/pos/__tests__/LocaleToggle.test.tsx`
Expected: FAIL — cannot find module `../LocaleToggle`.

- [ ] **Step 3: Flag SVGs**

```tsx
// src/components/pos/flags/FlagID.tsx — Indonesia: red over white
export function FlagID({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 3 2" className={className} aria-hidden preserveAspectRatio="xMidYMid slice">
      <rect width="3" height="1" y="0" fill="#CE1126" />
      <rect width="3" height="1" y="1" fill="#FFFFFF" />
    </svg>
  );
}
```

```tsx
// src/components/pos/flags/FlagGB.tsx — Union Jack (simplified, recognizable)
export function FlagGB({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 60 30" className={className} aria-hidden preserveAspectRatio="xMidYMid slice">
      <clipPath id="s"><path d="M0 0v30h60V0z" /></clipPath>
      <clipPath id="t"><path d="M30 15h30v15zv15H0zH0V0zV0h30z" /></clipPath>
      <g clipPath="url(#s)">
        <path d="M0 0v30h60V0z" fill="#012169" />
        <path d="M0 0l60 30m0-30L0 30" stroke="#fff" strokeWidth="6" />
        <path d="M0 0l60 30m0-30L0 30" clipPath="url(#t)" stroke="#C8102E" strokeWidth="4" />
        <path d="M30 0v30M0 15h60" stroke="#fff" strokeWidth="10" />
        <path d="M30 0v30M0 15h60" stroke="#C8102E" strokeWidth="6" />
      </g>
    </svg>
  );
}
```

```ts
// src/components/pos/flags/index.ts
export { FlagGB } from "./FlagGB";
export { FlagID } from "./FlagID";
```

- [ ] **Step 4: Implement `LocaleToggle`**

```tsx
// src/components/pos/LocaleToggle.tsx
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { motion, useReducedMotion } from "framer-motion";
import { api } from "../../../convex/_generated/api";
import { useSession } from "@/hooks/useSession";
import { useLocale, useT } from "@/lib/i18n";
import { Card } from "@/components/ui/card";
import { gridItemVariants } from "@/lib/motion";
import { FlagGB, FlagID } from "./flags";

export function LocaleToggle() {
  const [locale, setLocale] = useLocale();
  const t = useT();
  const session = useSession();
  const setOwnLocale = useMutation(api.staff.public.setOwnLocale);
  const reduce = useReducedMotion() ?? false;

  const next = locale === "en" ? "id" : "en";
  const currentName = locale === "en" ? t("locale.english") : t("locale.bahasa");
  const nextName = next === "en" ? t("locale.english") : t("locale.bahasa");

  const onToggle = async () => {
    if (session.status !== "active") return;
    const prev = locale;
    setLocale(next); // optimistic — provider is the single writer post-login
    try {
      await setOwnLocale({ idempotencyKey: crypto.randomUUID(), sessionId: session.sessionId, locale: next });
    } catch {
      setLocale(prev); // revert
      toast.error(t("locale.saveFailed")); // async failure stays a toast (#12 policy)
    }
  };

  const Flag = locale === "en" ? FlagGB : FlagID;

  return (
    <motion.div variants={gridItemVariants(reduce)}>
      <Card className="relative overflow-hidden p-0">
        <button
          type="button"
          role="switch"
          aria-checked={locale === "id"}
          aria-label={t("locale.toggleLabel", { current: currentName, next: nextName })}
          onClick={onToggle}
          className="relative block w-full min-h-[64px] text-left"
        >
          <Flag className="absolute inset-0 h-full w-full object-cover" />
          <span className="absolute inset-0 bg-foreground/45" aria-hidden />
          <span className="relative flex items-center justify-between gap-2 p-3 text-background">
            <span className="text-sm font-semibold drop-shadow">{currentName}</span>
            <span aria-hidden className="text-lg leading-none drop-shadow">⇄</span>
          </span>
        </button>
      </Card>
    </motion.div>
  );
}
```

- [ ] **Step 5: Wire into the home `YOU` group + convert home strings**

In `src/routes/home.tsx`: import `useT` and `LocaleToggle`; call `const t = useT();` in `HomeRoute`. Render the toggle as an extra cell in the `you` section, and replace the literal copy with `t(...)`. The group render becomes:

```tsx
{grouped.map(({ group, tiles }) => (
  <section key={group}>
    <h2 className="mb-2 text-xs font-medium tracking-widest text-muted-foreground">
      {t(`home.group.${group}` as const)}
    </h2>
    <div className="grid grid-cols-2 gap-2">
      {tiles.map((tile) => (
        <motion.div key={tile.id} variants={itemV}>
          <Card className="relative p-3 transition-colors hover:bg-accent">
            <Link to={tile.to} className="block"><TileBody tile={tile} /></Link>
          </Card>
        </motion.div>
      ))}
      {group === "you" && <LocaleToggle />}
    </div>
  </section>
))}
```

Also convert in this file (English default values shown — Task 1 already seeded these keys):
- `"New sale"` → `t("home.newSale")`; `"start a cart"` → `t("home.startCart")`
- the recount banner `"Saatnya menghitung ulang stok — ketuk untuk mulai"` → `t("home.recountNudge")`
- the recovery banner → `t("home.awaitingPayment_other", { count: recovery.count })`
- the catalog summary `{n} products · {n} SKUs` → `t("home.catalogSummary_other", { count: catalog.products.length, skus: catalog.skus.length })`
- the `account` tile's `label`/`hint` come from the static `TILES` array — leave the array literal as-is for now (Task 7 extracts tile copy via the `t()`-in-`TileBody` pattern); the `GROUP_LABELS` constant is now unused → delete it.

> `t(\`home.group.${group}\`)` is typed because all four `home.group.*` keys exist in `en`. If `tsc` rejects the template, add `as TranslationKey`.

- [ ] **Step 6: Run tests + typecheck**

**REQUIRED `home.test.tsx` fix:** `Home` now calls `useT()` and renders `<LocaleToggle/>` (both need
`LocaleProvider`), but `src/routes/__tests__/home.test.tsx:37-43` renders `<Home/>` inside only
`<MemoryRouter>` → `useT` throws "must be used within LocaleProvider", failing all 5 home tests. Wrap it:

```tsx
import { LocaleProvider } from "@/lib/i18n";
// ...
function renderHome() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <LocaleProvider>
        <Home />
      </LocaleProvider>
    </MemoryRouter>,
  );
}
```

The existing `useSession` mock (`home.test.tsx:8-15`) returns staff without `locale` — runtime-safe
(`savedLocale ?? "en"`). The mock starts session `status:"active"`, so the provider's seed effect sees
`prevStatus==="active"` on mount (`became===false`) and leaves locale at the `"en"` default — group labels
stay `"MANAGER"`/`"Manager home"`/`"Settlements"` (en), so all existing assertions still pass.

Run: `npx vitest run src/components/pos/__tests__/LocaleToggle.test.tsx src/routes/__tests__/home.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/pos/flags src/components/pos/LocaleToggle.tsx src/routes/home.tsx src/components/pos/__tests__/LocaleToggle.test.tsx src/routes/__tests__/home.test.tsx
git commit -m "feat(v1.2 #1): flag-backed LocaleToggle in home YOU group + convert home copy"
```

---

### Task 6: ESLint regression fence + ADR-049 + docs

**Files:**
- Modify: `eslint.config.js` (add an i18n hardcoded-copy fence block, registry-gated like the toast fence at `:163+`)
- Create: `docs/ADR/049-i18n-client-typed-dictionary.md`
- Modify: `docs/CHANGELOG.md`, `CLAUDE.md` (auth/ + staff/ module notes; new business rule: per-staff locale, EN default, format.ts excluded)

**Interfaces:** none (config + docs).

- [ ] **Step 1: Write the ADR**

Create `docs/ADR/049-i18n-client-typed-dictionary.md` covering: decision (client-side typed dictionary, zero deps), why no library (two locales, Indonesian analytic → no CLDR plural need), per-staff hybrid ownership (EN pre-login), `format.ts` (currency + dates) excluded, receipts/Telegram out of scope, the `_one`/`_other` plural convention, amends nothing but is referenced by the roadmap.

- [ ] **Step 2: Add the ESLint fence (registry-gated)**

Mirror the existing `no-restricted-syntax` toast fence (`eslint.config.js:163+`). Add a NEW `files` block whose registry lists converted files; the rule bans bare user-facing JSX text literals and string literals in known text props (`label`, `placeholder`, `title`, `aria-label`) so converted files can't regress. Seed the registry with the files converted in Task 5 (`src/routes/home.tsx`, `src/components/pos/LocaleToggle.tsx`). Example selector:

```js
// v1.2 #1 — i18n migration registry. Converted files route copy through t(); this
// fence stops regressions to hardcoded JSX text / text props. Files join as converted.
{
  files: ["src/routes/home.tsx", "src/components/pos/LocaleToggle.tsx"],
  rules: {
    "no-restricted-syntax": [
      "error",
      {
        selector: "JSXText[value=/[A-Za-z]{3,}/]",
        message: "Converted file: user-facing text must go through t(...) (ADR-049), not a hardcoded JSX literal.",
      },
      {
        selector: "JSXAttribute[name.name=/^(placeholder|title|aria-label)$/] > Literal[value=/[A-Za-z]{3,}/]",
        message: "Converted file: text props must use t(...) (ADR-049).",
      },
    ],
  },
},
```

> Verify against the real `eslint.config.js` structure — match how the toast block merges `rules` (the file may need the i18n rule appended rather than a second `no-restricted-syntax` key, since ESLint flat-config can't have two of the same rule in one block; if `home.tsx` later needs BOTH fences, combine selectors in one `no-restricted-syntax` array).

- [ ] **Step 3: Run lint + verify the fence bites**

Run: `npm run lint`
Expected: PASS (Task-5 files already route copy through `t`). Temporarily add a bare `<div>Hello</div>` to `home.tsx` and re-run to confirm the rule errors, then remove it.

- [ ] **Step 4: Update CHANGELOG + CLAUDE.md, commit**

Add a CHANGELOG entry (below). In CLAUDE.md, note `staff.locale` under the `auth/` schema and `setOwnLocale` under `staff/`, and add the per-staff-locale business rule.

```bash
git add eslint.config.js docs/ADR/049-i18n-client-typed-dictionary.md docs/CHANGELOG.md CLAUDE.md
git commit -m "docs(v1.2 #1): ADR-049 i18n + ESLint copy fence + CHANGELOG/CLAUDE"
```

CHANGELOG draft:
~~~markdown
## 2026-06-19 — v1.2 #1: EN/ID language picker (i18n)
- Per-staff EN/ID language toggle (flag-backed) on the home YOU group; English default.
- Zero-dependency typed i18n dictionary (`src/lib/i18n/`); `staff.locale` preference + `setOwnLocale`.
- ESLint fence prevents hardcoded copy regressions in converted files (ADR-049).
- Currency + dates unchanged (id-ID); receipts/Telegram out of scope.
~~~

---

### Task 7: Full copy extraction (all `src/`) via Workflow fan-out

**Files:** every `src/**/*.tsx` user-facing literal (excluding tests); grows `src/lib/i18n/dictionaries/{en,id}.ts` and the `eslint.config.js` registry.

**Interfaces:** Consumes `t`/`useT` (Tasks 1-2). No new exports.

This is the XL wave — parallelized with the **Workflow** tool (Lucas opted in). It runs AFTER Tasks 1-6 so the mechanism + the fence exist.

- [ ] **Step 1: Enumerate the work-list**

```bash
git -C . ls-files 'src/**/*.tsx' | grep -v -E '__tests__|\.test\.' > /tmp/i18n-files.txt
wc -l /tmp/i18n-files.txt   # expect ~60-70 files
```

- [ ] **Step 2: Author + run the extraction workflow**

Write a Workflow script (`pipeline` over file clusters, ~4-6 files per Stage-1 agent to respect the 16-agent cap). Per the Workflow tool contract:
- **Stage 1 (per cluster, `isolation: "worktree"`):** agent reads each file, extracts every user-facing literal (JSX text, `label`/`placeholder`/`title`/`aria-label`), assigns a namespaced key (`<surface>.<slug>`, reusing `common.*` for shared verbs), authors `{en, id}` values (filling the missing side of the existing bilingual mess — existing ID seeds `id`, existing EN seeds `en`), rewrites literals to `t("…")`/`t("…", {param})` (adds `const t = useT();`), and returns the proposed dict entries as structured JSON. **Excludes** `data-testid`, route paths, `src/lib/format.ts` output, dynamic-only strings (key the static template, pass `{params}`).
- **Stage 2 (merge, single agent):** consolidate all entries into `en.ts`/`id.ts` in key order, dedup shared strings into `common.*`, resolve collisions.
- **Stage 3 (verify, single agent):** run `npm run typecheck` + `npx vitest run src/lib/i18n` (keyset parity) and grep each converted file for residual `>[A-Za-z]{3,}<` JSX text; report misses.

- [ ] **Step 3: Add every converted file to the ESLint registry**

Append all converted paths to the Task-6 i18n fence `files` array.

- [ ] **Step 4: Full gate**

Run: `npm run typecheck && npm run lint && npx vitest run && npm run build`
Expected: all PASS. The keyset-parity test guards `en`≡`id`; the fence guards no residual literals in registered files.

- [ ] **Step 5: Manual smoke (both languages)**

`npm run dev`, log in, toggle to Bahasa on home, walk sale → charge → history → mgr screens confirming copy flips and currency/dates stay `id-ID`. Toggle back to English; reload (still ID for that staffer — per-staff persisted). Log in as a second staffer with no saved locale → English.

- [ ] **Step 6: Commit (per cluster during Step 2, final after gate)**

```bash
git add -A
git commit -m "feat(v1.2 #1): extract all src/ copy into en/id dictionaries (full coverage)"
```

---

## Self-Review

- **Spec coverage:** §A core → Task 1-2; §B persistence/lifecycle → Task 3 (schema/projection/type) + Task 4 (mutation) + Task 2 (seed effect); §C toggle → Task 5; §D extraction → Task 7; §E guards/ADR/tests → Task 6 + tests in every task. ✅ All spec sections mapped.
- **Placeholder scan:** every code step has complete code; commands have expected output. ✅
- **Type consistency:** `t(locale, key, params?)`, `setOwnLocale({idempotencyKey,sessionId,locale})`, `useLocale(): [Locale, setter]`, `staff.locale: "en"|"id"` are consistent across tasks. ✅
- **Known refinement vs spec:** the apply-on-login effect lives **inside `LocaleProvider`** (Task 2), not `RootLayout` — RootLayout's conditional early-returns make hook placement fragile; LocaleProvider already consumes `useSession`. Behavior (login-transition seed, single-writer toggle) is unchanged.

## Success Criteria

- `npm run typecheck && npm run lint && npx vitest run && npm run build` all pass.
- Toggling on home flips the UI language instantly, persists to `staff.locale`, and survives reload for that staffer; a staffer with no saved locale sees English; pre-login screens are English.
- `npm ls react-i18next react-intl` is empty (zero new deps).
- Currency + dates remain `id-ID` in both languages.

## Rollback / Deployment

- Additive `staff.locale` (optional) — no migration, no deploy-skew (no mutation↔action rename; `setOwnLocale` is net-new).
- Ships frontend + backend atomically via the single Vercel production build (`npm run build` → `scripts/build.mjs`).
- Revert = revert the squash commit; absent `locale` falls back to English by construction.
- Deploy order: backend (schema + mutation) ships with the FE in one build; the optional field is safe to land before the FE reads it.
