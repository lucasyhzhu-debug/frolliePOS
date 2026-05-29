// buildlog.config.mjs — config for `ceo-report build` (ceo-progress-report npm package).
// Replaces the retired in-tree scripts/build-progress-html.mjs.
// Build command (note non-default paths — Frollie keeps the board under docs/):
//   npx ceo-report build --src docs/PROGRESS.md --out docs/progress.html

export default {
  title: "Frollie POS",
  subtitle: "The Build Log.",
  monogram: "F",
  location: "Jakarta",
  v1Label: "v1.0",
  lanes: {
    Backend: "be",
    Frontend: "fe",
    "Cross-cutting": "xc",
  },
};
