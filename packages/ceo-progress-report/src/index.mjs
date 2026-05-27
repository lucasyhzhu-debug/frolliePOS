// packages/ceo-progress-report/src/index.mjs
import { parseProgressMarkdown } from "./parse.mjs";
import { computeStats } from "./compute.mjs";
import { renderPage } from "./render.mjs";

export { parseProgressMarkdown, computeStats, renderPage };

export async function buildHtml(md, config = {}) {
  const parsed = parseProgressMarkdown(md, { lanes: config.lanes });
  const doc = computeStats(parsed);
  const generatedAt = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  return await renderPage(doc, generatedAt, config);
}
