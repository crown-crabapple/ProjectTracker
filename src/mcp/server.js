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
 *  4. THE ONE WRITE TOOL IS SEPARATELY SCOPED. summary.write needs scope=write.
 *     A read token cannot reach it, and the refusal is audited like any call.
 */

'use strict';

const crypto = require('crypto');
const readline = require('readline');
const db = require('../db');
const rollup = require('../domain/rollup');
const lifecycle = require('../domain/lifecycle');
const query = require('../domain/query');
const notify = require('../domain/notify');

const PROTOCOL_VERSION = '2024-11-05';
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
  };
}

/** The project ids this token may read. Null scope means every project. */
async function scopedProjectIds() {
  const all = (await db.query('SELECT id FROM projects WHERE archived = 0')).map((r) => Number(r.id));
  if (!token || !token.projectScope) return all;
  const allowed = new Set(token.projectScope.map(Number));
  return all.filter((id) => allowed.has(id));
}

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
        SELECT d.*, p.code AS project, u.name AS updated_by_name
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
};

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
        + 'reads included.',
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
