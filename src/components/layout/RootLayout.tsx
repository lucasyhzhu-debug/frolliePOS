import { Suspense } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "@/hooks/useSession";
import { useDeviceId } from "@/hooks/useDeviceId";
import { useStartupReconciliation } from "@/hooks/useStartupReconciliation";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { PrinterProvider } from "@/components/pos/PrinterProvider";

/**
 * App shell. Gates everything under "/" behind:
 *  1. Device registration → redirect to /activate if not registered.
 *  2. Active session → redirect to /login if no active session.
 *
 * /login is exempt from gate 2 only.
 * /activate, /approve/*, /r/* live OUTSIDE this layout (see router.tsx) so
 * neither gate applies to them — verified by src/router.test.tsx.
 */
export function RootLayout() {
  const location = useLocation();
  const deviceId = useDeviceId();
  const session = useSession();

  // Strategic §6 device gate — uses the real isDeviceRegistered query.
  // Skip query while deviceId is still resolving (null = IDB not yet read).
  const deviceRegistered = useQuery(
    api.staff.public.isDeviceRegistered,
    deviceId ? { deviceId } : "skip",
  );

  // ADR-026: re-check any awaiting_payment txns from the last 5 min on startup.
  // Passes sessionId when active; hook is a no-op when undefined (session still
  // resolving or no active session).
  useStartupReconciliation(session.status === "active" ? session.sessionId : undefined);

  const isLogin = location.pathname === "/login";

  // Show loading while: deviceId hasn't resolved, device-registration query is
  // in-flight, or session is still validating against Convex.
  if (deviceId === null || deviceRegistered === undefined || session.status === "loading") {
    return <RouteFallback />;
  }

  if (!deviceRegistered) {
    return <Navigate to="/activate" replace />;
  }

  if (!isLogin && session.status === "none") {
    return <Navigate to="/login" replace />;
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
  return (
    <div className="flex-1 grid place-items-center text-muted-foreground text-sm">
      <span>Loading…</span>
    </div>
  );
}
