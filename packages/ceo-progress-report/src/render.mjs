import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import {
  escapeHtml, renderInline, numberWord, romanNumeral,
  formatLongDate, formatStampDate,
  formatShippedShort, relativeDaysAgo,
} from "./helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSS_PATH = resolve(__dirname, "theme/default.css");

export function renderStatusStrip(doc, v1Label) {
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
      <p class="percent-caption">of the road to <em>${escapeHtml(v1Label)}</em></p>
      <div class="roadmap-segments" style="--n: ${phases.length}">${segs}</div>
      <p class="percent-foot">${numberWord(phasesUntilV1)} phase${phasesUntilV1 === 1 ? "" : "s"} remain · ${lastShip}</p>
    </div>
    <div class="status-next">
      ${nextBlock}
    </div>
  </section>`;
}

// ─── render: coming-next hero (active phase checklist promoted) ──────────

export function renderComingNext(doc) {
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

export function renderDesk(doc) {
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

export function renderChecklist(phase) {
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

export function renderEtaPill(phase) {
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

export function renderSeal(phase, isActive) {
  if (phase.status === "done") return `<span class="seal seal-delivered">delivered</span>`;
  if (phase.status === "in-progress") return `<span class="seal seal-active">in flight</span>`;
  if (isActive) return `<span class="seal seal-active">active</span>`;
  return `<span class="seal seal-backlog">backlog</span>`;
}

export function renderMilestoneLadder(doc) {
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

export function renderRisks(doc) {
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

export function renderLedgerTask(task, ordinal) {
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

export function renderLanesForPhase(phase) {
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

export function renderBuildTeam(doc) {
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

export function renderCriticalPath(chain) {
  const chainHtml = chain
    .map((id) => `<a href="#task-${id}"><code>${id.replace(/^v\d{2}-(be|fe|xc)-/, "")}</code></a>`)
    .join(" <span class=\"arrow\">→</span> ");
  return `<p class="critical-chain-label">Critical path through this phase — ${numberWord(chain.length - 1)} sequential hops:</p>
    <p class="critical-chain">${chainHtml}</p>`;
}

// ─── full page ───────────────────────────────────────────────────────────

export async function renderPage(doc, generatedAt, config = {}) {
  const {
    title = "Project",
    subtitle = "The Build Log.",
    monogram: monogramConfig,
    location = "",
    v1Label = "v1.0",
    cssPath = DEFAULT_CSS_PATH,
  } = config;
  const safeTitle = title || "Project";
  const monogramLetter = monogramConfig === false
    ? null
    : (monogramConfig || safeTitle[0].toUpperCase());
  const css = (await readFile(cssPath, "utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
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
<title>${escapeHtml(safeTitle)} · ${escapeHtml(subtitle)}</title>
<meta name="description" content="${escapeHtml(safeTitle)} build log — ${escapeHtml(subtitle).replace(/\.$/, "")} for engineering and stakeholders." />
<meta name="generated-at" content="${generatedAt}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600&family=IBM+Plex+Sans:ital,wght@0,300;0,400;0,500;0,600;1,400;1,500&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
${css}
</style>
</head>
<body>

<div class="shell">

  <!-- ─── masthead ─── -->
  <header class="masthead">
    ${monogramLetter ? `<div class="monogram" aria-hidden="true">
      <span class="monogram-arc monogram-arc-top">${escapeHtml(safeTitle)} · Build Log</span>
      <span class="monogram-letter">${monogramLetter}</span>
    </div>` : ""}
    <div>
      <h1 class="masthead-title">${escapeHtml(safeTitle)}<em>${escapeHtml(subtitle)}</em></h1>
      <p class="masthead-deck">${renderInline(doc.mission || "Living build log for the booth-side point-of-sale.")}</p>
    </div>
    <div class="stamp">
      <div class="num">${stampDate}</div>
      <div>${escapeHtml(location)}</div>
      <div class="stamp-edition">Edition № ${editionNo}</div>
    </div>
  </header>

  <!-- ─── status strip (CEO scoreboard) ─── -->
  ${renderStatusStrip(doc, v1Label)}

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
