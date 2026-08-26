/**
 * Dates.
 *
 * Three things live here and they are deliberately separate:
 *
 *  1. THE WORK WEEK is arithmetic. It decides how many calendar days a
 *     fourteen-hour estimate spans. It does not decide what anybody can see:
 *     weekends are shaded on the calendar, never hidden. A week definition that
 *     hid days would make a due date on a Saturday invisible rather than wrong.
 *
 *  2. AUTOMATIC SCHEDULING derives a parent's dates from its children and a
 *     successor's start from its predecessor's finish. MANUAL pins them. A child
 *     cannot leave the dates of an automatic parent; against a manual parent it
 *     can, and that is the only way to plan a slip without rewriting the parent.
 *
 *  3. A BASELINE is a stored copy, compared against, never recomputed. See the
 *     comment on `baselines` in db/schema.sql.
 *
 * Every date in this file is an ISO 'YYYY-MM-DD' string and every arithmetic
 * step goes through Date.UTC. A DATE parsed as local time shifts by a day for
 * anyone west of UTC, and the shift is invisible until somebody's deadline moves.
 */

'use strict';

const DAY = 86400000;

/** 'YYYY-MM-DD' -> epoch ms at UTC midnight. Throws on anything else. */
function parseDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) throw new Error(`not an ISO date: ${JSON.stringify(iso)}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

const formatDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, n) => formatDay(parseDay(iso) + n * DAY);
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / DAY);
/** 0 = Sunday … 6 = Saturday, in UTC. */
const dayOfWeek = (iso) => new Date(parseDay(iso)).getUTCDay();

const WEEK_COLUMNS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** A week definition with every day on — the fallback when a project has none. */
const ALL_DAYS = {
  name: 'Every day', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
  saturday: 1, sunday: 1, hours_per_day: 8,
};

function isWorkingDay(iso, week = ALL_DAYS, nonWorking = new Set()) {
  if (nonWorking.has(iso)) return false;
  return Boolean(week[WEEK_COLUMNS[dayOfWeek(iso)]]);
}

/** Working days in [from, to] inclusive. */
function workingDays(from, to, week = ALL_DAYS, nonWorking = new Set()) {
  if (!from || !to) return 0;
  let n = 0;
  for (let t = parseDay(from); t <= parseDay(to); t += DAY) {
    if (isWorkingDay(formatDay(t), week, nonWorking)) n += 1;
  }
  return n;
}

/** The next working day at or after `iso`. */
function nextWorkingDay(iso, week = ALL_DAYS, nonWorking = new Set()) {
  let day = iso;
  // A week with no working days at all would spin forever; 400 iterations is
  // more than a year and turns that configuration error into an exception.
  for (let i = 0; i < 400; i += 1) {
    if (isWorkingDay(day, week, nonWorking)) return day;
    day = addDays(day, 1);
  }
  throw new Error(`no working day within 400 days of ${iso} — check the work week definition`);
}

/**
 * The finish date for `hours` of work starting on `start`, given the week's
 * hours per day.
 *
 * Rounds the day count UP: seven hours of work in an eight-hour day still
 * occupies a day, and a plan that said otherwise would show a task finishing
 * before anybody could have worked on it.
 */
function finishFor(start, hours, week = ALL_DAYS, nonWorking = new Set()) {
  const perDay = Number(week.hours_per_day) || 8;
  const needed = Math.max(1, Math.ceil((Number(hours) || 0) / perDay));
  let day = nextWorkingDay(start, week, nonWorking);
  let counted = 1;
  while (counted < needed) {
    day = nextWorkingDay(addDays(day, 1), week, nonWorking);
    counted += 1;
  }
  return day;
}

/**
 * Derive dates for every automatically scheduled work package in a set.
 *
 * Input rows need: id, parent_id, scheduling, start_date, due_date, and
 * `follows` — the ids this row follows, with their lag.
 *
 * Returns a Map of id -> { start_date, due_date, reason } for the rows that
 * should change. It does not write: the caller decides whether to apply, which
 * is what lets the API preview a reschedule before committing it.
 *
 * Order of resolution:
 *   a. a manual row keeps its dates, always;
 *   b. a row that follows something starts after that thing finishes, plus lag;
 *   c. a parent spans its children.
 *
 * (b) before (c) matters: a parent's span has to be computed from children whose
 * own dates have already settled, or the parent lags one pass behind and the
 * plan takes several saves to converge.
 */
function derive(rows, { week = ALL_DAYS, nonWorking = new Set(), maxPasses = 12 } = {}) {
  const byId = new Map(rows.map((r) => [Number(r.id), { ...r }]));
  const children = new Map();
  for (const r of byId.values()) {
    const p = r.parent_id ? Number(r.parent_id) : 0;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(Number(r.id));
  }

  const changes = new Map();
  const note = (id, reason) => {
    const r = byId.get(id);
    changes.set(id, { start_date: r.start_date, due_date: r.due_date, reason });
  };

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let moved = false;

    // (b) successors
    for (const r of byId.values()) {
      if (r.scheduling === 'manual') continue;
      const follows = r.follows || [];
      if (!follows.length) continue;
      let earliest = null;
      for (const f of follows) {
        const pred = byId.get(Number(f.id));
        if (!pred || !pred.due_date) continue;
        const candidate = nextWorkingDay(addDays(pred.due_date, 1 + (Number(f.lag_days) || 0)), week, nonWorking);
        if (!earliest || candidate > earliest) earliest = candidate;
      }
      if (earliest && r.start_date !== earliest) {
        // Keep the duration the row already had rather than recomputing from
        // hours: a person may have widened it on purpose, and a reschedule that
        // silently narrows a task back to its estimate is a reschedule that
        // loses a decision.
        const span = r.start_date && r.due_date ? daysBetween(r.start_date, r.due_date) : 0;
        r.start_date = earliest;
        r.due_date = addDays(earliest, Math.max(0, span));
        note(Number(r.id), 'follows a predecessor');
        moved = true;
      }
    }

    // (c) parents span their children
    // Deepest-first, so a grandparent sees settled parents.
    for (const id of depthOrder(byId, children).reverse()) {
      const r = byId.get(id);
      if (r.scheduling === 'manual') continue;
      const kids = (children.get(id) || []).map((k) => byId.get(k)).filter(Boolean);
      if (!kids.length) continue;
      const starts = kids.map((k) => k.start_date).filter(Boolean).sort();
      const dues = kids.map((k) => k.due_date).filter(Boolean).sort();
      if (!starts.length || !dues.length) continue;
      const start = starts[0];
      const due = dues[dues.length - 1];
      if (r.start_date !== start || r.due_date !== due) {
        r.start_date = start;
        r.due_date = due;
        note(id, 'spans its children');
        moved = true;
      }
    }

    if (!moved) return { changes, passes: pass + 1, converged: true };
  }
  // Not converging means a cycle in the relations. Report it rather than
  // applying a half-settled plan.
  return { changes, passes: maxPasses, converged: false };
}

/** Ids shallowest-first. Used so parents settle after their children. */
function depthOrder(byId, children) {
  const out = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const id of children.get(parent) || []) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      walk(id, depth + 1);
    }
  };
  walk(0, 0);
  for (const id of byId.keys()) if (!seen.has(id)) out.push(id);
  return out;
}

/**
 * Compare a work package against its baseline entry.
 *
 * `startShift` and `dueShift` are in days, positive meaning later than planned.
 * `slip` is the due shift and is the number that goes on the chart: a task that
 * started late and finished on time did not slip.
 */
function compareToBaseline(wp, entry) {
  if (!entry) return null;
  const out = {
    baselineStart: entry.start_date,
    baselineDue: entry.due_date,
    startShift: null,
    dueShift: null,
    slip: 0,
    pointsShift: null,
  };
  if (wp.start_date && entry.start_date) out.startShift = daysBetween(entry.start_date, wp.start_date);
  if (wp.due_date && entry.due_date) {
    out.dueShift = daysBetween(entry.due_date, wp.due_date);
    out.slip = Math.max(0, out.dueShift);
  }
  if (wp.story_points != null && entry.story_points != null) {
    out.pointsShift = Number(wp.story_points) - Number(entry.story_points);
  }
  return out;
}

/**
 * Position a bar on a timeline running from t0 to t1, as percentages.
 *
 * A zero-length item (a milestone: one pinned date) is given a minimum width so
 * it is still visible; the chart draws milestones as a diamond anyway, but a
 * width of 0% would collapse the element and take its tooltip with it.
 */
function timelinePosition(from, to, t0, t1, { minWidthPct = 0.7 } = {}) {
  const span = parseDay(t1) - parseDay(t0);
  if (span <= 0) return { left: 0, width: 0 };
  const a = parseDay(from || to);
  const b = parseDay(to || from);
  return {
    left: ((a - parseDay(t0)) / span) * 100,
    width: Math.max(minWidthPct, ((b - a + DAY) / span) * 100),
  };
}

/** The Monday of the ISO week containing `iso`. */
function weekStart(iso) {
  const dow = dayOfWeek(iso);
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(iso, -back);
}

module.exports = {
  DAY, ALL_DAYS, WEEK_COLUMNS,
  parseDay, formatDay, addDays, daysBetween, dayOfWeek,
  isWorkingDay, workingDays, nextWorkingDay, finishFor,
  derive, compareToBaseline, timelinePosition, weekStart,
};
