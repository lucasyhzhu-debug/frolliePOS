import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom doesn't implement scrollIntoView. Focus-management code (e.g. the
// FieldMessage focus-first-errored-field path in mgr/products + mgr/vouchers)
// calls el.scrollIntoView(); stub it so those handlers don't throw under jsdom.
// Guard on typeof HTMLElement so edge-runtime (convex/**) tests don't throw —
// HTMLElement is a jsdom global absent from edge-runtime; the setup file is
// shared across all environments.
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

afterEach(() => cleanup());
