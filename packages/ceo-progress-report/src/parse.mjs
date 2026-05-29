// Parse PROGRESS.md into a structured document object.
//
// Output shape:
//   {
//     mission: string,
//     phases: [{
//       version, slug, title, status, statusLabel, subtitle,
//       outcome, target, shippedLine,
//       youGet: string[], youDontGet: string[],
//       lanes: { [laneKey]: Task[] }
//     }],
//     risks: [{title, body, resolved}],
//     decisions: [{title, body, resolved, resolvedAt}]
//   }

const STATUS_FROM_EMOJI = {
  "✅": "done",
  "🔄": "in-progress",
  "📋": "planned",
  "🗂️": "backlog",
};

export function parseProgressMarkdown(md, { lanes = { Backend: "be", Frontend: "fe", "Cross-cutting": "xc" } } = {}) {
  const lines = md.split(/\r?\n/);
  const doc = { mission: "", phases: [], risks: [], decisions: [] };

  let currentPhase = null;
  let currentLane = null;
  let currentTask = null;
  let currentField = null;
  let currentPhaseField = null;
  let inCodeFence = false;
  let inSection = null;

  const phaseRe = /^##\s+(v\d+(?:\.\d+)+)\s+—\s+(.+?)\s+(✅|🔄|📋|🗂️)\s+(.+)$/;
  const laneLabels = Object.keys(lanes).join("|");
  const laneRe = new RegExp(`^###\\s+(${laneLabels})\\b`);
  const addressableRe = /^-\s+(✅|🔄|📋|🗂️)\s+\*\*\[([a-z0-9-]+)\]\*\*\s+(.+?)(?:\s+\(([0-9a-f]{7,40}(?:\s*\/\s*[0-9a-f]{7,40})*)\))?$/;
  const legacyRe = /^-\s+(✅|🔄|📋|🗂️)\s+(.+)$/;
  const metaRe = /^\s{2,}-\s+\*\*([a-z_]+):\*\*\s*(.*)$/i;
  const subtaskRe = /^\s{4,}-\s+\[([x\s])\]\s+(.+)$/i;
  const noteBulletRe = /^\s{4,}-\s+(.+)$/;
  const sectionHeadingRe = /^##\s+(.+)$/;
  const outcomeRe = /^\*\*Outcome:\*\*\s+(.+)$/;
  const targetRe = /^\*\*Target:\*\*\s+(.+)$/;
  const missionRe = /^\*\*Mission\.\*\*\s+(.+)$/;
  const bulletRe = /^-\s+(.+)$/;
  const resolvedDecisionRe = /^~~\*\*(.+?)\*\*~~\s*[—-]\s*\*\*RESOLVED\s+(\d{4}-\d{2}-\d{2})\*\*:?\s*(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^```/.test(line)) { inCodeFence = !inCodeFence; continue; }
    if (inCodeFence) continue;

    if (!doc.mission) {
      const m = line.match(missionRe);
      if (m) { doc.mission = m[1].trim(); continue; }
    }

    const sectionMatch = line.match(sectionHeadingRe);
    if (sectionMatch) {
      const heading = sectionMatch[1].toLowerCase();
      if (heading.startsWith("risks")) {
        inSection = "risks";
        currentPhase = null; currentLane = null; currentTask = null; currentField = null; currentPhaseField = null;
        continue;
      }
      if (heading.startsWith("decisions")) {
        inSection = "decisions";
        currentPhase = null; currentLane = null; currentTask = null; currentField = null; currentPhaseField = null;
        continue;
      }
      if (heading.startsWith("how agents") || heading.startsWith("how to") || heading.startsWith("appendix")) {
        inSection = "footer";
        currentPhase = null; currentLane = null;
        continue;
      }
    }

    if (inSection === "risks" || inSection === "decisions") {
      const b = line.match(bulletRe);
      if (b) {
        const text = b[1].trim();
        if (inSection === "decisions") {
          const r = text.match(resolvedDecisionRe);
          if (r) {
            doc.decisions.push({
              title: r[1].trim(), body: r[3].trim(),
              resolved: true, resolvedAt: r[2],
            });
            continue;
          }
        }
        const titled = text.match(/^\*\*(.+?)\*\*\s*[—-]\s*(.+)$/);
        const entry = titled
          ? { title: titled[1].trim(), body: titled[2].trim(), resolved: false }
          : { title: null, body: text, resolved: false };
        if (inSection === "risks") doc.risks.push(entry);
        else doc.decisions.push(entry);
      }
      continue;
    }

    const phaseMatch = line.match(phaseRe);
    if (phaseMatch) {
      const [, version, title, emoji, statusLabel] = phaseMatch;
      currentPhase = {
        version,
        slug: version.replace(/\./g, ""),
        title: title.trim(),
        status: STATUS_FROM_EMOJI[emoji],
        statusLabel: statusLabel.trim(),
        subtitle: "", outcome: "", target: "", shippedLine: "",
        youGet: [], youDontGet: [],
        lanes: Object.fromEntries(Object.values(lanes).map((k) => [k, []])),
      };
      doc.phases.push(currentPhase);
      currentLane = null; currentTask = null; currentField = null; currentPhaseField = null;
      inSection = null;
      continue;
    }

    if (currentPhase && !currentLane) {
      const om = line.match(outcomeRe);
      if (om) { currentPhase.outcome = om[1].trim(); currentPhaseField = null; continue; }
      const tm = line.match(targetRe);
      if (tm) { currentPhase.target = tm[1].trim(); currentPhaseField = null; continue; }
      if (/^\*\*You(?:'ll| can| will)? be able to:\*\*/i.test(line.trim()) || /^\*\*What you (?:get|can do):\*\*/i.test(line.trim())) {
        currentPhaseField = "youGet"; continue;
      }
      if (/^\*\*Still not yet/i.test(line.trim()) || /^\*\*Not yet/i.test(line.trim()) || /^\*\*You (?:won't|can't) (?:yet|be able to)/i.test(line.trim())) {
        currentPhaseField = "youDontGet"; continue;
      }
      if (currentPhaseField) {
        const bm = line.match(/^-\s+(.+)$/);
        if (bm) { currentPhase[currentPhaseField].push(bm[1].trim()); continue; }
        if (line.trim() && !line.startsWith("###") && !line.startsWith("##")) currentPhaseField = null;
      }
      if (/^Merged\b/i.test(line.trim())) { currentPhase.shippedLine = line.trim(); continue; }
      if (!currentPhase.subtitle && line.trim() && !line.startsWith("#") && !line.startsWith("---") && !line.startsWith("**") && !line.startsWith("-")) {
        currentPhase.subtitle = line.trim();
        continue;
      }
    }

    const laneMatch = line.match(laneRe);
    if (laneMatch && currentPhase) {
      currentLane = lanes[laneMatch[1]];
      currentTask = null; currentField = null; currentPhaseField = null;
      continue;
    }

    if (currentPhase && currentLane) {
      const taskMatch = line.match(addressableRe);
      if (taskMatch) {
        const [, emoji, id, title, sha] = taskMatch;
        currentTask = {
          id,
          phase: currentPhase.version,
          phaseSlug: currentPhase.slug,
          lane: currentLane,
          status: STATUS_FROM_EMOJI[emoji],
          title: title.trim(),
          commitSha: sha || null,
          agent: null, owner: null, deps: [],
          docs: "", subtasks: [], notes: [],
          addressable: true,
        };
        currentPhase.lanes[currentLane].push(currentTask);
        currentField = null;
        continue;
      }

      if (currentTask) {
        const metaMatch = line.match(metaRe);
        if (metaMatch) {
          const key = metaMatch[1].toLowerCase();
          const value = metaMatch[2].trim();
          if (key === "agent") { currentTask.agent = value.replace(/^`(.*)`$/, "$1") || "—"; currentField = null; }
          else if (key === "owner") { currentTask.owner = value.replace(/^`(.*)`$/, "$1"); currentField = null; }
          else if (key === "deps") {
            const cleaned = value.replace(/`/g, "");
            currentTask.deps = cleaned.toLowerCase() === "none" || !cleaned
              ? [] : cleaned.split(",").map((d) => d.trim()).filter(Boolean);
            currentField = null;
          } else if (key === "docs") { currentTask.docs = value; currentField = null; }
          else if (key === "subtasks") { currentField = "subtasks"; }
          else if (key === "notes") {
            if (/_\(empty\)_/.test(value)) currentTask.notes = [];
            else if (value) currentTask.notes.push(value);
            currentField = "notes";
          }
          continue;
        }

        const subtaskMatch = line.match(subtaskRe);
        if (subtaskMatch && currentField === "subtasks") {
          const [, mark, text] = subtaskMatch;
          currentTask.subtasks.push({ done: mark.toLowerCase() === "x", text: text.trim() });
          continue;
        }

        const noteMatch = line.match(noteBulletRe);
        if (noteMatch && currentField === "notes" && !subtaskMatch) {
          if (!/_\(empty\)_/.test(noteMatch[1])) currentTask.notes.push(noteMatch[1].trim());
          continue;
        }
      }

      const legacyMatch = line.match(legacyRe);
      if (legacyMatch && !line.includes("**[")) {
        const [, emoji, title] = legacyMatch;
        currentPhase.lanes[currentLane].push({
          id: null,
          phase: currentPhase.version, phaseSlug: currentPhase.slug, lane: currentLane,
          status: STATUS_FROM_EMOJI[emoji], title: title.trim(),
          commitSha: null, agent: null, owner: null, deps: [],
          docs: "", subtasks: [], notes: [], addressable: false,
        });
        currentTask = null;
        currentField = null;
        continue;
      }
    }

    if (line.startsWith("## ") || line.startsWith("---")) {
      currentTask = null;
      currentField = null;
    }
  }

  return doc;
}
