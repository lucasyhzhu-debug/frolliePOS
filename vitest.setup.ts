import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom doesn't implement scrollIntoView. Focus-management code (e.g. the
// FieldMessage focus-first-errored-field path in mgr/products + mgr/vouchers)
// calls el.scrollIntoView(); stub it so those handlers don't throw under jsdom.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

afterEach(() => cleanup());
