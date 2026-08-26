/**
 * The read side, continued: boards, backlogs, roadmap, calendar, planner,
 * activity, wiki, meetings, connections, administration, and the work package
 * drawer.
 */

'use strict';

const db = require('../db');
const rollup = require('../domain/rollup');
const sched = require('../domain/scheduling');
const query = require('../domain/query');
const access = require('../domain/access');
const { notFound, badRequest } = require('../http/router');
const { row, shortDate, ago, num } = require('./views');
const { recentActivity } = require('./views2');

// ------------------------------------------------------------------------ boards

const BOARD_NOTES = {
  status: 'Dragging a card writes the status and appends to the activity feed. Columns are the workflow statuses defined in administration — add a status there and it appears here.',
  version: 'A version board moves work between releases. Closing a version with cards left in it asks where they go.',
  subproject: 'One column per project in this program. Cards can cross projects, which is how a shared sprint is planned.',
  wbs: 'Columns are parents, cards are their children. This is the only board that shows hierarchy directly.',
  sprint: 'One column per sprint plus the backlog. A shared sprint shows the same cards in every project that draws from it.',
  free: 'Columns are whatever you name them, and card order is stored.',
};

/**
 * A board's columns.
 *
 * For status, version, subproject and wbs boards the columns are DERIVED, not
 * stored — which is why adding a status in administration makes a new column
 * appear here without a migration. Only a 'free' board has stored columns.
 */
async function boards(ctx, { projectId, boardType = 'status' } = {}) {
  const project = await db.one('SELECT id, code, name, program_id, parent_id FROM projects WHERE id = ?', [projectId]);
  if (!project) throw notFound('no such project');

  const available = await db.query(
    'SELECT id, name, board_type FROM boards WHERE project_id = ? ORDER BY position, id', [projectId]
  );
  const wps = await query.select({ filters: { project: projectId }, sort: 'board', limit: 1000, today: ctx.today });
  const card = (w) => row(w, ctx);

  let columns = [];
  if (boardType === 'status') {
    const statuses = await db.query('SELECT * FROM statuses WHERE is_closed = 0 OR code = ? ORDER BY position', ['done']);
    columns = statuses.map((s) => ({
      key: `status:${s.id}`, title: s.label, colour: s.colour, ref_kind: 'status', ref_id: s.id,
      cards: wps.filter((w) => w.status_code === s.code).map(card),
    }));
  } else if (boardType === 'version') {
    const versions = await db.query('SELECT * FROM versions WHERE project_id = ? ORDER BY due_date IS NULL, due_date', [projectId]);
    columns = versions.map((v) => ({
      key: `version:${v.id}`, title: v.name, colour: 'var(--accent)', ref_kind: 'version', ref_id: v.id,
      meta: v.due_date ? shortDate(v.due_date) : 'UNSCHEDULED',
      cards: wps.filter((w) => Number(w.version_id) === Number(v.id)).map(card),
    }));
    columns.push({
      key: 'version:none', title: 'No version', colour: 'var(--ink-6)', ref_kind: 'version', ref_id: null,
      cards: wps.filter((w) => !w.version_id).map(card),
    });
  } else if (boardType === 'subproject') {
    // Siblings in the program, plus this project. Cards can cross projects,
    // which is the point: it is how a shared sprint gets planned.
    const clause = db.inClause(ctx.visibleProjectIds);
    const siblings = await db.query(`
      SELECT id, code, name FROM projects
       WHERE id IN ${clause.sql} AND (program_id = ? OR parent_id = ? OR id = ?)
       ORDER BY code`, [...clause.params, project.program_id, project.id, project.id]);
    const all = await query.select({
      filters: { project: siblings.map((s) => s.id) }, limit: 1000, today: ctx.today,
    });
    columns = siblings.map((s) => ({
      key: `project:${s.id}`, title: `${s.code} ${s.name}`, colour: 'var(--sel)',
      ref_kind: 'project', ref_id: s.id,
      cards: all.filter((w) => Number(w.project_id) === Number(s.id)).map(card),
    }));
  } else if (boardType === 'wbs') {
    const parents = wps.filter((w) => wps.some((k) => Number(k.parent_id) === Number(w.id)));
    columns = parents.map((p) => ({
      key: `parent:${p.id}`, title: `${p.wp_key} ${p.subject}`, colour: 'var(--accent)',
      ref_kind: 'parent', ref_id: p.id,
      meta: `${wps.filter((k) => Number(k.parent_id) === Number(p.id)).length} CHILDREN`,
      cards: wps.filter((k) => Number(k.parent_id) === Number(p.id)).map(card),
    }));
    const roots = wps.filter((w) => !w.parent_id && !parents.some((p) => Number(p.id) === Number(w.id)));
    if (roots.length) {
      columns.unshift({
        key: 'parent:none', title: 'No parent', colour: 'var(--ink-6)', ref_kind: 'parent', ref_id: null,
        cards: roots.map(card),
      });
    }
  } else if (boardType === 'sprint') {
    const sprints = await sprintsFor(projectId);
    columns = sprints.map((s) => ({
      key: `sprint:${s.id}`, title: s.code, colour: s.state === 'active' ? 'var(--accent)' : 'var(--ink-5)',
      ref_kind: 'sprint', ref_id: s.id,
      meta: `${shortDate(s.start_date)} → ${shortDate(s.end_date)}`,
      cards: wps.filter((w) => Number(w.sprint_id) === Number(s.id)).map(card),
    }));
    columns.push({
      key: 'sprint:none', title: 'Backlog', colour: 'var(--ink-5)', ref_kind: 'sprint', ref_id: null,
      cards: wps.filter((w) => !w.sprint_id && !w.is_closed).map(card),
    });
  } else {
    const board = available.find((b) => b.board_type === 'free');
    const stored = board
      ? await db.query('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position', [board.id]) : [];
    columns = stored.map((c) => ({
      key: `col:${c.id}`, title: c.title, colour: 'var(--accent)', ref_kind: c.ref_kind, ref_id: c.ref_id,
      wip_limit: c.wip_limit, cards: [],
    }));
  }

  for (const c of columns) {
    c.count = c.cards.length;
    c.points = rollup.points(c.cards.map((k) => ({ ...k, type_name: k.type, story_points: k.story_points })));
    if (!c.meta) c.meta = String(c.count);
    if (c.wip_limit && c.count > c.wip_limit) c.over_wip = true;
  }

  return {
    boardType,
    available: available.map((b) => ({ id: b.id, name: b.name, type: b.board_type })),
    modes: ['status', 'version', 'subproject', 'wbs', 'sprint'],
    columns,
    note: BOARD_NOTES[boardType] || BOARD_NOTES.free,
  };
}

/**
 * Sprints a project can draw from: its own, plus any shared sprint that names it,
 * plus any system-shared sprint.
 */
async function sprintsFor(projectId) {
  return db.query(`
    SELECT DISTINCT s.* FROM sprints s
      LEFT JOIN sprint_projects sp ON sp.sprint_id = s.id
     WHERE s.project_id = ? OR sp.project_id = ? OR s.sharing = 'system'
     ORDER BY s.start_date`, [projectId, projectId]);
}

// --------------------------------------------------------- backlogs and sprints

async function backlogs(ctx, { projectId } = {}) {
  const sprints = await sprintsFor(projectId);
  const wps = await query.select({ filters: { project: projectId }, sort: 'backlog', limit: 1000, today: ctx.today });

  // A shared sprint's cards come from every project that draws on it, because
  // planning a shared sprint means seeing all of it.
  const shared = sprints.filter((s) => s.sharing === 'system').map((s) => s.id);
  const sharedCards = shared.length
    ? await query.select({
      filters: { sprint_id: shared, visible_projects: ctx.visibleProjectIds }, limit: 1000, today: ctx.today,
    })
    : [];

  const columns = sprints.map((s) => {
    const own = s.sharing === 'system'
      ? sharedCards.filter((w) => Number(w.sprint_id) === Number(s.id))
      : wps.filter((w) => Number(w.sprint_id) === Number(s.id));
    const pts = rollup.points(own);
    const done = rollup.closedPoints(own);
    return {
      id: s.id, code: s.code, state: s.state, sharing: s.sharing, goal: s.goal,
      dates: `${shortDate(s.start_date)} → ${shortDate(s.end_date)}`,
      start_date: s.start_date, end_date: s.end_date,
      scope: s.sharing === 'system' ? 'SHARED' : null,
      scope_detail: s.sharing === 'system'
        ? `shared · ${[...new Set(own.map((w) => w.project_code))].sort().join(' + ')}`
        : null,
      points: pts,
      closedPoints: done,
      burn: `${done} / ${pts}`,
      pct: pts ? Math.round((done / pts) * 100) : 0,
      cards: own.map((w) => row(w, ctx)),
    };
  });

  const backlog = wps.filter((w) => !w.sprint_id && !w.is_closed);

  const history = await db.query(
    'SELECT sprint_code, closed_points FROM sprint_velocity_history WHERE project_id = ? OR project_id IS NULL ORDER BY sprint_code',
    [projectId]
  );

  return {
    columns,
    backlog: {
      cards: backlog.map((w) => row(w, ctx)),
      count: backlog.length,
      points: rollup.points(backlog),
    },
    velocity: rollup.velocity(sprints, [...wps, ...sharedCards], history),
    activeCount: sprints.filter((s) => s.state === 'active').length,
  };
}

// ----------------------------------------------------------------------- roadmap

async function roadmap(ctx) {
  const clause = db.inClause(ctx.visibleProjectIds.length ? ctx.visibleProjectIds : [0]);
  const versions = await db.query(`
    SELECT v.*, p.code AS project_code, p.name AS project_name
      FROM versions v JOIN projects p ON p.id = v.project_id
     WHERE v.project_id IN ${clause.sql}
     ORDER BY v.due_date IS NULL, v.due_date, p.code`, clause.params);
  const wps = await query.select({
    filters: { visible_projects: ctx.visibleProjectIds }, limit: 1000, today: ctx.today,
  });

  // Bounds come from the version dates, widened to include today. A roadmap
  // whose window starts after today has nowhere to draw the today marker, and
  // then "are we ahead or behind" is the one question it cannot answer.
  const dated = versions.filter((v) => v.due_date).map((v) => v.due_date).sort();
  const earliest = dated.length ? (dated[0] < ctx.today ? dated[0] : ctx.today) : ctx.today;
  const latest = dated.length
    ? (dated[dated.length - 1] > ctx.today ? dated[dated.length - 1] : ctx.today)
    : ctx.today;
  const t0 = `${earliest.slice(0, 7)}-01`;
  const t1 = sched.addDays(`${nextMonth(latest)}-01`, -1);
  const { monthsBetween } = require('./views2');

  return {
    t0,
    t1,
    todayPct: ctx.today >= t0 && ctx.today <= t1
      ? sched.timelinePosition(ctx.today, ctx.today, t0, t1).left : null,
    months: monthsBetween(t0, t1).map((m) => ({
      label: m.label,
      widthPct: ((sched.daysBetween(m.from, m.to) + 1) / (sched.daysBetween(t0, t1) + 1)) * 100,
    })),
    versions: versions.map((v) => {
      const list = wps.filter((w) => Number(w.version_id) === Number(v.id));
      return {
        id: v.id, code: v.code, name: v.name, state: v.state, sharing: v.sharing,
        project_code: v.project_code, project_name: v.project_name,
        due_date: v.due_date,
        due_short: v.due_date ? shortDate(v.due_date) : 'UNSCHEDULED',
        overdue: Boolean(v.due_date && v.due_date < ctx.today && list.some((w) => !w.is_closed)),
        count: list.length,
        closed: list.filter((w) => w.is_closed).length,
        points: rollup.points(list),
        readiness: rollup.readiness(list),
        markPct: v.due_date && v.due_date >= t0 && v.due_date <= t1
          ? sched.timelinePosition(v.due_date, v.due_date, t0, t1).left : null,
      };
    }),
  };
}

function nextMonth(iso) {
  const [y, m] = iso.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------- calendar

/**
 * A month of cells.
 *
 * Weekends are shaded, never hidden: the work week definition is scheduling
 * arithmetic, and a day nobody works is still a day something can be due on.
 * The grid always runs Monday to Sunday and always shows whole weeks, so the
 * cell count is stable and the layout does not reflow between months.
 */
async function calendar(ctx, { projectId = null, month = null } = {}) {
  const target = month || ctx.today.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(target)) throw badRequest('month must be YYYY-MM');
  const first = `${target}-01`;
  const gridStart = sched.weekStart(first);
  const lastOfMonth = sched.addDays(`${nextMonth(first)}-01`, -1);
  const gridEnd = sched.addDays(sched.weekStart(lastOfMonth), 6);

  const filters = projectId
    ? { project: projectId, due_between: [gridStart, gridEnd] }
    : { visible_projects: ctx.visibleProjectIds, due_between: [gridStart, gridEnd] };
  const due = await query.select({ filters, limit: 500, today: ctx.today });

  const meetings = await db.query(`
    SELECT m.id, m.title, m.scheduled_on, m.start_time, m.state, p.code AS project_code
      FROM meetings m LEFT JOIN projects p ON p.id = m.project_id
     WHERE m.scheduled_on BETWEEN ? AND ?
       ${projectId ? 'AND m.project_id = ?' : ''}`,
  projectId ? [gridStart, gridEnd, projectId] : [gridStart, gridEnd]);

  const sprints = projectId
    ? (await sprintsFor(projectId)).filter((s) => s.start_date >= gridStart && s.start_date <= gridEnd)
    : await db.query('SELECT * FROM sprints WHERE start_date BETWEEN ? AND ?', [gridStart, gridEnd]);

  const week = projectId
    ? await db.one('SELECT w.* FROM work_weeks w JOIN projects p ON p.work_week_id = w.id WHERE p.id = ?', [projectId])
    : await db.one('SELECT * FROM work_weeks WHERE is_default = 1');
  const holidays = new Set(
    (await db.query('SELECT day FROM non_working_days WHERE day BETWEEN ? AND ?', [gridStart, gridEnd]))
      .map((r) => r.day)
  );

  const cells = [];
  for (let d = gridStart; d <= gridEnd; d = sched.addDays(d, 1)) {
    const events = [];
    for (const w of due.filter((x) => x.due_date === d)) {
      events.push({
        kind: 'due', colour: w.status_colour, text: `${w.wp_key} ${w.subject}`,
        work_package_id: w.id,
      });
    }
    for (const m of meetings.filter((x) => x.scheduled_on === d)) {
      events.push({
        kind: 'meeting', colour: 'var(--sel)',
        text: `${String(m.start_time || '').slice(0, 5)} ${m.title}`.trim(), meeting_id: m.id,
      });
    }
    for (const s of sprints.filter((x) => x.start_date === d)) {
      events.push({ kind: 'sprint', colour: 'var(--accent)', text: `${s.code} starts`, sprint_id: s.id });
    }
    cells.push({
      date: d,
      day: Number(d.slice(-2)),
      inMonth: d.slice(0, 7) === target,
      isToday: d === ctx.today,
      working: sched.isWorkingDay(d, week || sched.ALL_DAYS, holidays),
      events,
    });
  }

  const subscription = await db.one(
    'SELECT token, name FROM calendar_subscriptions WHERE user_id = ? AND revoked_at IS NULL LIMIT 1',
    [ctx.user.id]
  );

  return {
    month: target,
    monthLabel: new Date(sched.parseDay(first))
      .toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    prev: prevMonth(target),
    next: nextMonth(first),
    dows: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    cells,
    workWeek: week ? week.name : 'every day',
    subscription: subscription ? { url: `/ical/${subscription.token}.ics`, name: subscription.name } : null,
  };
}

function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ team planner

async function planner(ctx, { weeks = 6, from = null } = {}) {
  const start = sched.weekStart(from || ctx.today);
  const starts = Array.from({ length: Math.min(16, Math.max(1, Number(weeks) || 6)) },
    (_, i) => sched.addDays(start, i * 7));
  const { isoWeek } = require('./views');

  const people = await db.query(`
    SELECT u.id, u.name, u.initials, u.colour, u.kind, u.weekly_capacity, u.placeholder_for,
           (SELECT GROUP_CONCAT(DISTINCT r.name ORDER BY r.position SEPARATOR ', ')
              FROM memberships m JOIN membership_roles mr ON mr.membership_id = m.id
              JOIN roles r ON r.id = mr.role_id WHERE m.user_id = u.id) AS roles
      FROM users u WHERE u.active = 1 AND u.kind <> 'system'
     ORDER BY u.kind, u.name`);

  const clause = db.inClause(starts);
  const allocations = await db.query(`
    SELECT user_id, week_start, SUM(hours) AS hours
      FROM resource_allocations WHERE week_start IN ${clause.sql}
     GROUP BY user_id, week_start`, clause.params);
  const key = (u, w) => `${u}|${w}`;
  const byKey = new Map(allocations.map((a) => [key(a.user_id, a.week_start), Number(a.hours)]));

  return {
    weeks: starts.map((s) => ({ week_start: s, label: `W${isoWeek(s)} ${shortDate(s).toUpperCase()}` })),
    rows: people.map((p) => ({
      id: p.id, name: p.name, initials: p.initials, colour: p.colour, kind: p.kind,
      roles: p.roles || '—', capacity: num(p.weekly_capacity),
      placeholder_for: p.placeholder_for,
      cells: starts.map((s) => ({
        week_start: s,
        ...rollup.loadCell(byKey.get(key(p.id, s)) || 0, p.weekly_capacity),
      })),
      total: starts.reduce((a, s) => a + (byKey.get(key(p.id, s)) || 0), 0),
    })),
  };
}

// ----------------------------------------------------------------- activity page

async function activityPage(ctx) {
  const inbox = await db.query(`
    SELECT n.*, u.name AS actor_name, wp.wp_key, p.code AS project_code
      FROM notifications n
      LEFT JOIN users u ON u.id = n.actor_id
      LEFT JOIN work_packages wp ON wp.id = n.work_package_id
      LEFT JOIN projects p ON p.id = n.project_id
     WHERE n.user_id = ?
     ORDER BY n.created_at DESC LIMIT 40`, [ctx.user.id]);
  return {
    inbox: inbox.map((n) => ({
      id: n.id, kind: n.kind, title: n.title, detail: n.detail,
      who: n.actor_name || n.actor_label,
      wp_key: n.wp_key, work_package_id: n.work_package_id, project_code: n.project_code,
      unread: !n.read_at, when: ago(n.created_at), created_at: n.created_at,
    })),
    unread: inbox.filter((n) => !n.read_at).length,
    feed: await recentActivity(ctx, { limit: 40 }),
  };
}

module.exports = {
  boards, backlogs, roadmap, calendar, planner, activityPage, sprintsFor, BOARD_NOTES,
  prevMonth, nextMonth,
};
