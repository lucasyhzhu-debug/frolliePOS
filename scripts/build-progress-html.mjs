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
  let inCodeFence = false;
  let inSection = null; // "risks" | "decisions" | null

  const phaseRe = /^##\s+(v\d\.\d+)\s+—\s+(.+?)\s+(✅|🔄|📋|🗂️)\s+(.+)$/;
  const laneRe = /^###\s+(Backend|Frontend|Cross-cutting)\b/;
  const addressableRe = /^-\s+(✅|🔄|📋|🗂️)\s+\*\*\[([a-z0-9-]+)\]\*\*\s+(.+?)(?:\s+\(([0-9a-f]{7,40}(?:\s*\/\s*[0-9a-f]{7,40})*)\))?$/;
  const legacyRe = /^-\s+(✅|🔄|📋|🗂️)\s+(.+)$/;
  const metaRe = /^\s{2,}-\s+\*\*([a-z_]+):\*\*\s*(.*)$/i;
  const subtaskRe = /^\s{4,}-\s+\[([x\s])\]\s+(.+)$/i;
  const noteBulletRe = /^\s{4,}-\s+(.+)$/;
  const sectionHeadingRe = /^##\s+(.+)$/;
  const outcomeRe = /^\*\*Outcome:\*\*\s+(.+)$/;
  const missionRe = /^\*\*Mission\.\*\*\s+(.+)$/;
  const bulletRe = /^-\s+(.+)$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    // Mission
    if (!doc.mission) {
      const m = line.match(missionRe);
      if (m) {
        doc.mission = m[1].trim();
        continue;
      }
    }

    // Section heading
    const sectionMatch = line.match(sectionHeadingRe);
    if (sectionMatch) {
      const heading = sectionMatch[1].toLowerCase();
      if (heading.startsWith("risks")) {
        inSection = "risks";
        currentPhase = null;
        currentLane = null;
        currentTask = null;
        currentField = null;
        continue;
      }
      if (heading.startsWith("decisions")) {
        inSection = "decisions";
        currentPhase = null;
        currentLane = null;
        currentTask = null;
        currentField = null;
        continue;
      }
      if (heading.startsWith("how agents")) {
        inSection = "footer";
        currentPhase = null;
        currentLane = null;
        continue;
      }
    }

    // Risks / Decisions bullets
    if (inSection === "risks" || inSection === "decisions") {
      const b = line.match(bulletRe);
      if (b) {
        const text = b[1].trim();
        // Parse "**Title** — description" form
        const titled = text.match(/^\*\*(.+?)\*\*\s*[—-]\s*(.+)$/);
        const entry = titled
          ? { title: titled[1].trim(), body: titled[2].trim() }
          : { title: null, body: text };
        if (inSection === "risks") doc.risks.push(entry);
        else doc.decisions.push(entry);
      }
      continue;
    }

    // Phase header
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
        shippedLine: "",
        lanes: { be: [], fe: [], xc: [] },
      };
      doc.phases.push(currentPhase);
      currentLane = null;
      currentTask = null;
      currentField = null;
      inSection = null;
      continue;
    }

    // Phase outcome / subtitle (before any lane)
    if (currentPhase && !currentLane) {
      const om = line.match(outcomeRe);
      if (om) {
        currentPhase.outcome = om[1].trim();
        continue;
      }
      // Detect "Merged YYYY-MM-DD via PR #N..." shipping line
      if (/^Merged\b/i.test(line.trim())) {
        currentPhase.shippedLine = line.trim();
        continue;
      }
      // Generic subtitle (first non-blank, non-outcome line)
      if (!currentPhase.subtitle && line.trim() && !line.startsWith("#") && !line.startsWith("---") && !line.startsWith("**")) {
        currentPhase.subtitle = line.trim();
        continue;
      }
    }

    // Lane header
    const laneMatch = line.match(laneRe);
    if (laneMatch && currentPhase) {
      currentLane = LANE_FROM_SECTION[laneMatch[1]];
      currentTask = null;
      currentField = null;
      continue;
    }

    if (currentPhase && currentLane) {
      // Addressable task
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

      // Legacy task
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
  }

  // Critical path through the active phase: longest downstream chain from any ready task
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

  const activePhase = doc.phases.find((p) => p.status === "planned" || p.status === "in-progress");
  let criticalPath = [];
  if (activePhase) {
    const readyInActive = Object.values(activePhase.lanes).flat().filter((t) => t.ready);
    for (const r of readyInActive) {
      const chain = longestDownstream(r.id);
      if (chain.length > criticalPath.length) criticalPath = chain;
    }
  }

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
    criticalPath,
  };

  return { ...doc, globalCounts };
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

function renderInline(text) {
  if (!text) return "";
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) =>
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>`,
  );
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return html;
}

const MONTHS_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

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
  // e.g. "twenty-sixth of May, twenty twenty-six"
  const century = numberWord(Math.floor(d.getFullYear() / 100));
  const yearWithin = numberWord(d.getFullYear() % 100);
  return `${ordinalWord(d.getDate())} of ${MONTHS_LONG[d.getMonth()]}, ${century} ${yearWithin}`;
}

function formatStampDate(d) {
  return `${String(d.getDate()).padStart(2, "0")} · ${MONTHS_SHORT[d.getMonth()]} · ${romanNumeral(d.getFullYear())}`;
}

function formatHumanDate(iso) {
  // iso like "2026-05-26" → "the twenty-sixth of May, twenty twenty-six"
  const m = iso?.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const century = numberWord(Math.floor(d.getUTCFullYear() / 100));
  const yearWithin = numberWord(d.getUTCFullYear() % 100);
  return `the ${ordinalWord(d.getUTCDate())} of ${MONTHS_LONG[d.getUTCMonth()]}, ${century} ${yearWithin}`;
}

// ─── exec summary prose ──────────────────────────────────────────────────

function buildExecSummary(doc) {
  const g = doc.globalCounts;
  const phases = doc.phases;
  const sentences = [];

  const active = phases.find((p) => p.version === g.activePhase);

  // Sentence 1 — what's shipped
  const shipped = phases.filter((p) => p.status === "done");
  if (shipped.length === 0) {
    sentences.push(`<p>The build log opens. No phases have yet shipped.</p>`);
  } else if (shipped.length === 1) {
    const s = shipped[0];
    const mergedDate = s.shippedLine.match(/Merged\s+(\d{4}-\d{2}-\d{2})/)?.[1];
    const dateStr = mergedDate ? formatHumanDate(mergedDate) : "earlier";
    sentences.push(`<p><strong>${s.version}</strong> — ${escapeHtml(s.title)} — delivered on ${dateStr}. ${renderInline(s.outcome || "")}</p>`);
  } else {
    const list = shipped.map((s) => `<strong>${s.version}</strong>`).join(", ");
    sentences.push(`<p>Phases ${list} have shipped.</p>`);
  }

  // Sentence 2 — what's next, with prose numbers
  if (active) {
    const c = active.counts;
    const readyN = c.ready;
    const blockedN = c.blocked;
    const totalN = c.addressable;
    sentences.push(
      `<p><strong>${active.version}</strong> — ${escapeHtml(active.title)} — is in composition. ` +
      `Its outcome: <em>${renderInline(active.outcome || active.subtitle || "")}</em> ` +
      `Of ${numberWord(totalN)} planned tasks, ${numberWord(readyN)} ${readyN === 1 ? "is" : "are"} ready to begin; ` +
      `${numberWord(blockedN)} ${blockedN === 1 ? "awaits" : "await"} upstream work.</p>`,
    );

    // Critical path
    if (g.criticalPath.length > 1) {
      const chainHtml = g.criticalPath
        .map((id) => `<a href="#task-${id}"><code>${id.replace(/^v\d{2}-(be|fe|xc)-/, "")}</code></a>`)
        .join(" <span class=\"arrow\">→</span> ");
      sentences.push(
        `<p>The critical path passes through ${numberWord(g.criticalPath.length - 1)} hops:<br><span class="critical-chain">${chainHtml}</span></p>`,
      );
    }
  }

  // Sentence 3 — risks
  if (doc.risks?.length) {
    const top = doc.risks.slice(0, 3);
    const list = top.map((r) => r.title ? `<em>${escapeHtml(r.title)}</em>` : `<em>${escapeHtml(r.body.slice(0, 60))}…</em>`).join("; ");
    sentences.push(`<p>Under watch: ${list}.</p>`);
  }

  // Sentence 4 — decisions
  if (doc.decisions?.length) {
    const top = doc.decisions.slice(0, 3);
    const list = top.map((d) => d.title ? `<em>${escapeHtml(d.title)}</em>` : `<em>${escapeHtml(d.body.slice(0, 60))}…</em>`).join("; ");
    sentences.push(`<p>Queued for your judgement: ${list}.</p>`);
  }

  return sentences.join("\n");
}

// ─── render: milestone ladder ────────────────────────────────────────────

function renderMilestoneLadder(doc) {
  return doc.phases.map((p) => {
    const isActive = p.version === doc.globalCounts.activePhase;
    const c = p.counts;

    let statusLine = "";
    if (p.status === "done") {
      statusLine = `<span class="seal seal-delivered">delivered</span>`;
    } else if (p.status === "in-progress") {
      statusLine = `<span class="seal seal-active">in flight</span>`;
    } else if (isActive) {
      statusLine = `<span class="seal seal-active">in composition</span>`;
    } else if (p.status === "planned") {
      statusLine = `<span class="seal seal-planned">planned</span>`;
    } else {
      statusLine = `<span class="seal seal-backlog">backlog</span>`;
    }

    let trailingNote = "";
    if (p.status === "done") {
      const shipped = p.shippedLine.replace(/`([^`]+)`/g, "<code>$1</code>");
      trailingNote = `<p class="ladder-note">${shipped}</p>`;
    } else if (isActive) {
      trailingNote = `<p class="ladder-note">${numberWord(c.addressable)} addressable tasks · ${numberWord(c.ready)} ready · ${numberWord(c.blocked)} awaiting upstream.</p>`;
    } else {
      trailingNote = `<p class="ladder-note">${c.backlog || c.total} items sketched · plan not yet written.</p>`;
    }

    return `<article class="ladder-rung phase-${p.status} ${isActive ? "ladder-active" : ""}" data-phase="${p.slug}">
      <header class="ladder-head">
        <span class="ladder-version">${p.version}</span>
        <h3 class="ladder-title ${p.status === "done" ? "is-struck" : ""}">${escapeHtml(p.title)}</h3>
        ${statusLine}
      </header>
      <p class="ladder-outcome">${renderInline(p.outcome || p.subtitle || "")}</p>
      ${trailingNote}
    </article>`;
  }).join("\n");
}

// ─── render: tasks at hand (active phase) ───────────────────────────────

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

function renderTasksAtHand(doc) {
  const active = doc.phases.find((p) => p.version === doc.globalCounts.activePhase);
  if (!active) return "";

  const laneLabels = { be: "Backend", fe: "Frontend", xc: "Cross-cutting" };
  const laneSubs = {
    be: "convex/ — server-side functions, schema, integration glue.",
    fe: "src/ — routes, hooks, components, design tokens.",
    xc: "ADRs, schema docs, audit enums, environment.",
  };

  return `<section class="tasks-at-hand" id="phase-${active.slug}">
    <header class="section-head">
      <p class="section-eyebrow">the tasks at hand</p>
      <h2 class="section-title">${active.version} <span class="amp">·</span> ${escapeHtml(active.title)}</h2>
      <p class="section-deck"><em>${renderInline(active.outcome || "")}</em></p>
    </header>
    <div class="lanes">
      ${["be", "fe", "xc"].map((laneKey) => {
        const tasks = active.lanes[laneKey] || [];
        if (!tasks.length) return "";
        return `<section class="lane" data-lane="${laneKey}">
          <header class="lane-head">
            <h3>${laneLabels[laneKey]}</h3>
            <p class="lane-sub">${laneSubs[laneKey]}</p>
            <p class="lane-count">${numberWord(tasks.length)} item${tasks.length === 1 ? "" : "s"}</p>
          </header>
          <ol class="ledger">
            ${tasks.map((t, i) => renderLedgerTask(t, i + 1)).join("\n")}
          </ol>
        </section>`;
      }).join("\n")}
    </div>
  </section>`;
}

// ─── render: future and past phases (collapsed) ──────────────────────────

function renderOtherPhases(doc) {
  const others = doc.phases.filter((p) => p.version !== doc.globalCounts.activePhase);
  return others.map((p) => {
    const items = Object.values(p.lanes).flat();
    return `<details class="other-phase phase-${p.status}" data-phase="${p.slug}" id="phase-${p.slug}">
      <summary>
        <span class="other-version">${p.version}</span>
        <span class="other-title ${p.status === "done" ? "is-struck" : ""}">${escapeHtml(p.title)}</span>
        <span class="other-meta"><em>${renderInline(p.outcome || "")}</em></span>
      </summary>
      <div class="other-body">
        ${["be", "fe", "xc"].map((laneKey) => {
          const tasks = p.lanes[laneKey] || [];
          if (!tasks.length) return "";
          const laneLabels = { be: "Backend", fe: "Frontend", xc: "Cross-cutting" };
          return `<section class="lane lane-compact" data-lane="${laneKey}">
            <h4>${laneLabels[laneKey]}</h4>
            <ol class="ledger ledger-compact">
              ${tasks.map((t, i) => renderLedgerTask(t, i + 1)).join("\n")}
            </ol>
          </section>`;
        }).join("\n")}
      </div>
    </details>`;
  }).join("\n");
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
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=IBM+Plex+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400;1,500&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
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

  --seal: #0f6b5e;       /* Frollie teal — preserved as the verified-seal mark only */
  --seal-deep: #0a4d44;
  --stamp-red: #8a2a1f;  /* ink-stamp red for headlines and accents */
  --stamp-amber: #a35e1e;
  --stamp-sepia: #5a4226;

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
  line-height: 1.7;
  font-size: 18px;
  font-weight: 400;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
  font-feature-settings: "kern", "liga";
}

/* subtle paper grain */
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

/* ─── page shell ────────────────────────────────────────────── */

.shell { max-width: 1180px; margin: 0 auto; padding: 56px 56px 96px; position: relative; z-index: 2; }
@media (max-width: 760px) { .shell { padding: 32px 24px 64px; } }

/* ─── masthead ──────────────────────────────────────────────── */

.masthead {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 32px;
  align-items: start;
  margin-bottom: 48px;
  padding-bottom: 36px;
  border-bottom: 1px solid var(--ink);
  border-bottom-width: 2px;
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
  width: 68px;
  height: 68px;
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
  font-size: 36px;
  line-height: 1;
  color: var(--stamp-red);
  margin-top: -4px;
  letter-spacing: -0.02em;
}
.monogram-arc {
  position: absolute;
  inset: 0;
  font-family: var(--mono);
  font-size: 7px;
  letter-spacing: 0.24em;
  color: var(--stamp-red);
  text-transform: uppercase;
}
.monogram-arc-top {
  top: 6px;
  left: 0; right: 0;
  text-align: center;
}

.masthead-title {
  font-family: var(--serif);
  font-weight: 400;
  font-size: clamp(40px, 6vw, 64px);
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
  font-size: 0.92em;
  margin-top: 4px;
}
.masthead-deck {
  margin: 14px 0 0;
  font-family: var(--sans);
  font-style: italic;
  font-weight: 400;
  color: var(--ink-soft);
  font-size: clamp(15px, 1.6vw, 17px);
  line-height: 1.55;
  max-width: 44ch;
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

/* ─── sections ──────────────────────────────────────────────── */

.section-head {
  margin: 64px 0 32px;
  position: relative;
}
.section-eyebrow {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.30em;
  text-transform: uppercase;
  color: var(--stamp-red);
  margin: 0 0 8px;
}
.section-title {
  font-family: var(--serif);
  font-weight: 400;
  font-size: clamp(28px, 4vw, 42px);
  line-height: 1.1;
  letter-spacing: -0.01em;
  margin: 0;
  color: var(--ink);
}
.section-title .amp { font-style: italic; color: var(--muted); margin: 0 4px; }
.section-deck {
  margin: 14px 0 0;
  font-family: var(--sans);
  font-style: italic;
  font-weight: 400;
  color: var(--ink-soft);
  font-size: 17px;
  line-height: 1.55;
  max-width: 60ch;
}

/* ─── executive summary ───────────────────────────────────────── */

.summary {
  margin-bottom: 64px;
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 64px;
  align-items: start;
}
@media (max-width: 900px) { .summary { grid-template-columns: 1fr; gap: 32px; } }

.summary-prose {
  max-width: 60ch;
  font-size: 19px;
  line-height: 1.7;
  color: var(--ink);
  font-weight: 400;
}
.summary-prose p {
  margin: 0 0 20px;
}
.summary-prose p:last-child { margin-bottom: 0; }
.summary-prose strong { font-weight: 600; color: var(--ink); }
.summary-prose em { color: var(--ink-soft); font-style: italic; }
.summary-prose code { font-size: 0.82em; color: var(--stamp-sepia); }

.critical-chain {
  display: inline-block;
  margin-top: 6px;
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: -0.005em;
}
.critical-chain code { color: var(--stamp-red); font-size: 13px; }
.critical-chain .arrow {
  color: var(--muted);
  font-family: var(--serif);
  font-style: italic;
  margin: 0 2px;
}
.critical-chain a { border-bottom: none; }
.critical-chain a:hover code { background: rgba(138, 42, 31, 0.08); border-radius: 2px; padding: 0 2px; }

.summary-aside {
  border-left: 1px solid var(--rule-strong);
  padding-left: 32px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--muted);
  line-height: 1.7;
}
.summary-aside h4 {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.30em;
  text-transform: uppercase;
  color: var(--stamp-red);
  margin: 0 0 12px;
  font-weight: 400;
}
.summary-aside dl {
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
}
.summary-aside dt { color: var(--muted); }
.summary-aside dd { margin: 0; color: var(--ink); font-family: var(--sans); font-size: 14px; line-height: 1.4; font-feature-settings: "tnum"; font-weight: 500; }
.summary-aside dd em { color: var(--stamp-red); font-style: italic; }
.summary-aside-foot {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--rule);
  font-family: var(--sans);
  font-size: 13px;
  letter-spacing: 0;
  color: var(--muted);
  line-height: 1.6;
}
.summary-aside-foot a { font-family: var(--mono); font-size: 11px; color: var(--stamp-red); letter-spacing: 0.04em; }

/* ─── milestone ladder ───────────────────────────────────────── */

.ladder {
  display: grid;
  gap: 0;
  border-top: 1px solid var(--ink);
}

.ladder-rung {
  display: grid;
  grid-template-columns: 64px 1fr auto;
  gap: 24px;
  align-items: start;
  padding: 28px 0;
  border-bottom: 1px solid var(--rule);
  position: relative;
}
.ladder-rung:last-child { border-bottom: 1px solid var(--ink); }
.ladder-active {
  background: linear-gradient(to right, rgba(138, 42, 31, 0.04), transparent 30%);
}
.ladder-active::before {
  content: "→";
  position: absolute;
  left: -24px;
  top: 32px;
  font-family: var(--serif);
  font-style: italic;
  color: var(--stamp-red);
  font-size: 18px;
}

.ladder-head {
  display: contents;
}
.ladder-version {
  font-family: var(--serif);
  font-weight: 400;
  font-size: 36px;
  line-height: 1;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  font-feature-settings: "onum";
}
.phase-done .ladder-version { color: var(--muted); }
.phase-backlog .ladder-version { color: var(--muted); opacity: 0.6; }

.ladder-title {
  font-family: var(--serif);
  font-weight: 500;
  font-size: 22px;
  line-height: 1.2;
  margin: 0;
  color: var(--ink);
  letter-spacing: -0.005em;
}
.ladder-active .ladder-title { color: var(--stamp-red); }
.phase-backlog .ladder-title { color: var(--muted); }

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

.ladder-outcome {
  grid-column: 2;
  margin: 10px 0 4px;
  font-family: var(--sans);
  font-size: 17px;
  font-weight: 400;
  color: var(--ink);
  line-height: 1.55;
}
.phase-done .ladder-outcome { color: var(--muted); }

.ladder-note {
  grid-column: 2;
  margin: 6px 0 0;
  font-family: var(--sans);
  font-size: 14px;
  color: var(--muted);
  letter-spacing: 0;
  line-height: 1.5;
}
.phase-backlog .ladder-note { opacity: 0.7; }

.seal {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.30em;
  text-transform: uppercase;
  padding: 3px 10px;
  border: 1px solid currentColor;
  border-radius: 2px;
  white-space: nowrap;
  align-self: start;
}
.seal-delivered { color: var(--seal-deep); border-color: var(--seal); background: rgba(15, 107, 94, 0.06); }
.seal-active { color: var(--stamp-red); border-color: var(--stamp-red); background: rgba(138, 42, 31, 0.06); }
.seal-planned { color: var(--stamp-sepia); }
.seal-backlog { color: var(--muted); opacity: 0.6; }

/* ─── tasks at hand ─────────────────────────────────────────── */

.tasks-at-hand { margin: 80px 0 32px; }

.lanes {
  display: grid;
  grid-template-columns: 1fr;
  gap: 56px;
  border-top: 1px solid var(--ink);
  padding-top: 32px;
}

.lane { min-width: 0; }
.lane-head {
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--rule);
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 16px;
  align-items: baseline;
}
.lane-head h3 {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 500;
  font-size: 22px;
  letter-spacing: -0.005em;
  margin: 0;
  color: var(--ink);
}
.lane-head h3::before {
  content: "§ ";
  color: var(--stamp-red);
  font-style: normal;
}
.lane-sub {
  grid-column: 1;
  margin: 4px 0 0;
  font-family: var(--sans);
  font-size: 14px;
  color: var(--muted);
  line-height: 1.5;
}
.lane-count {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.20em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0;
  grid-column: 2;
  grid-row: 1;
}

/* ─── ledger entries ────────────────────────────────────────── */

.ledger {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0;
  counter-reset: ledger;
}

.ledger-entry {
  border-bottom: 1px solid var(--rule);
  animation: rise 700ms cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
}
.ledger-entry:last-child { border-bottom: none; }
@keyframes rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
.ledger-entry:nth-child(1) { animation-delay: 0ms; }
.ledger-entry:nth-child(2) { animation-delay: 40ms; }
.ledger-entry:nth-child(3) { animation-delay: 80ms; }
.ledger-entry:nth-child(4) { animation-delay: 120ms; }
.ledger-entry:nth-child(5) { animation-delay: 160ms; }
.ledger-entry:nth-child(n+6) { animation-delay: 200ms; }

.ledger-entry details > summary { list-style: none; cursor: pointer; }
.ledger-entry details > summary::-webkit-details-marker { display: none; }

.ledger-summary {
  display: grid;
  grid-template-columns: 36px 90px 1fr;
  gap: 16px;
  align-items: baseline;
  padding: 16px 0;
  transition: background-color 180ms ease;
}
.ledger-summary:hover { background-color: rgba(28, 24, 19, 0.03); }

.ledger-ord {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--muted);
  text-align: right;
  padding-top: 4px;
}
.ledger-ord::before { content: "No. "; font-family: var(--serif); font-style: italic; font-size: 12px; opacity: 0.7; }

.ledger-status {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.18em;
  text-transform: lowercase;
  color: var(--muted);
  align-self: start;
  padding-top: 6px;
  font-feature-settings: "smcp";
}
.ledger-status.is-ready { color: var(--seal-deep); font-weight: 500; }
.ledger-status.is-blocked { color: var(--stamp-amber); font-style: italic; }
.ledger-status.status-done { color: var(--muted); text-decoration: line-through; }
.ledger-status.status-in-progress { color: var(--stamp-red); font-weight: 500; }

.ledger-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.ledger-id {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.02em;
}

.ledger-title {
  font-family: var(--sans);
  font-size: 17px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--ink);
  letter-spacing: -0.005em;
}
.ledger-title code {
  background: rgba(28, 24, 19, 0.04);
  padding: 0 4px;
  border-radius: 2px;
  font-size: 0.86em;
  color: var(--stamp-sepia);
}

.ledger-deps, .ledger-progress, .ledger-sha, .ledger-owner {
  font-family: var(--sans);
  font-size: 14px;
  color: var(--muted);
  line-height: 1.5;
  font-weight: 400;
}
.ledger-deps a { color: var(--muted); border-bottom: 1px dotted currentColor; }
.ledger-deps a.dep-done { color: var(--seal-deep); }
.ledger-deps a.dep-done code { color: var(--seal-deep); }
.ledger-deps a.dep-wait { color: var(--stamp-amber); }
.ledger-deps a.dep-wait code { color: var(--stamp-amber); }
.ledger-deps code { font-size: 12px; }
.ledger-sha code { color: var(--seal-deep); }
.ledger-owner { color: var(--stamp-red); font-style: italic; }

/* expanded detail */
.ledger-detail {
  padding: 8px 0 24px 142px;
  display: grid;
  gap: 16px;
  border-top: 1px dashed var(--rule);
  margin-top: -1px;
}
@media (max-width: 760px) { .ledger-detail { padding-left: 0; padding-top: 16px; } }
.detail-line {
  display: grid;
  grid-template-columns: 88px 1fr;
  gap: 16px;
  align-items: baseline;
  font-size: 14px;
}
.detail-key {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.20em;
  text-transform: uppercase;
  color: var(--muted);
}
.detail-val { color: var(--ink-soft); font-size: 15px; font-family: var(--sans); line-height: 1.55; }
.detail-block { display: grid; grid-template-columns: 88px 1fr; gap: 16px; align-items: start; }
.subtask-list {
  margin: 0;
  padding-left: 20px;
  font-size: 15px;
  font-family: var(--sans);
  color: var(--ink-soft);
  display: grid;
  gap: 6px;
  line-height: 1.55;
}
.subtask-list li::marker {
  font-family: var(--mono);
  color: var(--muted);
  font-size: 12px;
}
.subtask-list .subtask-done {
  color: var(--muted);
  text-decoration: line-through;
  text-decoration-color: rgba(28, 24, 19, 0.4);
}
.notes-list {
  margin: 0;
  padding-left: 0;
  list-style: none;
}
.notes-list li {
  padding: 8px 0;
  font-size: 15px;
  font-family: var(--sans);
  color: var(--ink-soft);
  border-bottom: 1px dotted var(--rule);
  line-height: 1.5;
}
.notes-list li:last-child { border-bottom: none; }

/* ─── other phases (collapsed) ──────────────────────────────── */

.other-phases-section { margin-top: 64px; }
.other-phase {
  border-bottom: 1px solid var(--rule);
  padding: 0;
}
.other-phase > summary {
  list-style: none;
  cursor: pointer;
  padding: 20px 0;
  display: grid;
  grid-template-columns: 56px auto 1fr;
  gap: 16px;
  align-items: baseline;
}
.other-phase > summary::-webkit-details-marker { display: none; }
.other-phase > summary::after {
  content: "+";
  position: absolute;
  right: 0;
  font-family: var(--serif);
  font-size: 22px;
  color: var(--muted);
  transition: transform 200ms ease;
}
.other-phase[open] > summary::after { content: "−"; }
.other-phase > summary { position: relative; padding-right: 32px; }

.other-version {
  font-family: var(--serif);
  font-size: 22px;
  font-feature-settings: "onum", "tnum";
  color: var(--muted);
  letter-spacing: -0.01em;
}
.other-title {
  font-family: var(--serif);
  font-style: italic;
  font-size: 18px;
  color: var(--ink);
}
.other-meta {
  font-family: var(--sans);
  font-size: 15px;
  color: var(--muted);
  line-height: 1.5;
}
@media (max-width: 760px) {
  .other-phase > summary { grid-template-columns: 1fr; gap: 4px; }
}

.other-body {
  padding: 8px 0 32px;
  display: grid;
  gap: 32px;
}
.lane-compact h4 {
  font-family: var(--serif);
  font-style: italic;
  font-size: 16px;
  color: var(--ink-soft);
  margin: 0 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px dashed var(--rule);
}
.lane-compact h4::before { content: "§ "; color: var(--stamp-red); font-style: normal; }
.ledger-compact .ledger-summary { padding: 10px 0; grid-template-columns: 32px 80px 1fr; gap: 12px; }
.ledger-compact .ledger-title { font-size: 15px; }

/* ─── risks & decisions ──────────────────────────────────────── */

.tail {
  margin-top: 80px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 64px;
  padding-top: 36px;
  border-top: 1px solid var(--ink);
  border-top-width: 2px;
  position: relative;
}
.tail::before {
  content: "";
  position: absolute;
  top: -6px;
  left: 0; right: 0;
  height: 1px;
  background: var(--ink);
}
@media (max-width: 760px) { .tail { grid-template-columns: 1fr; gap: 40px; } }

.tail-section h3 {
  font-family: var(--serif);
  font-style: italic;
  font-weight: 500;
  font-size: 26px;
  letter-spacing: -0.005em;
  margin: 0 0 6px;
}
.tail-section .deck {
  margin: 0 0 24px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.30em;
  text-transform: uppercase;
  color: var(--muted);
}
.tail-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.tail-list li {
  padding: 18px 0;
  border-bottom: 1px solid var(--rule);
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 12px;
}
.tail-list li:last-child { border-bottom: none; }
.tail-list .ord {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--stamp-red);
  letter-spacing: 0.05em;
  padding-top: 6px;
}
.tail-list .body { font-family: var(--sans); font-size: 16px; line-height: 1.6; color: var(--ink-soft); }
.tail-list strong { font-weight: 600; color: var(--ink); font-style: normal; }
.tail-list code { font-size: 0.86em; color: var(--stamp-sepia); }

/* ─── colophon ──────────────────────────────────────────────── */

.colophon {
  margin-top: 96px;
  padding-top: 24px;
  border-top: 1px solid var(--rule);
  font-family: var(--sans);
  font-style: italic;
  font-size: 14px;
  color: var(--muted);
  line-height: 1.7;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 24px;
}
.colophon code { font-style: normal; font-size: 12px; }
.colophon-right { text-align: right; font-family: var(--mono); font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; font-style: normal; }
@media (max-width: 760px) {
  .colophon { grid-template-columns: 1fr; }
  .colophon-right { text-align: left; }
}

/* ─── print ──────────────────────────────────────────────────── */

@media print {
  body { background: white; color: black; }
  body::before { display: none; }
  .ledger-entry details, .other-phase { open: true; }
  a { color: black; border-bottom-color: black; }
}

@media (prefers-reduced-motion: reduce) {
  .ledger-entry { animation: none; }
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

  <!-- ─── executive summary ─── -->
  <section class="summary">
    <div class="summary-prose">
      <p class="section-eyebrow">From the CTO's desk · ${escapeHtml(proseDate)}</p>
      ${buildExecSummary(doc)}
    </div>
    <aside class="summary-aside">
      <h4>At a glance</h4>
      <dl>
        <dt>shipped</dt><dd>${numberWord(g.shippedPhases)} phase${g.shippedPhases === 1 ? "" : "s"}</dd>
        <dt>active</dt><dd><em>${g.activePhase || "—"}</em></dd>
        <dt>ready</dt><dd>${numberWord(g.ready)} task${g.ready === 1 ? "" : "s"}</dd>
        <dt>awaiting</dt><dd>${numberWord(g.blocked)} task${g.blocked === 1 ? "" : "s"}</dd>
        <dt>in flight</dt><dd>${numberWord(g.inProgress)} task${g.inProgress === 1 ? "" : "s"}</dd>
        <dt>backlog</dt><dd>${numberWord(g.backlog)} item${g.backlog === 1 ? "" : "s"}</dd>
      </dl>
      <p class="summary-aside-foot">
        Source: <a href="PROGRESS.md">PROGRESS.md</a><br/>
        Commands: <a href="#" onclick="return false">/progress</a> · <a href="#" onclick="return false">/progress-update</a>
      </p>
    </aside>
  </section>

  <!-- ─── milestone ladder ─── -->
  <section>
    <header class="section-head">
      <p class="section-eyebrow">The roadmap, top down</p>
      <h2 class="section-title">The Milestone Ladder</h2>
      <p class="section-deck">Each phase delivers a specific user outcome. Strike-through marks what has shipped.</p>
    </header>
    <div class="ladder">
      ${renderMilestoneLadder(doc)}
    </div>
  </section>

  <!-- ─── tasks at hand ─── -->
  ${renderTasksAtHand(doc)}

  <!-- ─── other phases ─── -->
  <section class="other-phases-section">
    <header class="section-head">
      <p class="section-eyebrow">Beyond the present</p>
      <h2 class="section-title">Phases shipped &amp; phases yet to come</h2>
      <p class="section-deck">Open any heading to read its task list. Backlog phases haven't been retrofitted with task IDs yet.</p>
    </header>
    ${renderOtherPhases(doc)}
  </section>

  <!-- ─── risks & decisions ─── -->
  <section class="tail">
    <div class="tail-section">
      <p class="deck">Operational watchlist</p>
      <h3>Risks under watch.</h3>
      <ol class="tail-list">
        ${doc.risks.map((r, i) => `<li><span class="ord">${romanNumeral(i + 1)}.</span><span class="body">${r.title ? `<strong>${escapeHtml(r.title)}</strong> — ` : ""}${renderInline(r.body)}</span></li>`).join("")}
      </ol>
    </div>
    <div class="tail-section">
      <p class="deck">In the margin, awaiting reply</p>
      <h3>Decisions awaiting the CTO.</h3>
      <ol class="tail-list">
        ${doc.decisions.map((d, i) => `<li><span class="ord">${romanNumeral(i + 1)}.</span><span class="body">${d.title ? `<strong>${escapeHtml(d.title)}</strong> — ` : ""}${renderInline(d.body)}</span></li>`).join("")}
      </ol>
    </div>
  </section>

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
  // Open the target task when navigating via hash
  function openIfHash() {
    const id = location.hash.replace("#task-", "").replace("#phase-", "");
    if (!id) return;
    const taskEl = document.getElementById("task-" + id);
    if (taskEl) {
      const details = taskEl.querySelector("details");
      if (details) details.open = true;
      // Also open any ancestor <details> (e.g., for tasks in collapsed other-phases)
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
      if (phaseEl.tagName === "DETAILS") phaseEl.open = true;
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
  console.log(`  ${g.shippedPhases} shipped · ${g.inProgress} in flight · ${g.ready} ready · ${g.blocked} blocked`);
  if (g.criticalPath.length > 1) {
    console.log(`  critical path (${g.criticalPath.length} hops): ${g.criticalPath.join(" → ")}`);
  }
  console.log(`  risks: ${doc.risks.length} · decisions: ${doc.decisions.length}`);
}

main().catch((err) => {
  console.error("✗ build-progress-html failed:", err);
  process.exit(1);
});
