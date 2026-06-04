import { Suspense } from "react";
import { Outlet } from "react-router";

/**
 * Minimal layout wrapping the three public routes (/activate, /approve/:token,
 * /r/:receiptNumber). Exists for two reasons:
 *
 * 1. Share a single `errorElement` declaration across the public siblings
 *    (avoids three identical attachments in router.tsx).
 * 2. Carry the Suspense fallback for lazy-loaded public routes (RootLayout
 *    handles it for the app shell; without an equivalent here, the public
 *    routes would render `null` during chunk load).
 *
 * No session gate, no chrome — public means public.
 */
export function PublicShell() {
  return (
    <Suspense fallback={null}>
      <Outlet />
    </Suspense>
  );
}
