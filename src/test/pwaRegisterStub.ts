// Test-only stub for the `virtual:pwa-register/react` module, which only exists
// at Vite build time (vite-plugin-pwa injects it). vitest.config.ts aliases the
// virtual id to this file so components that call `useRegisterSW` (the new-build
// banner) render inertly under jsdom — no waiting worker, no reloads.
import type { RegisterSWOptions } from "vite-plugin-pwa/types";

export function useRegisterSW(_options?: RegisterSWOptions) {
  return {
    needRefresh: [false, () => {}] as [boolean, (value: boolean) => void],
    offlineReady: [false, () => {}] as [boolean, (value: boolean) => void],
    updateServiceWorker: async (_reloadPage?: boolean) => {},
  };
}
