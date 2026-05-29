// test/render.test.mjs — exercises src/render.mjs via buildHtml
// buildHtml is the public surface: parse → compute → renderPage.
// renderPage is async (reads CSS from disk) so we test via buildHtml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHtml } from "../src/index.mjs";

// ─── Fixture helpers ─────────────────────────────────────────────────────────

const MINIMAL_MD = `**Mission.** Sell cookies, count money.

## v0.1 — foundation 📋 PLANNED
**Outcome:** POS boots and accepts logins.
**Target:** 2026-06-01

### Backend

- 📋 **[v01-be-auth]** Auth flow
`;

// ─── 1. buildHtml("", {}) produces something ────────────────────────────────

test("buildHtml with empty string produces HTML output", async () => {
  const html = await buildHtml("", {});
  assert.ok(typeof html === "string", "returns a string");
  assert.ok(html.length > 0, "not empty");
  assert.ok(html.includes("<!doctype html>"), "is HTML");
});

// ─── 2. buildHtml(minimalMd) contains masthead ──────────────────────────────

test("buildHtml with minimal PROGRESS.md contains masthead structure", async () => {
  const html = await buildHtml(MINIMAL_MD, {});
  assert.ok(html.includes("masthead"), "masthead class present");
  assert.ok(html.includes("masthead-title"), "masthead-title present");
});

// ─── 3. monogram: false suppresses the .monogram div ────────────────────────

test("buildHtml with monogram:false does NOT produce monogram div", async () => {
  const html = await buildHtml(MINIMAL_MD, { title: "Test", monogram: false });
  assert.ok(!html.includes('class="monogram"'), "monogram div absent when monogram:false");
});

test("buildHtml without monogram option DOES produce monogram div", async () => {
  const html = await buildHtml(MINIMAL_MD, { title: "Test" });
  assert.ok(html.includes('class="monogram"'), "monogram div present by default");
});

// ─── 4. location appears in stamp ───────────────────────────────────────────

test("buildHtml with location:'Berlin' includes Berlin in stamp", async () => {
  const html = await buildHtml(MINIMAL_MD, { title: "Test", location: "Berlin" });
  assert.ok(html.includes("Berlin"), "location string appears in output");
  // The stamp div contains the location
  const stampIdx = html.indexOf('class="stamp"');
  assert.ok(stampIdx >= 0, "stamp section present");
  const afterStamp = html.slice(stampIdx, stampIdx + 500);
  assert.ok(afterStamp.includes("Berlin"), "Berlin appears inside the stamp section");
});

// ─── 5. Empty title falls back to "Project" (doesn't crash) ─────────────────

test("buildHtml with title:'' does not crash and defaults title to 'Project'", async () => {
  let html;
  assert.doesNotThrow(async () => {
    html = await buildHtml(MINIMAL_MD, { title: "" });
  });
  html = await buildHtml(MINIMAL_MD, { title: "" });
  assert.ok(typeof html === "string", "returns string");
  // renderPage uses safeTitle = title || "Project"
  assert.ok(html.includes("Project"), "defaults to 'Project' when title is empty");
});

// ─── 6. v1Label shows in percent caption ────────────────────────────────────

test("buildHtml with v1Label:'v2.0' shows v2.0 in percent caption", async () => {
  const html = await buildHtml(MINIMAL_MD, { title: "Test", v1Label: "v2.0" });
  assert.ok(html.includes("v2.0"), "v1Label appears in rendered output");
  // The percent caption reads: "of the road to <em>v2.0</em>"
  assert.ok(html.includes("road to"), "percent caption present");
  const captionIdx = html.indexOf("road to");
  const afterCaption = html.slice(captionIdx, captionIdx + 50);
  assert.ok(afterCaption.includes("v2.0"), "v1Label is inside the percent caption");
});
