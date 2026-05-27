// test/compute.test.mjs — exercises src/compute.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats, extractShippedDate } from "../src/compute.mjs";
import { parseProgressMarkdown } from "../src/parse.mjs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEmptyDoc() {
  return { phases: [], risks: [], decisions: [], mission: "" };
}

function parseMd(md) {
  return parseProgressMarkdown(md);
}

// ─── 1. computeStats on empty doc ───────────────────────────────────────────

test("computeStats({phases:[]}) returns sensible empty defaults", () => {
  const result = computeStats(makeEmptyDoc());
  assert.ok(result.globalCounts, "globalCounts present");
  const g = result.globalCounts;
  assert.equal(g.phases, 0);
  assert.equal(g.tasks, 0);
  assert.equal(g.done, 0);
  assert.equal(g.inProgress, 0);
  assert.equal(g.planned, 0);
  assert.equal(g.shippedPhases, 0);
  assert.equal(g.activePhase, null);
  assert.ok(Array.isArray(g.criticalPath), "criticalPath is an array");
  assert.equal(g.criticalPath.length, 0, "criticalPath empty for empty doc");
  assert.equal(g.roadmapPct, 0, "roadmapPct is 0 for empty doc");
  assert.equal(g.lastShipDate, null, "lastShipDate null with no shipped phases");
});

// ─── 2. Single shipped phase ─────────────────────────────────────────────────

test("single done phase → shippedPhases 1, done tasks counted", () => {
  const md = `## v0.1 — base ✅ SHIPPED
**Outcome:** Foundation.
**Target:** 2026-04-01
Merged 2026-04-10

### Backend

- ✅ **[v01-be-auth]** Auth done
`;
  const doc = computeStats(parseMd(md));
  const g = doc.globalCounts;
  assert.equal(g.shippedPhases, 1, "one shipped phase");
  assert.equal(g.done, 1, "one done task");
  assert.equal(g.tasks, 1, "one total task");
  assert.equal(g.roadmapPct, 100, "100% when single phase is done");
});

// ─── 3. Orphan task dep doesn't crash; resolved as missing ───────────────────

test("orphan task deps don't crash; dep resolved as missing status", () => {
  const md = `## v0.2 — next 📋 PLANNED
**Outcome:** Second milestone.
**Target:** TBD

### Backend

- 📋 **[v02-be-widget]** Widget
  - **deps:** v02-be-nonexistent
`;
  let doc;
  assert.doesNotThrow(() => {
    doc = computeStats(parseMd(md));
  }, "computeStats does not throw on orphan dep");

  const task = Object.values(doc.phases[0].lanes).flat().find((t) => t.id === "v02-be-widget");
  assert.ok(task, "task found");
  assert.ok(Array.isArray(task.depsResolved), "depsResolved is an array");
  assert.equal(task.depsResolved.length, 1, "one dep entry");
  assert.equal(task.depsResolved[0].status, "missing", "orphan dep status is 'missing'");
});

// ─── 4. criticalPath is an array ────────────────────────────────────────────

test("criticalPath computation produces an array", () => {
  const md = `## v0.3 — chain 📋 PLANNED
**Outcome:** Chained tasks.
**Target:** TBD

### Backend

- ✅ **[v03-be-step1]** Step one
- 📋 **[v03-be-step2]** Step two
  - **deps:** v03-be-step1
`;
  const doc = computeStats(parseMd(md));
  const g = doc.globalCounts;
  assert.ok(Array.isArray(g.criticalPath), "criticalPath is always an array");
  // step2 depends on step1 (done), so step2 is ready; critical path should include step2
  // (the chain computation runs from ready tasks through downstream)
  assert.ok(g.criticalPath.length >= 1, "criticalPath has at least one entry when ready task exists");
});

// ─── 5. extractShippedDate handles bare Merged line ─────────────────────────

test("extractShippedDate handles 'Merged 2026-04-01' and returns correct Date", () => {
  const date = extractShippedDate("Merged 2026-04-01");
  assert.ok(date instanceof Date, "returns a Date object");
  assert.equal(date.getUTCFullYear(), 2026);
  assert.equal(date.getUTCMonth(), 3, "April is month index 3 (zero-based)");
  assert.equal(date.getUTCDate(), 1);
});

test("extractShippedDate returns null for empty/null input", () => {
  assert.equal(extractShippedDate(""), null);
  assert.equal(extractShippedDate(null), null);
  assert.equal(extractShippedDate(undefined), null);
});

test("extractShippedDate returns null when no date in line", () => {
  assert.equal(extractShippedDate("Merged by Lucas"), null);
});
