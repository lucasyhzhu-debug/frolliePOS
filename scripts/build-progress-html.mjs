#!/usr/bin/env node
// Build docs/progress.html from docs/PROGRESS.md.
// Run: node scripts/build-progress-html.mjs
// Re-run after every /progress-update to keep the rendered ledger in sync.

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SRC = resolve(REPO_ROOT, "docs/PROGRESS.md");
const OUT = resolve(REPO_ROOT, "docs/progress.html");

// ─── parse ────────────────────────────────────────────────────────────────

const STATUS_FROM_EMOJI = {
  "✅": "done",
  "🔄": "in-progress",
  "📋": "planned",
  "🗂️": "backlog",
};
const STATUS_EMOJI = Object.fromEntries(
  Object.entries(STATUS_FROM_EMOJI).map(([k, v]) => [v, k]),
);
const LANE_FROM_SECTION = {
  "Backend": "be",
  "Frontend": "fe",
  "Cross-cutting": "xc",
};

function parseProgressMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const doc = {
    mission: "",
    phases: [],
    risks: [],
    decisions: [],
  };

  let currentPhase = null;
  let currentLane = null;
  let currentTask = null;
  let currentField = null;
  let currentPhaseField = null;
  let inCodeFence = false;
  let inSection = null;

  const phaseRe = /^##\s+(v\d+(?:\.\d+)+)\s+—\s+(.+?)\s+(✅|🔄|📋|🗂️)\s+(.+)$/;
  const laneRe = /^###\s+(Backend|Frontend|Cross-cutting)\b/;
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

    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    if (!doc.mission) {
      const m = line.match(missionRe);
      if (m) {
        doc.mission = m[1].trim();
        continue;
      }
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
      if (heading.startsWith("how agents")) {
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
              title: r[1].trim(),
              body: r[3].trim(),
              resolved: true,
              resolvedAt: r[2],
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
        subtitle: "",
        outcome: "",
        target: "",
        shippedLine: "",
        youGet: [],
        youDontGet: [],
        lanes: { be: [], fe: [], xc: [] },
      };
      doc.phases.push(currentPhase);
      currentLane = null; currentTask = null; currentField = null; currentPhaseField = null;
      inSection = null;
      continue;
    }

    if (currentPhase && !currentLane) {
      const om = line.match(outcomeRe);
      if (om) {
        currentPhase.outcome = om[1].trim();
        currentPhaseField = null;
        continue;
      }
      const tm = line.match(targetRe);
      if (tm) {
        currentPhase.target = tm[1].trim();
        currentPhaseField = null;
        continue;
      }
      if (/^\*\*You(?:'ll| can| will)? be able to:\*\*/i.test(line.trim()) || /^\*\*What you (?:get|can do):\*\*/i.test(line.trim())) {
        currentPhaseField = "youGet";
        continue;
      }
      if (/^\*\*Still not yet/i.test(line.trim()) || /^\*\*Not yet/i.test(line.trim()) || /^\*\*You (?:won't|can't) (?:yet|be able to)/i.test(line.trim())) {
        currentPhaseField = "youDontGet";
        continue;
      }
      if (currentPhaseField) {
        const bm = line.match(/^-\s+(.+)$/);
        if (bm) {
          currentPhase[currentPhaseField].push(bm[1].trim());
          continue;
        }
        if (line.trim() && !line.startsWith("###") && !line.startsWith("##")) {
          currentPhaseField = null;
        }
      }
      if (/^Merged\b/i.test(line.trim())) {
        currentPhase.shippedLine = line.trim();
        continue;
      }
      if (!currentPhase.subtitle && line.trim() && !line.startsWith("#") && !line.startsWith("---") && !line.startsWith("**") && !line.startsWith("-")) {
        currentPhase.subtitle = line.trim();
        continue;
      }
    }

    const laneMatch = line.match(laneRe);
    if (laneMatch && currentPhase) {
      currentLane = LANE_FROM_SECTION[laneMatch[1]];
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
          agent: null,
          owner: null,
          deps: [],
          docs: "",
          subtasks: [],
          notes: [],
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
          if (key === "agent") {
            currentTask.agent = value.replace(/^`(.*)`$/, "$1") || "—";
            currentField = null;
          } else if (key === "owner") {
            currentTask.owner = value.replace(/^`(.*)`$/, "$1");
            currentField = null;
          } else if (key === "deps") {
            const cleaned = value.replace(/`/g, "");
            currentTask.deps = cleaned.toLowerCase() === "none" || !cleaned
              ? []
              : cleaned.split(",").map((d) => d.trim()).filter(Boolean);
            currentField = null;
          } else if (key === "docs") {
            currentTask.docs = value;
            currentField = null;
          } else if (key === "subtasks") {
            currentField = "subtasks";
          } else if (key === "notes") {
            if (/_\(empty\)_/.test(value)) {
              currentTask.notes = [];
            } else if (value) {
              currentTask.notes.push(value);
            }
            currentField = "notes";
          }
          continue;
        }

        const subtaskMatch = line.match(subtaskRe);
        if (subtaskMatch && currentField === "subtasks") {
          const [, mark, text] = subtaskMatch;
          currentTask.subtasks.push({
            done: mark.toLowerCase() === "x",
            text: text.trim(),
          });
          continue;
        }

        const noteMatch = line.match(noteBulletRe);
        if (noteMatch && currentField === "notes" && !subtaskMatch) {
          if (!/_\(empty\)_/.test(noteMatch[1])) {
            currentTask.notes.push(noteMatch[1].trim());
          }
          continue;
        }
      }

      const legacyMatch = line.match(legacyRe);
      if (legacyMatch && !line.includes("**[")) {
        const [, emoji, title] = legacyMatch;
        currentPhase.lanes[currentLane].push({
          id: null,
          phase: currentPhase.version,
          phaseSlug: currentPhase.slug,
          lane: currentLane,
          status: STATUS_FROM_EMOJI[emoji],
          title: title.trim(),
          commitSha: null,
          agent: null,
          owner: null,
          deps: [],
          docs: "",
          subtasks: [],
          notes: [],
          addressable: false,
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

// ─── computation ─────────────────────────────────────────────────────────

function computeStats(doc) {
  const allTasks = doc.phases.flatMap((p) => Object.values(p.lanes).flat());
  const addressable = allTasks.filter((t) => t.addressable);
  const taskIndex = new Map(addressable.map((t) => [t.id, t]));

  for (const task of addressable) {
    task.depsResolved = task.deps.map((depId) => {
      const dep = taskIndex.get(depId);
      return {
        id: depId,
        status: dep ? dep.status : "missing",
        title: dep ? dep.title : null,
      };
    });
    task.ready =
      task.status === "planned" &&
      task.depsResolved.every((d) => d.status === "done");
    task.blocked =
      task.status === "planned" &&
      task.deps.length > 0 &&
      !task.depsResolved.every((d) => d.status === "done");
  }

  for (const phase of doc.phases) {
    const tasks = Object.values(phase.lanes).flat();
    const addr = tasks.filter((t) => t.addressable);
    phase.counts = {
      total: tasks.length,
      addressable: addr.length,
      done: tasks.filter((t) => t.status === "done").length,
      inProgress: tasks.filter((t) => t.status === "in-progress").length,
      planned: tasks.filter((t) => t.status === "planned").length,
      backlog: tasks.filter((t) => t.status === "backlog").length,
      ready: addr.filter((t) => t.ready).length,
      blocked: addr.filter((t) => t.blocked).length,
    };
    phase.subtaskTotals = addr.reduce(
      (acc, t) => {
        acc.done += t.subtasks.filter((s) => s.done).length;
        acc.total += t.subtasks.length;
        return acc;
      },
      { done: 0, total: 0 },
    );
    phase.shippedDate = extractShippedDate(phase.shippedLine);
  }

  const activePhase = doc.phases.find((p) => p.status === "planned" || p.status === "in-progress");

  // Critical path through the active phase
  const downstreamMemo = new Map();
  function longestDownstream(id) {
    if (downstreamMemo.has(id)) return downstreamMemo.get(id);
    const downstream = [...taskIndex.values()].filter((t) => t.deps.includes(id));
    let best = [id];
    for (const d of downstream) {
      const tail = longestDownstream(d.id);
      if (1 + tail.length > best.length) {
        best = [id, ...tail.slice(0).map((x) => x)];
      }
    }
    downstreamMemo.set(id, best);
    return best;
  }
  let criticalPath = [];
  if (activePhase) {
    const readyInActive = Object.values(activePhase.lanes).flat().filter((t) => t.ready);
    for (const r of readyInActive) {
      const chain = longestDownstream(r.id);
      if (chain.length > criticalPath.length) criticalPath = chain;
    }
  }

  const activeDecisions = (doc.decisions || []).filter((d) => !d.resolved);
  const resolvedDecisions = (doc.decisions || []).filter((d) => d.resolved);

  // Last-ship date across all shipped phases
  const shippedDates = doc.phases
    .filter((p) => p.status === "done" && p.shippedDate)
    .map((p) => p.shippedDate.getTime());
  const lastShipDate = shippedDates.length ? new Date(Math.max(...shippedDates)) : null;

  const globalCounts = {
    phases: doc.phases.length,
    tasks: allTasks.length,
    addressable: addressable.length,
    done: allTasks.filter((t) => t.status === "done").length,
    inProgress: allTasks.filter((t) => t.status === "in-progress").length,
    planned: allTasks.filter((t) => t.status === "planned").length,
    backlog: allTasks.filter((t) => t.status === "backlog").length,
    ready: addressable.filter((t) => t.ready).length,
    blocked: addressable.filter((t) => t.blocked).length,
    shippedPhases: doc.phases.filter((p) => p.status === "done").length,
    activePhase: activePhase?.version || null,
    activePhaseSlug: activePhase?.slug || null,
    activeDecisions: activeDecisions.length,
    resolvedDecisions: resolvedDecisions.length,
    lastShipDate: lastShipDate ? lastShipDate.toISOString().slice(0, 10) : null,
    roadmapPct: doc.phases.length ? Math.round((doc.phases.filter((p) => p.status === "done").length / doc.phases.length) * 100) : 0,
    criticalPath,
  };

  return { ...doc, globalCounts };
}

function extractShippedDate(shippedLine) {
  if (!shippedLine) return null;
  const m = shippedLine.match(/Merged\s+(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

// ─── render helpers ──────────────────────────────────────────────────────

const escapeHtml = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);

// Render a single inline-formatted string. Order matters:
//   1. escape HTML
//   2. links (so labels can contain other tokens)
//   3. code spans (protect contents from further markdown)
//   4. strikethrough
//   5. bold (must come before single-* italic)
//   6. italic underscores (boundary-safe — won't trigger inside identifiers)
//   7. italic asterisks (after bold so it doesn't trip on **...**)
function renderInline(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>`,
  );
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(>\-—,:;])_([^_\n]+?)_(?=$|[\s,.:;!?)<\-—])/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(>])\*([^*\n]+?)\*(?=$|[\s,.:;!?)<])/g, "$1<em>$2</em>");
  return html;
}

const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MONTHS_FRIENDLY = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function ordinal(n) {
  const s = ["th","st","nd","rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function ordinalWord(n) {
  const names = [
    "zeroth","first","second","third","fourth","fifth","sixth","seventh","eighth","ninth",
    "tenth","eleventh","twelfth","thirteenth","fourteenth","fifteenth","sixteenth","seventeenth","eighteenth","nineteenth",
    "twentieth","twenty-first","twenty-second","twenty-third","twenty-fourth","twenty-fifth","twenty-sixth","twenty-seventh","twenty-eighth","twenty-ninth",
    "thirtieth","thirty-first",
  ];
  return names[n] || ordinal(n);
}

const NUMBER_WORDS = [
  "zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen","twenty",
];
function numberWord(n) {
  if (n >= 0 && n < NUMBER_WORDS.length) return NUMBER_WORDS[n];
  if (n < 100) {
    const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];
    const t = Math.floor(n / 10);
    const o = n % 10;
    return o ? `${tens[t]}-${NUMBER_WORDS[o]}` : tens[t];
  }
  return String(n);
}

function romanNumeral(n) {
  const map = [
    [1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],
    [50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"],
  ];
  let s = "";
  for (const [v, sym] of map) { while (n >= v) { s += sym; n -= v; } }
  return s;
}

function formatLongDate(d) {
  const century = numberWord(Math.floor(d.getFullYear() / 100));
  const yearWithin = numberWord(d.getFullYear() % 100);
  return `${ordinalWord(d.getDate())} of ${MONTHS_LONG[d.getMonth()]}, ${century} ${yearWithin}`;
}

function formatStampDate(d) {
  return `${String(d.getDate()).padStart(2, "0")} · ${MONTHS_SHORT[d.getMonth()]} · ${romanNumeral(d.getFullYear())}`;
}

function formatHumanDate(iso) {
  const m = iso?.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const century = numberWord(Math.floor(d.getUTCFullYear() / 100));
  const yearWithin = numberWord(d.getUTCFullYear() % 100);
  return `the ${ordinalWord(d.getUTCDate())} of ${MONTHS_LONG[d.getUTCMonth()]}, ${century} ${yearWithin}`;
}

function formatShippedShort(date) {
  if (!date) return "shipped";
  return `shipped ${date.getUTCDate()} ${MONTHS_FRIENDLY[date.getUTCMonth()]}`;
}

function formatTarget(phase) {
  if (phase.status === "done") return formatShippedShort(phase.shippedDate);
  if (phase.target && phase.target.toLowerCase() !== "tbd") return `target ${phase.target}`;
  return "target TBD";
}

function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

function relativeDaysAgo(iso, today) {
  if (!iso) return "—";
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "—";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const n = daysBetween(d, todayUTC);
  if (n === 0) return "shipped today";
  if (n === 1) return "shipped yesterday";
  if (n < 7) return `shipped ${n} days ago`;
  if (n < 14) return `shipped a week ago`;
  if (n < 30) return `shipped ${Math.floor(n / 7)} weeks ago`;
  return `shipped ${Math.floor(n / 30)} months ago`;
}

// ─── render: status strip (top-of-page CEO scoreboard) ───────────────────

function renderStatusStrip(doc) {
  const g = doc.globalCounts;
  const phases = doc.phases;
  const active = phases.find((p) => p.version === g.activePhase);

  const segs = phases.map((p) => {
    let cls = "seg-planned";
    if (p.status === "done") cls = "seg-done";
    else if (p.version === g.activePhase) cls = "seg-active";
    return `<a href="#phase-${p.slug}" class="seg ${cls}" title="${p.version} — ${escapeHtml(p.title)}"><span class="seg-version">${p.version}</span></a>`;
  }).join("");

  const phasesUntilV1 = phases.length - g.shippedPhases;
  const lastShip = g.lastShipDate ? relativeDaysAgo(g.lastShipDate, new Date()) : "no ships yet";

  let nextBlock;
  if (active) {
    const target = active.target && active.target.toLowerCase() !== "tbd"
      ? escapeHtml(active.target)
      : `<em class="tbd">TBD</em>`;
    const c = active.counts;
    nextBlock = `
      <p class="status-eyebrow">Next in composition</p>
      <h2 class="status-headline">
        <span class="status-version-num">${active.version}</span>
        <span class="status-version-title">${escapeHtml(active.title)}</span>
      </h2>
      <dl class="status-stats">
        <div class="stat-row"><dt>Target</dt><dd>${target}</dd></div>
        <div class="stat-row"><dt>Ready</dt><dd><strong class="num">${c.ready}</strong> <span class="dim">of</span> <strong class="num">${c.addressable}</strong> tasks</dd></div>
        <div class="stat-row"><dt>Blocked</dt><dd>${numberWord(c.blocked)} ${c.blocked === 1 ? "task awaits" : "tasks await"} upstream work</dd></div>
        <div class="stat-row"><dt>On your desk</dt><dd>${g.activeDecisions === 0 ? "no decisions await" : `<strong class="num">${g.activeDecisions}</strong> decision${g.activeDecisions === 1 ? "" : "s"} await${g.activeDecisions === 1 ? "s" : ""} <a href="#desk" class="goto">▾ go</a>`}</dd></div>
      </dl>`;
  } else {
    nextBlock = `<p class="status-eyebrow">Roadmap complete</p><h2 class="status-headline">All phases shipped.</h2>`;
  }

  return `<section class="status-strip" aria-label="Where the build is right now">
    <div class="status-percent">
      <div class="percent-display">
        <span class="percent-num">${g.roadmapPct}</span><span class="percent-sign">%</span>
      </div>
      <p class="percent-caption">of the road to <em>v1.0</em></p>
      <div class="roadmap-segments" style="--n: ${phases.length}">${segs}</div>
      <p class="percent-foot">${numberWord(phasesUntilV1)} phase${phasesUntilV1 === 1 ? "" : "s"} remain · ${lastShip}</p>
    </div>
    <div class="status-next">
      ${nextBlock}
    </div>
  </section>`;
}

// ─── render: coming-next hero (active phase checklist promoted) ──────────

function renderComingNext(doc) {
  const active = doc.phases.find((p) => p.version === doc.globalCounts.activePhase);
  if (!active) return "";
  const hasGet = active.youGet?.length > 0;
  const hasDont = active.youDontGet?.length > 0;
  if (!hasGet && !hasDont) return "";

  const target = active.target && active.target.toLowerCase() !== "tbd"
    ? escapeHtml(active.target)
    : `<em class="tbd">TBD</em>`;

  return `<section class="coming-next" aria-labelledby="coming-headline">
    <header class="coming-head">
      <div class="coming-meta-left">
        <p class="coming-eyebrow">Coming next</p>
        <h2 class="coming-title" id="coming-headline">
          <span class="coming-version">${active.version}</span>
          <span class="coming-sep">·</span>
          <span class="coming-name">${escapeHtml(active.title)}</span>
        </h2>
      </div>
      <div class="coming-meta-right">
        <p class="coming-target-label">Target</p>
        <p class="coming-target-value">${target}</p>
      </div>
    </header>
    <p class="coming-outcome">${renderInline(active.outcome || "")}</p>
    <div class="coming-grid">
      ${hasGet ? `<div class="coming-col coming-get">
        <p class="coming-label"><span class="glyph glyph-check">✓</span> <span>You'll be able to</span></p>
        <ul class="coming-list">${active.youGet.map((b) => `<li><span class="bullet-glyph">✓</span><span class="bullet-text">${renderInline(b)}</span></li>`).join("")}</ul>
      </div>` : ""}
      ${hasDont ? `<div class="coming-col coming-dont">
        <p class="coming-label"><span class="glyph glyph-cross">✕</span> <span>Still not yet</span></p>
        <ul class="coming-list">${active.youDontGet.map((b) => `<li><span class="bullet-glyph">✕</span><span class="bullet-text">${renderInline(b)}</span></li>`).join("")}</ul>
      </div>` : ""}
    </div>
  </section>`;
}

// ─── render: decisions (promoted from tail to mid-page) ──────────────────

function renderDesk(doc) {
  const active = (doc.decisions || []).filter((d) => !d.resolved);
  const resolved = (doc.decisions || []).filter((d) => d.resolved);
  if (active.length === 0 && resolved.length === 0) return "";

  const activeN = active.length;
  const eyebrowSuffix = activeN === 0
    ? "no decisions await — desk is clear"
    : `${numberWord(activeN)} decision${activeN === 1 ? "" : "s"} await${activeN === 1 ? "s" : ""}`;

  return `<section class="desk" id="desk" aria-label="Decisions awaiting the CEO">
    <header class="desk-head">
      <p class="section-eyebrow">Your desk · ${eyebrowSuffix}</p>
      <h2 class="section-title">In the margin, awaiting reply</h2>
    </header>
    ${active.length ? `<div class="desk-cards">
      ${active.map((d, i) => `<article class="desk-card">
        <span class="desk-card-ord">${romanNumeral(i + 1)}</span>
        <div class="desk-card-body">
          ${d.title ? `<h3 class="desk-card-title">${renderInline(d.title)}</h3>` : ""}
          <p class="desk-card-text">${renderInline(d.body)}</p>
        </div>
        <span class="desk-stamp">Your call needed</span>
      </article>`).join("")}
    </div>` : `<p class="desk-empty">Nothing awaits your judgement today.</p>`}
    ${resolved.length ? `<div class="desk-resolved">
      <p class="desk-resolved-divider"><span>Recently resolved</span></p>
      <ul class="desk-resolved-list">
        ${resolved.map((d) => `<li class="resolved-item">
          <span class="resolved-check">✓</span>
          <span class="resolved-body">
            ${d.title ? `<strong class="resolved-title">${renderInline(d.title)}</strong>` : ""}
            <span class="resolved-text">${renderInline(d.body)}</span>
            ${d.resolvedAt ? `<span class="resolved-when">resolved ${formatShippedShort(new Date(d.resolvedAt)).replace(/^shipped\s+/, "")} ${d.resolvedAt.slice(0, 4)}</span>` : ""}
          </span>
        </li>`).join("")}
      </ul>
    </div>` : ""}
  </section>`;
}

// ─── render: per-phase checklist (used inside ladder rungs) ──────────────

function renderChecklist(phase) {
  const hasGet = phase.youGet?.length > 0;
  const hasDont = phase.youDontGet?.length > 0;
  if (!hasGet && !hasDont) return "";
  const getLabel = phase.status === "done" ? "You can" : "You'll be able to";
  const dontLabel = phase.status === "done" ? "You still can't" : "Still not yet";

  return `<div class="rung-checklist">
    ${hasGet ? `<div class="checklist-col checklist-get">
      <p class="checklist-label"><span class="glyph glyph-check">✓</span> <span>${getLabel}</span></p>
      <ul class="checklist-items">${phase.youGet.map((b) => `<li><span class="bullet-glyph">✓</span><span class="bullet-text">${renderInline(b)}</span></li>`).join("")}</ul>
    </div>` : ""}
    ${hasDont ? `<div class="checklist-col checklist-dont">
      <p class="checklist-label"><span class="glyph glyph-cross">✕</span> <span>${dontLabel}</span></p>
      <ul class="checklist-items">${phase.youDontGet.map((b) => `<li><span class="bullet-glyph">✕</span><span class="bullet-text">${renderInline(b)}</span></li>`).join("")}</ul>
    </div>` : ""}
  </div>`;
}

// ─── render: milestone ladder (compact; active auto-expanded) ────────────

function renderEtaPill(phase) {
  if (phase.status === "done") {
    return `<span class="eta-pill eta-shipped">${escapeHtml(formatShippedShort(phase.shippedDate))}</span>`;
  }
  if (phase.status === "in-progress" || phase.target) {
    const label = phase.target && phase.target.toLowerCase() !== "tbd"
      ? `target ${phase.target}`
      : "target TBD";
    const cls = phase.target && phase.target.toLowerCase() !== "tbd" ? "eta-active" : "eta-tbd";
    return `<span class="eta-pill ${cls}">${escapeHtml(label)}</span>`;
  }
  return `<span class="eta-pill eta-tbd">target TBD</span>`;
}

function renderSeal(phase, isActive) {
  if (phase.status === "done") return `<span class="seal seal-delivered">delivered</span>`;
  if (phase.status === "in-progress") return `<span class="seal seal-active">in flight</span>`;
  if (isActive) return `<span class="seal seal-active">active</span>`;
  return `<span class="seal seal-backlog">backlog</span>`;
}

function renderMilestoneLadder(doc) {
  return doc.phases.map((p) => {
    const isActive = p.version === doc.globalCounts.activePhase;
    const isDone = p.status === "done";
    const seal = renderSeal(p, isActive);
    const eta = renderEtaPill(p);

    if (isActive) {
      return `<article class="rung rung-active phase-${p.status}" data-phase="${p.slug}" id="phase-${p.slug}">
        <div class="rung-pointer" aria-hidden="true">→</div>
        <header class="rung-head">
          <span class="rung-version">${p.version}</span>
          <h3 class="rung-title">${escapeHtml(p.title)}</h3>
          <div class="rung-tags">${seal}${eta}</div>
        </header>
        <p class="rung-outcome">${renderInline(p.outcome || "")}</p>
        ${renderChecklist(p)}
      </article>`;
    }

    return `<article class="rung phase-${p.status}" data-phase="${p.slug}" id="phase-${p.slug}">
      <details>
        <summary class="rung-head rung-summary">
          <span class="rung-version">${p.version}</span>
          <h3 class="rung-title ${isDone ? "is-struck" : ""}">${escapeHtml(p.title)}</h3>
          <div class="rung-tags">${seal}${eta}</div>
          <span class="rung-disclosure" aria-hidden="true">›</span>
        </summary>
        <div class="rung-body">
          <p class="rung-outcome">${renderInline(p.outcome || "")}</p>
          ${renderChecklist(p)}
        </div>
      </details>
    </article>`;
  }).join("");
}

// ─── render: risks (lifted from tail) ────────────────────────────────────

function renderRisks(doc) {
  if (!doc.risks?.length) return "";
  return `<section class="risks" aria-label="Risks under watch">
    <header class="section-head">
      <p class="section-eyebrow">Operational watchlist</p>
      <h2 class="section-title">Risks under watch</h2>
    </header>
    <ol class="risk-list">
      ${doc.risks.map((r, i) => `<li class="risk-item">
        <span class="risk-ord">${romanNumeral(i + 1)}.</span>
        <span class="risk-body">${r.title ? `<strong>${renderInline(r.title)}</strong> — ` : ""}${renderInline(r.body)}</span>
      </li>`).join("")}
    </ol>
  </section>`;
}

// ─── render: ledger task (kept for "for the build team" section) ─────────

function renderLedgerTask(task, ordinal) {
  if (!task.addressable) {
    return `<li class="ledger-entry ledger-legacy" data-status="${task.status}" data-lane="${task.lane}" data-phase="${task.phaseSlug}">
      <span class="ledger-ord">${String(ordinal).padStart(2, "0")}</span>
      <span class="ledger-status status-${task.status}">${task.status === "done" ? "delivered" : task.status}</span>
      <span class="ledger-body"><span class="ledger-title ${task.status === "done" ? "is-struck" : ""}">${renderInline(task.title)}</span></span>
    </li>`;
  }

  const subDone = task.subtasks.filter((s) => s.done).length;
  const subTotal = task.subtasks.length;
  let statusWord;
  if (task.status === "done") statusWord = "delivered";
  else if (task.status === "in-progress") statusWord = "in flight";
  else if (task.ready) statusWord = "ready";
  else if (task.blocked) statusWord = "awaiting";
  else if (task.status === "backlog") statusWord = "backlog";
  else statusWord = task.status;

  return `<li class="ledger-entry" id="task-${task.id}"
      data-task-id="${task.id}"
      data-status="${task.status}"
      data-lane="${task.lane}"
      data-phase="${task.phaseSlug}"
      data-agent="${escapeHtml(task.agent || "")}"
      data-deps="${task.deps.join(",")}"
      data-ready="${task.ready ? "true" : "false"}"
      data-blocked="${task.blocked ? "true" : "false"}">
    <details>
      <summary class="ledger-summary">
        <span class="ledger-ord">${String(ordinal).padStart(2, "0")}</span>
        <span class="ledger-status status-${task.status} ${task.ready ? "is-ready" : ""} ${task.blocked ? "is-blocked" : ""}">${statusWord}</span>
        <span class="ledger-body">
          <code class="ledger-id">${task.id}</code>
          <span class="ledger-title ${task.status === "done" ? "is-struck" : ""}">${renderInline(task.title)}</span>
          ${task.deps.length ? `<span class="ledger-deps">depends on ${task.depsResolved.map((d) => {
            const cls = d.status === "done" ? "dep-done" : "dep-wait";
            return `<a href="#task-${d.id}" class="${cls}"><code>${d.id.replace(/^v\d{2}-(be|fe|xc)-/, "")}</code></a>`;
          }).join(", ")}</span>` : ""}
          ${subTotal ? `<span class="ledger-progress">${numberWord(subTotal)} step${subTotal === 1 ? "" : "s"}${subDone ? ` · ${numberWord(subDone)} done` : ""}</span>` : ""}
          ${task.commitSha ? `<span class="ledger-sha">commit <code>${task.commitSha}</code></span>` : ""}
          ${task.owner ? `<span class="ledger-owner">in the hand of ${escapeHtml(task.owner)}</span>` : ""}
        </span>
      </summary>
      <div class="ledger-detail">
        ${task.agent ? `<div class="detail-line"><span class="detail-key">agent</span><span class="detail-val">${escapeHtml(task.agent)}</span></div>` : ""}
        ${task.docs ? `<div class="detail-line"><span class="detail-key">references</span><span class="detail-val">${renderInline(task.docs)}</span></div>` : ""}
        ${subTotal ? `<div class="detail-block"><span class="detail-key">subtasks</span><ol class="subtask-list">${task.subtasks.map((s) => `<li class="${s.done ? "subtask-done" : ""}">${renderInline(s.text)}</li>`).join("")}</ol></div>` : ""}
        ${task.notes.length ? `<div class="detail-block"><span class="detail-key">notes</span><ul class="notes-list">${task.notes.map((n) => `<li>${renderInline(n)}</li>`).join("")}</ul></div>` : ""}
      </div>
    </details>
  </li>`;
}

function renderLanesForPhase(phase) {
  const laneLabels = { be: "Backend", fe: "Frontend", xc: "Cross-cutting" };
  return ["be", "fe", "xc"].map((laneKey) => {
    const tasks = phase.lanes[laneKey] || [];
    if (!tasks.length) return "";
    return `<section class="lane lane-compact" data-lane="${laneKey}">
      <h4>${laneLabels[laneKey]} <span class="lane-meta">${tasks.length} item${tasks.length === 1 ? "" : "s"}</span></h4>
      <ol class="ledger ledger-compact">
        ${tasks.map((t, i) => renderLedgerTask(t, i + 1)).join("\n")}
      </ol>
    </section>`;
  }).join("\n");
}

function renderBuildTeam(doc) {
  const active = doc.phases.find((p) => p.version === doc.globalCounts.activePhase);
  const allOthers = doc.phases.filter((p) => p.version !== doc.globalCounts.activePhase);
  const totalAll = doc.phases.reduce((acc, p) => acc + Object.values(p.lanes).flat().length, 0);
  const g = doc.globalCounts;

  let activeBlock = "";
  if (active) {
    const tasks = Object.values(active.lanes).flat();
    activeBlock = `<details class="build-disc">
      <summary class="build-disc-summary">
        <span class="build-disc-mark">▸</span>
        <span class="build-disc-label">Tasks at hand</span>
        <span class="build-disc-meta">${active.version} · ${tasks.length} items · ${g.ready} ready · ${g.blocked} blocked</span>
      </summary>
      <div class="build-disc-body">
        <p class="build-disc-deck"><em>${renderInline(active.outcome || "")}</em></p>
        <div class="lanes">${renderLanesForPhase(active)}</div>
        ${g.criticalPath.length > 1 ? renderCriticalPath(g.criticalPath) : ""}
      </div>
    </details>`;
  }

  const phaseBlocks = allOthers.map((p) => {
    const tasks = Object.values(p.lanes).flat();
    if (!tasks.length) return "";
    return `<details class="build-sub-disc phase-${p.status}">
      <summary>
        <span class="sub-version">${p.version}</span>
        <span class="sub-title ${p.status === "done" ? "is-struck" : ""}">${escapeHtml(p.title)}</span>
        <span class="sub-meta">${tasks.length} item${tasks.length === 1 ? "" : "s"}</span>
      </summary>
      <div class="build-sub-body">${renderLanesForPhase(p)}</div>
    </details>`;
  }).join("");

  return `<section class="build-team" aria-label="For the build team">
    <header class="section-head">
      <p class="section-eyebrow">For the build team</p>
      <h2 class="section-title">Engineering details</h2>
      <p class="section-deck">The CEO doesn't need this. Task IDs, agent assignments, dependency chains, commit SHAs.</p>
    </header>
    ${activeBlock}
    <details class="build-disc">
      <summary class="build-disc-summary">
        <span class="build-disc-mark">▸</span>
        <span class="build-disc-label">All phases · shipped &amp; backlog</span>
        <span class="build-disc-meta">${totalAll} items across ${doc.phases.length} phases</span>
      </summary>
      <div class="build-disc-body build-disc-phases">
        ${phaseBlocks}
      </div>
    </details>
  </section>`;
}

function renderCriticalPath(chain) {
  const chainHtml = chain
    .map((id) => `<a href="#task-${id}"><code>${id.replace(/^v\d{2}-(be|fe|xc)-/, "")}</code></a>`)
    .join(" <span class=\"arrow\">→</span> ");
  return `<p class="critical-chain-label">Critical path through this phase — ${numberWord(chain.length - 1)} sequential hops:</p>
    <p class="critical-chain">${chainHtml}</p>`;
}

// ─── full page ───────────────────────────────────────────────────────────

function renderPage(doc, generatedAt) {
  const g = doc.globalCounts;
  const now = new Date();
  const stampDate = formatStampDate(now);
  const proseDate = formatLongDate(now);
  const editionNo = String(g.shippedPhases + (g.activePhase ? 1 : 0)).padStart(2, "0");

  const dataJson = JSON.stringify({
    globalCounts: g,
    phases: doc.phases,
    risks: doc.risks,
    decisions: doc.decisions,
    mission: doc.mission,
  }, null, 0).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Frollie POS · The Build Log</title>
<meta name="description" content="Living build log for the Frollie POS — what shipped, what's next, what's risky, what's blocked." />
<meta name="generated-at" content="${generatedAt}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=IBM+Plex+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400;1,500&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
:root {
  --paper: #f4ecd6;
  --paper-inset: #ede4c8;
  --paper-deep: #e5dcbd;
  --ink: #1c1813;
  --ink-soft: #4a3f2e;
  --muted: #7d6f57;
  --rule: rgba(28, 24, 19, 0.16);
  --rule-strong: rgba(28, 24, 19, 0.42);

  --seal: #0f6b5e;
  --seal-deep: #0a4d44;
  --stamp-red: #8a2a1f;
  --stamp-red-soft: rgba(138, 42, 31, 0.08);
  --stamp-amber: #a35e1e;
  --stamp-sepia: #5a4226;
  --cross: #8a2a1f;

  --serif: "Cormorant Garamond", "Iowan Old Style", "Hoefler Text", Georgia, serif;
  --sans: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, "Consolas", "Menlo", monospace;
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--sans);
  background-color: var(--paper);
  background-image:
    radial-gradient(ellipse 80% 50% at 20% 0%, rgba(138, 42, 31, 0.04), transparent 60%),
    radial-gradient(ellipse 60% 50% at 80% 100%, rgba(15, 107, 94, 0.04), transparent 60%);
  color: var(--ink);
  line-height: 1.65;
  font-size: 17px;
  font-weight: 400;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  font-feature-settings: "kern", "liga";
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 1;
  background-image:
    repeating-linear-gradient(45deg, rgba(28, 24, 19, 0.012) 0, rgba(28, 24, 19, 0.012) 1px, transparent 1px, transparent 3px),
    repeating-linear-gradient(-45deg, rgba(28, 24, 19, 0.012) 0, rgba(28, 24, 19, 0.012) 1px, transparent 1px, transparent 3px);
  mix-blend-mode: multiply;
  opacity: 0.5;
}

.num, code { font-family: var(--mono); font-feature-settings: "tnum"; font-variant-numeric: tabular-nums; }
code { font-size: 0.88em; color: var(--stamp-sepia); }

a { color: var(--stamp-red); text-decoration: none; border-bottom: 1px solid rgba(138, 42, 31, 0.35); padding-bottom: 1px; transition: border-color 200ms ease; }
a:hover { border-bottom-color: var(--stamp-red); }

em { font-style: italic; }
s { color: var(--muted); text-decoration-color: var(--muted); text-decoration-thickness: 1px; }

/* ─── page shell ──────────────────────────────────────────────────────── */

.shell { max-width: 1180px; margin: 0 auto; padding: 48px 56px 96px; position: relative; z-index: 2; }
@media (max-width: 760px) { .shell { padding: 28px 22px 64px; } }

/* ─── masthead ────────────────────────────────────────────────────────── */

.masthead {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 28px;
  align-items: start;
  margin-bottom: 36px;
  padding-bottom: 28px;
  border-bottom: 2px solid var(--ink);
  position: relative;
}
.masthead::after {
  content: "";
  position: absolute;
  left: 0; right: 0;
  bottom: -6px;
  height: 1px;
  background: var(--ink);
}

.monogram {
  width: 62px;
  height: 62px;
  border: 1.5px solid var(--stamp-red);
  border-radius: 50%;
  display: grid;
  place-items: center;
  position: relative;
  background: transparent;
  flex-shrink: 0;
}
.monogram::before {
  content: "";
  position: absolute;
  inset: 5px;
  border: 0.5px solid var(--stamp-red);
  border-radius: 50%;
  opacity: 0.7;
}
.monogram-letter {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 500;
  font-size: 32px;
  line-height: 1;
  color: var(--stamp-red);
  margin-top: -3px;
  letter-spacing: -0.02em;
}
.monogram-arc {
  position: absolute;
  inset: 0;
  font-family: var(--mono);
  font-size: 6.5px;
  letter-spacing: 0.24em;
  color: var(--stamp-red);
  text-transform: uppercase;
}
.monogram-arc-top { top: 5px; left: 0; right: 0; text-align: center; }

.masthead-title {
  font-family: var(--serif);
  font-weight: 400;
  font-size: clamp(36px, 5vw, 54px);
  line-height: 1.0;
  letter-spacing: -0.012em;
  margin: 0;
  color: var(--ink);
}
.masthead-title em {
  font-style: italic;
  font-weight: 400;
  display: block;
  color: var(--stamp-red);
  font-size: 0.85em;
  margin-top: 4px;
}
.masthead-deck {
  margin: 12px 0 0;
  font-family: var(--sans);
  font-style: italic;
  font-weight: 400;
  color: var(--ink-soft);
  font-size: clamp(14px, 1.5vw, 16px);
  line-height: 1.55;
  max-width: 50ch;
}

.stamp {
  text-align: right;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.20em;
  text-transform: uppercase;
  color: var(--stamp-sepia);
  line-height: 1.8;
  border-left: 1px solid var(--rule);
  padding-left: 16px;
  white-space: nowrap;
}
.stamp .num { font-size: 11px; color: var(--ink); }
.stamp-edition {
  display: block;
  font-family: var(--serif);
  font-style: italic;
  font-size: 14px;
  letter-spacing: 0;
  text-transform: none;
  color: var(--ink);
  margin-top: 8px;
}
@media (max-width: 760px) {
  .masthead { grid-template-columns: 1fr; }
  .stamp { text-align: left; border-left: none; border-top: 1px solid var(--rule); padding-left: 0; padding-top: 12px; }
}

/* ─── section headings ────────────────────────────────────────────────── */

.section-head { margin: 56px 0 24px; position: relative; }
.section-eyebrow {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.30em;
  text-transform: uppercase;
  color: var(--stamp-red);
  margin: 0 0 8px;
  font-weight: 500;
}
.section-title {
  font-family: var(--serif);
  font-weight: 400;
  font-size: clamp(26px, 3.6vw, 38px);
  line-height: 1.1;
  letter-spacing: -0.01em;
  margin: 0;
  color: var(--ink);
}
.section-deck {
  margin: 12px 0 0;
  font-family: var(--sans);
  font-style: italic;
  font-weight: 400;
  color: var(--muted);
  font-size: 15px;
  line-height: 1.55;
  max-width: 60ch;
}

/* ═════════════════════════════════════════════════════════════════════ */
/* STATUS STRIP — the CEO scoreboard, top of page                        */
/* ═════════════════════════════════════════════════════════════════════ */

.status-strip {
  margin: 8px 0 36px;
  display: grid;
  grid-template-columns: 1fr 1.3fr;
  gap: 56px;
  align-items: stretch;
  padding: 32px 0 20px;
  border-top: 1px solid var(--ink);
  border-bottom: 1px solid var(--ink);
  position: relative;
}
.status-strip::before {
  content: "";
  position: absolute;
  top: 6px;
  left: 0; right: 0;
  height: 1px;
  background: var(--ink);
}
.status-strip::after {
  content: "";
  position: absolute;
  bottom: -6px;
  left: 0; right: 0;
  height: 1px;
  background: var(--ink);
}

@media (max-width: 900px) {
  .status-strip { grid-template-columns: 1fr; gap: 36px; }
}

.status-percent {
  display: grid;
  gap: 14px;
  align-content: start;
  padding-right: 40px;
  border-right: 1px solid var(--rule-strong);
}
@media (max-width: 900px) { .status-percent { padding-right: 0; border-right: none; border-bottom: 1px solid var(--rule); padding-bottom: 28px; } }

.percent-display {
  display: flex;
  align-items: baseline;
  gap: 4px;
  line-height: 0.85;
}
.percent-num {
  font-family: var(--serif);
  font-weight: 400;
  font-style: italic;
  font-size: clamp(96px, 14vw, 156px);
  color: var(--ink);
  letter-spacing: -0.04em;
  font-feature-settings: "lnum", "tnum";
}
.percent-sign {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 400;
  font-size: clamp(40px, 5vw, 60px);
  color: var(--stamp-red);
  line-height: 1;
  margin-left: 2px;
}

.percent-caption {
  font-family: var(--sans);
  font-size: 15px;
  font-weight: 400;
  color: var(--ink-soft);
  margin: -8px 0 0;
  letter-spacing: 0.01em;
}
.percent-caption em {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 500;
  color: var(--stamp-red);
  font-size: 1.1em;
}

.roadmap-segments {
  display: grid;
  grid-template-columns: repeat(var(--n), 1fr);
  gap: 4px;
  margin-top: 12px;
  align-items: stretch;
}
.seg {
  position: relative;
  display: block;
  height: 22px;
  background: transparent;
  border: 1.5px solid var(--ink);
  border-radius: 1px;
  text-decoration: none;
  border-bottom: 1.5px solid var(--ink);
  transition: transform 160ms ease, box-shadow 160ms ease;
  padding: 0;
}
.seg:hover { transform: translateY(-1px); box-shadow: 0 2px 0 var(--ink); }
.seg-done {
  background: var(--seal);
  border-color: var(--seal-deep);
}
.seg-active {
  background: linear-gradient(90deg, var(--stamp-red) 50%, transparent 50%);
  border-color: var(--stamp-red);
}
.seg-planned {
  background: repeating-linear-gradient(45deg, transparent 0, transparent 3px, rgba(28, 24, 19, 0.06) 3px, rgba(28, 24, 19, 0.06) 4px);
}
.seg-version {
  position: absolute;
  bottom: -18px;
  left: 50%;
  transform: translateX(-50%);
  font-family: var(--mono);
  font-size: 9px;
  color: var(--muted);
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.seg-active .seg-version { color: var(--stamp-red); font-weight: 600; }
.seg-done .seg-version { color: var(--seal-deep); font-weight: 500; }

.percent-foot {
  margin: 28px 0 0;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.04em;
  text-transform: lowercase;
}

.status-next {
  display: grid;
  gap: 16px;
  align-content: start;
  padding-left: 4px;
}
.status-eyebrow {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.30em;
  text-transform: uppercase;
  color: var(--stamp-red);
  margin: 0;
  font-weight: 500;
}
.status-headline {
  font-family: var(--serif);
  font-weight: 400;
  font-size: clamp(28px, 3.8vw, 42px);
  line-height: 1.05;
  letter-spacing: -0.012em;
  color: var(--ink);
  margin: 4px 0 0;
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}
.status-version-num {
  font-family: var(--serif);
  font-feature-settings: "onum", "tnum";
  color: var(--stamp-red);
  font-weight: 500;
  flex-shrink: 0;
}
.status-version-title {
  font-style: italic;
  font-weight: 400;
  color: var(--ink);
}

.status-stats {
  margin: 12px 0 0;
  display: grid;
  gap: 6px;
}
.status-stats .stat-row {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 18px;
  align-items: baseline;
  padding: 6px 0;
  border-bottom: 1px dotted var(--rule);
}
.status-stats .stat-row:last-child { border-bottom: none; }
.status-stats dt {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 500;
}
.status-stats dd {
  margin: 0;
  font-family: var(--sans);
  font-size: 16px;
  color: var(--ink);
  line-height: 1.4;
}
.status-stats dd .num { font-weight: 600; font-size: 18px; color: var(--ink); }
.status-stats dd .dim { color: var(--muted); }
.status-stats .tbd {
  font-family: var(--serif);
  font-style: italic;
  color: var(--stamp-amber);
  font-size: 1.05em;
  letter-spacing: 0.02em;
}
.status-stats a.goto {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--stamp-red);
  border-bottom: none;
  margin-left: 4px;
  text-transform: uppercase;
}

/* ═════════════════════════════════════════════════════════════════════ */
/* COMING-NEXT HERO — promotes the active phase's checklist              */
/* ═════════════════════════════════════════════════════════════════════ */

.coming-next {
  margin: 48px 0 0;
  padding: 36px 36px 32px;
  background: var(--paper-inset);
  border: 1px solid var(--ink);
  border-radius: 2px;
  position: relative;
  box-shadow: 4px 4px 0 rgba(28, 24, 19, 0.06);
}
.coming-next::before {
  content: "";
  position: absolute;
  top: -1px; left: 8px; right: 8px;
  height: 6px;
  background: linear-gradient(90deg, var(--stamp-red) 0%, var(--stamp-red) 100%);
  opacity: 0.6;
}
@media (max-width: 760px) { .coming-next { padding: 24px 22px; } }

.coming-head {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 24px;
  align-items: end;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--rule-strong);
  margin-bottom: 18px;
}
@media (max-width: 600px) {
  .coming-head { grid-template-columns: 1fr; gap: 8px; }
}

.coming-eyebrow {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.30em;
  text-transform: uppercase;
  color: var(--stamp-red);
  margin: 0 0 6px;
  font-weight: 500;
}
.coming-title {
  font-family: var(--serif);
  font-weight: 400;
  font-size: clamp(28px, 4vw, 40px);
  line-height: 1.05;
  letter-spacing: -0.012em;
  color: var(--ink);
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 14px;
  flex-wrap: wrap;
}
.coming-version {
  font-family: var(--serif);
  font-feature-settings: "onum", "tnum";
  color: var(--stamp-red);
  font-weight: 500;
}
.coming-sep { color: var(--muted); font-style: italic; }
.coming-name { font-style: italic; }

.coming-meta-right { text-align: right; }
.coming-target-label {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 2px;
}
.coming-target-value {
  font-family: var(--serif);
  font-style: italic;
  font-size: 22px;
  color: var(--ink);
  margin: 0;
  font-feature-settings: "onum", "tnum";
}
.coming-target-value .tbd { color: var(--stamp-amber); }
@media (max-width: 600px) { .coming-meta-right { text-align: left; } }

.coming-outcome {
  font-family: var(--serif);
  font-style: italic;
  font-size: 19px;
  line-height: 1.55;
  color: var(--ink-soft);
  margin: 0 0 24px;
  max-width: 64ch;
}

.coming-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 36px;
  padding-top: 8px;
  border-top: 1px dashed var(--rule);
}
@media (max-width: 760px) {
  .coming-grid { grid-template-columns: 1fr; gap: 28px; }
}

.coming-col { display: grid; gap: 10px; }

.coming-label, .checklist-label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.coming-get .coming-label, .checklist-get .checklist-label { color: var(--seal-deep); }
.coming-dont .coming-label, .checklist-dont .checklist-label { color: var(--stamp-red); }

.glyph {
  display: inline-grid;
  place-items: center;
  width: 22px;
  height: 22px;
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
  border-radius: 2px;
  border: 1.5px solid currentColor;
  line-height: 1;
}
.glyph-check { color: var(--seal-deep); background: rgba(15, 107, 94, 0.08); }
.glyph-cross { color: var(--stamp-red); background: rgba(138, 42, 31, 0.08); }

.coming-list, .checklist-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}
.coming-list li, .checklist-items li {
  display: grid;
  grid-template-columns: 22px 1fr;
  gap: 10px;
  align-items: start;
  font-family: var(--sans);
  font-size: 15.5px;
  line-height: 1.55;
  color: var(--ink);
}
.coming-list .bullet-glyph, .checklist-items .bullet-glyph {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.7;
  text-align: center;
}
.coming-get .bullet-glyph, .checklist-get .bullet-glyph { color: var(--seal-deep); }
.coming-dont .bullet-glyph, .checklist-dont .bullet-glyph { color: var(--stamp-red); }
.coming-dont .bullet-text, .checklist-dont .bullet-text { color: var(--ink-soft); }
.bullet-text code {
  background: rgba(28, 24, 19, 0.05);
  padding: 0 4px;
  border-radius: 2px;
  font-size: 0.86em;
}

/* ═════════════════════════════════════════════════════════════════════ */
/* DESK — decisions awaiting the CEO, promoted up the page               */
/* ═════════════════════════════════════════════════════════════════════ */

.desk { margin: 64px 0 0; }
.desk-head { margin-bottom: 28px; }
.desk-empty {
  font-family: var(--serif);
  font-style: italic;
  font-size: 18px;
  color: var(--muted);
}

.desk-cards { display: grid; gap: 18px; }

.desk-card {
  position: relative;
  display: grid;
  grid-template-columns: 36px 1fr;
  gap: 18px;
  padding: 22px 24px 22px 22px;
  background: var(--paper);
  border: 1.5px solid var(--ink);
  border-radius: 2px;
  box-shadow: 3px 3px 0 rgba(28, 24, 19, 0.08);
}
@media (max-width: 600px) { .desk-card { grid-template-columns: 1fr; } .desk-card .desk-card-ord { font-size: 18px; } }

.desk-card-ord {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 500;
  font-size: 28px;
  color: var(--stamp-red);
  line-height: 1;
  padding-top: 2px;
  text-align: right;
}
.desk-card-body { min-width: 0; }
.desk-card-title {
  font-family: var(--serif);
  font-weight: 500;
  font-size: 22px;
  line-height: 1.2;
  letter-spacing: -0.005em;
  color: var(--ink);
  margin: 0 0 8px;
}
.desk-card-text {
  font-family: var(--sans);
  font-size: 15.5px;
  line-height: 1.55;
  color: var(--ink-soft);
  margin: 0;
  padding-right: 120px;
}
@media (max-width: 760px) { .desk-card-text { padding-right: 0; } }

.desk-stamp {
  position: absolute;
  right: 18px;
  bottom: 16px;
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--stamp-red);
  padding: 6px 12px;
  border: 1.5px solid var(--stamp-red);
  border-radius: 2px;
  background: rgba(138, 42, 31, 0.06);
  transform: rotate(-1.2deg);
  white-space: nowrap;
  box-shadow: 1px 1px 0 rgba(138, 42, 31, 0.15);
}
@media (max-width: 760px) {
  .desk-stamp { position: static; transform: none; margin-top: 16px; align-self: start; display: inline-block; }
}

.desk-resolved { margin-top: 28px; padding-top: 4px; }
.desk-resolved-divider {
  margin: 0 0 14px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.30em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 12px;
}
.desk-resolved-divider::before,
.desk-resolved-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--rule);
}
.desk-resolved-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.resolved-item {
  display: grid;
  grid-template-columns: 22px 1fr;
  gap: 12px;
  align-items: start;
  padding: 8px 0;
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.55;
  color: var(--muted);
}
.resolved-check {
  font-family: var(--mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--seal-deep);
  text-align: center;
  line-height: 1.7;
}
.resolved-body { display: grid; gap: 2px; }
.resolved-title { color: var(--ink-soft); font-style: italic; font-family: var(--serif); font-size: 16px; font-weight: 500; letter-spacing: -0.005em; }
.resolved-text { color: var(--muted); }
.resolved-text s { color: var(--muted); }
.resolved-when {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: lowercase;
  color: var(--muted);
  margin-top: 4px;
}

/* ═════════════════════════════════════════════════════════════════════ */
/* MILESTONE LADDER — compact, active auto-expanded                     */
/* ═════════════════════════════════════════════════════════════════════ */

.ladder { display: grid; gap: 0; border-top: 1.5px solid var(--ink); margin-top: 8px; }

.rung {
  border-bottom: 1px solid var(--rule);
  position: relative;
  padding: 0;
}
.rung:last-child { border-bottom: 1.5px solid var(--ink); }

.rung > details > summary { list-style: none; cursor: pointer; }
.rung > details > summary::-webkit-details-marker { display: none; }

.rung-head, .rung-summary {
  display: grid;
  grid-template-columns: 72px 1fr auto;
  gap: 20px;
  align-items: baseline;
  padding: 22px 0;
}
.rung-summary { padding-right: 28px; position: relative; }
.rung-summary:hover { background-color: rgba(28, 24, 19, 0.03); }

.rung-version {
  font-family: var(--serif);
  font-weight: 400;
  font-size: 32px;
  line-height: 1;
  color: var(--ink);
  font-feature-settings: "onum", "tnum";
  letter-spacing: -0.01em;
}
.phase-done .rung-version { color: var(--muted); }
.phase-backlog .rung-version { color: var(--muted); opacity: 0.65; }
.rung-active .rung-version { color: var(--stamp-red); font-weight: 500; }

.rung-title {
  font-family: var(--serif);
  font-weight: 500;
  font-size: 22px;
  line-height: 1.25;
  margin: 0;
  color: var(--ink);
  letter-spacing: -0.005em;
}
.rung-active .rung-title { color: var(--stamp-red); font-style: italic; }
.phase-backlog .rung-title { color: var(--muted); }

.is-struck { position: relative; color: var(--muted) !important; }
.is-struck::after {
  content: "";
  position: absolute;
  left: -4px; right: -4px;
  top: 50%;
  height: 1.5px;
  background: var(--ink);
  transform: rotate(-0.6deg);
  pointer-events: none;
}

.rung-tags {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
  align-self: start;
  padding-top: 4px;
}

.rung-disclosure {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-family: var(--serif);
  font-size: 22px;
  color: var(--muted);
  transition: transform 200ms ease;
}
.rung > details[open] > summary .rung-disclosure {
  transform: translateY(-50%) rotate(90deg);
  color: var(--stamp-red);
}

.rung-outcome {
  grid-column: 2 / -1;
  margin: 0 0 14px;
  font-family: var(--sans);
  font-size: 16px;
  font-weight: 400;
  color: var(--ink);
  line-height: 1.55;
  padding-left: 0;
}
.rung-summary + div .rung-outcome,
.rung-body .rung-outcome {
  padding-left: 92px;
}
.rung-active > .rung-outcome { padding-left: 92px; }
@media (max-width: 760px) {
  .rung-summary + div .rung-outcome,
  .rung-body .rung-outcome,
  .rung-active > .rung-outcome { padding-left: 0; }
}

.rung-body { padding: 0 0 24px; }

.seal {
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.26em;
  text-transform: uppercase;
  padding: 4px 10px;
  border: 1.5px solid currentColor;
  border-radius: 2px;
  white-space: nowrap;
}
.seal-delivered { color: var(--seal-deep); background: rgba(15, 107, 94, 0.08); border-color: var(--seal); }
.seal-active { color: var(--stamp-red); background: rgba(138, 42, 31, 0.08); border-color: var(--stamp-red); }
.seal-backlog { color: var(--muted); opacity: 0.7; }

.eta-pill {
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.10em;
  text-transform: lowercase;
  padding: 4px 10px;
  border: 1px solid currentColor;
  border-radius: 999px;
  white-space: nowrap;
}
.eta-shipped { color: var(--seal-deep); background: rgba(15, 107, 94, 0.04); }
.eta-active { color: var(--stamp-red); background: rgba(138, 42, 31, 0.06); border-width: 1.5px; }
.eta-tbd { color: var(--stamp-amber); background: rgba(163, 94, 30, 0.06); font-style: italic; }

.rung-active {
  background: linear-gradient(90deg, rgba(138, 42, 31, 0.05) 0%, rgba(138, 42, 31, 0) 60%);
  padding-bottom: 8px;
}
.rung-active .rung-head { padding-bottom: 14px; }
.rung-pointer {
  position: absolute;
  left: -28px;
  top: 26px;
  font-family: var(--serif);
  font-style: italic;
  font-size: 22px;
  color: var(--stamp-red);
}
@media (max-width: 1100px) { .rung-pointer { display: none; } }

.rung-checklist {
  margin: 18px 0 0;
  padding-left: 92px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 28px;
}
.rung:not(.rung-active) .rung-checklist {
  background: rgba(28, 24, 19, 0.025);
  padding: 18px 18px 18px 18px;
  border-left: 2px solid var(--rule-strong);
  border-radius: 0 4px 4px 0;
  margin-left: 92px;
  padding-left: 18px;
}
.phase-done .rung-checklist { opacity: 0.78; }
@media (max-width: 760px) {
  .rung-checklist, .rung:not(.rung-active) .rung-checklist {
    grid-template-columns: 1fr; padding-left: 16px; margin-left: 0; gap: 18px;
  }
}

.checklist-col { display: grid; gap: 8px; }

/* ═════════════════════════════════════════════════════════════════════ */
/* RISKS — kept simple, set in roman-numeral ledger style                */
/* ═════════════════════════════════════════════════════════════════════ */

.risks { margin-top: 64px; }
.risk-list {
  list-style: none;
  margin: 24px 0 0;
  padding: 0;
  border-top: 1px solid var(--rule);
}
.risk-item {
  display: grid;
  grid-template-columns: 36px 1fr;
  gap: 14px;
  padding: 16px 0;
  border-bottom: 1px solid var(--rule);
  align-items: baseline;
}
.risk-ord {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--stamp-red);
  letter-spacing: 0.05em;
  font-weight: 500;
}
.risk-body {
  font-family: var(--sans);
  font-size: 15.5px;
  line-height: 1.6;
  color: var(--ink-soft);
}
.risk-body strong { color: var(--ink); font-weight: 600; }

/* ═════════════════════════════════════════════════════════════════════ */
/* BUILD TEAM — engineering details, collapsed by default                */
/* ═════════════════════════════════════════════════════════════════════ */

.build-team { margin-top: 72px; }

.build-disc {
  border-top: 1px solid var(--rule);
  margin-top: 8px;
}
.build-disc:first-of-type { border-top: 1.5px solid var(--ink); margin-top: 28px; }
.build-disc:last-of-type { border-bottom: 1.5px solid var(--ink); }

.build-disc > summary {
  list-style: none;
  cursor: pointer;
  padding: 20px 0;
  display: grid;
  grid-template-columns: 28px 1fr auto;
  gap: 14px;
  align-items: baseline;
  font-family: var(--sans);
  transition: background-color 160ms ease;
}
.build-disc > summary::-webkit-details-marker { display: none; }
.build-disc > summary:hover { background-color: rgba(28, 24, 19, 0.03); }

.build-disc-mark {
  font-family: var(--serif);
  font-size: 16px;
  color: var(--stamp-red);
  transition: transform 200ms ease;
  text-align: center;
}
.build-disc[open] > summary .build-disc-mark { transform: rotate(90deg); }

.build-disc-label {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 500;
  font-size: 20px;
  color: var(--ink);
  letter-spacing: -0.005em;
}
.build-disc-meta {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.04em;
}

.build-disc-body { padding: 8px 0 32px 42px; }
@media (max-width: 760px) { .build-disc-body { padding-left: 0; } }

.build-disc-deck {
  margin: 0 0 24px;
  font-family: var(--serif);
  font-style: italic;
  font-size: 16px;
  color: var(--muted);
  max-width: 60ch;
}

.lanes { display: grid; gap: 32px; }

.lane h4 {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 500;
  font-size: 18px;
  color: var(--ink-soft);
  margin: 0 0 12px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--rule);
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.lane h4::before { content: "§ "; color: var(--stamp-red); font-style: normal; }
.lane-meta {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
  font-style: normal;
  font-weight: 400;
}

.critical-chain-label {
  margin: 32px 0 4px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--muted);
}
.critical-chain {
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: -0.005em;
  margin: 0;
}
.critical-chain code { color: var(--stamp-red); font-size: 13px; }
.critical-chain .arrow {
  color: var(--muted);
  font-family: var(--serif);
  font-style: italic;
  margin: 0 4px;
}
.critical-chain a { border-bottom: none; }
.critical-chain a:hover code { background: rgba(138, 42, 31, 0.08); border-radius: 2px; padding: 0 2px; }

/* ─── ledger entries (inside build-disc) ───────────────────────────── */

.ledger { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
.ledger-entry { border-bottom: 1px solid var(--rule); }
.ledger-entry:last-child { border-bottom: none; }
.ledger-entry details > summary { list-style: none; cursor: pointer; }
.ledger-entry details > summary::-webkit-details-marker { display: none; }

.ledger-summary {
  display: grid;
  grid-template-columns: 32px 80px 1fr;
  gap: 12px;
  align-items: baseline;
  padding: 12px 0;
  transition: background-color 180ms ease;
}
.ledger-summary:hover { background-color: rgba(28, 24, 19, 0.03); }

.ledger-ord {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--muted);
  text-align: right;
}
.ledger-ord::before { content: "№ "; font-family: var(--serif); font-style: italic; opacity: 0.7; }

.ledger-status {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: lowercase;
  color: var(--muted);
}
.ledger-status.is-ready { color: var(--seal-deep); font-weight: 600; }
.ledger-status.is-blocked { color: var(--stamp-amber); font-style: italic; }
.ledger-status.status-done { color: var(--muted); text-decoration: line-through; }
.ledger-status.status-in-progress { color: var(--stamp-red); font-weight: 600; }

.ledger-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ledger-id { font-family: var(--mono); font-size: 10px; color: var(--muted); letter-spacing: 0.02em; }
.ledger-title {
  font-family: var(--sans);
  font-size: 15.5px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--ink);
  letter-spacing: -0.005em;
}
.ledger-title code { background: rgba(28, 24, 19, 0.04); padding: 0 4px; border-radius: 2px; font-size: 0.86em; color: var(--stamp-sepia); }

.ledger-deps, .ledger-progress, .ledger-sha, .ledger-owner {
  font-family: var(--sans);
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
}
.ledger-deps a { color: var(--muted); border-bottom: 1px dotted currentColor; }
.ledger-deps a.dep-done { color: var(--seal-deep); }
.ledger-deps a.dep-done code { color: var(--seal-deep); }
.ledger-deps a.dep-wait { color: var(--stamp-amber); }
.ledger-deps a.dep-wait code { color: var(--stamp-amber); }
.ledger-deps code { font-size: 12px; }
.ledger-sha code { color: var(--seal-deep); }
.ledger-owner { color: var(--stamp-red); font-style: italic; }

.ledger-detail {
  padding: 8px 0 20px 124px;
  display: grid;
  gap: 14px;
  border-top: 1px dashed var(--rule);
}
@media (max-width: 760px) { .ledger-detail { padding-left: 0; padding-top: 14px; } }
.detail-line { display: grid; grid-template-columns: 88px 1fr; gap: 16px; align-items: baseline; font-size: 13px; }
.detail-key {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.20em;
  text-transform: uppercase;
  color: var(--muted);
}
.detail-val { color: var(--ink-soft); font-size: 14px; font-family: var(--sans); line-height: 1.55; }
.detail-block { display: grid; grid-template-columns: 88px 1fr; gap: 16px; align-items: start; }
.subtask-list {
  margin: 0;
  padding-left: 18px;
  font-size: 14px;
  font-family: var(--sans);
  color: var(--ink-soft);
  display: grid;
  gap: 4px;
  line-height: 1.55;
}
.subtask-list li::marker { font-family: var(--mono); color: var(--muted); font-size: 11px; }
.subtask-list .subtask-done { color: var(--muted); text-decoration: line-through; text-decoration-color: rgba(28, 24, 19, 0.4); }
.notes-list { margin: 0; padding-left: 0; list-style: none; }
.notes-list li { padding: 6px 0; font-size: 14px; font-family: var(--sans); color: var(--ink-soft); border-bottom: 1px dotted var(--rule); line-height: 1.5; }
.notes-list li:last-child { border-bottom: none; }

/* ─── sub-disclosures inside the "all phases" group ──────────────── */

.build-disc-phases { display: grid; gap: 4px; }
.build-sub-disc { border-bottom: 1px solid var(--rule); }
.build-sub-disc:last-child { border-bottom: none; }
.build-sub-disc > summary {
  list-style: none;
  cursor: pointer;
  padding: 14px 0;
  display: grid;
  grid-template-columns: 56px 1fr auto;
  gap: 14px;
  align-items: baseline;
  transition: background-color 160ms ease;
}
.build-sub-disc > summary::-webkit-details-marker { display: none; }
.build-sub-disc > summary:hover { background-color: rgba(28, 24, 19, 0.025); }
.sub-version {
  font-family: var(--serif);
  font-size: 18px;
  font-feature-settings: "onum", "tnum";
  color: var(--muted);
  font-weight: 500;
}
.phase-done .sub-version { color: var(--muted); }
.sub-title {
  font-family: var(--serif);
  font-style: italic;
  font-size: 16px;
  color: var(--ink);
}
.sub-meta {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--muted);
}
.build-sub-body { padding: 6px 0 22px 56px; }
@media (max-width: 760px) { .build-sub-body { padding-left: 0; } }

/* ═════════════════════════════════════════════════════════════════════ */
/* COLOPHON                                                              */
/* ═════════════════════════════════════════════════════════════════════ */

.colophon {
  margin-top: 80px;
  padding-top: 24px;
  border-top: 1px solid var(--rule);
  font-family: var(--sans);
  font-style: italic;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.7;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 24px;
}
.colophon code { font-style: normal; font-size: 12px; }
.colophon-right { text-align: right; font-family: var(--mono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; font-style: normal; }
@media (max-width: 760px) { .colophon { grid-template-columns: 1fr; } .colophon-right { text-align: left; } }

/* ─── print ────────────────────────────────────────────────────────── */

@media print {
  body { background: white; color: black; font-size: 11pt; }
  body::before { display: none; }
  .shell { padding: 0; max-width: 100%; }
  a { color: black; border-bottom-color: black; }
  .build-disc, .rung > details, .ledger-entry > details { }
  .build-disc > summary, .build-sub-disc > summary { display: none; }
  .build-disc-body, .build-sub-body { padding: 0; }
  details[open] > summary .rung-disclosure { display: none; }
  details:not([open]) > .rung-body { display: block !important; }
  .status-strip { page-break-inside: avoid; }
  .coming-next { page-break-inside: avoid; box-shadow: none; }
  .desk-card { box-shadow: none; page-break-inside: avoid; }
  .seg { border-color: #444; }
  .seg-done { background: #ddd; }
  .seg-active { background: linear-gradient(90deg, #888 50%, transparent 50%); }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
</style>
</head>
<body>

<div class="shell">

  <!-- ─── masthead ─── -->
  <header class="masthead">
    <div class="monogram" aria-hidden="true">
      <span class="monogram-arc monogram-arc-top">Frollie · Build Log</span>
      <span class="monogram-letter">F</span>
    </div>
    <div>
      <h1 class="masthead-title">Frollie POS<em>The Build Log.</em></h1>
      <p class="masthead-deck">${renderInline(doc.mission || "Living build log for the booth-side point-of-sale.")}</p>
    </div>
    <div class="stamp">
      <div class="num">${stampDate}</div>
      <div>Jakarta</div>
      <div class="stamp-edition">Edition № ${editionNo}</div>
    </div>
  </header>

  <!-- ─── status strip (CEO scoreboard) ─── -->
  ${renderStatusStrip(doc)}

  <!-- ─── coming next hero ─── -->
  ${renderComingNext(doc)}

  <!-- ─── decisions ─── -->
  ${renderDesk(doc)}

  <!-- ─── milestone ladder ─── -->
  <section class="milestone-section">
    <header class="section-head">
      <p class="section-eyebrow">The roadmap, top down</p>
      <h2 class="section-title">The Milestone Ladder</h2>
      <p class="section-deck">Each phase delivers a specific user outcome. The active phase is open; the rest expand on click.</p>
    </header>
    <div class="ladder">
      ${renderMilestoneLadder(doc)}
    </div>
  </section>

  <!-- ─── risks ─── -->
  ${renderRisks(doc)}

  <!-- ─── build team (engineering, collapsed) ─── -->
  ${renderBuildTeam(doc)}

  <!-- ─── colophon ─── -->
  <footer class="colophon">
    <div>
      Set in Cormorant Garamond &amp; IBM Plex Mono.<br/>
      Generated from <code>docs/PROGRESS.md</code> by <code>scripts/build-progress-html.mjs</code>.
      Task data lives in <code>&lt;script id="kanban-data"&gt;</code> and per-entry <code>data-task-id</code> attributes; agents may grep either path.
    </div>
    <div class="colophon-right">
      ${escapeHtml(generatedAt)}
    </div>
  </footer>

</div>

<script id="kanban-data" type="application/json">${dataJson}</script>

<script>
(() => {
  // Open the target task or phase when navigating via hash
  function openIfHash() {
    const id = location.hash.replace("#task-", "").replace("#phase-", "").replace("#", "");
    if (!id) return;
    const taskEl = document.getElementById("task-" + id);
    if (taskEl) {
      const details = taskEl.querySelector("details");
      if (details) details.open = true;
      let parent = taskEl.parentElement;
      while (parent) {
        if (parent.tagName === "DETAILS") parent.open = true;
        parent = parent.parentElement;
      }
      taskEl.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const phaseEl = document.getElementById("phase-" + id);
    if (phaseEl) {
      const details = phaseEl.querySelector("details");
      if (details) details.open = true;
      let parent = phaseEl.parentElement;
      while (parent) {
        if (parent.tagName === "DETAILS") parent.open = true;
        parent = parent.parentElement;
      }
      phaseEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
  window.addEventListener("hashchange", openIfHash);
  openIfHash();
})();
</script>

</body>
</html>
`;
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
  const md = await readFile(SRC, "utf8");
  const parsed = parseProgressMarkdown(md);
  const doc = computeStats(parsed);

  const generatedAt = new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  const html = renderPage(doc, generatedAt);

  await writeFile(OUT, html, "utf8");

  const g = doc.globalCounts;
  console.log(`✓ wrote ${OUT}`);
  console.log(`  ${doc.phases.length} phases · ${g.addressable} addressable tasks · ${g.tasks} total`);
  console.log(`  ${g.shippedPhases} shipped · ${g.roadmapPct}% of roadmap · ${g.inProgress} in flight · ${g.ready} ready · ${g.blocked} blocked`);
  console.log(`  decisions: ${g.activeDecisions} active · ${g.resolvedDecisions} resolved · risks: ${doc.risks.length}`);
  if (g.criticalPath.length > 1) {
    console.log(`  critical path (${g.criticalPath.length} hops): ${g.criticalPath.join(" → ")}`);
  }
}

main().catch((err) => {
  console.error("✗ build-progress-html failed:", err);
  process.exit(1);
});
