import { Suspense } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "@/hooks/useSession";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useStartupReconciliation } from "@/hooks/useStartupReconciliation";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { PrinterProvider } from "@/components/pos/PrinterProvider";
import { useBoothState } from "@/hooks/useBoothState";
import { hasManagerSkippedSOD } from "@/lib/shiftSkip";
import { useT } from "@/lib/i18n";

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

function RouteFallback() {
  const t = useT();
  return (
    <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
      <span>{t("common.loading")}</span>
    </div>
  );
}
