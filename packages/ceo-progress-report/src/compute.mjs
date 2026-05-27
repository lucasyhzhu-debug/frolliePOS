// Pure computation functions: computeStats and extractShippedDate.

export function computeStats(doc, config = {}) {
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
    roadmapPct: (() => {
      const mode = config.roadmapPercent || "phases";
      if (mode === "tasks") {
        const addrAll = doc.phases.flatMap((p) => Object.values(p.lanes).flat()).filter((t) => t.addressable);
        const totalTasks = addrAll.length;
        const shippedTasks = addrAll.filter((t) => t.status === "done").length;
        return totalTasks > 0 ? Math.round((shippedTasks / totalTasks) * 100) : 0;
      }
      // "phases" (default): shipped phases / total phases
      return doc.phases.length ? Math.round((doc.phases.filter((p) => p.status === "done").length / doc.phases.length) * 100) : 0;
    })(),
    criticalPath,
  };

  return { ...doc, globalCounts };
}

export function extractShippedDate(shippedLine) {
  if (!shippedLine) return null;
  const m = shippedLine.match(/Merged\s+(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
