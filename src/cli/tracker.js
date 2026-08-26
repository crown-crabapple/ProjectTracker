#!/usr/bin/env node
/**
 * The command line.
 *
 * Same database, no browser, and the same rollup functions the web app uses —
 * which is the point. A CLI that computed its own percentages would be a second
 * implementation of the progress model, and the two would eventually disagree in
 * front of somebody who had to decide which to believe.
 *
 *   pt report                       where the portfolio stands
 *   pt next                         what to pick up now, and what blocks it
 *   pt plan [CODE]                  the life cycle, rolled up
 *   pt list [--project VW] [--status in_build] [--open]
 *   pt show WP-112                  one work package in full
 *   pt status WP-112 done --note "..."
 *   pt assign WP-112 modell
 *   pt gate VW G4 --note "..."
 *   pt baseline VW --name "..."
 *   pt sprint close S-14
 *   pt alerts run
 *   pt activity [--limit 20]
 *   pt export csv|xlsx|pdf [--project VW] [--out FILE]
 *   pt whoami
 *
 * `--as LOGIN` (or PT_CLI_USER) chooses whose permissions the command runs
 * with. There is no ambient superuser: every write goes through the same
 * permission check the API does, so the CLI cannot do something the web app
 * would refuse.
 */

'use strict';

const db = require('../db');
const rollup = require('../domain/rollup');
const lifecycle = require('../domain/lifecycle');
const query = require('../domain/query');
const access = require('../domain/access');
const notify = require('../domain/notify');
const mut = require('../api/mutations');
const mut2 = require('../api/mutations2');
const exporters = require('../api/exports');
const views = require('../api/views');

const argv = process.argv.slice(2);
const command = argv[0] || 'report';

/** Parse `--flag value` and `--flag` pairs, leaving the positionals alone. */
function parseArgs(list) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith('--')) flags[name] = true;
      else { flags[name] = next; i += 1; }
    } else positional.push(a);
  }
  return { flags, positional };
}

const { flags, positional } = parseArgs(argv.slice(1));

/** A flag's value, or null when it was given without one (or not at all). */
const flag = (name) => (flags[name] === true || flags[name] === undefined ? null : String(flags[name]));

// ---------------------------------------------------------------- presentation

// Built from the character code rather than written as a literal escape, so this
// file contains no control characters and survives every editor and diff tool.
const ESC = String.fromCharCode(27);
const CSI = `${ESC}[`;
const sgr = (n) => (s) => `${CSI}${n}m${s}${CSI}0m`;
const W = { dim: sgr(2), bold: sgr(1), amber: sgr(33), green: sgr(32), red: sgr(31), cyan: sgr(36) };

// Colour is off when stdout is not a terminal, so a piped or redirected report
// stays plain text rather than carrying escape sequences into a file.
if (!process.stdout.isTTY || process.env.NO_COLOR) {
  for (const k of Object.keys(W)) W[k] = (s) => String(s);
}

const STATUS_PAINT = {
  done: W.green, in_build: W.amber, speccing: W.cyan,
  not_started: W.dim, deferred: W.dim, rejected: W.red,
};
const paintStatus = (statusCode, text) => (STATUS_PAINT[statusCode] || ((s) => s))(text);

/** The printable length of a string, ignoring colour escapes. */
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const visible = (s) => String(s === null || s === undefined ? '' : s).replace(SGR_PATTERN, '');

/**
 * A fixed-width table that measures its own columns.
 *
 * Widths are measured on the visible text, not the raw string: a coloured cell
 * carries nine invisible characters, and measuring those pads every row
 * differently and shears the columns apart.
 */
function table(headers, rows, aligns = []) {
  if (!rows.length) return '  nothing to show';
  const widths = headers.map((hd, i) => Math.max(
    visible(hd).length,
    ...rows.map((r) => visible(r[i]).length)
  ));
  const pad = (text, i) => {
    const raw = String(text === null || text === undefined ? '' : text);
    const gap = ' '.repeat(Math.max(0, widths[i] - visible(raw).length));
    return aligns[i] === 'r' ? gap + raw : raw + gap;
  };
  const line = (cells) => '  ' + cells.map((c, i) => pad(c, i)).join('  ');
  return [line(headers.map((hd) => W.dim(hd.toUpperCase()))), ...rows.map((r) => line(r))].join('\n');
}

const bar = (value, width = 22) => {
  const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * width);
  return '#'.repeat(filled) + '.'.repeat(width - filled);
};

const heading = (text) => `\n${W.bold(text)}\n${W.dim('-'.repeat(Math.max(12, visible(text).length)))}`;

// ------------------------------------------------------------------ the caller

/**
 * Who the command runs as.
 *
 * `--as LOGIN`, then PT_CLI_USER, then the single administrator if there is
 * exactly one. Refusing to guess between several administrators is deliberate:
 * a write attributed to the wrong person is worse than a command that asks.
 */
async function whoami() {
  const wanted = flag('as') || process.env.PT_CLI_USER;
  if (wanted) {
    const u = await db.one(
      'SELECT * FROM users WHERE login = ? AND active = 1 AND kind = ?', [wanted, 'user']
    );
    if (!u) throw new Error(`no active user with login "${wanted}"`);
    return u;
  }
  const admins = await db.query("SELECT * FROM users WHERE is_admin = 1 AND active = 1 AND kind = 'user'");
  if (admins.length === 1) return admins[0];
  if (!admins.length) throw new Error('no active administrator - run `node db/seed.js`');
  throw new Error(
    `${admins.length} administrators exist, so who this runs as is ambiguous.\n`
    + `  Use --as LOGIN, or set PT_CLI_USER. Candidates: ${admins.map((a) => a.login).join(', ')}`
  );
}

async function context() {
  const user = await whoami();
  const seen = await access.visibleProjects(user.id);
  return {
    user: {
      id: user.id, login: user.login, name: user.name, is_admin: Boolean(user.is_admin),
      kind: user.kind, initials: user.initials, colour: user.colour,
      weekly_capacity: Number(user.weekly_capacity),
      highlight_mode: user.highlight_mode, show_ai_summaries: Boolean(user.show_ai_summaries),
      theme_id: user.theme_id, start_screen: user.start_screen,
    },
    visibleProjectIds: seen.map((r) => Number(r.id)),
    today: new Date().toISOString().slice(0, 10),
  };
}

/** 'WP-112' or '112' -> 112. */
function wpId(token) {
  const m = /^(?:WP-)?(\d+)$/i.exec(String(token || '').trim());
  if (!m) throw new Error(`"${token}" is not a work package key - expected WP-112 or 112`);
  return Number(m[1]);
}

async function projectByCode(ctx, wanted) {
  if (!wanted) return null;
  const p = await db.one('SELECT * FROM projects WHERE code = ? OR identifier = ?',
    [String(wanted).toUpperCase(), String(wanted).toLowerCase()]);
  if (!p) throw new Error(`no project with code "${wanted}"`);
  if (!ctx.visibleProjectIds.includes(Number(p.id))) throw new Error(`you cannot see project ${p.code}`);
  return p;
}

// -------------------------------------------------------------------- commands

const COMMANDS = {
  async report(ctx) {
    const data = await require('../api/views2').portfolio(ctx);
    const out = [heading(`${await views.setting('app.portfolio_name', 'Portfolio')} - where it stands`), ''];
    out.push(`  ${W.bold(String(data.kpis.projects))} projects · ${data.kpis.projectsSub}`);
    out.push(`  ${W.amber(bar(data.kpis.readiness.pct))} ${W.bold(data.kpis.readiness.pct + '%')} weighted readiness`
      + W.dim(`  (${data.kpis.readiness.scored} scored, ${data.kpis.readiness.excluded} excluded)`));
    out.push(`  ${W.bold(String(data.kpis.open))} open work packages · ${data.kpis.openSub}`);
    out.push(`  ${data.kpis.gatesBlocked ? W.red(String(data.kpis.gatesBlocked)) : '0'} gate(s) awaiting a decision`
      + ` · ${data.kpis.gatesBlockedSub}`);
    out.push(W.dim('\n  Readiness is weighted - speccing 0.35, in build 0.7, done 1 - and is not a'));
    out.push(W.dim('  completion figure. Deferred and rejected work leaves the denominator.'));

    for (const program of data.programs) {
      out.push(heading(`${program.code || '-'} ${program.name}`));
      out.push(table(
        ['', 'project', 'readiness', 'done/part/open', 'next gate'],
        program.projects.map((p) => [
          p.favourite ? W.amber('*') : ' ',
          `${p.code} ${p.name}`,
          `${W.amber(bar(p.readiness.pct, 14))} ${String(p.readiness.pct).padStart(3)}%`,
          `${p.completion.done}/${p.completion.partial}/${p.open}`,
          p.next_gate
            ? (p.next_gate.blocked ? W.red : W.dim)(
              p.next_gate.gate ? `${p.next_gate.gate} ${p.next_gate.phase}` : 'shipped'
            )
            : W.dim('no life cycle'),
        ]),
        ['', '', '', 'r', '']
      ));
    }
    return out.join('\n');
  },

  /**
   * What to pick up now.
   *
   * Ordered by what is actually blocking: immediate, then overdue, then work
   * already started, then what is genuinely ready. "What is blocked" is reported
   * separately, because the two questions have different answers and mixing them
   * buries both.
   */
  async next(ctx) {
    const out = [heading('What to pick up now')];
    const mine = await query.select({
      filters: { visible_projects: ctx.visibleProjectIds, involves: ctx.user.id, open: true },
      sort: 'due', limit: 400, today: ctx.today,
    });

    const immediate = mine.filter((w) => w.priority_code === 'immediate');
    const overdue = mine.filter((w) => rollup.isOverdue(w, ctx.today) && !immediate.includes(w));
    const started = mine.filter((w) => w.status_code === 'in_build' && rollup.isLeaf(w)
      && !immediate.includes(w) && !overdue.includes(w));

    const show = (label, list, paintFn) => {
      if (!list.length) return;
      out.push('', `  ${paintFn(label)}`);
      out.push(table(['id', 'project', 'subject', 'status', 'due'], list.slice(0, 8).map((w) => [
        w.wp_key, w.project_code, w.subject.slice(0, 52),
        paintStatus(w.status_code, w.status_label),
        rollup.isOverdue(w, ctx.today) ? W.red(w.due_date || '-') : (w.due_date || '-'),
      ])));
    };
    show('IMMEDIATE', immediate, W.red);
    show('OVERDUE', overdue, W.red);
    show('IN BUILD - finish before starting more', started, W.amber);

    // Anything unstarted whose predecessors are all closed is genuinely ready.
    const ready = [];
    const blocked = [];
    for (const w of mine) {
      const preds = await db.query(`
        SELECT wp.wp_key, s.is_closed FROM work_package_relations r
          JOIN work_packages wp ON wp.id = r.to_id
          JOIN statuses s ON s.id = wp.status_id
         WHERE r.from_id = ? AND r.kind IN ('follows', 'requires')`, [w.id]);
      const open = preds.filter((p) => !p.is_closed);
      if (open.length) blocked.push([w.wp_key, w.subject.slice(0, 44), open.map((o) => o.wp_key).join(', ')]);
      else if (w.status_code === 'not_started') ready.push(w);
    }
    show('READY - nothing in front of it', ready, W.cyan);

    if (blocked.length) {
      out.push('', `  ${W.dim('BLOCKED - waiting on something else')}`);
      out.push(table(['id', 'subject', 'waiting on'], blocked));
    }

    if (ctx.visibleProjectIds.length) {
      const clause = db.inClause(ctx.visibleProjectIds);
      const gates = await db.query(`
        SELECT p.code, ph.gate_name, ph.name, ph.gate_criterion FROM project_phases ph
          JOIN projects p ON p.id = ph.project_id
         WHERE ph.state = 'blocked' AND ph.project_id IN ${clause.sql}`, clause.params);
      if (gates.length) {
        out.push('', `  ${W.red('GATES AWAITING A DECISION')}`);
        out.push(table(['project', 'gate', 'criterion'],
          gates.map((g) => [g.code, `${g.gate_name} ${g.name}`, g.gate_criterion])));
      }
    }

    if (out.length === 1) out.push('\n  nothing open that involves you');
    return out.join('\n');
  },

  async plan(ctx) {
    const clause = db.inClause(ctx.visibleProjectIds.length ? ctx.visibleProjectIds : [0]);
    const projects = positional[0]
      ? [await projectByCode(ctx, positional[0])]
      : await db.query(`SELECT * FROM projects WHERE id IN ${clause.sql} ORDER BY code`, clause.params);
    const out = [heading('Life cycle')];
    for (const p of projects) {
      const phases = await db.query('SELECT * FROM project_phases WHERE project_id = ? ORDER BY position', [p.id]);
      const life = lifecycle.summarise(phases);
      const wps = await query.select({ filters: { project: p.id }, limit: 1000, today: ctx.today });
      out.push('', `  ${W.bold(`${p.code} ${p.name}`)}  `
        + W.dim(`${life.gatesMet}/${life.gatesTotal} gates met · ${rollup.readiness(wps).pct}% weighted readiness`));
      out.push(table(['gate', 'phase', 'state', 'criterion'], life.phases.map((ph) => [
        ph.gate_name, ph.name,
        ph.state === 'gate_met' ? W.green(`met ${ph.gate_met_on || ''}`.trim())
          : ph.state === 'current' ? W.amber('current')
            : ph.state === 'blocked' ? W.red('criterion undecided') : W.dim('not entered'),
        W.dim(ph.gate_criterion),
      ])));
    }
    return out.join('\n');
  },

  async list(ctx) {
    const project = await projectByCode(ctx, flag('project'));
    const filters = { visible_projects: ctx.visibleProjectIds };
    if (project) filters.project = project.id;
    if (flag('status')) filters.status = flag('status').split(',');
    if (flag('type')) filters.type = flag('type').split(',');
    if (flag('version')) filters.version = flag('version').split(',');
    if (flag('sprint')) filters.sprint = flag('sprint').split(',');
    if (flags.open) filters.open = true;
    if (flags.closed) filters.closed = true;
    if (flags.overdue) filters.overdue = true;
    if (flags.mine) filters.involves = ctx.user.id;
    if (flag('q')) filters.q = flag('q');

    const rows = await query.select({
      filters, sort: flag('sort') || 'id', limit: Number(flag('limit')) || 200, today: ctx.today,
    });
    const { rows: flat } = rollup.flattenHierarchy(rows);
    return [
      heading(`${rows.length} work package(s)`),
      '',
      table(['id', 'proj', 'type', 'subject', 'status', 'assignee', 'due', 'pts'], flat.map((w) => [
        w.wp_key, w.project_code, W.dim(w.type_name),
        '  '.repeat(w.depth) + w.subject.slice(0, 56),
        paintStatus(w.status_code, w.status_label),
        w.assignee_name || W.dim('-'),
        rollup.isOverdue(w, ctx.today) ? W.red(w.due_date) : (w.due_date || W.dim('-')),
        w.story_points === null ? W.dim('-') : String(w.story_points),
      ]), ['', '', '', '', '', '', '', 'r']),
    ].join('\n');
  },

  async show(ctx) {
    const id = wpId(positional[0]);
    const wp = await query.byId(id);
    if (!wp) throw new Error(`no work package ${positional[0]}`);
    if (!ctx.visibleProjectIds.includes(Number(wp.project_id))) throw new Error('you cannot see that project');
    const d = await require('../api/views4').drawer(ctx, id);
    const out = [heading(`${wp.wp_key} ${wp.subject}`), '', `  ${d.breadcrumb.join(' > ')}`, ''];
    const pairs = [
      ['type', wp.type_name],
      ['status', paintStatus(wp.status_code, wp.status_label)],
      ['priority', wp.priority_label],
      ['assignee', wp.assignee_name || '-'],
      ['accountable', wp.accountable_name || '-'],
      ['watchers', d.watchers.map((u) => u.name).join(', ') || 'nobody'],
      ['dates', `${wp.start_date || '-'} -> ${wp.due_date || '-'}`],
      ['scheduling', d.scheduling.explanation],
      ['version', wp.version_code || '-'],
      ['sprint', wp.sprint_code
        ? wp.sprint_code + (wp.sprint_sharing === 'system' ? ' (shared across projects)' : '') : 'backlog'],
      ['points', wp.story_points === null ? 'not estimated' : String(wp.story_points)],
      ['progress', `${d.progress.pct}%  ${d.progress.label}  [basis: ${d.progress.basis}]`],
    ];
    if (d.baseline) {
      pairs.push(['baseline', `${d.baseline.baselineStart} -> ${d.baseline.baselineDue}`
        + (d.baseline.slip ? W.red(`  slipped ${d.baseline.slip}d`) : '  on plan')]);
    }
    for (const [k, v] of pairs) out.push(`  ${W.dim(k.padEnd(13))}${v}`);
    for (const c of d.customValues) out.push(`  ${W.dim(c.name.toLowerCase().padEnd(13))}${c.value || '-'}`);

    if (d.parent || d.children.length || d.relations.length) {
      out.push('');
      out.push(table(['relation', 'id', 'subject'], [
        ...(d.parent ? [['parent', d.parent.key, d.parent.subject]] : []),
        ...d.children.map((c) => ['child', c.key, c.subject]),
        ...d.relations.map((r) => [r.kind.toLowerCase(), r.key, r.subject]),
      ]));
    }
    if (d.comments.length) {
      out.push(heading('Comments'));
      for (const c of d.comments) {
        out.push('', `  ${W.bold(c.author || 'somebody')} ${W.dim(`${c.when} ago`)}`
          + (c.internal ? ` ${W.amber('[INTERNAL]')}` : ''));
        for (const line of String(c.body).split('\n')) out.push(`    ${line}`);
      }
    }
    return out.join('\n');
  },

  async status(ctx) {
    const id = wpId(positional[0]);
    const wanted = positional[1];
    if (!wanted) throw new Error('which status? e.g. `pt status WP-112 in_build`');
    const status = await db.one('SELECT * FROM statuses WHERE code = ?', [wanted]);
    if (!status) {
      const all = (await db.query('SELECT code FROM statuses ORDER BY position')).map((s) => s.code);
      throw new Error(`no status "${wanted}" - use one of ${all.join(', ')}`);
    }
    const out = await mut.updateWorkPackage(ctx, id, { status_id: status.id });
    let text = `  ${out.wp.wp_key} is now ${paintStatus(status.code, status.label)}`;
    if (flag('note')) {
      await mut.addComment(ctx, {
        containerType: 'work_package', containerId: id, body: flag('note'), internal: false,
      });
      text += '\n  note recorded as a comment';
    }
    for (const a of out.automations) {
      text += `\n  ${W.dim(`automation "${a.automation}": ${a.outcome} - ${a.detail}`)}`;
    }
    if (out.rescheduled.changed.length) {
      text += `\n  ${W.dim(`${out.rescheduled.changed.length} automatic date(s) moved`)}`;
    }
    return text;
  },

  async assign(ctx) {
    const id = wpId(positional[0]);
    const login = positional[1];
    if (!login) throw new Error('assign to whom? e.g. `pt assign WP-112 modell`');
    const user = await db.one(
      'SELECT id, name FROM users WHERE (login = ? OR name = ?) AND active = 1', [login, login]
    );
    if (!user) throw new Error(`no active user "${login}"`);
    const out = await mut.updateWorkPackage(ctx, id, { assignee_id: user.id });
    return `  ${out.wp.wp_key} assigned to ${user.name}`;
  },

  async comment(ctx) {
    const id = wpId(positional[0]);
    const text = positional.slice(1).join(' ') || flag('body');
    if (!text) throw new Error('what comment? e.g. `pt comment WP-112 "picked this up"`');
    const out = await mut.addComment(ctx, {
      containerType: 'work_package', containerId: id, body: String(text), internal: Boolean(flags.internal),
    });
    let msg = `  comment added to WP-${id}${flags.internal ? ' (internal)' : ''}`;
    if (out.mentioned.length) msg += `\n  notified ${out.mentioned.join(', ')}`;
    if (out.unresolved.length) msg += `\n  ${W.red(`@${out.unresolved.join(', @')} matched nobody`)}`;
    return msg;
  },

  async gate(ctx) {
    const project = await projectByCode(ctx, positional[0]);
    if (!project) throw new Error('which project? e.g. `pt gate VW G4`');
    const phases = await db.query('SELECT * FROM project_phases WHERE project_id = ? ORDER BY position', [project.id]);
    const gateName = positional[1];
    if (!gateName) {
      const life = lifecycle.summarise(phases);
      return [
        heading(`${project.code} - gates`), '',
        table(['gate', 'phase', 'state', 'criterion'], life.phases.map((p) => [
          p.gate_name, p.name,
          p.state === 'gate_met' ? W.green('met') : p.state === 'current' ? W.amber('current')
            : p.state === 'blocked' ? W.red('undecided') : W.dim('not entered'),
          W.dim(p.gate_criterion),
        ])),
        '', W.dim(`  Sign one with: pt gate ${project.code} G4 --note "..."`),
      ].join('\n');
    }
    const phase = phases.find((p) => p.gate_name.toUpperCase() === String(gateName).toUpperCase());
    if (!phase) throw new Error(`no gate "${gateName}" in ${project.code}`);
    await mut.signGate(ctx, project.id, phase.id, { note: flag('note') });
    return `  ${project.code} ${phase.gate_name} recorded as met on ${ctx.today} by ${ctx.user.name}`;
  },

  async baseline(ctx) {
    const project = await projectByCode(ctx, positional[0]);
    if (!project) throw new Error('which project? e.g. `pt baseline VW --name "gate 4 sign-off"`');
    const out = await mut2.takeBaseline(ctx, project.id, {
      name: flag('name') || `Baseline ${ctx.today}`, note: flag('note'),
    });
    return `  baseline "${out.name}" taken over ${out.entries} work package(s)`;
  },

  async sprint(ctx) {
    if (positional[0] === 'close') {
      const wanted = positional[1];
      const sprint = await db.one('SELECT * FROM sprints WHERE code = ?', [wanted]);
      if (!sprint) throw new Error(`no sprint "${wanted}"`);
      const out = await mut2.closeSprint(ctx, sprint.id);
      let msg = `  ${wanted} closed`;
      for (const a of out.automations) {
        msg += `\n  ${W.dim(`automation "${a.automation}": ${a.outcome} - ${a.detail}`)}`;
      }
      return msg;
    }
    const sprints = await db.query('SELECT * FROM sprints ORDER BY start_date');
    const wps = await query.select({
      filters: { visible_projects: ctx.visibleProjectIds }, limit: 1000, today: ctx.today,
    });
    return [
      heading('Sprints'), '',
      table(['code', 'dates', 'state', 'sharing', 'points', 'closed'], sprints.map((s) => {
        const list = wps.filter((w) => Number(w.sprint_id) === Number(s.id));
        return [
          s.code, `${s.start_date} -> ${s.end_date}`,
          s.state === 'active' ? W.amber(s.state) : W.dim(s.state),
          s.sharing === 'system' ? W.cyan('shared') : s.sharing,
          String(rollup.points(list)), String(rollup.closedPoints(list)),
        ];
      }), ['', '', '', '', 'r', 'r']),
      '', W.dim('  Points are leaf work only, so a parent never double-counts its children.'),
    ].join('\n');
  },

  async alerts(ctx) {
    if (positional[0] !== 'run') {
      const rows = await db.query(
        'SELECT a.*, u.login FROM date_alerts a JOIN users u ON u.id = a.user_id ORDER BY a.id'
      );
      return [
        heading('Date alert rules'), '',
        table(['who', 'rule', 'days', 'scope', 'enabled', 'last run'], rows.map((r) => [
          r.login, r.rule, String(r.threshold_days),
          r.only_assigned ? 'assigned to them' : r.only_watched ? 'watched by them' : 'everything',
          r.enabled ? W.green('on') : W.dim('off'),
          r.last_ran_at || W.dim('never'),
        ])),
        '', W.dim('  `pt alerts run` evaluates them. A rule that already fired for the same'),
        W.dim('  work package today does not fire again.'),
      ].join('\n');
    }
    const created = await notify.runDateAlerts(ctx.today);
    return `  ${created.length} notification(s) raised`
      + (created.length
        ? '\n' + table(['user', 'work package', 'rule'],
          created.map((c) => [String(c.user_id), `WP-${c.work_package_id}`, c.rule]))
        : '');
  },

  async activity(ctx) {
    const rows = await require('../api/views2').recentActivity(ctx, { limit: Number(flag('limit')) || 25 });
    return [
      heading('Activity'), '',
      table(['when', 'who', 'what', 'target', 'detail'], rows.map((a) => [
        W.dim(a.when),
        a.is_machine ? W.cyan(a.who) : a.who,
        a.verb, a.target || '',
        W.dim(String(a.detail || '').slice(0, 60)),
      ])),
    ].join('\n');
  },

  async export(ctx) {
    const format = positional[0];
    if (!['csv', 'xlsx', 'pdf'].includes(format)) throw new Error('format must be csv, xlsx or pdf');
    const project = await projectByCode(ctx, flag('project'));
    const filters = { visible_projects: ctx.visibleProjectIds };
    if (project) filters.project = project.id;
    if (flags.open) filters.open = true;
    const rows = await query.select({ filters, limit: 1000, today: ctx.today });
    const shaped = rows.map((w) => views.row(w, ctx));
    const cols = exporters.WP_COLUMNS;
    const payload = format === 'csv' ? Buffer.from(exporters.toCsv(cols, shaped), 'utf8')
      : format === 'xlsx' ? exporters.toXlsx(cols, shaped)
        : exporters.toPdf(project ? `${project.code} work packages` : 'Portfolio work packages', cols, shaped);
    const file = flag('out') || `work-packages-${ctx.today}.${format}`;
    require('fs').writeFileSync(file, payload);
    return `  ${rows.length} row(s) written to ${file} (${payload.length} bytes)`;
  },

  async whoami(ctx) {
    const perms = ctx.visibleProjectIds.length
      ? await access.permissionsFor(ctx.user.id, ctx.visibleProjectIds[0]) : new Set();
    return [
      heading('Running as'), '',
      `  ${W.bold(ctx.user.name)} (${ctx.user.login})${ctx.user.is_admin ? W.amber('  administrator') : ''}`,
      `  ${ctx.visibleProjectIds.length} project(s) visible`,
      `  ${perms.size} permission(s) on the first of them`,
      '', W.dim('  Use --as LOGIN or PT_CLI_USER to run as somebody else. Every write goes'),
      W.dim('  through the same permission check the web app does.'),
    ].join('\n');
  },

  async help() {
    const rows = [
      ['report', 'where the portfolio stands'],
      ['next', 'what to pick up now, and what is blocked'],
      ['plan [CODE]', 'the life cycle, rolled up'],
      ['list [flags]', '--project --status --type --version --sprint --open --overdue --mine --q --sort --limit'],
      ['show WP-112', 'one work package in full'],
      ['status WP-112 done', '--note "..." records the note as a comment'],
      ['assign WP-112 modell', 'set the assignee'],
      ['comment WP-112 "..."', '--internal for an internal comment'],
      ['gate VW [G4]', 'list gates, or sign one with --note'],
      ['baseline VW', '--name "..." - a copy of every date, never recomputed'],
      ['sprint [close S-14]', 'list sprints, or close one'],
      ['alerts [run]', 'the date alert rules, or evaluate them now'],
      ['activity', '--limit N'],
      ['export csv|xlsx|pdf', '--project VW --out FILE'],
      ['whoami', 'who the command runs as'],
    ];
    return [
      heading('pt - ProjectTracker command line'), '',
      ...rows.map(([cmd, help]) => `  ${cmd.padEnd(22)}${W.dim(help)}`),
      '', W.dim('  Every command runs as a real user with real permissions. There is no'),
      W.dim('  ambient superuser: --as LOGIN or PT_CLI_USER chooses who.'),
    ].join('\n');
  },
};

async function main() {
  if (command === 'help' || flags.help) {
    console.log(await COMMANDS.help());
    return;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`  no command "${command}". Try \`pt help\`.`);
    process.exitCode = 1;
    return;
  }
  const out = await fn(await context());
  if (out) console.log(out);
  console.log('');
}

main()
  .catch((e) => { console.error(`\n  ${W.red(e.message)}\n`); process.exitCode = 1; })
  .finally(() => db.close());
