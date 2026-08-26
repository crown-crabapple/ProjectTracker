/**
 * The work package query.
 *
 * Every list, board, Gantt row, calendar cell, backlog card and export goes
 * through `select()`. There is one query because there is one set of rules about
 * what a row looks like, and a second copy of those rules is a second place for
 * the status colour to be wrong.
 *
 * Filters arrive from the browser, the CLI and MCP. None of them is trusted:
 * a filter key that is not in FILTERS is an error, not a silently ignored
 * clause. Silently ignoring an unknown filter is how a query returns more than
 * the caller asked for, which on a shared link is a disclosure.
 */

'use strict';

const db = require('../db');

/**
 * The row shape. Joined once so that a caller never has to look up a status
 * colour or an assignee name for itself.
 *
 * `spent_hours` is a correlated subquery rather than a stored column: time
 * entries are the record and a cached total would drift the first time one was
 * corrected.
 */
const SELECT = `
  SELECT wp.id, wp.wp_key, wp.project_id, wp.subject, wp.parent_id,
         -- The raw foreign keys as well as the joined labels. Leaving these out
         -- was a real bug: the status-transition check read wp.status_id, got
         -- undefined, and refused every status change in the app.
         wp.status_id, wp.type_id, wp.priority_id,
         wp.start_date, wp.due_date, wp.scheduling,
         wp.estimated_hours, wp.remaining_hours, wp.story_points,
         wp.version_id, wp.sprint_id, wp.board_position, wp.backlog_position,
         wp.assignee_id, wp.accountable_id, wp.author_id,
         wp.created_at, wp.updated_at, wp.closed_at,
         t.name  AS type_name,    t.colour AS type_colour, t.is_milestone,
         s.code  AS status_code,  s.label  AS status_label, s.colour AS status_colour,
         s.is_closed, s.progress_weight,
         pr.code AS priority_code, pr.label AS priority_label, pr.colour AS priority_colour,
         p.code  AS project_code,  p.name  AS project_name,
         v.code  AS version_code,  v.name  AS version_name,
         sp.code AS sprint_code,   sp.sharing AS sprint_sharing,
         ua.name AS assignee_name, ua.initials AS assignee_initials, ua.colour AS assignee_colour,
         ua.kind AS assignee_kind,
         uc.name AS accountable_name,
         (SELECT COUNT(*) FROM work_package_watchers w WHERE w.work_package_id = wp.id) AS watcher_count,
         (SELECT COALESCE(SUM(te.hours), 0) FROM time_entries te WHERE te.work_package_id = wp.id) AS spent_hours,
         (SELECT COUNT(*) FROM attachments a WHERE a.container_type = 'work_package' AND a.container_id = wp.id) AS attachment_count,
         (SELECT COUNT(*) FROM comments c WHERE c.container_type = 'work_package' AND c.container_id = wp.id) AS comment_count
    FROM work_packages wp
    JOIN work_package_types t ON t.id = wp.type_id
    JOIN statuses s          ON s.id = wp.status_id
    JOIN priorities pr       ON pr.id = wp.priority_id
    JOIN projects p          ON p.id = wp.project_id
    LEFT JOIN versions v     ON v.id = wp.version_id
    LEFT JOIN sprints sp     ON sp.id = wp.sprint_id
    LEFT JOIN users ua       ON ua.id = wp.assignee_id
    LEFT JOIN users uc       ON uc.id = wp.accountable_id`;

/**
 * Every filter the app understands, as a clause builder. Adding one here is the
 * only way to add one: `select()` throws on a key that is not in this map.
 */
const FILTERS = {
  project: (v) => clause('wp.project_id', v),
  project_code: (v) => clause('p.code', v),
  program: (v) => ({ sql: 'p.program_id IN (SELECT id FROM programs WHERE code = ?)', params: [v] }),
  status: (v) => clause('s.code', v),
  status_id: (v) => clause('wp.status_id', v),
  type: (v) => clause('t.name', v),
  priority: (v) => clause('pr.code', v),
  version: (v) => clause('v.code', v),
  version_id: (v) => clause('wp.version_id', v),
  sprint: (v) => clause('sp.code', v),
  sprint_id: (v) => clause('wp.sprint_id', v),
  assignee: (v) => clause('wp.assignee_id', v),
  accountable: (v) => clause('wp.accountable_id', v),
  author: (v) => clause('wp.author_id', v),
  parent: (v) => clause('wp.parent_id', v),
  // `open` and `closed` read the status's own is_closed flag rather than a list
  // of status names, so adding a status in administration does not need a code
  // change here.
  open: () => ({ sql: 's.is_closed = 0', params: [] }),
  closed: () => ({ sql: 's.is_closed = 1', params: [] }),
  overdue: (v, ctx) => ({ sql: 'wp.due_date < ? AND s.is_closed = 0', params: [ctx.today] }),
  due_before: (v) => ({ sql: 'wp.due_date < ?', params: [v] }),
  due_after: (v) => ({ sql: 'wp.due_date > ?', params: [v] }),
  due_between: (v) => ({ sql: 'wp.due_date BETWEEN ? AND ?', params: [v[0], v[1]] }),
  starts_before: (v) => ({ sql: 'wp.start_date < ?', params: [v] }),
  no_sprint: () => ({ sql: 'wp.sprint_id IS NULL', params: [] }),
  no_version: () => ({ sql: 'wp.version_id IS NULL', params: [] }),
  unassigned: () => ({ sql: 'wp.assignee_id IS NULL', params: [] }),
  watched_by: (v) => ({
    sql: 'EXISTS (SELECT 1 FROM work_package_watchers w WHERE w.work_package_id = wp.id AND w.user_id = ?)',
    params: [v],
  }),
  // Involves me: assigned, accountable, or watching. The three-role model means
  // "my work" is genuinely three questions, and answering only the first is why
  // people miss the thing they are accountable for.
  involves: (v) => ({
    sql: `(wp.assignee_id = ? OR wp.accountable_id = ?
           OR EXISTS (SELECT 1 FROM work_package_watchers w WHERE w.work_package_id = wp.id AND w.user_id = ?))`,
    params: [v, v, v],
  }),
  custom: (v) => ({
    sql: `EXISTS (SELECT 1 FROM custom_values cv JOIN custom_fields cf ON cf.id = cv.custom_field_id
                   WHERE cv.customized_type = 'work_package' AND cv.customized_id = wp.id
                     AND cf.name = ? AND cv.value = ?)`,
    params: [v.field, v.value],
  }),
  // Free text. Matches the key, the subject and the assignee's name, which is
  // what a person means when they type into the filter box.
  q: (v) => ({
    sql: '(wp.wp_key LIKE ? OR wp.subject LIKE ? OR ua.name LIKE ? OR v.code LIKE ?)',
    params: Array(4).fill(`%${String(v).replace(/[%_]/g, (c) => '\\' + c)}%`),
  }),
  ids: (v) => clause('wp.id', v),
  // Restrict to what the caller is allowed to see. Always applied by the API
  // layer; a filter rather than a wrapper so it composes with everything else.
  visible_projects: (v) => clause('wp.project_id', v),
};

/** `col = ?` or `col IN (…)` depending on whether the value is a list. */
function clause(column, value) {
  if (Array.isArray(value)) {
    const c = db.inClause(value);
    return { sql: `${column} IN ${c.sql}`, params: c.params };
  }
  return { sql: `${column} = ?`, params: [value] };
}

const SORTS = {
  id: 'wp.id',
  key: 'wp.id',
  subject: 'wp.subject',
  status: 's.position',
  priority: 'pr.position DESC',
  type: 't.position',
  due: 'wp.due_date',
  start: 'wp.start_date',
  points: 'wp.story_points',
  updated: 'wp.updated_at DESC',
  project: 'p.code',
  board: 'wp.board_position',
  backlog: 'wp.backlog_position',
};

/**
 * Run a query.
 *
 *   filters  an object whose keys are in FILTERS
 *   sort     a key in SORTS, optionally prefixed with '-' for descending
 *   limit    capped at 1000 — a list that would return more than that is a list
 *            somebody should have filtered, and an uncapped query is how one
 *            request takes the server down
 */
async function select({ filters = {}, sort = 'id', limit = 500, offset = 0, today = null } = {}) {
  const ctx = { today: today || new Date().toISOString().slice(0, 10) };
  const where = [];
  const params = [];

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const build = FILTERS[key];
    if (!build) throw badRequest(`unknown filter "${key}"`);
    const part = build(value, ctx);
    where.push(`(${part.sql})`);
    params.push(...part.params);
  }

  const desc = String(sort).startsWith('-');
  const sortKey = desc ? String(sort).slice(1) : String(sort);
  if (!SORTS[sortKey]) throw badRequest(`unknown sort "${sortKey}"`);
  const orderBy = SORTS[sortKey] + (desc && !/DESC$/.test(SORTS[sortKey]) ? ' DESC' : '');

  const cap = Math.min(1000, Math.max(1, Number(limit) || 500));
  const sql = `${SELECT}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}, wp.id
    LIMIT ${cap} OFFSET ${Math.max(0, Number(offset) || 0)}`;
  return db.query(sql, params);
}

/** How many rows the same filters would return, without fetching them. */
async function count({ filters = {}, today = null } = {}) {
  const ctx = { today: today || new Date().toISOString().slice(0, 10) };
  const where = [];
  const params = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const build = FILTERS[key];
    if (!build) throw badRequest(`unknown filter "${key}"`);
    const part = build(value, ctx);
    where.push(`(${part.sql})`);
    params.push(...part.params);
  }
  const sql = `SELECT COUNT(*) AS n FROM work_packages wp
    JOIN work_package_types t ON t.id = wp.type_id
    JOIN statuses s          ON s.id = wp.status_id
    JOIN priorities pr       ON pr.id = wp.priority_id
    JOIN projects p          ON p.id = wp.project_id
    LEFT JOIN versions v     ON v.id = wp.version_id
    LEFT JOIN sprints sp     ON sp.id = wp.sprint_id
    LEFT JOIN users ua       ON ua.id = wp.assignee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  return Number(await db.scalar(sql, params));
}

/** One row by id, in the same shape as a list row. */
async function byId(id) {
  const rows = await db.query(`${SELECT} WHERE wp.id = ?`, [id]);
  return rows.length ? rows[0] : null;
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

module.exports = { select, count, byId, FILTERS, SORTS, SELECT };
