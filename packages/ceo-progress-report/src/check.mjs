// packages/ceo-progress-report/src/check.mjs
//
// Lint rules over a parsed PROGRESS.md document.
//
// Severity scale:
//   BLOCKER — the CEO literally can't read the phase. CLI exits 1.
//   FIX     — structurally wrong but salvageable. CLI exits 0.
//   POLISH  — worth flagging but not breaking. CLI exits 0.
//
// Each finding: { severity, phase, message }
//
// The parser (src/parse.mjs) returns this shape (the names below are what
// runChecks reads — they reflect the *actual* parser output, not the spec
// shorthand):
//   phase.outcome      → string ("" if missing)
//   phase.target       → string ("" if missing)
//   phase.shippedLine  → string ("Merged YYYY-MM-DD" or "")
//   phase.youGet       → string[]  (the "You'll be able to" / "You can" block)
//   phase.youDontGet   → string[]  (the "Still not yet" / "You still can't" block)
//   phase.status       → 'done' | 'in-progress' | 'planned' | 'backlog'
//   phase.lanes        → { [laneKey]: Task[] }  (object, keyed by lane slug)
//   task.id            → string | null  (null for legacy non-addressable bullets)
//   task.deps          → string[]
//   doc.decisions      → [{ title, body, resolved, resolvedAt }]

const wordCount = (s) =>
  String(s || "").trim().split(/\s+/).filter(Boolean).length;

// Engineer-voice tokens that betray a bullet as written for the build team,
// not the reader. "Build a cart" reads fine in user voice; "Build a payment
// pipeline" reads less so — we err toward flagging anything matching the
// stricter tokens. "Build" alone is intentionally NOT in this list (see the
// skill's worked example "Build a cart with items and quantities").
const ENGINEER_VOICE = /^(Implement|Refactor|Migrate|Configure|Setup)\b/i;

export function runChecks(doc) {
  const findings = [];

  // ---- Build the set of all task IDs once, for orphan-dep checking ----
  const allTaskIds = new Set();
  for (const phase of doc.phases) {
    for (const laneKey of Object.keys(phase.lanes)) {
      for (const task of phase.lanes[laneKey]) {
        if (task.id) allTaskIds.add(task.id);
      }
    }
  }

  // ---- Per-phase checks ----
  for (const phase of doc.phases) {
    const phaseLabel = `${phase.version} — ${phase.title}`;
    const isDone = phase.status === "done";
    const isInProgress = phase.status === "in-progress";

    // BLOCKER: no outcome
    if (!phase.outcome || !phase.outcome.trim()) {
      findings.push({
        severity: "BLOCKER",
        phase: phaseLabel,
        message: `Phase has no **Outcome:** line — the CEO can't tell what this phase delivers.`,
      });
    }

    // BLOCKER: not done AND no target
    // (Shipped phases derive their date from the Merged line; everything
    // else needs an explicit **Target:** — even "TBD" satisfies presence.)
    if (!isDone && (!phase.target || !phase.target.trim())) {
      findings.push({
        severity: "BLOCKER",
        phase: phaseLabel,
        message: `Phase is not shipped and has no **Target:** line — the CEO can't tell when it lands.`,
      });
    }

    // BLOCKER: not done AND no "You'll be able to" bullets
    if (!isDone && (!phase.youGet || phase.youGet.length === 0)) {
      findings.push({
        severity: "BLOCKER",
        phase: phaseLabel,
        message: `Phase is not shipped and has no **You'll be able to:** block — the CEO can't tell what unlocks.`,
      });
    }

    // FIX: in-progress with Target: TBD
    // (Backlog/planned can legitimately be TBD. Once work has started,
    // the team should have a date.)
    if (isInProgress && /^tbd$/i.test((phase.target || "").trim())) {
      findings.push({
        severity: "FIX",
        phase: phaseLabel,
        message: `In-progress phase still has **Target: TBD** — work has started, the team should commit a date.`,
      });
    }

    // FIX: long bullets in youGet / youDontGet (>18 words per skill directive #2)
    for (const bullet of phase.youGet || []) {
      if (wordCount(bullet) > 18) {
        findings.push({
          severity: "FIX",
          phase: phaseLabel,
          message: `"You'll be able to" bullet is ${wordCount(bullet)} words (>18): "${truncate(bullet, 70)}"`,
        });
      }
    }
    for (const bullet of phase.youDontGet || []) {
      if (wordCount(bullet) > 18) {
        findings.push({
          severity: "FIX",
          phase: phaseLabel,
          message: `"Still not yet" bullet is ${wordCount(bullet)} words (>18): "${truncate(bullet, 70)}"`,
        });
      }
    }

    // POLISH: outcome longer than 25 words
    if (phase.outcome && wordCount(phase.outcome) > 25) {
      findings.push({
        severity: "POLISH",
        phase: phaseLabel,
        message: `Outcome is ${wordCount(phase.outcome)} words (>25) — tighten to one sentence.`,
      });
    }

    // POLISH: engineer-voice bullets in "You'll be able to"
    for (const bullet of phase.youGet || []) {
      if (ENGINEER_VOICE.test(bullet.trim())) {
        const verb = bullet.trim().match(/^(\w+)/)?.[1];
        findings.push({
          severity: "POLISH",
          phase: phaseLabel,
          message: `"You'll be able to" bullet uses engineer voice ("${verb}"): "${truncate(bullet, 70)}"`,
        });
      }
    }

    // FIX: orphan deps inside this phase's tasks
    for (const laneKey of Object.keys(phase.lanes)) {
      for (const task of phase.lanes[laneKey]) {
        for (const dep of task.deps || []) {
          if (!allTaskIds.has(dep)) {
            findings.push({
              severity: "FIX",
              phase: phaseLabel,
              message: `Task [${task.id}] depends on [${dep}], which doesn't exist anywhere in the doc.`,
            });
          }
        }
      }
    }
  }

  // ---- Decisions: "resolved" word but not in canonical resolved form ----
  // The parser already detects the canonical `~~**...**~~ — **RESOLVED ...**:`
  // pattern and sets `resolved: true`. Anything else with the word "resolved"
  // in its body is mis-formatted.
  for (const decision of doc.decisions) {
    if (decision.resolved) continue;
    const blob = `${decision.title || ""} ${decision.body || ""}`;
    if (/\bresolved\b/i.test(blob)) {
      findings.push({
        severity: "FIX",
        phase: null,
        message: `Decision mentions "resolved" but isn't in canonical \`~~**...**~~ — **RESOLVED YYYY-MM-DD**:\` form: "${truncate(decision.title || decision.body, 70)}"`,
      });
    }
  }

  return findings;
}

function truncate(s, n) {
  const str = String(s || "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}
