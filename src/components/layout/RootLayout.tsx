import { Suspense, useEffect, useRef } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "@/hooks/useSession";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useStartupReconciliation } from "@/hooks/useStartupReconciliation";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { PrinterProvider } from "@/components/pos/PrinterProvider";
import { useBoothState } from "@/hooks/useBoothState";
import { hasManagerSkippedSOD } from "@/lib/shiftSkip";
import { useT, useLocale } from "@/lib/i18n";
import { OutletProvider } from "@/contexts/OutletContext";
import { OutletSwitcher } from "@/components/cockpit/OutletSwitcher";
import { Button } from "@/components/ui/button";

// SEC-03: session IDs already shown the forced-rotation prompt this app session.
// Soft enforcement — we surface the "Change your PIN" step ONCE after login, then
// stop redirecting so the manager can still operate the booth (no hard-block per
// spec). The flag clears server-side on a successful change, so it won't recur.
// Growth is bounded by distinct logins per unreloaded page session (one ~20-char
// id each — negligible for a single-device booth PWA), not by request count. A
// full reload resets it, which is desirable: a security prompt should re-surface.
const rotationPrompted = new Set<string>();

/**
 * App shell. Gates everything under "/" behind:
 *  1. Device registration → redirect to /activate if not registered.
 *  2. Active session → redirect to /login if no active session.
 *  3. SEC-03 forced PIN rotation → one-time redirect to /account when
 *     must_change_pin (soft; does not re-trap).
 *
 * /login is always exempt from gate 2; /shift/handover is exempt from gate 2 while
 * booth state is "handover_pending" (the incoming staff authenticates session-less
 * inside that screen — see the handover deadlock note below).
 * /activate, /approve/*, /r/* live OUTSIDE this layout (see router.tsx) so
 * neither gate applies to them — verified by src/router.test.tsx.
 */
export function RootLayout() {
  const location = useLocation();
  const deviceId = useDeviceId();
  const session = useSession();
  const boothState = useBoothState();

  // Strategic §6 device gate — uses the real isDeviceRegistered query.
  // Skip query while deviceId is still resolving (null = IDB not yet read).
  const deviceRegistered = useQuery(
    api.staff.public.isDeviceRegistered,
    deviceId ? { deviceId } : "skip",
  );

  // v2.0 Task 10: SOP gate uses the device's formal outlet binding instead of
  // the retired `pos_settings.outlet_device_id` hotfix. Returns true for all
  // registered devices during the migration window (backward-compat); Task 12
  // tightens to false for unbound viewer devices.
  const isOutletDevice = useQuery(
    api.auth.public.isDeviceOutlet,
    deviceId ? { deviceId } : "skip",
  );

  // ADR-026: re-check any awaiting_payment txns from the last 5 min on startup.
  // Passes sessionId when active; hook is a no-op when undefined (session still
  // resolving or no active session).
  useStartupReconciliation(session.status === "active" ? session.sessionId : undefined);

  // v2.0 owner-auth (ADR-052): the cockpit is a separate auth plane. /cockpit/*
  // routes are gated on a COCKPIT session (not a booth one) and carry the owner
  // amber theme. They live under the same RootLayout subtree but bypass the booth
  // device-registration + SOP gates entirely (cockpit needs neither a registered
  // booth device nor a shift checklist). `/cockpit/login` is the cockpit no-session
  // exemption (mirrors /login for the booth) — see the cockpit branch below.
  const isCockpit = location.pathname.startsWith("/cockpit");
  const isCockpitLogin = location.pathname === "/cockpit/login";

  // Apply / remove the owner theme class on <html> for the whole cockpit plane so
  // every cockpit surface (this login + Spec-3 screens) re-tints via the scoped
  // .theme-owner token override. Removed off /cockpit/* so the booth keeps phthalo.
  useEffect(() => {
    const root = document.documentElement;
    if (isCockpit) root.classList.add("theme-owner");
    else root.classList.remove("theme-owner");
    return () => root.classList.remove("theme-owner");
  }, [isCockpit]);

  const isLogin = location.pathname === "/login";
  const onHandoverRoute = location.pathname === "/shift/handover";
  // Single source for the "handover_pending" check — consumed by both the
  // no-session exemption below and the active-session SOP gate further down, so
  // the two can't drift. `?.` so it's safely `false` while boothState loads.
  const boothPending = boothState?.state === "handover_pending";

  // /shift/handover must be reachable WITHOUT an active session: handoverOut ends
  // the outgoing session, so during handover_pending the device has no session and
  // the INCOMING staff authenticates inside that screen (loginWithPin). Exempt it
  // from the no-session redirect (mirrors /login). Without this, the session gate
  // sends /shift/handover → /login while login.tsx sends handover_pending → /shift/handover,
  // deadlock-bouncing forever (getActiveStaff re-fires on every remount — prod
  // incident 2026-06-20). Gated on the live booth state so a stale or manual visit
  // with no pending handover still correctly redirects to /login.
  // NOTE: only the `session.status === "none"` gate below consults this flag, so an
  // active-session visitor on /shift/handover is unaffected (the SOP gate handles them).
  const isHandoverIn = onHandoverRoute && boothPending;

  // ── Cockpit plane gate (v2.0 owner-auth, ADR-052) ──────────────────────────
  // Handled BEFORE the booth device-registration / session / SOP gates so the
  // cockpit never inherits them — in particular it must NOT stall on the booth
  // `isDeviceRegistered` query (cockpit needs no registered booth device), which
  // would flash the loading fallback on every cockpit load. /cockpit/login is
  // exempt from the no-session redirect (mirrors /login — no bounce loop). Any
  // other /cockpit/* route requires an ACTIVE COCKPIT session; a booth/no session
  // there bounces to /cockpit/login once. (A cockpit session that drifts onto a
  // booth route is handled by the booth branch below.)
  if (isCockpit) {
    if (isCockpitLogin) {
      return <CockpitShell />;
    }
    if (deviceId === null || session.status === "loading") {
      return <RouteFallback />;
    }
    if (session.status === "none" || session.kind !== "cockpit") {
      return <Navigate to="/cockpit/login" replace />;
    }
    return <CockpitShell />;
  }

  // Show loading while: deviceId hasn't resolved, device-registration query is
  // in-flight, session is still validating, OR we're session-less on /shift/handover
  // and booth state hasn't resolved yet. The last clause matters: `isHandoverIn` is
  // `false` while boothState is undefined, so without holding here a cold PWA
  // relaunch on /shift/handover would briefly bounce through /login (re-firing
  // getActiveStaff) before settling. We must know whether it's genuinely
  // handover_pending before choosing to exempt vs redirect (review I-1).
  if (
    deviceId === null ||
    deviceRegistered === undefined ||
    session.status === "loading" ||
    (onHandoverRoute && session.status === "none" && boothState === undefined)
  ) {
    return <RouteFallback />;
  }

  // A cockpit session must NOT operate booth routes (it has no outlet and cannot
  // call booth mutations — Item 3). Redirect it back to the cockpit plane once.
  if (
    !isLogin &&
    session.status === "active" &&
    session.kind === "cockpit"
  ) {
    return <Navigate to="/cockpit/login" replace />;
  }

  if (!deviceRegistered) {
    return <Navigate to="/activate" replace />;
  }

  if (!isLogin && !isHandoverIn && session.status === "none") {
    return <Navigate to="/login" replace />;
  }

  // SEC-03: one-time forced-rotation prompt after login. Only redirect if we
  // haven't already prompted this session and we're not already on /account
  // (avoids a Batal → redirect re-trap loop — soft enforcement, not hard-block).
  if (
    session.status === "active" &&
    session.staff.must_change_pin &&
    location.pathname !== "/account" &&
    !rotationPrompted.has(session.sessionId)
  ) {
    rotationPrompted.add(session.sessionId);
    return <Navigate to="/account" replace />;
  }


  // v2.0 Task 10: SOP gate applies only to formally-assigned outlet devices.
  // `isOutletDevice` is backend-computed (migration-tolerant: unbound = true
  // until Task 12). Defaults to FALSE while loading so a viewer device is never
  // momentarily trapped in the SOD checklist (the cost is a sub-second menu flash
  // on the outlet device at start-of-day, which then redirects correctly).
  const deviceIsOutlet = isOutletDevice ?? false;

  // Booth-state SOP gate: redirect to mandatory start-of-day / handover flows.
  // Only fires when: (a) there IS an active session (session gate above already
  // handled the no-session case), (b) boothState has resolved (not undefined —
  // undefined = still loading, render children), (c) this device is the outlet,
  // (d) current path is not already the target route (loop-safety).
  // "locked" and "open" states: no forced shift redirect (normal app flow).
  // "closed": mandatory /shift/start (start of day) — EXCEPT a manager who has
  //   explicitly skipped it this session (escape hatch; see shiftSkip.ts). Normal
  //   staff (role !== "manager") are always gated, so the first staff of the day
  //   still walks the checklist.
  // "handover_pending": mandatory /shift/handover (incoming handover).
  // Routes outside these shift screens are NOT affected when state is open/locked.
  // /login and /activate are outside this layout entirely (see router.tsx comment).
  if (
    session.status === "active" &&
    boothState !== undefined &&
    deviceIsOutlet
  ) {
    const managerSkipped =
      session.staff.role === "manager" && hasManagerSkippedSOD(session.sessionId);
    if (
      boothState.state === "closed" &&
      location.pathname !== "/shift/start" &&
      !managerSkipped
    ) {
      return <Navigate to="/shift/start" replace />;
    }
    if (boothPending && !onHandoverRoute) {
      return <Navigate to="/shift/handover" replace />;
    }
  }
  return (
    <div className="min-h-dvh flex flex-col bg-background">
      {/* PrinterProvider sits above the Outlet so one BLE connection survives
          route changes (connect once per shift, not per screen). */}
      <PrinterProvider>
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </PrinterProvider>
    </div>
  );
}

/**
 * Cockpit subtree shell (v2.0 owner-auth / v1.3.0 Task 8). Distinct from the
 * booth shell: no PrinterProvider (cockpit doesn't drive the thermal printer).
 * The owner amber theme is applied on <html> by the effect above, so
 * bg-background here resolves to the tinted canvas.
 *
 * Additions (Task 8):
 *  - Wraps children in <OutletProvider> so every cockpit screen can read and
 *    set the current outlet scope.
 *  - Renders a cockpit header with <OutletSwitcher> when an active cockpit
 *    session exists (omitted on /cockpit/login which has its own chrome).
 *  - Runs a session keepalive: pings `touchCockpitSession` on mount, every 5
 *    minutes, and on window focus — using a FRESH `crypto.randomUUID()` key on
 *    each call so `withIdempotency` never replays a cached no-op (the session
 *    would idle out if the same key were reused). Errors are swallowed; the gate
 *    in RootLayout redirects to /cockpit/login when the session is truly dead.
 */
function CockpitShell() {
  const session = useSession();
  const touchCockpit = useMutation(api.auth.public.touchCockpitSession);
  const lastPingedAtRef = useRef<number>(0);

  // Derive a stable sessionId so the effect dep is a primitive (null | string),
  // not the whole session object — avoids spurious re-runs on unrelated renders.
  const sessionId =
    session.status === "active" && session.kind === "cockpit"
      ? session.sessionId
      : null;

  useEffect(() => {
    if (!sessionId) return;

    const ping = async () => {
      if (Date.now() - lastPingedAtRef.current < 60_000) return;
      try {
        // Fresh UUID on EVERY call — withIdempotency caches by key; reusing the
        // same key would short-circuit to the cached null response and never
        // update last_active_at, causing the session to idle out after 30 min.
        await touchCockpit({
          idempotencyKey: crypto.randomUUID(),
          sessionId,
        });
        lastPingedAtRef.current = Date.now();
      } catch {
        // Session ended or transient network error. Swallow: the RootLayout gate
        // already redirects to /cockpit/login when getSession returns null.
      }
    };

    void ping();
    const intervalId = setInterval(() => void ping(), 5 * 60 * 1_000);
    window.addEventListener("focus", ping);

    return () => {
      clearInterval(intervalId);
      window.removeEventListener("focus", ping);
    };
  }, [sessionId, touchCockpit]);

  // Show the header chrome only for authenticated cockpit routes.
  // The /cockpit/login page renders its own full-screen chrome.
  const showHeader = sessionId !== null;

  return (
    <OutletProvider>
      <div className="min-h-dvh flex flex-col bg-background">
        {showHeader && (
          <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
            <span className="text-sm font-semibold tracking-tight text-primary">
              {"Frollie"}
            </span>
            <div className="flex items-center gap-2">
              <OutletSwitcher />
              <CockpitLocaleToggle />
            </div>
          </header>
        )}
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </div>
    </OutletProvider>
  );
}

/**
 * Compact EN/ID toggle for the cockpit header (UAT fix #6 — the owner plane had
 * no language toggle, unlike the booth). Deliberately client-only: the booth's
 * full LocaleToggle persists via `setOwnLocale`, a manager-session mutation that
 * a cockpit session is rejected from (NOT_BOOTH_SESSION). Flipping the in-memory
 * locale via `setLocale` re-renders the cockpit in the chosen language; the
 * dictionary is already fully translated. Resets to the seeded locale on reload.
 */
function CockpitLocaleToggle() {
  const [locale, setLocale] = useLocale();
  const t = useT();
  const next = locale === "en" ? "id" : "en";
  const currentName = locale === "en" ? t("locale.english") : t("locale.bahasa");
  const nextName = next === "en" ? t("locale.english") : t("locale.bahasa");
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setLocale(next)}
      role="switch"
      aria-checked={locale === "id"}
      aria-label={t("locale.toggleLabel", { current: currentName, next: nextName })}
      className="h-8 px-2 text-xs font-medium uppercase text-muted-foreground"
    >
      {locale}
    </Button>
  );
}

function RouteFallback() {
  const t = useT();
  return (
    <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
      <span>{t("common.loading")}</span>
    </div>
  );
}
