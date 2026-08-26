/**
 * The write side, continued: projects, baselines, sprints, boards, wiki,
 * meetings, news, forums, notifications, allocations, administration, and the
 * email intake.
 */

'use strict';

const db = require('../db');
const access = require('../domain/access');
const notify = require('../domain/notify');
const automations = require('../domain/automations');
const files = require('../domain/files');
const { newToken, today } = require('./mutations');
const { badRequest, notFound, forbidden, conflict } = require('../http/router');

// ------------------------------------------------------------------- projects

/**
 * Create a project from a template.
 *
 * The template's blueprint is applied in one transaction: phases, versions, the
 * wiki skeleton, the boards and the seed work packages. A project half-created
 * from a template is worse than none, because the missing half is invisible.
 */
async function createProject(ctx, body) {
  if (!ctx.user.is_admin) {
    const anyAdmin = await db.scalar(
      "SELECT COUNT(*) FROM memberships m JOIN membership_roles mr ON mr.membership_id = m.id "
      + "JOIN roles r ON r.id = mr.role_id WHERE m.user_id = ? AND r.name = 'Owner'", [ctx.user.id]
    );
    if (!Number(anyAdmin)) throw forbidden('only an owner or an administrator may create a project');
  }
  const code = String(body.code || '').trim().toUpperCase();
  const name = String(body.name || '').trim();
  if (!/^[A-Z0-9]{2,16}$/.test(code)) throw badRequest('the code is 2–16 letters or digits');
  if (!name) throw badRequest('a project needs a name');
  const identifier = String(body.identifier || code).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const clash = await db.one('SELECT id FROM projects WHERE code = ? OR identifier = ?', [code, identifier]);
  if (clash) throw conflict(`${code} or ${identifier} is already taken`);

  const template = body.template_id
    ? await db.one('SELECT * FROM project_templates WHERE id = ?', [body.template_id])
    : null;
  const blueprint = template ? db.json(template.blueprint, {}) : {};

  const projectId = await db.transaction(async (tx) => {
    const id = await tx.insert('projects', {
      code, identifier, name,
      description: body.description || null,
      program_id: body.program_id || null,
      parent_id: body.parent_id || null,
      template_id: template ? template.id : null,
      organization_id: body.organization_id || null,
      health: 'off',
      health_note: 'Not started',
      work_week_id: await tx.scalar('SELECT id FROM work_weeks WHERE is_default = 1'),
    });

    const phases = blueprint.phases || [];
    for (let i = 0; i < phases.length; i += 1) {
      await tx.insert('project_phases', {
        project_id: id, position: i + 1, name: phases[i].name,
        gate_name: phases[i].gate || `G${i + 1}`,
        gate_criterion: phases[i].criterion || 'to be written',
        state: i === 0 ? 'current' : 'not_entered',
      });
    }
    for (const v of blueprint.versions || []) {
      await tx.insert('versions', { project_id: id, code: v.code, name: v.name, state: 'open', sharing: 'none' });
    }
    for (const w of blueprint.wiki || []) {
      const slug = String(w.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      await tx.insert('documents', {
        project_id: id, number: w.number || null, slug, title: w.title,
        body: `# ${w.title}\n\nWritten from the ${template ? template.code : 'blank'} template. Nothing here yet.`,
        status: 'DRAFT', word_count: 12, section_count: 1,
        position: Number(w.number) || 0, created_by: ctx.user.id, updated_by: ctx.user.id,
      });
    }
    for (const [bname, btype] of [['Status board', 'status'], ['Version board', 'version']]) {
      await tx.insert('boards', { project_id: id, name: bname, board_type: btype });
    }
    const dash = await tx.insert('dashboards', { project_id: id, owner_id: null, name: 'Overview' });
    const kinds = ['lifecycle', 'kpi_strip', 'status_breakdown', 'versions', 'members', 'activity'];
    for (let i = 0; i < kinds.length; i += 1) {
      await tx.insert('dashboard_widgets', { dashboard_id: dash, kind: kinds[i], position: i });
    }

    // The creator is the Owner. A project with no owner is a project nobody can
    // sign a gate on.
    const ownerRole = await tx.scalar("SELECT id FROM roles WHERE name = 'Owner'");
    const m = await tx.insert('memberships', { project_id: id, user_id: ctx.user.id });
    await tx.run('INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)', [m, ownerRole]);

    const defaultStatus = await tx.scalar('SELECT id FROM statuses WHERE is_default = 1 LIMIT 1');
    const defaultPriority = await tx.scalar('SELECT id FROM priorities WHERE is_default = 1 LIMIT 1');
    for (const w of blueprint.work_packages || []) {
      const typeId = await tx.scalar('SELECT id FROM work_package_types WHERE name = ?', [w.type || 'TASK']);
      await tx.insert('work_packages', {
        project_id: id, type_id: typeId, subject: w.subject,
        status_id: defaultStatus, priority_id: defaultPriority,
        accountable_id: ctx.user.id, author_id: ctx.user.id,
      });
    }

    await notify.record({
      projectId: id, actorId: ctx.user.id, kind: 'project', verb: 'created a project',
      targetLabel: code,
      detail: template ? `from the ${template.code} template — ${template.detail}` : 'with no template',
    }, tx);
    return id;
  });

  return { id: projectId, code, identifier };
}

/** Sign off a project-initiation request and create the project it asked for. */
async function decideInitiation(ctx, requestId, { approve, note = null, code = null }) {
  if (!ctx.user.is_admin) throw forbidden('only an administrator decides an initiation request');
  const req = await db.one('SELECT * FROM project_initiation_requests WHERE id = ?', [requestId]);
  if (!req) throw notFound('no such request');
  if (req.state !== 'submitted') throw conflict(`that request is already ${req.state}`);

  if (!approve) {
    await db.update('project_initiation_requests', requestId, {
      state: 'rejected', decided_by: ctx.user.id, decided_at: new Date(), decision_note: note,
    });
    return { state: 'rejected' };
  }
  const created = await createProject(ctx, {
    code: code || req.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase(),
    name: req.name, template_id: req.template_id, program_id: req.program_id,
    description: JSON.stringify(db.json(req.answers, {}), null, 1),
  });
  await db.update('project_initiation_requests', requestId, {
    state: 'created', decided_by: ctx.user.id, decided_at: new Date(),
    decision_note: note, project_id: created.id,
  });
  return { state: 'created', project: created };
}

async function setFavourite(ctx, projectId, on) {
  if (on) {
    await db.run(
      'INSERT INTO project_favorites (user_id, project_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = user_id',
      [ctx.user.id, projectId]
    );
  } else {
    await db.run('DELETE FROM project_favorites WHERE user_id = ? AND project_id = ?', [ctx.user.id, projectId]);
  }
  return { favourite: Boolean(on) };
}

async function setHealth(ctx, projectId, { health, note }) {
  await access.require(ctx.user.id, projectId, 'edit_project');
  if (!['green', 'amber', 'rust', 'off'].includes(health)) throw badRequest('unknown health value');
  const before = await db.one('SELECT health FROM projects WHERE id = ?', [projectId]);
  await db.update('projects', projectId, { health, health_note: note || null });
  await notify.record({
    projectId, actorId: ctx.user.id, kind: 'project', verb: 'set project health',
    from: before ? before.health : null, to: health, detail: note || null,
  });
  return { health, note };
}

// ------------------------------------------------------------------ baselines

/**
 * Take a baseline: a copy of every work package's dates, status and points, as
 * of now. The previous current baseline stops being current but is kept — a plan
 * has a history of sign-offs, and the earlier ones are how you see a slip
 * accumulate rather than appear.
 */
async function takeBaseline(ctx, projectId, { name, note = null }) {
  await access.require(ctx.user.id, projectId, 'set_baseline');
  const label = String(name || '').trim() || `Baseline ${today()}`;
  return db.transaction(async (tx) => {
    await tx.run('UPDATE baselines SET is_current = 0 WHERE project_id = ?', [projectId]);
    const id = await tx.insert('baselines', {
      project_id: projectId, name: label, taken_by: ctx.user.id, note, is_current: 1,
    });
    const wps = await tx.query(
      'SELECT id, start_date, due_date, status_id, story_points, estimated_hours FROM work_packages WHERE project_id = ?',
      [projectId]
    );
    for (const w of wps) {
      await tx.insert('baseline_entries', {
        baseline_id: id, work_package_id: w.id,
        start_date: w.start_date, due_date: w.due_date, status_id: w.status_id,
        story_points: w.story_points, estimated_hours: w.estimated_hours,
      });
    }
    await notify.record({
      projectId, actorId: ctx.user.id, kind: 'baseline', verb: 'took a baseline',
      targetLabel: label, detail: `${wps.length} work package(s) recorded`,
    }, tx);
    return { id, name: label, entries: wps.length };
  });
}

// -------------------------------------------------------------------- sprints

async function closeSprint(ctx, sprintId) {
  const sprint = await db.one('SELECT * FROM sprints WHERE id = ?', [sprintId]);
  if (!sprint) throw notFound('no such sprint');
  const scopeProject = sprint.project_id
    || Number(await db.scalar('SELECT project_id FROM sprint_projects WHERE sprint_id = ? LIMIT 1', [sprintId]));
  await access.require(ctx.user.id, scopeProject, 'manage_sprints');
  if (sprint.state === 'closed') throw conflict('that sprint is already closed');

  await db.update('sprints', sprintId, { state: 'closed' });
  await notify.record({
    projectId: scopeProject, actorId: ctx.user.id, kind: 'sprint', verb: 'closed a sprint',
    targetLabel: sprint.code,
  });
  const fired = await automations.dispatch('sprint_closed', {
    projectId: scopeProject, sprintId, actorId: ctx.user.id,
  });
  return { closed: true, automations: fired };
}

// --------------------------------------------------------------------- boards

/**
 * Move a card. What "move" means depends on the board: on a status board it
 * writes the status (and goes through the workflow check, because the board is
 * not a way round it); on a version board it writes the version; on a sprint
 * board the sprint.
 */
async function moveCard(ctx, { workPackageId, boardType, columnKey, position = 0 }) {
  const { updateWorkPackage } = require('./mutations');
  const [kind, rawId] = String(columnKey || '').split(':');
  const refId = rawId === 'none' || rawId === '' ? null : Number(rawId);

  if (kind === 'status') {
    if (!refId) throw badRequest('a card must land in a status');
    return updateWorkPackage(ctx, workPackageId, { status_id: refId });
  }
  if (kind === 'version') return updateWorkPackage(ctx, workPackageId, { version_id: refId });
  if (kind === 'sprint') return updateWorkPackage(ctx, workPackageId, { sprint_id: refId });
  if (kind === 'parent') return updateWorkPackage(ctx, workPackageId, { parent_id: refId });
  if (kind === 'project') throw badRequest('moving a work package between projects is not supported');
  // A free board stores order only.
  await db.run('UPDATE work_packages SET board_position = ? WHERE id = ?', [Number(position) || 0, workPackageId]);
  return { moved: true };
}

async function reorderBacklog(ctx, projectId, orderedIds) {
  await access.require(ctx.user.id, projectId, 'edit_work_packages');
  if (!Array.isArray(orderedIds)) throw badRequest('expected a list of ids');
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i += 1) {
      await tx.run('UPDATE work_packages SET backlog_position = ? WHERE id = ? AND project_id = ?',
        [i, orderedIds[i], projectId]);
    }
  });
  return { reordered: orderedIds.length };
}

// ----------------------------------------------------------------------- wiki

/**
 * Save a document.
 *
 * Optimistic concurrency on the revision number: a save against a stale base
 * revision is refused, and the current body is returned so the client can
 * present both. It is NOT merged. Two people editing the same document is a real
 * situation, and a silent merge that picks one of them is the failure mode this
 * refuses to have — the app shows presence so the collision is visible before it
 * happens, and refuses the save when it does.
 */
async function saveDocument(ctx, documentId, { body, baseRevision, note = null }) {
  const doc = await db.one('SELECT * FROM documents WHERE id = ?', [documentId]);
  if (!doc) throw notFound('no such document');
  await access.require(ctx.user.id, doc.project_id, 'edit_wiki');

  const current = Number(await db.scalar(
    'SELECT COALESCE(MAX(revision), 0) FROM document_versions WHERE document_id = ?', [documentId]
  ));
  if (baseRevision !== undefined && Number(baseRevision) !== current) {
    const e = conflict(`this document has moved on — you edited revision ${baseRevision}, it is now at ${current}`);
    e.currentBody = doc.body;
    e.currentRevision = current;
    throw e;
  }

  const text = String(body || '');
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const sections = (text.match(/^#{1,6} /gm) || []).length;

  await db.transaction(async (tx) => {
    await tx.update('documents', documentId, {
      body: text, word_count: words, section_count: sections, updated_by: ctx.user.id,
    });
    await tx.insert('document_versions', {
      document_id: documentId, revision: current + 1, body: text, author_id: ctx.user.id, note,
    });
    await notify.record({
      projectId: doc.project_id, actorId: ctx.user.id, kind: 'wiki', verb: 'edited the wiki',
      targetLabel: `${doc.number || ''} ${doc.title}`.trim(),
      detail: note || `revision ${current + 1} · ${words} words`,
    }, tx);
  });
  return { revision: current + 1, word_count: words, section_count: sections };
}

/** Heartbeat presence in a document, so co-editors can see each other. */
async function touchPresence(ctx, documentId, { section = null, baseRevision = null }) {
  await db.run(`
    INSERT INTO document_presence (document_id, user_id, section, base_revision)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE section = VALUES(section), base_revision = VALUES(base_revision), last_seen = NOW()`,
  [documentId, ctx.user.id, section, baseRevision]);
  const others = await db.query(`
    SELECT u.name, u.initials, u.colour, p.section FROM document_presence p JOIN users u ON u.id = p.user_id
     WHERE p.document_id = ? AND p.user_id <> ? AND p.last_seen > DATE_SUB(NOW(), INTERVAL 2 MINUTE)`,
  [documentId, ctx.user.id]);
  return { others };
}

// -------------------------------------------------------------------- meetings

async function addAgendaItem(ctx, meetingId, { title, duration_min = null, work_package_id = null }) {
  const meeting = await db.one('SELECT * FROM meetings WHERE id = ?', [meetingId]);
  if (!meeting) throw notFound('no such meeting');
  await access.require(ctx.user.id, meeting.project_id, 'manage_meetings');
  // The agenda freezes when the meeting opens. After that, edits go to the
  // minutes — which is not the same thing as being unable to record them.
  if (meeting.state !== 'agenda') {
    throw conflict('this agenda is frozen — the meeting has opened, so this belongs in the minutes');
  }
  const text = String(title || '').trim();
  if (!text) throw badRequest('an agenda item needs a title');
  const position = Number(await db.scalar(
    'SELECT COALESCE(MAX(position), -1) + 1 FROM meeting_agenda_items WHERE meeting_id = ?', [meetingId]
  ));
  const id = await db.insert('meeting_agenda_items', {
    meeting_id: meetingId, position, title: text,
    duration_min: duration_min ? Number(duration_min) : null,
    presenter_id: ctx.user.id, work_package_id: work_package_id || null,
  });
  await notify.record({
    projectId: meeting.project_id, actorId: ctx.user.id, kind: 'meeting',
    verb: 'added an agenda item', targetLabel: meeting.title, detail: text,
  });
  return { id, position };
}

async function recordMinutes(ctx, meetingId, { body, outcomes = [] }) {
  const meeting = await db.one('SELECT * FROM meetings WHERE id = ?', [meetingId]);
  if (!meeting) throw notFound('no such meeting');
  await access.require(ctx.user.id, meeting.project_id, 'manage_meetings');
  const text = String(body || '').trim();
  if (!text) throw badRequest('minutes with no body are not minutes');

  await db.transaction(async (tx) => {
    await tx.run(`
      INSERT INTO meeting_minutes (meeting_id, body, recorded_by)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE body = VALUES(body), recorded_by = VALUES(recorded_by), recorded_at = NOW()`,
    [meetingId, text, ctx.user.id]);
    await tx.update('meetings', meetingId, { state: 'minutes' });
    for (const o of outcomes) {
      if (!o.text) continue;
      await tx.insert('meeting_outcomes', {
        meeting_id: meetingId,
        kind: ['action', 'carried', 'decision'].includes(o.kind) ? o.kind : 'action',
        text: String(o.text).slice(0, 500),
        owner_id: o.owner_id || null,
        work_package_id: o.work_package_id || null,
        carried_to: o.carried_to || null,
      });
    }
    await notify.record({
      projectId: meeting.project_id, actorId: ctx.user.id, kind: 'meeting',
      verb: 'recorded minutes', targetLabel: meeting.title,
      detail: `${outcomes.length} outcome(s) recorded`,
    }, tx);
    const participants = await tx.query('SELECT user_id FROM meeting_participants WHERE meeting_id = ?', [meetingId]);
    for (const p of participants) {
      await notify.notify({
        userId: p.user_id, kind: 'comment', actorId: ctx.user.id,
        title: `Minutes recorded — ${meeting.title}`,
        detail: text.slice(0, 300), projectId: meeting.project_id,
      }, tx);
    }
  });
  return { state: 'minutes' };
}

// ------------------------------------------------------ notifications and prefs

async function markRead(ctx, ids) {
  if (ids === 'all') {
    const r = await db.run(
      'UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [ctx.user.id]
    );
    return { read: r.affectedRows };
  }
  if (!Array.isArray(ids) || !ids.length) throw badRequest('expected a list of notification ids, or "all"');
  const c = db.inClause(ids);
  const r = await db.run(
    `UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND id IN ${c.sql}`, [ctx.user.id, ...c.params]
  );
  return { read: r.affectedRows };
}

const PREFS = new Set(['highlight_mode', 'start_screen', 'show_ai_summaries', 'theme_id', 'timezone']);

async function setPreferences(ctx, patch) {
  const changes = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!PREFS.has(k)) throw badRequest(`"${k}" is not a preference`);
    changes[k] = k === 'show_ai_summaries' ? (v ? 1 : 0) : v;
  }
  if (changes.highlight_mode && !['none', 'status', 'priority', 'overdue'].includes(changes.highlight_mode)) {
    throw badRequest('highlight mode must be none, status, priority or overdue');
  }
  if (!Object.keys(changes).length) throw badRequest('nothing to change');
  await db.update('users', ctx.user.id, changes);
  return changes;
}

// ---------------------------------------------------------------- allocations

async function setAllocation(ctx, { userId, weekStart, hours, projectId = null, workPackageId = null }) {
  if (projectId) await access.require(ctx.user.id, projectId, 'manage_allocations');
  else if (!ctx.user.is_admin && Number(userId) !== Number(ctx.user.id)) {
    throw forbidden('you may only book your own time without naming a project');
  }
  const monday = require('../domain/scheduling').weekStart(weekStart);
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0 || h > 168) throw badRequest('hours must be between 0 and 168');
  if (h === 0) {
    await db.run(`DELETE FROM resource_allocations WHERE user_id = ? AND week_start = ?
                   AND (work_package_id = ? OR (work_package_id IS NULL AND ? IS NULL))`,
    [userId, monday, workPackageId, workPackageId]);
    return { hours: 0, week_start: monday };
  }
  await db.run(`
    INSERT INTO resource_allocations (user_id, project_id, work_package_id, week_start, hours)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE hours = VALUES(hours), project_id = VALUES(project_id)`,
  [userId, projectId, workPackageId, monday, h]);
  return { hours: h, week_start: monday };
}

// ------------------------------------------------------------- administration

async function setStatusWeight(ctx, statusId, weight) {
  if (!ctx.user.is_admin) throw forbidden('only an administrator changes the progress model');
  const status = await db.one('SELECT * FROM statuses WHERE id = ?', [statusId]);
  if (!status) throw notFound('no such status');
  // null is "excluded from the denominator" and is a legitimate value. It is not
  // the same as 0, and the API accepts both explicitly so that a client cannot
  // mean one and get the other.
  const value = weight === null || weight === 'excluded' ? null : Number(weight);
  if (value !== null && (!Number.isFinite(value) || value < 0 || value > 1)) {
    throw badRequest('a weight is between 0 and 1, or null to exclude the status from the denominator');
  }
  await db.update('statuses', statusId, { progress_weight: value });
  await notify.record({
    actorId: ctx.user.id, kind: 'automation', verb: 'changed a status weight',
    targetLabel: status.label,
    from: status.progress_weight === null ? 'excluded' : String(status.progress_weight),
    to: value === null ? 'excluded' : String(value),
    detail: 'every progress figure in the portfolio is derived from these weights',
  });
  return { id: statusId, weight: value };
}

async function toggleAutomation(ctx, automationId, { enabled, note = null }) {
  if (!ctx.user.is_admin) throw forbidden('only an administrator changes automations');
  const a = await db.one('SELECT * FROM automations WHERE id = ?', [automationId]);
  if (!a) throw notFound('no such automation');
  // Turning one off requires a reason. The seeded overdue escalation is the
  // worked example: without its note, somebody turns it back on in six months
  // and rediscovers why it was off.
  if (!enabled && !note && !a.disabled_note) {
    throw badRequest('say why it is being turned off — the note is what stops it being turned back on blind');
  }
  await db.update('automations', automationId, {
    enabled: enabled ? 1 : 0,
    disabled_note: enabled ? null : (note || a.disabled_note),
  });
  await notify.record({
    actorId: ctx.user.id, kind: 'automation',
    verb: enabled ? 'enabled an automation' : 'disabled an automation',
    targetLabel: a.name, detail: enabled ? null : (note || a.disabled_note),
  });
  return { enabled: Boolean(enabled) };
}

async function saveCustomField(ctx, body) {
  if (!ctx.user.is_admin) throw forbidden('only an administrator changes custom fields');
  const name = String(body.name || '').trim();
  if (!name) throw badRequest('a field needs a name');
  const formats = ['text', 'long_text', 'int', 'decimal', 'date', 'bool', 'list', 'user', 'version'];
  if (!formats.includes(body.field_format)) throw badRequest(`format must be one of ${formats.join(', ')}`);
  if (body.field_format === 'list' && !(Array.isArray(body.possible_values) && body.possible_values.length)) {
    throw badRequest('a list field needs its possible values');
  }
  const row = {
    name,
    field_format: body.field_format,
    customized_type: body.customized_type || 'work_package',
    possible_values: body.possible_values ? JSON.stringify(body.possible_values) : null,
    help_text: body.help_text || null,
    is_required: body.is_required ? 1 : 0,
    is_for_all: body.projects && body.projects.length ? 0 : 1,
    position: Number(body.position) || 0,
  };
  const id = body.id
    ? (await db.update('custom_fields', body.id, row), Number(body.id))
    : await db.insert('custom_fields', row);
  if (body.projects) {
    await db.run('DELETE FROM custom_field_projects WHERE custom_field_id = ?', [id]);
    for (const p of body.projects) {
      await db.run('INSERT INTO custom_field_projects (custom_field_id, project_id) VALUES (?, ?)', [id, p]);
    }
  }
  return { id };
}

async function setCustomValue(ctx, { fieldId, entityType, entityId, value }) {
  const field = await db.one('SELECT * FROM custom_fields WHERE id = ?', [fieldId]);
  if (!field) throw notFound('no such custom field');
  if (field.field_format === 'list') {
    const allowed = db.json(field.possible_values, []) || [];
    if (value !== null && value !== '' && !allowed.includes(value)) {
      throw badRequest(`"${value}" is not one of ${allowed.join(', ')}`);
    }
  }
  if (field.value_regexp && value && !new RegExp(field.value_regexp).test(String(value))) {
    throw badRequest(`"${value}" does not match the pattern for ${field.name}`);
  }
  if (field.is_required && (value === null || value === '')) {
    throw badRequest(`${field.name} is required`);
  }
  await db.run(`
    INSERT INTO custom_values (custom_field_id, customized_type, customized_id, value)
    VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)`,
  [fieldId, entityType, entityId, value === '' ? null : value]);
  return { ok: true };
}

// -------------------------------------------------------------- MCP tokens

async function issueMcpToken(ctx, { name, scope = 'read', projects = null, expiresDays = 90 }) {
  if (!ctx.user.is_admin) throw forbidden('only an administrator issues MCP tokens');
  if (!['read', 'write'].includes(scope)) throw badRequest('scope is read or write');
  const crypto = require('crypto');
  const secret = 'pt_mcp_' + crypto.randomBytes(24).toString('hex');
  const id = await db.insert('mcp_tokens', {
    name: String(name || 'assistant').slice(0, 160),
    token_hash: crypto.createHash('sha256').update(secret).digest('hex'),
    token_hint: secret.slice(-4),
    scope,
    project_scope: projects && projects.length ? JSON.stringify(projects) : null,
    includes_internal: 0,
    created_by: ctx.user.id,
    expires_at: expiresDays
      ? new Date(Date.now() + Number(expiresDays) * 86400000).toISOString().slice(0, 19).replace('T', ' ')
      : null,
  });
  await notify.record({
    actorId: ctx.user.id, kind: 'automation', verb: 'issued an MCP token',
    targetLabel: name, detail: `${scope} scope · internal comments excluded`,
  });
  // Returned once. It is not recoverable from the database, which is the point
  // of storing only the hash.
  return { id, secret, scope };
}

async function revokeMcpToken(ctx, tokenId) {
  if (!ctx.user.is_admin) throw forbidden('only an administrator revokes MCP tokens');
  const t = await db.one('SELECT * FROM mcp_tokens WHERE id = ?', [tokenId]);
  if (!t) throw notFound('no such token');
  await db.update('mcp_tokens', tokenId, { revoked_at: new Date() });
  await notify.record({
    actorId: ctx.user.id, kind: 'automation', verb: 'revoked an MCP token', targetLabel: t.name,
  });
  return { revoked: true };
}

// --------------------------------------------------------------- email intake

/**
 * Turn an inbound email into a work package or a comment.
 *
 * The rules, in order:
 *   * a subject carrying a work package key becomes a comment on it;
 *   * otherwise it becomes a work package in the project named by the address's
 *     plus-suffix (tasks+vw@…), or the default project;
 *   * a sender who is not a member of anything, and whose domain is not on the
 *     allow-list, is rejected WITH THE REASON RECORDED. An intake that silently
 *     drops mail is an intake nobody trusts twice.
 */
async function receiveEmail(payload) {
  const from = String(payload.from || '').toLowerCase().trim();
  const to = String(payload.to || '').toLowerCase().trim();
  const subjectLine = String(payload.subject || '').trim();
  const body = String(payload.body || '');
  const messageId = payload.message_id || `<${Date.now()}.${Math.random().toString(36).slice(2)}@intake>`;

  const integration = await db.one("SELECT * FROM integrations WHERE kind = 'email' AND state = 'connected' LIMIT 1");
  const config = integration ? db.json(integration.config, {}) : {};
  const allowList = config.allow_list || [];

  const intakeId = await db.insert('email_intake', {
    message_id: messageId, from_email: from, to_email: to,
    subject: subjectLine || null, body, state: 'pending',
  });

  const sender = await db.one('SELECT id, name FROM users WHERE LOWER(email) = ? AND active = 1', [from]);
  const domain = from.split('@')[1] || '';
  if (!sender && !allowList.includes(domain)) {
    await db.update('email_intake', intakeId, {
      state: 'rejected',
      reason: `sender is not a member of any project and ${domain || 'the sender domain'} is not on the allow-list`,
    });
    return { state: 'rejected', id: intakeId };
  }

  const keyMatch = /\bWP-(\d+)\b/i.exec(subjectLine);
  if (keyMatch) {
    const wp = await db.one('SELECT id, project_id, wp_key FROM work_packages WHERE id = ?', [Number(keyMatch[1])]);
    if (wp) {
      await db.insert('comments', {
        container_type: 'work_package', container_id: wp.id,
        author_id: sender ? sender.id : null, internal: 0,
        body: `${body}\n\n— received by email from ${from}`,
      });
      await db.update('email_intake', intakeId, {
        state: 'commented', project_id: wp.project_id, work_package_id: wp.id,
      });
      await notify.record({
        projectId: wp.project_id, workPackageId: wp.id,
        actorId: sender ? sender.id : null,
        actorLabel: sender ? null : `email · ${from}`,
        kind: 'comment', verb: 'commented by email', targetLabel: wp.wp_key,
        detail: body.slice(0, 300),
      });
      return { state: 'commented', id: intakeId, work_package_id: wp.id };
    }
  }

  const suffix = (to.split('@')[0] || '').split('+')[1];
  const project = suffix
    ? await db.one('SELECT id, code FROM projects WHERE identifier = ? OR code = ?', [suffix, suffix.toUpperCase()])
    : await db.one('SELECT id, code FROM projects WHERE archived = 0 ORDER BY id LIMIT 1');
  if (!project) {
    await db.update('email_intake', intakeId, { state: 'rejected', reason: 'no project to file it in' });
    return { state: 'rejected', id: intakeId };
  }

  const typeId = await db.scalar("SELECT id FROM work_package_types WHERE name = 'TASK'");
  const statusId = await db.scalar('SELECT id FROM statuses WHERE is_default = 1 LIMIT 1');
  const priorityId = await db.scalar('SELECT id FROM priorities WHERE is_default = 1 LIMIT 1');
  const wpId = await db.insert('work_packages', {
    project_id: project.id, type_id: typeId,
    subject: (subjectLine || `Email from ${from}`).slice(0, 400),
    description: `${body}\n\n— created from email from ${from}`,
    status_id: statusId, priority_id: priorityId,
    author_id: sender ? sender.id : null,
    accountable_id: sender ? sender.id : null,
  });
  await db.update('email_intake', intakeId, { state: 'created', project_id: project.id, work_package_id: wpId });
  await notify.record({
    projectId: project.id, workPackageId: wpId,
    actorId: sender ? sender.id : null,
    actorLabel: sender ? null : `email · ${from}`,
    kind: 'status', verb: 'created by email', targetLabel: `WP-${wpId}`,
    detail: subjectLine.slice(0, 300),
  });
  return { state: 'created', id: intakeId, work_package_id: wpId, project: project.code };
}

module.exports = {
  createProject, decideInitiation, setFavourite, setHealth, takeBaseline, closeSprint,
  moveCard, reorderBacklog, saveDocument, touchPresence, addAgendaItem, recordMinutes,
  markRead, setPreferences, setAllocation, setStatusWeight, toggleAutomation,
  saveCustomField, setCustomValue, issueMcpToken, revokeMcpToken, receiveEmail,
};
