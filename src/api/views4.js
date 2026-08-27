/**
 * The read side, finished: wiki, meetings, connections, administration, and the
 * work package drawer.
 */

'use strict';

const db = require('../db');
const rollup = require('../domain/rollup');
const sched = require('../domain/scheduling');
const query = require('../domain/query');
const access = require('../domain/access');
const { notFound } = require('../http/router');
const { row, shortDate, ago, num } = require('./views');

// -------------------------------------------------------------------------- wiki

async function wiki(ctx, { projectId = null, slug = null } = {}) {
  const clause = db.inClause(ctx.visibleProjectIds.length ? ctx.visibleProjectIds : [0]);
  const where = projectId ? 'd.project_id = ?' : `(d.project_id IS NULL OR d.project_id IN ${clause.sql})`;
  const params = projectId ? [projectId] : clause.params;

  const docs = await db.query(`
    SELECT d.id, d.number, d.slug, d.title, d.status, d.word_count, d.section_count,
           d.updated_at, d.position, p.code AS project_code,
           (SELECT COUNT(*) FROM document_presence pr
             WHERE pr.document_id = d.id AND pr.last_seen > DATE_SUB(NOW(), INTERVAL 5 MINUTE)) AS editing
      FROM documents d LEFT JOIN projects p ON p.id = d.project_id
     WHERE ${where}
       -- This page's content is now a decision record: showing it in both the
       -- wiki index and on #/decisions is how the two come to disagree about
       -- what a decision means.
       AND NOT EXISTS (SELECT 1 FROM decisions x WHERE x.document_id = d.id)
     ORDER BY d.position, d.number, d.title`, params);

  const current = slug
    ? docs.find((d) => d.slug === slug) || null
    : docs[0] || null;

  let body = null;
  let revisions = [];
  let editors = [];
  if (current) {
    const full = await db.one(`
      SELECT d.*, u.name AS updated_by_name FROM documents d
        LEFT JOIN users u ON u.id = d.updated_by WHERE d.id = ?`, [current.id]);
    body = full;
    revisions = await db.query(`
      SELECT v.revision, v.note, v.created_at, u.name AS author
        FROM document_versions v LEFT JOIN users u ON u.id = v.author_id
       WHERE v.document_id = ? ORDER BY v.revision DESC LIMIT 10`, [current.id]);
    editors = await db.query(`
      SELECT u.name, u.initials, u.colour, pr.section, pr.last_seen
        FROM document_presence pr JOIN users u ON u.id = pr.user_id
       WHERE pr.document_id = ? AND pr.last_seen > DATE_SUB(NOW(), INTERVAL 5 MINUTE)`, [current.id]);
  }

  const newsWhere = projectId ? 'n.project_id = ?' : `(n.project_id IS NULL OR n.project_id IN ${clause.sql})`;
  const news = await db.query(`
    SELECT n.id, n.title, n.summary, n.created_at, u.name AS author
      FROM news n LEFT JOIN users u ON u.id = n.author_id
     WHERE ${newsWhere} ORDER BY n.created_at DESC LIMIT 6`, projectId ? [projectId] : clause.params);

  const forumWhere = projectId ? 'f.project_id = ?' : `(f.project_id IS NULL OR f.project_id IN ${clause.sql})`;
  const topics = await db.query(`
    SELECT t.id, t.subject, t.reply_count, t.last_reply_at, f.name AS forum, u.name AS author
      FROM forum_topics t JOIN forums f ON f.id = t.forum_id
      LEFT JOIN users u ON u.id = t.author_id
     WHERE ${forumWhere} ORDER BY t.sticky DESC, t.last_reply_at DESC LIMIT 8`,
  projectId ? [projectId] : clause.params);

  const attachments = Number(await db.scalar(
    `SELECT COUNT(*) FROM attachments WHERE container_type IN ('document', 'work_package')`
  ));
  const xwiki = await db.one("SELECT name, target, state, detail FROM integrations WHERE kind = 'xwiki' LIMIT 1");

  return {
    docs: docs.map((d) => ({ ...d, editing: Number(d.editing) || 0 })),
    current: body ? {
      id: body.id, number: body.number, slug: body.slug, title: body.title,
      status: body.status, body: body.body,
      word_count: body.word_count, section_count: body.section_count,
      updated_at: body.updated_at, updated_by: body.updated_by_name,
      revision: revisions.length ? revisions[0].revision : 1,
    } : null,
    revisions,
    editors,
    news: news.map((n) => ({ ...n, when: ago(n.created_at) })),
    topics: topics.map((t) => ({ ...t, when: ago(t.last_reply_at) })),
    alsoHere: {
      forums: topics.length,
      news: news.length,
      attachments,
      xwiki: xwiki || null,
    },
  };
}

// ---------------------------------------------------------------------- meetings

async function meetings(ctx, { projectId = null, meetingId = null } = {}) {
  const clause = db.inClause(ctx.visibleProjectIds.length ? ctx.visibleProjectIds : [0]);
  const where = projectId ? 'm.project_id = ?' : `(m.project_id IS NULL OR m.project_id IN ${clause.sql})`;
  const params = projectId ? [projectId] : clause.params;

  const list = await db.query(`
    SELECT m.*, p.code AS project_code,
           (SELECT GROUP_CONCAT(u.name ORDER BY u.name SEPARATOR ', ')
              FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
             WHERE mp.meeting_id = m.id) AS who,
           EXISTS (SELECT 1 FROM meeting_minutes mn WHERE mn.meeting_id = m.id) AS has_minutes
      FROM meetings m LEFT JOIN projects p ON p.id = m.project_id
     WHERE ${where}
     ORDER BY m.scheduled_on DESC, m.start_time DESC LIMIT 50`, params);

  const current = meetingId
    ? list.find((m) => Number(m.id) === Number(meetingId)) || null
    : list[0] || null;

  let detail = null;
  if (current) {
    const [agenda, minutes, outcomes, participants] = await Promise.all([
      db.query(`
        SELECT a.*, wp.wp_key, wp.subject AS wp_subject, u.name AS presenter
          FROM meeting_agenda_items a
          LEFT JOIN work_packages wp ON wp.id = a.work_package_id
          LEFT JOIN users u ON u.id = a.presenter_id
         WHERE a.meeting_id = ? ORDER BY a.position`, [current.id]),
      db.one(`
        SELECT mn.*, u.name AS recorded_by_name FROM meeting_minutes mn
          LEFT JOIN users u ON u.id = mn.recorded_by WHERE mn.meeting_id = ?`, [current.id]),
      db.query(`
        SELECT o.*, u.name AS owner_name, wp.wp_key, m2.title AS carried_to_title
          FROM meeting_outcomes o
          LEFT JOIN users u ON u.id = o.owner_id
          LEFT JOIN work_packages wp ON wp.id = o.work_package_id
          LEFT JOIN meetings m2 ON m2.id = o.carried_to
         WHERE o.meeting_id = ? ORDER BY o.id`, [current.id]),
      db.query(`
        SELECT u.id, u.name, u.initials, u.colour, mp.attended
          FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
         WHERE mp.meeting_id = ?`, [current.id]),
    ]);
    detail = {
      ...current,
      // The agenda is frozen once the meeting opens; after that edits go to the
      // minutes. The client greys the add-item control on this flag rather than
      // deciding for itself, so the rule lives in one place.
      agendaOpen: current.state === 'agenda',
      agenda, minutes, outcomes, participants,
      dateLabel: `${shortDate(current.scheduled_on)} ${String(current.start_time || '').slice(0, 5)}`.trim(),
    };
  }

  return {
    list: list.map((m) => ({
      id: m.id, title: m.title, state: m.state, project_code: m.project_code,
      scheduled_on: m.scheduled_on, start_time: String(m.start_time || '').slice(0, 5),
      duration_min: m.duration_min, who: m.who, has_minutes: Boolean(m.has_minutes),
      dateLabel: shortDate(m.scheduled_on),
    })),
    current: detail,
  };
}

// ------------------------------------------------------------ repositories & MCP

async function connect(ctx) {
  const integrations = await db.query(`
    SELECT i.*, p.code AS project_code FROM integrations i
      LEFT JOIN projects p ON p.id = i.project_id ORDER BY i.kind, i.name`);
  const repositories = await db.query(`
    SELECT r.*, p.code AS project_code,
           (SELECT COUNT(*) FROM repository_revisions rv WHERE rv.repository_id = r.id) AS revisions
      FROM repositories r JOIN projects p ON p.id = r.project_id ORDER BY r.scm, r.name`);
  const revisions = await db.query(`
    SELECT rv.identifier, rv.author, rv.message, rv.committed_at, rv.insertions, rv.deletions,
           r.name AS repository, GROUP_CONCAT(wp.wp_key) AS work_packages
      FROM repository_revisions rv
      JOIN repositories r ON r.id = rv.repository_id
      LEFT JOIN revision_work_packages rwp ON rwp.revision_id = rv.id
      LEFT JOIN work_packages wp ON wp.id = rwp.work_package_id
     GROUP BY rv.id ORDER BY rv.committed_at DESC LIMIT 10`);

  const tools = await db.query('SELECT * FROM mcp_tools ORDER BY position, name');
  const tokens = await db.query(`
    SELECT t.id, t.name, t.token_hint, t.scope, t.project_scope, t.includes_internal,
           t.created_at, t.expires_at, t.last_used_at, t.revoked_at, u.name AS created_by_name
      FROM mcp_tokens t LEFT JOIN users u ON u.id = t.created_by
     ORDER BY t.revoked_at IS NOT NULL, t.created_at DESC`);
  const audit = await db.query(`
    SELECT a.id, a.token_hint, a.tool, a.mode, a.outcome, a.row_count, a.duration_ms,
           a.result_note, a.created_at
      FROM mcp_audit a ORDER BY a.created_at DESC LIMIT 20`);

  const intake = await db.query(`
    SELECT e.id, e.from_email, e.subject, e.state, e.reason, e.received_at, wp.wp_key
      FROM email_intake e LEFT JOIN work_packages wp ON wp.id = e.work_package_id
     ORDER BY e.received_at DESC LIMIT 10`);

  return {
    integrations: integrations.map((i) => ({
      id: i.id, kind: i.kind, name: i.name, target: i.target, state: i.state, detail: i.detail,
      project_code: i.project_code,
      // The variable name, never the value. A credential is not in this database
      // and so cannot be in this response.
      credential: i.token_env ? `read from $${i.token_env}` : 'no credential needed',
      credential_present: i.token_env ? Boolean(process.env[i.token_env]) : null,
    })),
    repositories: repositories.map((r) => ({
      id: r.id, scm: r.scm, name: r.name, url: r.url, state: r.state, detail: r.detail,
      default_branch: r.default_branch, project_code: r.project_code,
      revisions: Number(r.revisions), last_synced_at: r.last_synced_at,
      // Whether this one can actually be fetched, and whether it ever has been.
      // The connections page is where somebody asks "is this connected", and
      // 'connected' on a row nothing has ever pulled answers a different
      // question. The deck at #/deck is where the contents are.
      pullable: ['github', 'gitlab', 'forgejo'].includes(r.scm),
      pull_state: r.pull_state,
      pull_detail: r.pull_detail,
      last_synced: r.last_synced_at ? ago(r.last_synced_at) : 'never pulled',
      credential: r.token_env ? `read from $${r.token_env}` : 'no credential needed',
      credential_present: r.token_env ? Boolean(process.env[r.token_env]) : null,
    })),
    revisions: revisions.map((r) => ({ ...r, when: ago(r.committed_at) })),
    mcp: {
      // stdio only. There is no listening port, which is why there is no URL to
      // show: the assistant launches the server as a child process, so nothing
      // is exposed to the network and there is no tunnel to secure.
      transport: 'stdio · local only, no listening port',
      command: 'node src/mcp/server.js',
      tools: tools.map((t) => ({
        name: t.name, mode: t.mode, detail: t.detail, status: t.status, enabled: Boolean(t.enabled),
      })),
      tokens: tokens.map((t) => ({
        id: t.id, name: t.name, hint: `pt_mcp_...${t.token_hint}`, scope: t.scope,
        project_scope: db.json(t.project_scope, null),
        includes_internal: Boolean(t.includes_internal),
        last_used: t.last_used_at ? ago(t.last_used_at) : 'never',
        expires_at: t.expires_at, revoked: Boolean(t.revoked_at),
        created_by: t.created_by_name,
      })),
      // The audit exists, and this is it. Every call lands here, reads included,
      // because "what did the assistant look at" is the question an audit is
      // actually asked.
      audit: audit.map((a) => ({ ...a, when: ago(a.created_at) })),
      auditCount: Number(await db.scalar('SELECT COUNT(*) FROM mcp_audit')),
    },
    intake: intake.map((e) => ({ ...e, when: ago(e.received_at) })),
  };
}

// ---------------------------------------------------------------- administration

async function admin(ctx, { tab = 'fields' } = {}) {
  const out = { tab };

  if (tab === 'fields') {
    const fields = await db.query(`
      SELECT cf.*,
             (SELECT GROUP_CONCAT(p.code ORDER BY p.code SEPARATOR ', ')
                FROM custom_field_projects cfp JOIN projects p ON p.id = cfp.project_id
               WHERE cfp.custom_field_id = cf.id) AS project_codes,
             (SELECT COUNT(*) FROM custom_values cv WHERE cv.custom_field_id = cf.id) AS used
        FROM custom_fields cf ORDER BY cf.customized_type, cf.position, cf.name`);
    out.fields = fields.map((f) => ({
      id: f.id, name: f.name, format: f.field_format, entity: f.customized_type,
      scope: f.is_for_all ? 'all projects' : (f.project_codes || 'no projects'),
      help: f.help_text, required: Boolean(f.is_required),
      values: db.json(f.possible_values, null), used: Number(f.used),
    }));
    out.helpTexts = await db.query('SELECT entity, attribute, help FROM attribute_help_texts ORDER BY entity, attribute');
  }

  if (tab === 'workflow') {
    const statuses = await db.query('SELECT * FROM statuses ORDER BY position');
    const transitions = await db.query(`
      SELECT t.from_status_id, t.to_status_id, sf.code AS from_code, st.code AS to_code, st.label AS to_label
        FROM status_transitions t
        JOIN statuses sf ON sf.id = t.from_status_id
        JOIN statuses st ON st.id = t.to_status_id
       ORDER BY sf.position, st.position`);
    out.statuses = statuses.map((s) => ({
      id: s.id, code: s.code, label: s.label, colour: s.colour,
      closed: Boolean(s.is_closed),
      weight: s.progress_weight === null ? null : Number(s.progress_weight),
      // Said in words as well as in the column, because "EXCLUDED" and "0" look
      // similar in a table and mean opposite things.
      weightLabel: s.progress_weight === null ? 'EXCLUDED FROM THE DENOMINATOR' : String(Number(s.progress_weight)),
      allowed: transitions.filter((t) => t.from_code === s.code).map((t) => t.to_label).join(', ') || 'nothing',
      inUse: 0,
    }));
    for (const s of out.statuses) {
      s.inUse = Number(await db.scalar('SELECT COUNT(*) FROM work_packages WHERE status_id = ?', [s.id]));
    }
    out.types = await db.query('SELECT id, name, colour, is_milestone, subject_pattern FROM work_package_types ORDER BY position');
  }

  if (tab === 'auto') {
    const rows = await db.query(`
      SELECT a.*,
             (SELECT GROUP_CONCAT(p.code ORDER BY p.code SEPARATOR ', ')
                FROM automation_projects ap JOIN projects p ON p.id = ap.project_id
               WHERE ap.automation_id = a.id) AS project_codes,
             (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.outcome = 'applied') AS applied,
             (SELECT COUNT(*) FROM automation_runs r WHERE r.automation_id = a.id AND r.outcome = 'failed') AS failed
        FROM automations a ORDER BY a.id`);
    out.automations = rows.map((a) => ({
      id: a.id, name: a.name, trigger: a.trigger_kind, action: a.action_kind,
      scope: a.scope === 'all' ? 'all projects' : (a.project_codes || 'no projects'),
      enabled: Boolean(a.enabled),
      // Why it is off matters more than that it is off. Without the note,
      // somebody turns it back on in six months and rediscovers the reason.
      note: a.disabled_note,
      runs: Number(a.run_count), applied: Number(a.applied), failed: Number(a.failed),
      last_run_at: a.last_run_at, last_run: a.last_run_at ? ago(a.last_run_at) : 'never',
    }));
    out.runs = (await db.query(`
      SELECT r.*, a.name, wp.wp_key FROM automation_runs r
        JOIN automations a ON a.id = r.automation_id
        LEFT JOIN work_packages wp ON wp.id = r.work_package_id
       ORDER BY r.created_at DESC LIMIT 20`)).map((r) => ({ ...r, when: ago(r.created_at) }));
  }

  if (tab === 'roles') {
    out.roles = await db.query(`
      SELECT r.id, r.name, r.builtin, r.description,
             (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id) AS permissions,
             (SELECT COUNT(*) FROM membership_roles mr WHERE mr.role_id = r.id) AS grants
        FROM roles r ORDER BY r.position`);
    out.permissions = await db.query('SELECT code, category, label FROM permissions ORDER BY category, code');
    out.groups = await db.query(`
      SELECT g.id, g.name, g.description,
             (SELECT COUNT(*) FROM user_group_members m WHERE m.group_id = g.id) AS members,
             (SELECT GROUP_CONCAT(DISTINCT p.code ORDER BY p.code SEPARATOR ', ')
                FROM memberships mm JOIN projects p ON p.id = mm.project_id
               WHERE mm.group_id = g.id) AS projects
        FROM user_groups g ORDER BY g.name`);
    out.placeholders = await db.query(`
      SELECT u.id, u.name, u.placeholder_for,
             (SELECT COUNT(*) FROM work_packages wp WHERE wp.assignee_id = u.id) AS assignments,
             (SELECT COALESCE(SUM(hours), 0) FROM resource_allocations ra WHERE ra.user_id = u.id) AS booked
        FROM users u WHERE u.kind = 'placeholder' ORDER BY u.name`);
    out.people = await db.query(`
      SELECT u.id, u.name, u.login, u.kind, u.is_admin, u.weekly_capacity, u.active, u.last_seen_at,
             (SELECT COUNT(*) FROM memberships m WHERE m.user_id = u.id) AS projects
        FROM users u ORDER BY u.kind, u.name`);
  }

  if (tab === 'theme') {
    out.themes = (await db.query('SELECT * FROM themes ORDER BY is_default DESC, name'))
      .map((t) => ({ ...t, tokens: db.json(t.tokens, {}) }));
    const forms = await db.query(`
      SELECT f.id, f.name, t.name AS type_name, t.id AS type_id
        FROM form_configurations f JOIN work_package_types t ON t.id = f.type_id
       ORDER BY t.position`);
    out.forms = [];
    for (const f of forms) {
      const sections = await db.query('SELECT * FROM form_sections WHERE form_id = ? ORDER BY position', [f.id]);
      for (const s of sections) {
        s.fields = await db.query('SELECT attribute, label, position, required, read_only FROM form_fields WHERE section_id = ? ORDER BY position', [s.id]);
      }
      out.forms.push({ ...f, sections });
    }
  }

  if (tab === 'initiation') {
    out.requests = await db.query(`
      SELECT r.*, u.name AS requested_by_name, t.code AS template_code, g.code AS program_code,
             d.name AS decided_by_name, p.code AS created_code
        FROM project_initiation_requests r
        JOIN users u ON u.id = r.requested_by
        LEFT JOIN project_templates t ON t.id = r.template_id
        LEFT JOIN programs g ON g.id = r.program_id
        LEFT JOIN users d ON d.id = r.decided_by
        LEFT JOIN projects p ON p.id = r.project_id
       ORDER BY r.created_at DESC`);
    for (const r of out.requests) r.answers = db.json(r.answers, {});
    out.templates = await db.query('SELECT id, code, name, detail FROM project_templates WHERE archived = 0 ORDER BY code');
  }

  return out;
}

// ------------------------------------------------------------- work package drawer

async function drawer(ctx, id) {
  const wp = await query.byId(id);
  if (!wp) throw notFound('no such work package');
  const perms = await access.permissionsFor(ctx.user.id, wp.project_id);

  const [parent, children, relations, watchers, files, timeEntries, baselineEntry, shares, customValues] =
    await Promise.all([
      wp.parent_id ? query.byId(wp.parent_id) : null,
      db.query(`SELECT wp.id, wp.wp_key, wp.subject, s.code AS status_code, s.colour
                  FROM work_packages wp JOIN statuses s ON s.id = wp.status_id
                 WHERE wp.parent_id = ? ORDER BY wp.id`, [id]),
      db.query(`
        SELECT r.kind, r.lag_days, 'out' AS direction, wp.id, wp.wp_key, wp.subject, s.colour
          FROM work_package_relations r JOIN work_packages wp ON wp.id = r.to_id
          JOIN statuses s ON s.id = wp.status_id WHERE r.from_id = ?
        UNION ALL
        SELECT r.kind, r.lag_days, 'in' AS direction, wp.id, wp.wp_key, wp.subject, s.colour
          FROM work_package_relations r JOIN work_packages wp ON wp.id = r.from_id
          JOIN statuses s ON s.id = wp.status_id WHERE r.to_id = ?`, [id, id]),
      db.query(`SELECT u.id, u.name, u.initials, u.colour, u.kind
                  FROM work_package_watchers w JOIN users u ON u.id = w.user_id
                 WHERE w.work_package_id = ?`, [id]),
      db.query(`SELECT a.id, a.filename, a.content_type, a.byte_size, a.created_at, u.name AS author
                  FROM attachments a LEFT JOIN users u ON u.id = a.author_id
                 WHERE a.container_type = 'work_package' AND a.container_id = ?
                 ORDER BY a.created_at DESC`, [id]),
      db.query(`SELECT t.id, t.spent_on, t.hours, t.comment, t.activity, u.name AS who
                  FROM time_entries t JOIN users u ON u.id = t.user_id
                 WHERE t.work_package_id = ? ORDER BY t.spent_on DESC`, [id]),
      db.one(`SELECT be.* FROM baseline_entries be JOIN baselines b ON b.id = be.baseline_id
               WHERE be.work_package_id = ? AND b.is_current = 1 ORDER BY b.taken_at DESC LIMIT 1`, [id]),
      db.query(`SELECT id, token, email, permission, expires_at, revoked_at, view_count, last_viewed_at
                  FROM work_package_shares WHERE work_package_id = ? ORDER BY created_at DESC`, [id]),
      db.query(`SELECT cf.name, cf.field_format, cf.help_text, cv.value
                  FROM custom_values cv JOIN custom_fields cf ON cf.id = cv.custom_field_id
                 WHERE cv.customized_type = 'work_package' AND cv.customized_id = ?
                 ORDER BY cf.position, cf.name`, [id]),
    ]);

  // Internal comments are filtered on the read path, not in the browser. A UI
  // filter is a filter an API call goes around.
  const seesInternal = access.seesInternal(perms);
  const comments = await db.query(`
    SELECT c.id, c.body, c.internal, c.created_at, c.edited_at,
           u.name AS author, u.initials, u.colour, u.kind AS author_kind
      FROM comments c LEFT JOIN users u ON u.id = c.author_id
     WHERE c.container_type = 'work_package' AND c.container_id = ?
       ${seesInternal ? '' : 'AND c.internal = 0'}
     ORDER BY c.created_at`, [id]);

  const cmp = baselineEntry ? sched.compareToBaseline(wp, baselineEntry) : null;
  const est = Number(wp.estimated_hours) || 0;
  const spent = Number(wp.spent_hours) || 0;
  // Progress: booked against estimate where there is one, otherwise the status
  // weight. Two different measurements, and the label says which is in use — a
  // bar that silently switches basis is a bar nobody can read.
  const progress = est > 0
    ? { pct: Math.min(100, Math.round((spent / est) * 100)), basis: 'hours', label: `${spent} / ${est} h` }
    : {
      pct: Math.round((wp.progress_weight === null ? 0 : Number(wp.progress_weight)) * 100),
      basis: 'status', label: 'NO ESTIMATE — STATUS WEIGHT',
    };

  return {
    wp: row(wp, ctx),
    breadcrumb: [wp.project_code, wp.project_name, parent ? `${parent.wp_key} ${parent.subject}` : null]
      .filter(Boolean),
    parent: parent ? { id: parent.id, key: parent.wp_key, subject: parent.subject } : null,
    children: children.map((c) => ({ id: c.id, key: c.wp_key, subject: c.subject, colour: c.colour })),
    relations: relations.map((r) => ({
      // The inverse name is derived on read, so the pair can never disagree.
      kind: r.direction === 'out' ? r.kind : INVERSE[r.kind] || r.kind,
      id: r.id, key: r.wp_key, subject: r.subject, colour: r.colour, lag_days: r.lag_days,
    })),
    watchers,
    files: files.map((f) => ({ ...f, size: humanSize(f.byte_size) })),
    timeEntries,
    comments: comments.map((c) => ({ ...c, when: ago(c.created_at), internal: Boolean(c.internal) })),
    canSeeInternal: seesInternal,
    canEdit: access.canEditWorkPackage(perms, wp, ctx.user.id),
    customValues,
    baseline: cmp,
    progress,
    shares: shares.map((s) => ({
      id: s.id, email: s.email, permission: s.permission,
      // The URL, not the token on its own: a token in a UI is a token somebody
      // pastes into a chat without the context that it is a credential.
      url: s.revoked_at ? null : `/share/${s.token}`,
      expires_at: s.expires_at, revoked: Boolean(s.revoked_at),
      views: s.view_count, last_viewed_at: s.last_viewed_at,
    })),
    scheduling: {
      mode: wp.scheduling,
      explanation: wp.scheduling === 'manual'
        ? 'manual — this work package holds its own dates'
        : children.length
          ? 'automatic — spans its children'
          : 'automatic — follows its predecessors',
    },
  };
}

const INVERSE = {
  follows: 'precedes', blocks: 'blocked by', includes: 'part of',
  requires: 'required by', relates: 'relates', duplicates: 'duplicated by',
};

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

module.exports = { wiki, meetings, connect, admin, drawer, INVERSE, humanSize };
