/**
 * The read side: one endpoint per screen.
 *
 * Each function returns exactly what one view draws, already rolled up. The
 * alternative — a generic resource API the browser assembles a screen out of —
 * was rejected for a specific reason: every number on these screens is a
 * derivation with a rule attached (weighted readiness, leaf-only points, a
 * shared sprint counted once), and a client that assembles them itself will
 * eventually get one of those rules wrong. The rules live in src/domain and are
 * applied here, once.
 *
 * Every function takes `ctx` = { user, permissions, visibleProjectIds, today }.
 */

'use strict';

const db = require('../db');
const rollup = require('../domain/rollup');
const sched = require('../domain/scheduling');
const lifecycle = require('../domain/lifecycle');
const query = require('../domain/query');
const access = require('../domain/access');
const { notFound, badRequest } = require('../http/router');

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** '2026-08-26' -> '26 AUG'. The short form every table uses. */
function shortDate(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split('-');
  return `${Number(d)} ${MONTH_ABBR[Number(m) - 1]}`;
}

/** A relative age, in the compressed form the activity feed uses. */
function ago(dt, now = Date.now()) {
  if (!dt) return null;
  const then = Date.parse(String(dt).replace(' ', 'T') + 'Z');
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

// --------------------------------------------------------------------- bootstrap

/**
 * Everything the shell needs: who you are, what you can see, and the vocabulary.
 *
 * The nav counts are here rather than fetched per view because they are on
 * screen the whole time, and a badge that updates only when you visit the page
 * it counts is a badge nobody believes.
 */
async function bootstrap(ctx) {
  const ids = ctx.visibleProjectIds;
  if (!ids.length) {
    return {
      user: ctx.user, today: ctx.today, projects: [], programs: [],
      statuses: [], priorities: [], types: [], theme: null,
      counts: { my: 0, projects: 0, inbox: 0, alerts: 0 },
      portfolioName: await setting('app.portfolio_name', 'Portfolio'),
    };
  }
  const clause = db.inClause(ids);

  const projects = await db.query(`
    SELECT p.id, p.code, p.identifier, p.name, p.health, p.health_note, p.archived,
           p.program_id, p.parent_id, g.code AS program_code, g.name AS program_name,
           (SELECT COUNT(*) FROM work_packages wp WHERE wp.project_id = p.id) AS wp_total,
           (SELECT COUNT(*) FROM work_packages wp JOIN statuses s ON s.id = wp.status_id
             WHERE wp.project_id = p.id AND s.is_closed = 0) AS wp_open,
           EXISTS (SELECT 1 FROM project_favorites f WHERE f.project_id = p.id AND f.user_id = ?) AS favourite
      FROM projects p LEFT JOIN programs g ON g.id = p.program_id
     WHERE p.id IN ${clause.sql}
     ORDER BY g.position, p.code`, [ctx.user.id, ...clause.params]);

  const phases = await db.query(
    `SELECT * FROM project_phases WHERE project_id IN ${clause.sql} ORDER BY project_id, position`,
    clause.params
  );
  const phasesByProject = new Map();
  for (const ph of phases) {
    if (!phasesByProject.has(ph.project_id)) phasesByProject.set(ph.project_id, []);
    phasesByProject.get(ph.project_id).push(ph);
  }

  for (const p of projects) {
    p.favourite = Boolean(p.favourite);
    p.lifecycle = lifecycle.summarise(phasesByProject.get(p.id) || []);
  }

  const [statuses, priorities, types, programs, theme] = await Promise.all([
    db.query('SELECT id, code, label, colour, is_closed, is_default, progress_weight, position FROM statuses ORDER BY position'),
    db.query('SELECT id, code, label, colour, position FROM priorities ORDER BY position'),
    db.query('SELECT id, name, colour, is_milestone, is_parent_ok, subject_pattern FROM work_package_types ORDER BY position'),
    db.query('SELECT id, code, name, summary, position FROM programs ORDER BY position'),
    db.one('SELECT id, name, tokens, reserved_note FROM themes WHERE id = ? OR is_default = 1 ORDER BY (id = ?) DESC LIMIT 1',
      [ctx.user.theme_id || 0, ctx.user.theme_id || 0]),
  ]);

  const myOpen = await query.count({
    filters: { visible_projects: ids, involves: ctx.user.id, open: true }, today: ctx.today,
  });
  const inbox = Number(await db.scalar(
    'SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL', [ctx.user.id]
  ));
  const alerts = Number(await db.scalar(
    "SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'date_alert' AND read_at IS NULL",
    [ctx.user.id]
  ));

  return {
    user: ctx.user,
    today: ctx.today,
    portfolioName: await setting('app.portfolio_name', 'Portfolio'),
    projects,
    programs,
    statuses: statuses.map((s) => ({ ...s, progress_weight: num(s.progress_weight) })),
    priorities,
    types,
    theme: theme ? { ...theme, tokens: db.json(theme.tokens, {}) } : null,
    counts: { my: myOpen, projects: projects.length, inbox, alerts },
  };
}

async function setting(name, fallback) {
  const v = await db.scalar('SELECT value FROM settings WHERE name = ?', [name]);
  return v === null || v === undefined ? fallback : v;
}

// ----------------------------------------------------------------------- my page

async function myPage(ctx) {
  const ids = ctx.visibleProjectIds;
  const mine = ids.length
    ? await query.select({
      filters: { visible_projects: ids, involves: ctx.user.id, open: true },
      sort: 'due', limit: 200, today: ctx.today,
    })
    : [];

  const weekEnd = sched.addDays(sched.weekStart(ctx.today), 6);
  const dueThisWeek = mine.filter((w) => w.due_date && w.due_date <= weekEnd);
  const overdue = mine.filter((w) => rollup.isOverdue(w, ctx.today));

  // Hours booked for this week against declared capacity.
  const thisWeek = sched.weekStart(ctx.today);
  const booked = Number(await db.scalar(
    'SELECT COALESCE(SUM(hours), 0) FROM resource_allocations WHERE user_id = ? AND week_start = ?',
    [ctx.user.id, thisWeek]
  ));

  // Points in flight: leaf work assigned to me in an ACTIVE sprint and not
  // closed. "In flight" deliberately excludes planned sprints — points in a
  // sprint that has not started are a plan, not work in progress.
  const activeSprints = await db.query("SELECT id, code FROM sprints WHERE state = 'active'");
  const inFlight = mine.filter((w) => rollup.isLeaf(w)
    && activeSprints.some((s) => Number(s.id) === Number(w.sprint_id)));

  const weeks = [];
  for (let i = 0; i < 6; i += 1) {
    const start = sched.addDays(thisWeek, i * 7);
    const hours = Number(await db.scalar(
      'SELECT COALESCE(SUM(hours), 0) FROM resource_allocations WHERE user_id = ? AND week_start = ?',
      [ctx.user.id, start]
    ));
    weeks.push({
      week_start: start,
      label: `W${isoWeek(start)}`,
      long_label: `W${isoWeek(start)} ${shortDate(start).toUpperCase()}`,
      ...rollup.loadCell(hours, ctx.user.weekly_capacity),
    });
  }

  const alerts = await db.query(`
    SELECT n.id, n.kind, n.title, n.detail, n.created_at, n.read_at,
           wp.wp_key, wp.id AS work_package_id, wp.due_date,
           s.is_closed
      FROM notifications n
      LEFT JOIN work_packages wp ON wp.id = n.work_package_id
      LEFT JOIN statuses s ON s.id = wp.status_id
     WHERE n.user_id = ? AND n.kind = 'date_alert'
     ORDER BY n.created_at DESC LIMIT 12`, [ctx.user.id]);

  const summary = ctx.user.show_ai_summaries
    ? await db.one(`
      SELECT gs.id, gs.body, gs.source, gs.generated_at, t.name AS token_name
        FROM generated_summaries gs LEFT JOIN mcp_tokens t ON t.id = gs.token_id
       WHERE gs.superseded_at IS NULL AND gs.scope = 'user' AND gs.user_id = ?
       ORDER BY gs.generated_at DESC LIMIT 1`, [ctx.user.id])
    : null;

  return {
    today: ctx.today,
    kpis: {
      assigned: mine.length,
      assignedSub: `${mine.filter((w) => w.priority_code === 'immediate' || w.priority_code === 'high').length} high or immediate`
        + ` · ${new Set(mine.map((w) => w.project_id)).size} projects`,
      dueThisWeek: dueThisWeek.length,
      dueSub: `${overdue.length} already overdue · ${Math.max(0, dueThisWeek.length - overdue.length)} inside the week`,
      bookedThisWeek: booked,
      capacity: ctx.user.weekly_capacity,
      points: rollup.points(inFlight),
      pointsSub: `across ${new Set(inFlight.map((w) => w.sprint_code)).size} active sprint(s)`,
    },
    work: mine.slice(0, 12).map((w) => row(w, ctx)),
    alerts: alerts.map((a) => ({
      id: a.id, work_package_id: a.work_package_id, wp_key: a.wp_key,
      text: a.detail || a.title, when: whenLabel(a, ctx.today), unread: !a.read_at,
      severity: a.due_date && a.due_date < ctx.today && !a.is_closed ? 'overdue'
        : a.due_date && a.due_date <= sched.addDays(ctx.today, 3) ? 'soon' : 'later',
    })),
    weeks,
    summary: summary ? { ...summary, age: ago(summary.generated_at) } : null,
  };
}

function whenLabel(alert, today) {
  if (!alert.due_date) return 'NO DATE';
  const days = sched.daysBetween(today, alert.due_date);
  if (days < 0) return `OVERDUE ${Math.abs(days)}D`;
  if (days === 0) return 'TODAY';
  return `IN ${days}D`;
}

function isoWeek(iso) {
  const d = new Date(sched.parseDay(iso));
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  return 1 + Math.round((target - firstThursday) / (7 * 86400000));
}

/** The row shape every table shares. Computed once so no two tables disagree. */
function row(w, ctx, extra = {}) {
  return {
    id: w.id,
    key: w.wp_key,
    subject: w.subject,
    type: w.type_name,
    type_colour: w.type_colour,
    is_milestone: Boolean(w.is_milestone),
    status: w.status_code,
    status_label: w.status_label,
    status_colour: w.status_colour,
    is_closed: Boolean(w.is_closed),
    priority: w.priority_code,
    priority_label: w.priority_label,
    priority_colour: w.priority_colour,
    project_id: w.project_id,
    project_code: w.project_code,
    project_name: w.project_name,
    assignee: w.assignee_name,
    assignee_kind: w.assignee_kind,
    accountable: w.accountable_name,
    watchers: Number(w.watcher_count) || 0,
    start_date: w.start_date,
    due_date: w.due_date,
    dates: `${shortDate(w.start_date) || '—'} → ${shortDate(w.due_date) || '—'}`,
    due_short: shortDate(w.due_date) || '—',
    overdue: rollup.isOverdue(w, ctx.today),
    scheduling: w.scheduling,
    estimated_hours: num(w.estimated_hours),
    spent_hours: num(w.spent_hours),
    story_points: num(w.story_points),
    version: w.version_code,
    sprint: w.sprint_code,
    sprint_shared: w.sprint_sharing === 'system',
    parent_id: w.parent_id,
    comments: Number(w.comment_count) || 0,
    attachments: Number(w.attachment_count) || 0,
    highlight: rollup.highlight(w, ctx.user.highlight_mode, ctx.today),
    ...extra,
  };
}

module.exports = { bootstrap, myPage, row, shortDate, ago, isoWeek, whenLabel, setting, num, MONTH_ABBR };
