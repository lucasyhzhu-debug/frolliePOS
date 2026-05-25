import { Suspense } from "react";
import { Outlet } from "react-router";

/**
 * RootLayout — minimal stub for Wave 1.
 * Wave 4 fills this in with:
 *   - session gate (redirect to /login when no session)
 *   - device-registration gate
 *   - connection indicator
 *   - offline banner
 *   - install prompt for PWA
 */
export function RootLayout() {
  return (
    <div className="min-h-dvh flex flex-col">
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
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
