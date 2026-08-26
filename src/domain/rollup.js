/**
 * Every number the product shows, computed here and stored nowhere.
 *
 * This is the file the SeedFall tracker's store.js `project()` function became.
 * The rules it carried are the rules here, and they are worth restating because
 * each one exists to stop a specific lie:
 *
 *  1. WEIGHTED READINESS IS NOT COMPLETION. `readiness` is a weighted sum —
 *     speccing 0.35, in build 0.7, done 1 — and is deliberately not a percentage
 *     of finished work. Completion is three separate counts (done / partial /
 *     not started) and is reported beside it, never folded into it. The SeedFall
 *     tracker added done and in_build together and called the total "built",
 *     which reported a milestone as 49/49 with four features unfinished.
 *
 *  2. EXCLUDED IS NOT ZERO. A status with a NULL progress weight leaves the
 *     denominator. Scoring it zero would mean a project could be made to look
 *     worse by deferring work and better by rejecting it, and neither is true.
 *
 *  3. A PARENT NEVER COUNTS ITS CHILDREN'S POINTS. Story points are summed over
 *     leaf work only. A phase or an epic that carried its own points would
 *     double-count every child underneath it, and velocity would drift upward
 *     the more structure a project grew.
 *
 *  4. A SHARED SPRINT COUNTS ONCE. Its points appear in every project that
 *     draws from it, and once in velocity.
 */

'use strict';

/** Types that hold other work. Their points and estimates are their children's. */
const CONTAINER_TYPES = new Set(['PHASE', 'EPIC']);

const isLeaf = (wp) => !CONTAINER_TYPES.has(wp.type_name);

/**
 * Weighted readiness over a list of work packages.
 *
 * Returns { pct, scored, excluded } — `scored` is the denominator and is
 * reported so a caller can say "62% of 34" rather than implying the whole list
 * was measured.
 */
function readiness(list) {
  const scored = list.filter((w) => w.progress_weight !== null && w.progress_weight !== undefined);
  if (!scored.length) return { pct: 0, scored: 0, excluded: list.length };
  const sum = scored.reduce((a, w) => a + Number(w.progress_weight), 0);
  return {
    pct: Math.round((sum / scored.length) * 100),
    scored: scored.length,
    excluded: list.length - scored.length,
  };
}

/**
 * Completion as three counts plus what is left. Never one number.
 *
 * `remaining` excludes deferred and rejected: they are not work still to do.
 * `partial` covers both in_build and speccing, because "started" is the only
 * honest thing either of them means.
 */
function completion(list) {
  const closedOrGone = new Set(['done', 'deferred', 'rejected']);
  return {
    total: list.length,
    done: list.filter((w) => w.status_code === 'done').length,
    partial: list.filter((w) => w.status_code === 'in_build' || w.status_code === 'speccing').length,
    notStarted: list.filter((w) => w.status_code === 'not_started').length,
    deferred: list.filter((w) => w.status_code === 'deferred').length,
    rejected: list.filter((w) => w.status_code === 'rejected').length,
    remaining: list.filter((w) => !closedOrGone.has(w.status_code)).length,
  };
}

/** Story points over leaf work only. Rule 3. */
function points(list) {
  return list.filter(isLeaf).reduce((a, w) => a + (Number(w.story_points) || 0), 0);
}

/** Closed story points over leaf work only — the velocity numerator. */
function closedPoints(list) {
  return list.filter((w) => isLeaf(w) && w.status_code === 'done')
    .reduce((a, w) => a + (Number(w.story_points) || 0), 0);
}

/** Estimated and spent hours. Containers are excluded for the same reason as points. */
function hours(list) {
  const leaves = list.filter(isLeaf);
  return {
    estimated: round2(leaves.reduce((a, w) => a + (Number(w.estimated_hours) || 0), 0)),
    spent: round2(leaves.reduce((a, w) => a + (Number(w.spent_hours) || 0), 0)),
  };
}

/** Counts by status code, in the order the statuses are defined. */
function byStatus(list, statuses) {
  return statuses.map((s) => ({
    code: s.code,
    label: s.label,
    colour: s.colour,
    count: list.filter((w) => w.status_code === s.code).length,
  }));
}

function byType(list, types) {
  return types.map((t) => ({
    name: t.name,
    colour: t.colour,
    count: list.filter((w) => w.type_name === t.name).length,
  }));
}

/**
 * The proportion of the bar each status occupies. Widths are rounded and then
 * the largest segment absorbs the rounding error, so the segments always sum to
 * exactly 100 and the bar never shows a hairline gap.
 */
function statusBar(list, statuses) {
  const present = byStatus(list, statuses).filter((s) => s.count > 0);
  const total = present.reduce((a, s) => a + s.count, 0);
  if (!total) return [];
  const withPct = present.map((s) => ({ ...s, pct: Math.round((s.count / total) * 100) }));
  const drift = 100 - withPct.reduce((a, s) => a + s.pct, 0);
  if (drift !== 0) {
    const biggest = withPct.reduce((a, b) => (b.count > a.count ? b : a), withPct[0]);
    biggest.pct += drift;
  }
  return withPct;
}

/**
 * Is a work package overdue? A closed one never is: a task finished late is a
 * fact about the past, and colouring it red forever means the colour stops
 * meaning "act on this".
 */
function isOverdue(wp, today) {
  if (!wp.due_date) return false;
  if (wp.is_closed) return false;
  return wp.due_date < today;
}

/**
 * The highlight colour for a row's left edge. `mode` comes from the viewer's
 * preference; 'none' is a legitimate answer and returns null rather than a
 * transparent colour, so the renderer can omit the border entirely.
 */
function highlight(wp, mode, today) {
  if (mode === 'status') return wp.status_colour;
  if (mode === 'priority') return wp.priority_colour;
  if (mode === 'overdue') return isOverdue(wp, today) ? 'var(--blocked)' : null;
  return null;
}

/**
 * Flatten a parent-child forest into rows carrying their depth, in the order a
 * table shows them.
 *
 * Guards against a cycle: a work package that is its own ancestor would
 * otherwise recurse forever, and the schema permits one (parent_id is a plain
 * self-reference). Anything already visited is skipped and reported.
 */
function flattenHierarchy(list) {
  const byParent = new Map();
  const ids = new Set(list.map((w) => Number(w.id)));
  for (const wp of list) {
    // A parent outside this list (another project, or filtered out) is treated
    // as a root here, so filtering a table never hides a row behind a parent
    // that is not on screen.
    const key = wp.parent_id && ids.has(Number(wp.parent_id)) ? Number(wp.parent_id) : 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(wp);
  }
  const out = [];
  const seen = new Set();
  const cycles = [];
  const walk = (parentKey, depth) => {
    for (const wp of byParent.get(parentKey) || []) {
      if (seen.has(Number(wp.id))) { cycles.push(wp.id); continue; }
      seen.add(Number(wp.id));
      out.push({ ...wp, depth });
      walk(Number(wp.id), depth + 1);
    }
  };
  walk(0, 0);
  // Anything unreachable from a root is in a cycle. Append it flat rather than
  // dropping it — a row that vanishes from a list is worse than one out of order.
  for (const wp of list) {
    if (!seen.has(Number(wp.id))) { out.push({ ...wp, depth: 0, orphaned: true }); cycles.push(wp.id); }
  }
  return { rows: out, cycles };
}

/**
 * Velocity: closed leaf points per sprint, with recorded history for sprints
 * that predate the itemised work. A live sprint is always computed — a stored
 * figure that could be computed is a figure that will one day disagree with the
 * cards.
 */
function velocity(sprints, wps, history) {
  const fromHistory = history.map((h) => ({
    code: h.sprint_code, points: Number(h.closed_points), source: 'recorded',
  }));
  const computed = sprints.map((s) => ({
    code: s.code,
    points: closedPoints(wps.filter((w) => Number(w.sprint_id) === Number(s.id))),
    source: 'computed',
    state: s.state,
  }));
  const seen = new Set(computed.map((c) => c.code));
  return [...fromHistory.filter((h) => !seen.has(h.code)), ...computed];
}

/** Booked against declared capacity, for one person's week. */
function loadCell(bookedHours, capacity) {
  const booked = Number(bookedHours) || 0;
  const cap = Number(capacity) || 0;
  if (!cap) {
    // No declared capacity is not the same as no work. A placeholder with hours
    // booked against it is a real plan against a person who does not exist yet,
    // and the planner has to be able to show that rather than divide by zero.
    return { booked, capacity: 0, pct: 0, state: booked > 0 ? 'no_capacity_booked' : 'no_capacity' };
  }
  const pct = Math.min(100, Math.round((booked / cap) * 100));
  const state = booked > cap ? 'over' : booked === cap ? 'at' : booked > cap * 0.6 ? 'high' : 'under';
  return { booked, capacity: cap, pct, state };
}

const round2 = (n) => Math.round(n * 100) / 100;

module.exports = {
  CONTAINER_TYPES, isLeaf, readiness, completion, points, closedPoints, hours,
  byStatus, byType, statusBar, isOverdue, highlight, flattenHierarchy, velocity, loadCell,
};
