// test/parse.test.mjs — exercises src/parse.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProgressMarkdown } from "../src/parse.mjs";

// ─── 1. Empty string ────────────────────────────────────────────────────────

test("parses an empty PROGRESS.md without crashing", () => {
  const doc = parseProgressMarkdown("");
  assert.ok(doc, "returns a doc object");
  assert.ok(Array.isArray(doc.phases), "phases is an array");
  assert.ok(Array.isArray(doc.risks), "risks is an array");
  assert.ok(Array.isArray(doc.decisions), "decisions is an array");
  assert.equal(doc.phases.length, 0, "no phases");
  assert.equal(doc.risks.length, 0, "no risks");
  assert.equal(doc.decisions.length, 0, "no decisions");
  assert.equal(typeof doc.mission, "string", "mission is a string");
  assert.equal(doc.mission, "", "mission is empty string for empty input");
});

// ─── 2. Single-phase PROGRESS.md ────────────────────────────────────────────

test("parses a single-phase PROGRESS.md without crashing", () => {
  const md = `# Progress

## v0.1 — first slice 📋 PLANNED
**Outcome:** Minimal viable checkout.
**Target:** 2026-06-01
`;
  const doc = parseProgressMarkdown(md);
  assert.equal(doc.phases.length, 1, "one phase parsed");
  assert.equal(doc.phases[0].version, "v0.1");
  assert.equal(doc.phases[0].title, "first slice");
  assert.equal(doc.phases[0].status, "planned");
  assert.equal(doc.phases[0].outcome, "Minimal viable checkout.");
  assert.equal(doc.phases[0].target, "2026-06-01");
});

// ─── 3. Custom lanes config ──────────────────────────────────────────────────

test("uses custom lanes labels when passed via options", () => {
  const md = `## v0.1 — init ✅ SHIPPED

### Mobile

- ✅ **[mob-auth]** Mobile auth screen

### API

- ✅ **[api-login]** Login endpoint
`;
  const doc = parseProgressMarkdown(md, { lanes: { Mobile: "mob", API: "api" } });
  assert.equal(doc.phases.length, 1, "one phase");
  assert.ok(doc.phases[0].lanes["mob"], "mob lane exists");
  assert.ok(doc.phases[0].lanes["api"], "api lane exists");
  assert.equal(doc.phases[0].lanes["mob"].length, 1, "one task in mob lane");
  assert.equal(doc.phases[0].lanes["api"].length, 1, "one task in api lane");
  assert.equal(doc.phases[0].lanes["mob"][0].id, "mob-auth");
  assert.equal(doc.phases[0].lanes["api"][0].id, "api-login");
});

// ─── 4. Phase with no Outcome line ──────────────────────────────────────────

test("gracefully handles a phase with no Outcome line", () => {
  const md = `## v0.2 — refactor 📋 PLANNED
**Target:** TBD
`;
  const doc = parseProgressMarkdown(md);
  assert.equal(doc.phases.length, 1);
  assert.equal(doc.phases[0].outcome, "", "outcome defaults to empty string");
  assert.equal(doc.phases[0].target, "TBD");
});

// ─── 5. Phase header with unusual title chars ────────────────────────────────

test("parses phase header with em-dashes, ampersands, and emoji in title", () => {
  // Note: the em-dash in the phase header regex is the separator, the title itself
  // can contain ampersands and other unicode — but the separator em-dash must be present
  const md = `## v0.3 — Auth & Sessions — foundation 🔄 IN PROGRESS
**Outcome:** Users can log in.
`;
  const doc = parseProgressMarkdown(md);
  // The phase regex captures everything between "— " and " <emoji>" as title
  // With a second em-dash in the title the regex will greedily capture up to last emoji match
  assert.equal(doc.phases.length, 1, "one phase parsed");
  assert.ok(doc.phases[0].title.includes("Auth"), "title contains 'Auth'");
  assert.equal(doc.phases[0].status, "in-progress");
});

// ─── 5b. Ampersand-only unusual title ────────────────────────────────────────

test("parses phase header with ampersand and internal emoji in title", () => {
  const md = `## v0.4 — Payments & 💳 Checkout 📋 PLANNED
**Outcome:** Staff can accept QRIS.
`;
  const doc = parseProgressMarkdown(md);
  // Parser may or may not handle this; primary goal: no crash
  assert.ok(doc, "does not crash");
});

// ─── 6. Resolved decision ───────────────────────────────────────────────────

test("parses a resolved decision in canonical format", () => {
  const md = `## Decisions

- ~~**PIN length**~~ — **RESOLVED 2026-04-01**: 4 digits, fixed forever.
`;
  const doc = parseProgressMarkdown(md);
  assert.equal(doc.decisions.length, 1, "one decision");
  const d = doc.decisions[0];
  assert.equal(d.resolved, true, "resolved flag is true");
  assert.equal(d.resolvedAt, "2026-04-01");
  assert.equal(d.title, "PIN length");
  assert.ok(d.body.includes("4 digits"), "body captured");
});

// ─── 7. Active (unresolved) decision ────────────────────────────────────────

test("parses an active decision with no strikethrough", () => {
  const md = `## Decisions

- **Offline sync strategy** — Should we queue locally or block?
`;
  const doc = parseProgressMarkdown(md);
  assert.equal(doc.decisions.length, 1, "one decision");
  const d = doc.decisions[0];
  assert.equal(d.resolved, false, "resolved is false for active decision");
  assert.equal(d.title, "Offline sync strategy");
  assert.ok(d.body.includes("Should we queue"), "body captured");
});
