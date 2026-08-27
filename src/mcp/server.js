#!/usr/bin/env node
/**
 * The MCP server: what an AI assistant is allowed to see, and what it may change.
 *
 *   node src/mcp/server.js
 *
 * Transport is stdio — JSON-RPC 2.0 over newline-delimited stdin/stdout, which
 * is what MCP's stdio transport is. There is no listening port and no tunnel, so
 * nothing is exposed to the network; the client launches this as a child
 * process. That is also why the protocol is implemented directly here rather
 * than through the SDK: the whole surface is initialize, tools/list and
 * tools/call, and a dependency that moves underneath a security boundary is a
 * dependency to audit on every upgrade.
 *
 * FOUR RULES, and each one is the answer to a question somebody will ask:
 *
 *  1. EVERY CALL IS AUDITED, READS INCLUDED. "What did the assistant look at" is
 *     the question an audit is actually asked, and logging only writes answers a
 *     different one. mcp_audit carries the tool, the arguments, the outcome, the
 *     row count and how long it took.
 *
 *  2. INTERNAL COMMENTS ARE NEVER RETURNED, at any scope. Not filtered in a
 *     wrapper — excluded in the SQL, in every tool that touches a comment.
 *
 *  3. A TOKEN IS REQUIRED AND IS SCOPED. PT_MCP_TOKEN names it; the row decides
 *     read or write and which projects. Without a token the server starts,
 *     answers initialize, and refuses every tool call with a message saying so —
 *     which is more useful than failing to start, because the client's error
 *     surface for "process died" is usually nothing at all.
 *
 *  4. THE WRITE TOOLS ARE SEPARATELY SCOPED. Every tool whose mode is 'write'
 *     needs scope=write. A read token is not offered them in tools/list at all
 *     and is refused if it calls one anyway, and the refusal is audited.
 *
 *  5. A WRITE BORROWS THE AUTHORITY OF WHOEVER ISSUED THE TOKEN, AND THE TRAIL
 *     RECORDS THE MACHINE. A token is not a person and the tracker's permissions
 *     are per person, so there is no membership to check for "the assistant".
 *     Every write runs as the token's issuer — it can never do what they could
 *     not — and goes through the same mutation functions the web app and the
 *     CLI use, so there is one write model and not a second one here. The
 *     activity trail then names the machine INSTEAD OF the issuer. See
 *     docs/decisions/0006.
 */

'use strict';

const crypto = require('crypto');
const readline = require('readline');
const db = require('../db');
const rollup = require('../domain/rollup');
const lifecycle = require('../domain/lifecycle');
const query = require('../domain/query');
const notify = require('../domain/notify');
// The write tools call these rather than writing SQL of their own. A second
// write path would be a second set of rules — the status workflow, the
// milestone's single date, the subject pattern, the automations that fire after
// the commit — and the two would drift.
const mutations = require('../api/mutations');
const mutations2 = require('../api/mutations2');
const views5 = require('../api/views5');
const gitPull = require('../gitdeck/pull');

const PROTOCOL_VERSION = '2024-11-05';
const today = () => new Date().toISOString().slice(0, 10);
const SERVER_INFO = { name: 'projecttracker', version: '0.1.0' };

/** Resolved once at startup from PT_MCP_TOKEN. */
let token = null;

async function loadToken() {
  const secret = process.env.PT_MCP_TOKEN;
  if (!secret) return null;
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  const row = await db.one('SELECT * FROM mcp_tokens WHERE token_hash = ?', [hash]);
  if (!row) return { invalid: 'that token is not in the database' };
  if (row.revoked_at) return { invalid: 'that token has been revoked' };
  if (row.expires_at && new Date(String(row.expires_at).replace(' ', 'T') + 'Z') < new Date()) {
    return { invalid: 'that token has expired' };
  }
  await db.run('UPDATE mcp_tokens SET last_used_at = NOW() WHERE id = ?', [row.id]);
  return {
    id: row.id,
    hint: row.token_hint,
    scope: row.scope,
    projectScope: db.json(row.project_scope, null),
    includesInternal: Boolean(row.includes_internal),
    // Who issued it. A write runs as this person and can never exceed them.
    issuerId: row.created_by ? Number(row.created_by) : null,
  };
}

/** The project ids this token may read. Null scope means every project. */
async function scopedProjectIds() {
  const all = (await db.query('SELECT id FROM projects WHERE archived = 0')).map((r) => Number(r.id));
  if (!token || !token.projectScope) return all;
  const allowed = new Set(token.projectScope.map(Number));
  return all.filter((id) => allowed.has(id));
}

// ------------------------------------------------------ writing: who, and what

/**
 * The context a write runs as.
 *
 * A token is not a person, and every permission in this tracker is answered per
 * person: there is no membership, and no role, for "the assistant". So a write
 * borrows the authority of whoever issued the token. It can do what they can do
 * and nothing more, which is what stops a token being a way around a role.
 *
 * `actorLabel` is the other half. It goes to the same mutation functions the web
 * app calls, and `notify.record` records the label INSTEAD OF the issuer's id,
 * so an MCP write reads as a machine in the activity trail rather than as the
 * person whose authority it borrowed.
 */
async function writeContext() {
  if (!token.issuerId) {
    throw new Error(
      'this token has nobody recorded as having issued it, so there is no authority to write with. '
      + 'Issue a new token in Administration -> Repositories & MCP.'
    );
  }
  const user = await db.one(
    'SELECT id, login, name, is_admin, kind, active FROM users WHERE id = ?', [token.issuerId]
  );
  if (!user || !user.active) {
    throw new Error('the account that issued this token is gone or deactivated, so it may no longer write');
  }
  return {
    user: { ...user, is_admin: Boolean(user.is_admin) },
    actorLabel: `mcp · ${token.hint || 'unknown token'}`,
  };
}

/**
 * The line that says a machine wrote this, appended to the text it wrote.
 *
 * The activity trail carries the same fact as data, but a comment is read in the
 * drawer, in a share, in an export and in the CLI, and none of those read the
 * trail. The email intake already solves this the same way — an emailed comment
 * ends "— received by email from …" — so this follows the convention that is
 * here rather than adding a column beside `comments.author_id` for it.
 *
 * The byline stays the person whose authority was used, which is what
 * `author_id` means. The line says who actually typed it.
 */
const writtenBy = (ctx) => `written by ${ctx.actorLabel}`;

/** A project by code or identifier, refused unless the token can see it. */
async function projectInScope(code, what = 'project') {
  const wanted = String(code || '').trim();
  if (!wanted) throw new Error(`${what} is required, as a project code, e.g. "VW"`);
  const p = await db.one('SELECT id, code, name FROM projects WHERE code = ? OR identifier = ?',
    [wanted.toUpperCase(), wanted.toLowerCase()]);
  const ids = await scopedProjectIds();
  if (!p || !ids.includes(Number(p.id))) throw new Error(`no project "${wanted}" in this token's scope`);
  return p;
}

/** 'WP-112' or '112' -> the row, refused unless the token can see its project. */
async function workPackageInScope(key) {
  const m = /^(?:WP-)?(\d+)$/i.exec(String(key || '').trim());
  if (!m) throw new Error(`"${key}" is not a work package key - expected WP-112`);
  const wp = await query.byId(Number(m[1]));
  if (!wp) throw new Error(`no work package ${String(key).toUpperCase()}`);
  const ids = await scopedProjectIds();
  if (!ids.includes(Number(wp.project_id))) throw new Error(`${wp.wp_key} is not in this token's scope`);
  return wp;
}

/**
 * 'WP-112', or the key the repository knows it by — 'F-LOAD-012'.
 *
 * The second form exists because an assistant reading a pull request has the
 * repository's key and not the tracker's, and making it look the number up
 * first is the friction the mapping was built to remove.
 */
async function workPackageByAnyKey(key, ids) {
  const raw = String(key || '').trim();
  if (!raw) throw new Error('which work package? give WP-112, or a repository key such as F-LOAD-012');
  if (/^(?:WP-)?\d+$/i.test(raw)) return workPackageInScope(raw);
  const clause = db.inClause(ids.length ? ids : [0]);
  const rows = await db.query(
    `SELECT id, wp_key, project_id FROM work_packages WHERE ref_key = ? AND project_id IN ${clause.sql}`,
    [raw.toUpperCase(), ...clause.params]
  );
  if (!rows.length) throw new Error(`no work package keyed "${raw}" in this token's scope`);
  if (rows.length > 1) {
    throw new Error(`"${raw}" is the key of ${rows.length} work packages - name the WP- key instead`);
  }
  return { id: Number(rows[0].id), wp_key: rows[0].wp_key, project_id: Number(rows[0].project_id) };
}

/** A wiki document by number or slug, refused unless the token can see it. */
async function documentInScope({ number, slug, project }) {
  if (!number && !slug) throw new Error('which document? give its number or its slug');
  const ids = await scopedProjectIds();
  const clause = db.inClause(ids.length ? ids : [0]);
  const doc = await db.one(`
    SELECT d.*, (SELECT COALESCE(MAX(v.revision), 0) FROM document_versions v WHERE v.document_id = d.id) AS revision
      FROM documents d
     WHERE d.project_id IN ${clause.sql}
       AND (d.number = ? OR d.slug = ?)
       ${project ? 'AND d.project_id = ?' : ''}
     LIMIT 1`,
  [...clause.params, number || '', slug || '', ...(project ? [project] : [])]);
  // A portfolio-wide document has no project, and so no project permission to
  // check a write against. It is readable through wiki.read and not writable
  // here, which is said rather than left to look like "not found".
  if (!doc) throw new Error('no such wiki page in this token\'s scope (a portfolio-wide page is read-only here)');
  return doc;
}

/** A user, by login or full name. Errors name what the person was wanted for. */
async function activeUser(who, what) {
  const u = await db.one('SELECT id, name FROM users WHERE (login = ? OR name = ?) AND active = 1', [who, who]);
  if (!u) throw new Error(`no active user "${who}" to be the ${what}`);
  return u;
}

/** One of a vocabulary table's codes, or an error that lists them. */
async function byCode(table, code, what) {
  const row = await db.one(`SELECT id, code FROM ${db.ident(table)} WHERE code = ?`, [String(code)]);
  if (!row) {
    const all = (await db.query(`SELECT code FROM ${db.ident(table)} ORDER BY id`)).map((r) => r.code);
    throw new Error(`no ${what} "${code}" - use one of ${all.join(', ')}`);
  }
  return row;
}

/**
 * The vocabulary arguments both work package tools take, resolved to ids.
 *
 * One function for create and update, so "status" means the same thing in both
 * and a code that is wrong is refused the same way in both.
 */
async function workPackageFields(args, projectId) {
  const out = {};
  if (args.subject !== undefined) out.subject = args.subject;
  if (args.description !== undefined) out.description = args.description;
  if (args.start_date !== undefined) out.start_date = args.start_date || null;
  if (args.due_date !== undefined) out.due_date = args.due_date || null;
  // Checked here rather than left to the database: a number that arrived as
  // "about twelve" becomes NaN, and NaN reaches SQL as a syntax error nobody can
  // read back to the argument that caused it.
  if (args.estimated_hours !== undefined) {
    const hours = Number(args.estimated_hours);
    if (!Number.isFinite(hours) || hours < 0) throw new Error('estimated_hours is a number of hours, 0 or more');
    out.estimated_hours = hours;
  }
  if (args.story_points !== undefined) {
    if (args.story_points === null || args.story_points === '') out.story_points = null;
    else {
      const points = Number(args.story_points);
      if (!Number.isInteger(points) || points < 0) throw new Error('story_points is a whole number, 0 or more');
      out.story_points = points;
    }
  }

  if (args.status) out.status_id = (await byCode('statuses', args.status, 'status')).id;
  if (args.priority) out.priority_id = (await byCode('priorities', args.priority, 'priority')).id;
  if (args.assignee !== undefined) {
    out.assignee_id = args.assignee ? (await activeUser(args.assignee, 'assignee')).id : null;
  }
  if (args.accountable !== undefined) {
    out.accountable_id = args.accountable ? (await activeUser(args.accountable, 'accountable')).id : null;
  }
  if (args.version !== undefined) {
    if (!args.version) out.version_id = null;
    else {
      const v = await db.one('SELECT id FROM versions WHERE project_id = ? AND code = ?', [projectId, args.version]);
      if (!v) throw new Error(`no version "${args.version}" in this project - create it with version.create`);
      out.version_id = v.id;
    }
  }
  if (args.sprint !== undefined) {
    if (!args.sprint) out.sprint_id = null;
    else {
      const sp = await db.one('SELECT id FROM sprints WHERE code = ?', [args.sprint]);
      if (!sp) throw new Error(`no sprint "${args.sprint}"`);
      out.sprint_id = sp.id;
    }
  }
  if (args.parent !== undefined) {
    out.parent_id = args.parent ? (await workPackageInScope(args.parent)).id : null;
  }
  return out;
}

/** The compact work package a write tool hands back. */
const wpSummary = (w) => ({
  key: w.wp_key,
  project: w.project_code,
  type: w.type_name,
  subject: w.subject,
  status: w.status_code,
  priority: w.priority_code,
  assignee: w.assignee_name,
  start_date: w.start_date,
  due_date: w.due_date,
  estimated_hours: Number(w.estimated_hours),
  story_points: w.story_points,
  version: w.version_code,
  sprint: w.sprint_code,
  parent: w.parent_id ? `WP-${w.parent_id}` : null,
});

async function audit(tool, mode, args, outcome, note, rowCount, ms, projectIds) {
  await db.insert('mcp_audit', {
    token_id: token && token.id ? token.id : null,
    token_hint: token && token.hint ? token.hint : null,
    tool,
    mode,
    // The arguments are recorded verbatim. An audit that records the tool but
    // not what it was asked for cannot answer "did it read the thing it should
    // not have".
    arguments: JSON.stringify(args || {}),
    outcome,
    result_note: note ? String(note).slice(0, 600) : null,
    row_count: rowCount === undefined ? null : rowCount,
    project_ids: projectIds ? JSON.stringify(projectIds) : null,
    duration_ms: ms,
  });
}

// ---------------------------------------------------------------------- tools

const TOOLS = {
  'portfolio.status': {
    mode: 'read',
    description:
      'Weighted readiness, gate state and health for every project in scope. Readiness is a weighted '
      + 'sum (speccing 0.35, in build 0.7, done 1) and is NOT a completion figure; completion is '
      + 'reported separately as done / partial / not started. Deferred and rejected work is excluded '
      + 'from the denominator entirely.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Restrict to one project code, e.g. "VW".' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const ids = await scopedProjectIds();
      if (!ids.length) return { projects: [], note: 'this token can see no projects' };
      const clause = db.inClause(ids);
      const projects = await db.query(`
        SELECT p.id, p.code, p.name, p.health, p.health_note, g.code AS program
          FROM projects p LEFT JOIN programs g ON g.id = p.program_id
         WHERE p.id IN ${clause.sql} ${args.project ? 'AND p.code = ?' : ''}
         ORDER BY p.code`, args.project ? [...clause.params, String(args.project).toUpperCase()] : clause.params);
      if (args.project && !projects.length) {
        throw new Error(`no project "${args.project}" in this token's scope`);
      }

      const out = [];
      for (const p of projects) {
        const wps = await query.select({ filters: { project: p.id }, limit: 1000 });
        const phases = await db.query(
          'SELECT * FROM project_phases WHERE project_id = ? ORDER BY position', [p.id]
        );
        const life = lifecycle.summarise(phases);
        out.push({
          code: p.code,
          name: p.name,
          program: p.program,
          health: p.health,
          health_note: p.health_note,
          readiness_pct: rollup.readiness(wps).pct,
          readiness_scored: rollup.readiness(wps).scored,
          readiness_excluded: rollup.readiness(wps).excluded,
          completion: rollup.completion(wps),
          story_points: rollup.points(wps),
          hours: rollup.hours(wps),
          gates_met: life.gatesMet,
          gates_total: life.gatesTotal,
          current_phase: life.current ? life.current.name : (life.shipped ? 'shipped' : null),
          next_gate: life.nextGate,
          gate_blocked: life.blocked,
        });
      }
      return {
        projects: out,
        portfolio_readiness_pct: rollup.readiness(
          await query.select({ filters: { visible_projects: ids }, limit: 1000 })
        ).pct,
        note: 'Readiness is weighted, not completion. See the completion object for the three counts.',
      };
    },
  },

  'work_packages.query': {
    mode: 'read',
    description:
      'Filter work packages by project, status, type, priority, version, sprint, assignee, overdue or '
      + 'free text. Returns at most 200 rows; narrow the filter rather than paging, because a list '
      + 'that needs paging is a list that needs a filter.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project code, e.g. "VW".' },
        status: { type: 'array', items: { type: 'string' }, description: 'Status codes.' },
        type: { type: 'array', items: { type: 'string' }, description: 'PHASE, EPIC, FEATURE, TASK, BUG, MILESTONE.' },
        priority: { type: 'array', items: { type: 'string' }, description: 'low, normal, high, immediate.' },
        version: { type: 'string' },
        sprint: { type: 'string' },
        assignee: { type: 'string', description: 'A login or a full name.' },
        open: { type: 'boolean', description: 'Only work in a status that is not closed.' },
        overdue: { type: 'boolean' },
        q: { type: 'string', description: 'Free text over the key, subject and assignee.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    async run(args) {
      const ids = await scopedProjectIds();
      const filters = { visible_projects: ids };
      if (args.project) {
        const p = await db.one('SELECT id FROM projects WHERE code = ?', [String(args.project).toUpperCase()]);
        if (!p || !ids.includes(Number(p.id))) throw new Error(`no project "${args.project}" in this token's scope`);
        filters.project = p.id;
      }
      if (args.status) filters.status = args.status;
      if (args.type) filters.type = args.type;
      if (args.priority) filters.priority = args.priority;
      if (args.version) filters.version = args.version;
      if (args.sprint) filters.sprint = args.sprint;
      if (args.open) filters.open = true;
      if (args.overdue) filters.overdue = true;
      if (args.q) filters.q = args.q;
      if (args.assignee) {
        const u = await db.one('SELECT id FROM users WHERE login = ? OR name = ?', [args.assignee, args.assignee]);
        if (!u) throw new Error(`no user "${args.assignee}"`);
        filters.assignee = u.id;
      }

      const rows = await query.select({
        filters, limit: Math.min(200, Number(args.limit) || 100),
      });
      return {
        count: rows.length,
        work_packages: rows.map((w) => ({
          key: w.wp_key,
          project: w.project_code,
          type: w.type_name,
          subject: w.subject,
          status: w.status_code,
          priority: w.priority_code,
          assignee: w.assignee_name,
          accountable: w.accountable_name,
          start_date: w.start_date,
          due_date: w.due_date,
          scheduling: w.scheduling,
          estimated_hours: Number(w.estimated_hours),
          spent_hours: Number(w.spent_hours),
          story_points: w.story_points,
          version: w.version_code,
          sprint: w.sprint_code,
          shared_sprint: w.sprint_sharing === 'system',
          watchers: Number(w.watcher_count),
          parent: w.parent_id ? `WP-${w.parent_id}` : null,
        })),
      };
    },
  },

  'wiki.read': {
    mode: 'read',
    description: 'Fetch a wiki document by number or slug, or list what is available.',
    schema: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'The document number, e.g. "05".' },
        slug: { type: 'string' },
        project: { type: 'string', description: 'Project code.' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const ids = await scopedProjectIds();
      const clause = db.inClause(ids.length ? ids : [0]);
      if (!args.number && !args.slug) {
        const docs = await db.query(`
          SELECT d.number, d.slug, d.title, d.status, d.word_count, d.section_count, p.code AS project
            FROM documents d LEFT JOIN projects p ON p.id = d.project_id
           WHERE d.project_id IS NULL OR d.project_id IN ${clause.sql}
           ORDER BY d.position, d.number`, clause.params);
        return { documents: docs, note: 'Pass number or slug to read one.' };
      }
      const doc = await db.one(`
        SELECT d.*, p.code AS project, u.name AS updated_by_name,
               -- The revision a save must be made against. 0 is a page that has
               -- never been saved since it was created, which is a real state
               -- and not a missing one.
               (SELECT COALESCE(MAX(v.revision), 0) FROM document_versions v WHERE v.document_id = d.id) AS revision
          FROM documents d
          LEFT JOIN projects p ON p.id = d.project_id
          LEFT JOIN users u ON u.id = d.updated_by
         WHERE (d.project_id IS NULL OR d.project_id IN ${clause.sql})
           AND (d.number = ? OR d.slug = ?)
         LIMIT 1`, [...clause.params, args.number || '', args.slug || '']);
      if (!doc) throw new Error('no such document in this token\'s scope');
      return {
        number: doc.number,
        slug: doc.slug,
        title: doc.title,
        project: doc.project,
        status: doc.status,
        revision: Number(doc.revision),
        writable: doc.project_id !== null,
        word_count: doc.word_count,
        section_count: doc.section_count,
        updated_at: doc.updated_at,
        updated_by: doc.updated_by_name,
        body: doc.body,
      };
    },
  },

  'activity.recent': {
    mode: 'read',
    description:
      'The activity trail, newest first. Internal comments are never included. An entry with '
      + 'actor_label and no actor is a machine — an automation, an integration, or this MCP server.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        kind: { type: 'string', description: 'status, comment, gate, repo, wiki, file, ai, automation, …' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const ids = await scopedProjectIds();
      const clause = db.inClause(ids.length ? ids : [0]);
      const params = [...clause.params];
      let extra = '';
      if (args.project) {
        const p = await db.one('SELECT id FROM projects WHERE code = ?', [String(args.project).toUpperCase()]);
        if (!p || !ids.includes(Number(p.id))) throw new Error(`no project "${args.project}" in this token's scope`);
        extra += ' AND a.project_id = ?';
        params.push(p.id);
      }
      if (args.kind) { extra += ' AND a.kind = ?'; params.push(args.kind); }
      const limit = Math.min(200, Number(args.limit) || 40);
      const rows = await db.query(`
        SELECT a.kind, a.verb, a.detail, a.from_value, a.to_value, a.created_at,
               a.actor_label, u.name AS actor_name, wp.wp_key, p.code AS project
          FROM activities a
          LEFT JOIN users u ON u.id = a.actor_id
          LEFT JOIN work_packages wp ON wp.id = a.work_package_id
          LEFT JOIN projects p ON p.id = a.project_id
         WHERE (a.project_id IS NULL OR a.project_id IN ${clause.sql})${extra}
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT ${limit}`, params);
      return {
        count: rows.length,
        activity: rows.map((a) => ({
          when: a.created_at,
          who: a.actor_name || a.actor_label,
          is_machine: !a.actor_name,
          verb: a.verb,
          kind: a.kind,
          target: a.wp_key || a.project,
          from: a.from_value,
          to: a.to_value,
          detail: a.detail,
        })),
      };
    },
  },

  'project.create': {
    mode: 'write',
    description:
      'Create a project. With a template code, the template\'s blueprint comes with it: its phases and '
      + 'gates, its versions, its wiki skeleton, its boards and its seed work packages, all in one '
      + 'transaction. The person who issued this token becomes the project\'s owner, because a project '
      + 'with no owner is a project nobody can sign a gate on. A token scoped to a list of projects may '
      + 'not create one.',
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '2-16 letters or digits, e.g. "VW". Uppercased.' },
        name: { type: 'string' },
        description: { type: 'string' },
        template: { type: 'string', description: 'A project template code. Omit for a project with no structure.' },
        program: { type: 'string', description: 'A program code, to place it in the portfolio.' },
        parent: { type: 'string', description: 'A parent project code.' },
      },
      required: ['code', 'name'],
      additionalProperties: false,
    },
    async run(args) {
      const ctx = await writeContext();
      // A scoped token creating a project would create one outside its own
      // scope, and then be unable to see what it made. That is the scope
      // escaping rather than being enforced.
      if (token.projectScope) {
        throw new Error(
          `this token is scoped to ${token.projectScope.length} project(s), so it may not create a new one `
          + '- a project it created would be outside its own scope. Creating projects needs an unscoped '
          + 'write token.'
        );
      }
      const body = {
        code: args.code, name: args.name, description: args.description || null,
      };
      if (args.template) {
        const t = await db.one('SELECT id, code FROM project_templates WHERE code = ? AND archived = 0',
          [String(args.template).toUpperCase()]);
        if (!t) {
          const all = (await db.query('SELECT code FROM project_templates WHERE archived = 0 ORDER BY id'))
            .map((r) => r.code);
          throw new Error(`no project template "${args.template}"`
            + (all.length ? ` - use one of ${all.join(', ')}` : ' - this database has none'));
        }
        body.template_id = t.id;
      }
      if (args.program) {
        const g = await db.one('SELECT id FROM programs WHERE code = ? AND archived = 0',
          [String(args.program).toUpperCase()]);
        if (!g) throw new Error(`no program "${args.program}"`);
        body.program_id = g.id;
      }
      if (args.parent) body.parent_id = (await projectInScope(args.parent, 'parent')).id;

      const created = await mutations2.createProject(ctx, body);
      const counts = await db.one(`
        SELECT (SELECT COUNT(*) FROM project_phases WHERE project_id = ?) AS phases,
               (SELECT COUNT(*) FROM versions       WHERE project_id = ?) AS versions,
               (SELECT COUNT(*) FROM documents      WHERE project_id = ?) AS documents,
               (SELECT COUNT(*) FROM work_packages  WHERE project_id = ?) AS work_packages`,
      [created.id, created.id, created.id, created.id]);
      return {
        code: created.code,
        identifier: created.identifier,
        owner: ctx.user.login,
        from_template: args.template || null,
        created: {
          phases: Number(counts.phases),
          versions: Number(counts.versions),
          wiki_pages: Number(counts.documents),
          work_packages: Number(counts.work_packages),
        },
      };
    },
  },

  'work_package.create': {
    mode: 'write',
    description:
      'Create a work package. The type decides whether a subject can be generated from its pattern and '
      + 'whether the thing is a milestone, which has one date rather than two. Automations that watch for '
      + 'a new work package fire after the row is committed, and what they did comes back in the result.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project code, e.g. "VW".' },
        subject: { type: 'string', description: 'Omit only when the type generates one from a pattern.' },
        type: { type: 'string', description: 'PHASE, EPIC, FEATURE, TASK, BUG, MILESTONE. Defaults to TASK.' },
        description: { type: 'string', description: 'Markdown.' },
        parent: { type: 'string', description: 'A work package key, e.g. "WP-112".' },
        status: { type: 'string', description: 'A status code. Defaults to the default status.' },
        priority: { type: 'string', description: 'low, normal, high, immediate.' },
        assignee: { type: 'string', description: 'A login or a full name.' },
        accountable: { type: 'string', description: 'A login or a full name. Defaults to the token\'s issuer.' },
        start_date: { type: 'string', description: 'YYYY-MM-DD.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD. A milestone uses this one and no start.' },
        estimated_hours: { type: 'number' },
        story_points: { type: 'integer' },
        version: { type: 'string', description: 'A version code in the same project.' },
        sprint: { type: 'string', description: 'A sprint code.' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    async run(args) {
      const ctx = await writeContext();
      const project = await projectInScope(args.project);
      const fields = await workPackageFields(args, project.id);
      const out = await mutations.createWorkPackage(ctx, {
        ...fields, project_id: project.id, type: args.type || 'TASK',
      });
      return {
        work_package: wpSummary(out.wp),
        subject_generated: Boolean(out.generatedSubject),
        automations: out.automations,
      };
    },
  },

  'work_package.update': {
    mode: 'write',
    description:
      'Change a work package. A status change is checked against the workflow in administration rather '
      + 'than being allowed anywhere, so a move the workflow does not have is refused and says so. '
      + 'Changing a date re-derives the automatically scheduled dates that follow it, and the count of '
      + 'what moved comes back with the result.',
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The work package key, e.g. "WP-112".' },
        subject: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', description: 'A status code.' },
        priority: { type: 'string' },
        assignee: { type: 'string', description: 'A login or a full name. Empty string unassigns.' },
        accountable: { type: 'string' },
        parent: { type: 'string', description: 'A work package key. Empty string detaches it.' },
        start_date: { type: 'string', description: 'YYYY-MM-DD, or empty to clear.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD, or empty to clear.' },
        estimated_hours: { type: 'number' },
        story_points: { type: 'integer' },
        version: { type: 'string', description: 'A version code, or empty to clear.' },
        sprint: { type: 'string', description: 'A sprint code, or empty to clear.' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    async run(args) {
      const ctx = await writeContext();
      const wp = await workPackageInScope(args.key);
      // `key` is not one of the fields, and workPackageFields reads only the
      // ones it knows, so there is nothing to strip out of the arguments first.
      const patch = await workPackageFields(args, wp.project_id);
      if (!Object.keys(patch).length) {
        throw new Error('nothing to change - pass at least one attribute besides the key');
      }
      const out = await mutations.updateWorkPackage(ctx, wp.id, patch);
      return {
        work_package: wpSummary(out.wp),
        changed: Object.keys(patch),
        automations: out.automations,
        dates_moved: out.rescheduled.changed.length,
      };
    },
  },

  'version.create': {
    mode: 'write',
    description:
      'Create a version in a project. A version with no due date is legitimate and the roadmap draws it '
      + 'as UNSCHEDULED, which is not the same as one somebody forgot to date. A code already used in '
      + 'the project is refused rather than suffixed.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project code.' },
        code: { type: 'string', description: 'Short, e.g. "V1".' },
        name: { type: 'string', description: 'Defaults to the code.' },
        description: { type: 'string' },
        start_date: { type: 'string', description: 'YYYY-MM-DD.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD. Omit for an unscheduled version.' },
        sharing: {
          type: 'string',
          enum: ['none', 'descendants', 'hierarchy', 'tree', 'system'],
          description: 'Who else may assign work to it. Defaults to none.',
        },
      },
      required: ['project', 'code'],
      additionalProperties: false,
    },
    async run(args) {
      const ctx = await writeContext();
      const project = await projectInScope(args.project);
      const version = await mutations2.createVersion(ctx, {
        project_id: project.id,
        code: args.code,
        name: args.name,
        description: args.description,
        start_date: args.start_date,
        due_date: args.due_date,
        sharing: args.sharing,
      });
      return { project: project.code, ...version };
    },
  },

  'wiki.create': {
    mode: 'write',
    description:
      'Create a wiki page in a project. The slug is derived from the title unless one is given, and a '
      + 'slug already used in the project is refused: two pages a person cannot tell apart in a link is '
      + 'worse than being asked for another name. A new page is at revision 0 - "as created" - and the '
      + 'first wiki.update makes revision 1.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project code.' },
        title: { type: 'string' },
        body: { type: 'string', description: 'Markdown. May be empty for a stub.' },
        number: { type: 'string', description: 'Its place in a numbered set, e.g. "05".' },
        slug: { type: 'string', description: 'Defaults to the title, lowercased and hyphenated.' },
        status: { type: 'string', description: 'DRAFT, REVIEW, AGREED, … Defaults to DRAFT.' },
      },
      required: ['project', 'title'],
      additionalProperties: false,
    },
    async run(args) {
      const ctx = await writeContext();
      const project = await projectInScope(args.project);
      const doc = await mutations2.createDocument(ctx, {
        project_id: project.id,
        title: args.title,
        slug: args.slug,
        number: args.number,
        body: args.body,
        status: args.status,
      });
      return { project: project.code, ...doc };
    },
  },

  'wiki.update': {
    mode: 'write',
    description:
      'Replace the body of a wiki page. base_revision is required and is the revision you read: a save '
      + 'against a revision that has moved on is REFUSED rather than merged, and the error says what the '
      + 'page is at now so you can read it again. Read the page with wiki.read first - it returns the '
      + 'revision to pass here.',
    schema: {
      type: 'object',
      properties: {
        number: { type: 'string', description: 'The document number, e.g. "05".' },
        slug: { type: 'string' },
        project: { type: 'string', description: 'Project code, when a number or slug is used twice.' },
        body: { type: 'string', description: 'Markdown. This replaces the whole page.' },
        base_revision: { type: 'integer', description: 'The revision wiki.read returned. 0 for a page never saved.' },
        note: { type: 'string', description: 'What changed, kept with the revision.' },
      },
      required: ['body', 'base_revision'],
      additionalProperties: false,
    },
    async run(args) {
      const ctx = await writeContext();
      const project = args.project ? (await projectInScope(args.project)).id : null;
      const doc = await documentInScope({ number: args.number, slug: args.slug, project });
      try {
        const saved = await mutations2.saveDocument(ctx, doc.id, {
          body: args.body,
          baseRevision: Number(args.base_revision),
          // The note is what the wiki's revision list shows, and it is the only
          // place on that screen a machine's revision can say so.
          note: args.note ? `${args.note} — ${writtenBy(ctx)}` : writtenBy(ctx),
        });
        return { number: doc.number, slug: doc.slug, title: doc.title, ...saved };
      } catch (e) {
        // The refusal carries the current revision so the next call can be
        // right. An error that says only "conflict" makes the assistant guess.
        if (e.currentRevision !== undefined) {
          throw new Error(`${e.message}. Read it again with wiki.read and save against revision ${e.currentRevision}.`);
        }
        throw e;
      }
    },
  },

  'comment.add': {
    mode: 'write',
    description:
      'Comment on a work package or a wiki page. The comment is signed with this server\'s name, '
      + 'because a comment is read in the drawer and in a share, and neither of those reads the '
      + 'activity trail that records who wrote it. @mentions are resolved and notify the people they '
      + 'match, and the handles that matched nobody come back in the result rather than failing '
      + 'silently. This server never writes an internal comment.',
    schema: {
      type: 'object',
      properties: {
        work_package: { type: 'string', description: 'A work package key, e.g. "WP-112".' },
        wiki: { type: 'string', description: 'A wiki page number or slug. Use one of this or work_package.' },
        project: { type: 'string', description: 'Project code, to disambiguate a wiki page.' },
        body: { type: 'string', description: 'Markdown.' },
      },
      required: ['body'],
      additionalProperties: false,
    },
    async run(args) {
      const ctx = await writeContext();
      if (Boolean(args.work_package) === Boolean(args.wiki)) {
        throw new Error('comment on one thing: pass work_package or wiki, not both and not neither');
      }
      let containerType = 'work_package';
      let containerId = null;
      let target = null;
      if (args.work_package) {
        const wp = await workPackageInScope(args.work_package);
        containerId = wp.id;
        target = wp.wp_key;
      } else {
        const project = args.project ? (await projectInScope(args.project)).id : null;
        const doc = await documentInScope({ number: args.wiki, slug: args.wiki, project });
        containerType = 'document';
        containerId = doc.id;
        target = doc.slug;
      }
      // Never internal, at any scope. This server cannot read an internal
      // comment back, and a comment nobody can audit is not one to be able to
      // write. The argument does not exist rather than being refused, so there
      // is nothing to keep trying.
      const out = await mutations.addComment(ctx, {
        containerType, containerId, internal: false,
        body: `${args.body}\n\n— ${writtenBy(ctx)}`,
      });
      return {
        id: out.id, on: target, mentioned: out.mentioned, unresolved: out.unresolved,
        note: out.unresolved.length
          ? `@${out.unresolved.join(', @')} matched nobody, so nobody was told`
          : undefined,
      };
    },
  },

  'summary.write': {
    mode: 'write',
    description:
      'Post a generated status summary to a person\'s My page. Needs a write-scoped token. The '
      + 'previous summary for the same scope is superseded rather than deleted, and the page labels '
      + 'the result as generated with its age and source, so a reader can always tell it from prose a '
      + 'person wrote.',
    schema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Markdown. Two or three short paragraphs is what the widget fits.' },
        user: { type: 'string', description: 'The login whose My page it goes on.' },
        project: { type: 'string', description: 'Or a project code, for a project-scoped summary.' },
      },
      required: ['body'],
      additionalProperties: false,
    },
    async run(args) {
      const body = String(args.body || '').trim();
      if (!body) throw new Error('an empty summary is not a summary');
      if (body.length > 4000) throw new Error('a summary longer than 4000 characters is a document, not a summary');

      let scope = 'portfolio';
      let userId = null;
      let projectId = null;
      if (args.user) {
        const u = await db.one("SELECT id FROM users WHERE login = ? AND kind = 'user'", [args.user]);
        if (!u) throw new Error(`no user "${args.user}"`);
        scope = 'user';
        userId = u.id;
      } else if (args.project) {
        const ids = await scopedProjectIds();
        const p = await db.one('SELECT id FROM projects WHERE code = ?', [String(args.project).toUpperCase()]);
        if (!p || !ids.includes(Number(p.id))) throw new Error(`no project "${args.project}" in this token's scope`);
        scope = 'project';
        projectId = p.id;
      }

      const id = await db.transaction(async (tx) => {
        await tx.run(`
          UPDATE generated_summaries SET superseded_at = NOW()
           WHERE superseded_at IS NULL AND scope = ?
             AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))
             AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))`,
        [scope, userId, userId, projectId, projectId]);
        const newId = await tx.insert('generated_summaries', {
          scope, user_id: userId, project_id: projectId, body,
          source: 'mcp', token_id: token && token.id ? token.id : null,
        });
        // Written to the activity feed like any other change, tagged as a
        // machine. An automated write indistinguishable from a human one is a
        // write nobody can explain a week later.
        await notify.record({
          projectId,
          actorLabel: `mcp · ${(token && token.hint) || 'unknown token'}`,
          kind: 'ai',
          verb: 'wrote a status summary',
          detail: body.slice(0, 300),
        }, tx);
        return newId;
      });
      return { id, scope, superseded_previous: true };
    },
  },

  // ------------------------------------------------------------- the git deck

  'git.links': {
    mode: 'read',
    description:
      'What a work package is in the repository, and what the repository has that belongs to no work '
      + 'package. Ask it by the tracker key (WP-112) or by the key the repository knows it by '
      + '(F-LOAD-012). Every link says how it came to exist — the key that matched and where it was '
      + 'found, or that a person made it by hand — because a link that cannot say why it exists is a '
      + 'link nobody should act on.',
    schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'WP-112, or a repository key such as F-LOAD-012.' },
        project: { type: 'string', description: 'Project code, when asking for the unmapped lists instead.' },
        unmapped: {
          type: 'boolean',
          description: 'Instead of one work package: the work with no forge object, and the forge '
            + 'objects with no work package.',
        },
      },
      additionalProperties: false,
    },
    async run(args) {
      const ids = await scopedProjectIds();
      const ctx = { user: { id: null }, visibleProjectIds: ids, today: today() };
      if (args.unmapped) {
        const project = args.project ? await projectInScope(args.project) : null;
        const data = await views5.deck(ctx, { projectId: project ? Number(project.id) : null });
        const unmappedItems = data.items.filter((i) => !i.links.length
          && ['pull_request', 'issue', 'milestone', 'release'].includes(i.kind));
        return {
          coverage: data.coverage,
          unmatched_keys: data.unmatched,
          forge_objects_with_no_work_package: unmappedItems.map((i) => ({
            repository: i.repository, kind: i.kind, ref: i.ref, title: i.title, state: i.state, url: i.url,
          })),
          count: unmappedItems.length,
          note: 'A key found in a repository that matches no work package is kept, not dropped. '
            + 'Give a work package that key and the next pull links it.',
        };
      }
      const wp = await workPackageByAnyKey(args.key, ids);
      const data = await views5.workPackageGit(ctx, wp.id);
      return {
        work_package: data.work_package,
        mapping: data.mapping,
        links: data.links,
        commits: data.revisions,
        count: data.links.filter((l) => !l.removed).length,
      };
    },
  },

  'git.deck': {
    mode: 'read',
    description:
      'The repositories in scope: pull requests, issues, CI, the health score and how much of the '
      + 'work is mapped. THE HEALTH SCORE AND THE CI RATE ARE NOT PROGRESS. Health is repository '
      + 'hygiene, CI is a pipeline, and neither enters the readiness figure that portfolio.status '
      + 'reports. Do not add them together and do not present either as completion.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Restrict to one project code.' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const ids = await scopedProjectIds();
      const project = args.project ? await projectInScope(args.project) : null;
      const data = await views5.deck(
        { user: { id: null }, visibleProjectIds: ids, today: today() },
        { projectId: project ? Number(project.id) : null }
      );
      return {
        repositories: data.repositories.map((r) => ({
          name: r.name, project: r.project_code, scm: r.scm, slug: r.slug,
          state: r.state, pull_state: r.pull_state, last_synced: r.last_synced,
          counts: r.counts, health: r.health, ci: r.ci, digest: r.digest,
          forge_objects_mapped: `${r.coverage.items_linked}/${r.coverage.items}`,
          // Whether the forge can reach us, and whether a delivery may move
          // anything. Never the secret — only the name of the variable and
          // whether it is set.
          webhook: {
            open: Boolean(r.hook.secret_env && r.hook.secret_present),
            secret_env: r.hook.secret_env, state: r.hook.state, last: r.hook.last,
            acts_as: r.hook.actor || 'nobody — deliveries mirror and move no status',
          },
        })),
        coverage: data.coverage,
        mapping: data.mapping,
        recent_pulls: data.pulls,
        count: data.repositories.length,
        note: data.note,
      };
    },
  },

  'git.pull': {
    mode: 'write',
    description:
      'Pull a repository now: fetch its pull requests, issues, milestones, releases and CI, mirror '
      + 'them, and re-match their keys to work packages. A write because it reaches the network on '
      + "the tracker's behalf and, where a repository has been configured to allow it, can move a "
      + 'work package through the status workflow. `dry_run` fetches and matches and writes nothing, '
      + 'which is how to find out what a first pull would do.',
    schema: {
      type: 'object',
      properties: {
        repository: { type: 'string', description: 'The repository name or slug, e.g. "seedfall/seedfall".' },
        dry_run: { type: 'boolean', description: 'Fetch and match, write nothing.' },
      },
      required: ['repository'],
      additionalProperties: false,
    },
    async run(args) {
      const ctx = await writeContext();
      const ids = await scopedProjectIds();
      const clause = db.inClause(ids.length ? ids : [0]);
      const repo = await db.one(
        `SELECT id, name, scm FROM repositories
          WHERE (name = ? OR slug = ?) AND project_id IN ${clause.sql}`,
        [String(args.repository), String(args.repository), ...clause.params]
      );
      if (!repo) throw new Error(`no repository "${args.repository}" in this token's scope`);
      const report = await gitPull.pullRepository(ctx, repo.id, { dryRun: Boolean(args.dry_run) });
      return {
        ...report,
        count: report.links_made,
        note: report.dry_run
          ? 'Nothing was written. The dry run itself is recorded.'
          : 'A link a person removed by hand is never re-made by a pull; those are counted as held.',
      };
    },
  },
};

/**
 * Check the arguments against the tool's own schema before running it.
 *
 * An argument this server does not know is REFUSED, not ignored. A caller that
 * writes `assigned_to` where the tool wanted `assignee`, and is told nothing,
 * has created a work package with no assignee and no way to find out why. It is
 * the same rule `src/domain/query.js` applies to an unknown filter, for the same
 * reason: silently ignoring one does something other than what was asked.
 *
 * Deliberately shallow — required keys, unknown keys, and a declared enum. Types
 * are left to the tool, which has to check them against the database anyway.
 */
function checkArguments(tool, args) {
  const schema = tool.schema || {};
  const known = Object.keys(schema.properties || {});
  for (const r of schema.required || []) {
    if (args[r] === undefined || args[r] === null) throw new Error(`"${r}" is required`);
  }
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(args).filter((k) => !known.includes(k));
    if (unknown.length) {
      throw new Error(
        `no argument called ${unknown.map((u) => `"${u}"`).join(', ')} - this tool takes ${known.join(', ')}`
      );
    }
  }
  for (const [k, v] of Object.entries(args)) {
    const spec = (schema.properties || {})[k];
    if (spec && spec.enum && v !== undefined && !spec.enum.includes(v)) {
      throw new Error(`"${k}" is one of ${spec.enum.join(', ')}, not "${v}"`);
    }
  }
}

// --------------------------------------------------------------- JSON-RPC

const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => write({
  jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) },
});

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    return respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions:
        'ProjectTracker. Readiness figures are WEIGHTED (speccing 0.35, in build 0.7, done 1) and are '
        + 'not completion percentages — completion is the separate done/partial/not-started counts. '
        + 'Deferred and rejected work is excluded from the denominator rather than scored zero. Story '
        + 'points are summed over leaf work only, so a parent never counts its children. Internal '
        + 'comments are never returned by any tool. Every call you make is recorded in an audit table, '
        + 'reads included. '
        + 'The write tools run with the permissions of the person who issued this token and can do no '
        + 'more than they can, and every change they make is recorded in the activity trail as coming '
        + 'from this server rather than from that person. A status change goes through the workflow in '
        + 'administration, so a transition it does not have is refused; a wiki save is refused when the '
        + 'page has moved on since you read it, rather than being merged.',
    });
  }

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;

  if (method === 'ping') return respond(id, {});

  if (method === 'tools/list') {
    // A tool whose row is disabled is not listed. A tool that is listed and
    // refuses is worse than one that was never offered.
    const enabled = new Set(
      (await db.query('SELECT name FROM mcp_tools WHERE enabled = 1')).map((r) => r.name)
    );
    const available = Object.entries(TOOLS)
      .filter(([name]) => !enabled.size || enabled.has(name))
      .filter(([, t]) => !token || token.scope === 'write' || t.mode === 'read');
    return respond(id, {
      tools: available.map(([name, t]) => ({
        name,
        description: `${t.description}${t.mode === 'write' ? ' [WRITE — needs a write-scoped token]' : ''}`,
        inputSchema: t.schema,
      })),
    });
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const tool = TOOLS[name];
    const started = Date.now();

    if (!tool) {
      await audit(String(name), 'read', args, 'error', 'no such tool', null, Date.now() - started, null);
      return fail(id, -32601, `no tool called "${name}"`);
    }
    if (!token) {
      await audit(name, tool.mode, args, 'denied', 'no token presented', null, Date.now() - started, null);
      return fail(id, -32001,
        'PT_MCP_TOKEN is not set, so this server can read nothing. Issue a token in '
        + 'Administration -> Repositories & MCP and put it in the environment.');
    }
    if (token.invalid) {
      await audit(name, tool.mode, args, 'denied', token.invalid, null, Date.now() - started, null);
      return fail(id, -32001, `PT_MCP_TOKEN: ${token.invalid}`);
    }
    if (tool.mode === 'write' && token.scope !== 'write') {
      await audit(name, 'write', args, 'denied', 'read-scoped token', null, Date.now() - started, null);
      return fail(id, -32002,
        `"${name}" writes, and this token is read-scoped. A separate write-scoped token is needed, `
        + 'which is deliberate: a read token cannot be talked into writing.');
    }

    try {
      checkArguments(tool, args);
      const result = await tool.run(args);
      const rowCount = result.count !== undefined ? result.count
        : Array.isArray(result.projects) ? result.projects.length : null;
      await audit(name, tool.mode, args, 'ok', null, rowCount, Date.now() - started,
        await scopedProjectIds());
      return respond(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 1) }],
        isError: false,
      });
    } catch (e) {
      await audit(name, tool.mode, args, 'error', e.message, null, Date.now() - started, null);
      // Returned as tool content rather than a protocol error: the assistant can
      // read the message and correct its arguments, which a transport-level
      // failure does not let it do.
      return respond(id, {
        content: [{ type: 'text', text: `error: ${e.message}` }],
        isError: true,
      });
    }
  }

  return fail(id, -32601, `unsupported method "${method}"`);
}

async function main() {
  token = await loadToken();

  // Diagnostics go to stderr, never stdout: stdout is the protocol channel and
  // one stray line on it breaks the client's parser.
  if (!token) {
    process.stderr.write('projecttracker mcp: PT_MCP_TOKEN is not set — every tool call will be refused\n');
  } else if (token.invalid) {
    process.stderr.write(`projecttracker mcp: PT_MCP_TOKEN ${token.invalid}\n`);
  } else {
    process.stderr.write(
      `projecttracker mcp: ready · ${token.scope} scope · `
      + `${token.projectScope ? token.projectScope.length + ' project(s)' : 'every project'}\n`
    );
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    let message;
    try {
      message = JSON.parse(text);
    } catch (e) {
      fail(null, -32700, 'parse error');
      continue;
    }
    try {
      await handle(message);
    } catch (e) {
      // A bug in a handler must not take the server down: the client would see
      // the process die with no explanation.
      process.stderr.write(`projecttracker mcp: ${e.stack}\n`);
      if (message && message.id !== undefined) fail(message.id, -32603, 'internal error');
    }
  }
  await db.close();
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`projecttracker mcp: cannot start: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { TOOLS, handle, loadToken };
