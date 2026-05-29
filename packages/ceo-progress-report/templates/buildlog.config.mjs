// buildlog.config.mjs — all values optional; sensible defaults apply.
// Override only what you want to change.

export default {
  // The big title in the masthead
  title: "Your Project",

  // Italic subtitle under the title
  subtitle: "The Build Log.",

  // Monogram letter in the masthead circle.
  // - String: that letter is used.
  // - Omitted (default): derived from title[0] uppercase.
  // - false: monogram hidden entirely.
  // monogram: "M",
  // monogram: false,

  // City stamp in the masthead (right side)
  location: "",

  // The version label that anchors "% of the road to ___"
  v1Label: "v1.0",

  // Lane labels in your PROGRESS.md → internal slug used in Task IDs.
  // Replace with whatever lanes your project uses (Research/Build/Ship,
  // Mobile/Backend/Infra, etc.). The slug becomes the middle segment of
  // Task IDs (e.g., `v02-be-checkout-flow`).
  lanes: {
    Backend: "be",
    Frontend: "fe",
    "Cross-cutting": "xc",
  },

  // Roadmap % calculation mode:
  // - "phases" (default): % = shipped phases / total phases (unweighted, simple)
  // - "tasks":            % = shipped addressable tasks / total addressable tasks (weighted by scope)
  // The phases mode treats a 1-task phase the same as a 50-task phase. tasks mode
  // adjusts for size but requires every phase to use addressable task IDs consistently.
  // roadmapPercent: "phases",
};
