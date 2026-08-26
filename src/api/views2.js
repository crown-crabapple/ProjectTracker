/**
 * The read side, continued: portfolio, project overview, work, Gantt.
 *
 * Split from views.js only because one file of two thousand lines is harder to
 * read than two of a thousand. The shared row shape and the small formatters
 * live in views.js and are imported, never copied.
 */

'use strict';

const db = require('../db');
const rollup = require('../domain/rollup');
const sched = require('../domain/scheduling');
const lifecycle = require('../domain/lifecycle');
const query = require('../domain/query');
const { notFound } = require('../http/router');
const { row, shortDate, ago, num } = require('./views');

// ---------------------------------------------------------------------- portfolio

/**
 * The portfolio.
 *
 * `programCode` narrows BOTH the tables and the KPI strip. Narrowing only the
 * tables was the first version and it produced a header reading "7 projects"
 * above a table showing four — a summary that does not summarise what is under
 * it is worse than no summary.
 */
async function portfolio(ctx, { favouritesOnly = false, listId = null, programCode = null } = {}) {
  const ids = ctx.visibleProjectIds;
  if (!ids.length) return { kpis: {}, programs: [], templates: [], lifecycle: [], lists: [] };
  const clause = db.inClause(ids);

  const all = await query.select({
    filters: { visible_projects: ids }, limit: 1000, today: ctx.today,
  });

  const projects = await db.query(`
    SELECT p.id, p.code, p.name, p.identifier, p.health, p.health_note, p.program_id, p.archived,
           g.code AS program_code, g.name AS program_name, g.summary AS program_summary, g.position AS program_position,
           EXISTS (SELECT 1 FROM project_favorites f WHERE f.project_id = p.id AND f.user_id = ?) AS favourite
      FROM projects p LEFT JOIN programs g ON g.id = p.program_id
     WHERE p.id IN ${clause.sql}
     ORDER BY g.position, p.code`, [ctx.user.id, ...clause.params]);

  const phases = await db.query(
    `SELECT * FROM project_phases WHERE project_id IN ${clause.sql} ORDER BY project_id, position`, clause.params
  );
  const phaseMap = new Map();
  for (const ph of phases) {
    if (!phaseMap.has(ph.project_id)) phaseMap.set(ph.project_id, []);
    phaseMap.get(ph.project_id).push(ph);
  }

  const rows = projects
    .filter((p) => !favouritesOnly || p.favourite)
    .filter((p) => !programCode || p.program_code === programCode)
    .map((p) => {
      const own = all.filter((w) => Number(w.project_id) === Number(p.id));
      const life = lifecycle.summarise(phaseMap.get(p.id) || []);
      return {
        id: p.id, code: p.code, name: p.name, identifier: p.identifier,
        favourite: Boolean(p.favourite),
        health: p.health, health_note: p.health_note,
        program_id: p.program_id, program_code: p.program_code,
        readiness: rollup.readiness(own),
        completion: rollup.completion(own),
        open: own.filter((w) => !w.is_closed).length,
        points: rollup.points(own),
        lifecycle: life,
        phases: life.phases.map((ph, i) => ({
          name: ph.name, gate: ph.gate_name, state: ph.state,
          position: ph.position,
          done: i < life.currentIndex,
          current: i === life.currentIndex,
        })),
        next_gate: life.nextGate,
      };
    });

  const programs = [];
  for (const p of rows) {
    let g = programs.find((x) => x.code === p.program_code);
    if (!g) {
      const meta = projects.find((x) => x.program_code === p.program_code);
      g = {
        code: p.program_code || null,
        name: meta ? meta.program_name : 'Unassigned',
        summary: meta ? meta.program_summary : 'projects with no program',
        projects: [],
      };
      programs.push(g);
    }
    g.projects.push(p);
  }

  const templates = await db.query(
    'SELECT id, code, name, detail, blueprint FROM project_templates WHERE archived = 0 ORDER BY code'
  );

  // The life cycle rollup: how many projects sit in each phase name. Phase names
  // vary per template, so this groups by name and reports what it found rather
  // than assuming one canonical list.
  const byPhaseName = new Map();
  for (const p of rows) {
    const cur = p.lifecycle.current;
    if (!cur) continue;
    if (!byPhaseName.has(cur.name)) {
      byPhaseName.set(cur.name, { phase: cur.name, gate: cur.gate_criterion, count: 0, blocked: 0 });
    }
    const e = byPhaseName.get(cur.name);
    e.count += 1;
    if (cur.state === 'blocked') e.blocked += 1;
  }

  const gatesBlocked = rows.filter((p) => p.lifecycle.blocked);

  // Scoped to the rows on screen, so the strip and the tables cannot disagree.
  const shownIds = new Set(rows.map((p) => Number(p.id)));
  const shown = all.filter((w) => shownIds.has(Number(w.project_id)));

  const lists = await db.query(`
    SELECT l.id, l.name, l.starred, l.visibility, l.filters,
           (SELECT COUNT(*) FROM project_list_shares s
             WHERE s.list_id = l.id AND s.revoked_at IS NULL) AS shares,
           (SELECT s.token FROM project_list_shares s
             WHERE s.list_id = l.id AND s.revoked_at IS NULL
               AND (s.expires_at IS NULL OR s.expires_at > NOW())
             ORDER BY s.created_at DESC LIMIT 1) AS share_token
      FROM project_lists l WHERE l.owner_id = ? OR l.visibility <> 'private'
     ORDER BY l.starred DESC, l.name`, [ctx.user.id]);

  return {
    kpis: {
      projects: rows.length,
      projectsSub: `in ${programs.length} program(s)`
        + (projects.some((p) => p.archived) ? ` · ${projects.filter((p) => p.archived).length} archived` : '')
        + (programCode ? ` · filtered to ${programCode}` : '')
        + (favouritesOnly ? ' · favourites only' : ''),
      readiness: rollup.readiness(shown),
      open: shown.filter((w) => !w.is_closed).length,
      openSub: `${shown.filter((w) => w.status_code === 'in_build').length} in build`
        + ` · ${shown.filter((w) => w.status_code === 'speccing').length} speccing`,
      gatesBlocked: gatesBlocked.length,
      gatesBlockedSub: gatesBlocked.map((p) => `${p.code} ${p.lifecycle.current.gate_name}`).join(' · ') || 'none',
    },
    programs,
    templates: templates.map((t) => ({ ...t, blueprint: db.json(t.blueprint, {}) })),
    lifecycle: [...byPhaseName.values()],
    lists: lists.map((l) => ({ ...l, filters: db.json(l.filters, {}), starred: Boolean(l.starred) })),
    favouritesOnly,
    listId,
  };
}

// --------------------------------------------------------------- project overview

async function overview(ctx, projectId) {
  const project = await db.one(`
    SELECT p.*, g.code AS program_code, g.name AS program_name,
           o.name AS organization_name, ww.name AS work_week_name,
           t.code AS template_code
      FROM projects p
      LEFT JOIN programs g ON g.id = p.program_id
      LEFT JOIN organizations o ON o.id = p.organization_id
      LEFT JOIN work_weeks ww ON ww.id = p.work_week_id
      LEFT JOIN project_templates t ON t.id = p.template_id
     WHERE p.id = ?`, [projectId]);
  if (!project) throw notFound('no such project');

  const wps = await query.select({ filters: { project: projectId }, limit: 1000, today: ctx.today });
  const statuses = await db.query('SELECT * FROM statuses ORDER BY position');
  const types = await db.query('SELECT * FROM work_package_types ORDER BY position');
  const phases = await db.query('SELECT * FROM project_phases WHERE project_id = ? ORDER BY position', [projectId]);
  const life = lifecycle.summarise(phases);

  const versions = await db.query(`
    SELECT v.* FROM versions v WHERE v.project_id = ? ORDER BY v.due_date IS NULL, v.due_date`, [projectId]);

  const members = await db.query(`
    SELECT u.id, u.name, u.initials, u.colour, u.kind, u.weekly_capacity,
           GROUP_CONCAT(DISTINCT r.name ORDER BY r.position SEPARATOR ', ') AS roles,
           g.name AS via_group
      FROM memberships m
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN user_groups g ON g.id = m.group_id
      LEFT JOIN membership_roles mr ON mr.membership_id = m.id
      LEFT JOIN roles r ON r.id = mr.role_id
     WHERE m.project_id = ? AND m.user_id IS NOT NULL
     GROUP BY u.id, g.name
     ORDER BY MIN(r.position), u.name`, [projectId]);

  const activity = await recentActivity(ctx, { projectId, limit: 8 });
  const hours = rollup.hours(wps);
  const dashboard = await db.one(
    'SELECT id, name FROM dashboards WHERE project_id = ? AND owner_id IS NULL LIMIT 1', [projectId]
  );
  const widgets = dashboard
    ? await db.query('SELECT id, kind, title, position, span, config FROM dashboard_widgets WHERE dashboard_id = ? ORDER BY position', [dashboard.id])
    : [];

  return {
    project: {
      id: project.id, code: project.code, name: project.name, identifier: project.identifier,
      health: project.health, health_note: project.health_note,
      program: project.program_code ? { code: project.program_code, name: project.program_name } : null,
      organization: project.organization_name,
      work_week: project.work_week_name,
      template: project.template_code,
      archived: Boolean(project.archived),
    },
    lifecycle: {
      ...life,
      phases: life.phases.map((ph, i) => ({
        id: ph.id, position: ph.position, name: ph.name, gate: ph.gate_name,
        criterion: ph.gate_criterion, state: ph.state,
        gate_met_on: ph.gate_met_on, gate_note: ph.gate_note,
        done: i < life.currentIndex, current: i === life.currentIndex,
      })),
    },
    kpis: {
      readiness: rollup.readiness(wps),
      completion: rollup.completion(wps),
      open: wps.filter((w) => !w.is_closed).length,
      closed: wps.filter((w) => w.is_closed).length,
      points: rollup.points(wps),
      hours,
    },
    statusBar: rollup.statusBar(wps, statuses),
    statusRows: rollup.byStatus(wps, statuses).filter((s) => s.count > 0).map((s) => ({
      ...s, pct: wps.length ? Math.round((s.count / wps.length) * 100) : 0,
    })),
    typeRows: rollup.byType(wps, types).filter((t) => t.count > 0),
    versions: versions.map((v) => {
      const list = wps.filter((w) => Number(w.version_id) === Number(v.id));
      return {
        id: v.id, code: v.code, name: v.name, state: v.state, sharing: v.sharing,
        due_date: v.due_date, due_short: shortDate(v.due_date) || 'UNSCHEDULED',
        count: list.length,
        closed: list.filter((w) => w.is_closed).length,
        points: rollup.points(list),
        readiness: rollup.readiness(list),
      };
    }),
    members: members.map((m) => ({
      id: m.id, name: m.name, initials: m.initials, colour: m.colour, kind: m.kind,
      roles: m.roles || (m.via_group ? `via ${m.via_group}` : ''),
      capacity: num(m.weekly_capacity),
    })),
    activity,
    widgets: widgets.map((w) => ({ ...w, config: db.json(w.config, {}) })),
  };
}

// ------------------------------------------------------------------ work packages

async function work(ctx, { projectId = null, filters = {}, sort = 'id', flat = false } = {}) {
  const base = projectId
    ? { project: projectId }
    : { visible_projects: ctx.visibleProjectIds };
  const combined = { ...base, ...filters };
  const wps = await query.select({ filters: combined, sort, limit: 1000, today: ctx.today });
  const statuses = await db.query('SELECT * FROM statuses ORDER BY position');

  // The unfiltered set, for the filter chips' counts. A chip that showed the
  // count *after* its own filter was applied would always read the same number
  // as the list, which is useless: the point of the chip is to say how many
  // there would be if you clicked it.
  const scope = await query.select({ filters: base, limit: 1000, today: ctx.today });

  const { rows, cycles } = flat
    ? { rows: wps.map((w) => ({ ...w, depth: 0 })), cycles: [] }
    : rollup.flattenHierarchy(wps);

  return {
    rows: rows.map((w) => row(w, ctx, { depth: w.depth, orphaned: Boolean(w.orphaned) })),
    shown: rows.length,
    total: scope.length,
    highlightMode: ctx.user.highlight_mode,
    statusFilters: rollup.byStatus(scope, statuses),
    typeFilters: rollup.byType(scope, await db.query('SELECT * FROM work_package_types ORDER BY position')),
    // A cycle in the parent chain is a data problem, and the list says so rather
    // than silently reordering. Nothing in the app can create one; a hand-edited
    // database can.
    cycles,
  };
}

// -------------------------------------------------------------------------- gantt

/**
 * The Gantt.
 *
 * The timeline bounds come from the data, padded to whole months, rather than
 * being fixed: a chart with hard-coded bounds silently truncates a bar the first
 * time somebody plans past them.
 */
async function gantt(ctx, { projectId = null, baselineId = null } = {}) {
  const base = projectId ? { project: projectId } : { visible_projects: ctx.visibleProjectIds };
  const wps = await query.select({ filters: base, sort: 'start', limit: 1000, today: ctx.today });
  if (!wps.length) return { rows: [], months: [], weeks: [], t0: null, t1: null, todayPct: null, baseline: null };

  const starts = wps.map((w) => w.start_date).filter(Boolean).sort();
  const dues = wps.map((w) => w.due_date).filter(Boolean).sort();
  const first = starts[0] || ctx.today;
  const last = dues[dues.length - 1] || ctx.today;
  const t0 = monthStart(first);
  const t1 = monthEnd(last);

  const baseline = baselineId
    ? await db.one('SELECT * FROM baselines WHERE id = ?', [baselineId])
    : projectId
      ? await db.one('SELECT * FROM baselines WHERE project_id = ? AND is_current = 1 ORDER BY taken_at DESC LIMIT 1', [projectId])
      : null;
  const entries = baseline
    ? await db.query('SELECT * FROM baseline_entries WHERE baseline_id = ?', [baseline.id])
    : [];
  const entryByWp = new Map(entries.map((e) => [Number(e.work_package_id), e]));

  const relations = await db.query(`
    SELECT r.* FROM work_package_relations r
     WHERE r.from_id IN ${db.inClause(wps.map((w) => w.id)).sql}`, wps.map((w) => w.id));

  const { rows } = rollup.flattenHierarchy(wps);

  return {
    t0,
    t1,
    todayPct: ctx.today >= t0 && ctx.today <= t1
      ? sched.timelinePosition(ctx.today, ctx.today, t0, t1).left : null,
    months: monthsBetween(t0, t1).map((m) => ({
      label: m.label,
      widthPct: ((sched.daysBetween(m.from, m.to) + 1) / (sched.daysBetween(t0, t1) + 1)) * 100,
    })),
    weeks: weeksBetween(t0, t1),
    baseline: baseline
      ? { id: baseline.id, name: baseline.name, taken_at: baseline.taken_at, note: baseline.note }
      : null,
    rows: rows.map((w) => {
      // A work package with neither date gets no bar. It used to be positioned
      // anyway, which passed null into the date parser and returned a 500 for the
      // whole chart — and "no dates yet" is the normal state of anything created
      // by the email intake or straight from a board.
      const undated = !w.start_date && !w.due_date;
      const pos = undated
        ? { left: null, width: null }
        : sched.timelinePosition(w.start_date || w.due_date, w.due_date || w.start_date, t0, t1);
      const entry = entryByWp.get(Number(w.id));
      const cmp = entry ? sched.compareToBaseline(w, entry) : null;
      const basePos = entry && entry.start_date && entry.due_date
        ? sched.timelinePosition(entry.start_date, entry.due_date, t0, t1) : null;
      return {
        ...row(w, ctx, { depth: w.depth }),
        undated,
        leftPct: pos.left,
        widthPct: pos.width,
        baseline: cmp ? { ...cmp, leftPct: basePos ? basePos.left : null, widthPct: basePos ? basePos.width : null } : null,
        follows: relations.filter((r) => Number(r.from_id) === Number(w.id) && r.kind === 'follows')
          .map((r) => Number(r.to_id)),
        blocks: relations.filter((r) => Number(r.from_id) === Number(w.id) && r.kind === 'blocks')
          .map((r) => Number(r.to_id)),
      };
    }),
  };
}

const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
function monthEnd(iso) {
  const [y, m] = iso.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return sched.addDays(next, -1);
}
function monthsBetween(t0, t1) {
  const out = [];
  let cursor = monthStart(t0);
  while (cursor <= t1) {
    const end = monthEnd(cursor);
    out.push({
      from: cursor < t0 ? t0 : cursor,
      to: end > t1 ? t1 : end,
      label: new Date(sched.parseDay(cursor)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }).toUpperCase(),
    });
    cursor = monthStart(sched.addDays(end, 1));
  }
  return out;
}
/**
 * The week ruler, with each cell's width in per cent of the whole span.
 *
 * Sized by the days it actually covers inside [t0, t1] rather than by 1/n. The
 * first and last weeks are usually partial — t0 is a month start, which is
 * rarely a Monday — and dividing the width evenly put every week gridline a few
 * pixels away from the month boundary above it and from the bars below.
 */
function weeksBetween(t0, t1) {
  const { isoWeek } = require('./views');
  const totalDays = sched.daysBetween(t0, t1) + 1;
  const out = [];
  let cursor = sched.weekStart(t0);
  while (cursor <= t1) {
    const from = cursor < t0 ? t0 : cursor;
    const weekEnd = sched.addDays(cursor, 6);
    const to = weekEnd > t1 ? t1 : weekEnd;
    out.push({
      week_start: cursor,
      label: `W${isoWeek(cursor)}`,
      widthPct: ((sched.daysBetween(from, to) + 1) / totalDays) * 100,
    });
    cursor = sched.addDays(cursor, 7);
  }
  return out;
}

/** The activity feed, with internal comments excluded unless the reader may see them. */
async function recentActivity(ctx, { projectId = null, limit = 40 } = {}) {
  const params = [];
  let where = '1 = 1';
  if (projectId) { where = 'a.project_id = ?'; params.push(projectId); }
  else if (ctx.visibleProjectIds.length) {
    const c = db.inClause(ctx.visibleProjectIds);
    where = `(a.project_id IS NULL OR a.project_id IN ${c.sql})`;
    params.push(...c.params);
  }
  const rows = await db.query(`
    SELECT a.*, u.name AS actor_name, u.initials, u.colour,
           wp.wp_key, p.code AS project_code
      FROM activities a
      LEFT JOIN users u ON u.id = a.actor_id
      LEFT JOIN work_packages wp ON wp.id = a.work_package_id
      LEFT JOIN projects p ON p.id = a.project_id
     WHERE ${where}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ${Math.min(200, Math.max(1, Number(limit) || 40))}`, params);
  return rows.map((a) => ({
    id: a.id, kind: a.kind, verb: a.verb, detail: a.detail,
    who: a.actor_name || a.actor_label || 'someone',
    is_machine: !a.actor_id,
    target: a.wp_key || a.target_label || a.project_code,
    project_code: a.project_code,
    work_package_id: a.work_package_id,
    from: a.from_value, to: a.to_value,
    created_at: a.created_at,
    when: ago(a.created_at),
  }));
}

module.exports = { portfolio, overview, work, gantt, recentActivity, monthsBetween, weeksBetween };
