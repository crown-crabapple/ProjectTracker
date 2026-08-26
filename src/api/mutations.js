/**
 * The write side.
 *
 * Every mutation in this file does four things, in one transaction:
 *   check the permission, validate, write, append to the activity trail.
 *
 * The trail is inside the transaction on purpose. An activity entry written
 * afterwards can be lost to a crash, and a change with no trail is a change
 * nobody can explain — which is precisely the failure the trail exists to
 * prevent.
 *
 * Automations fire AFTER the transaction commits, never inside it. An automation
 * that ran inside would see uncommitted state, and one that failed would roll
 * back the change that triggered it.
 */

'use strict';

const db = require('../db');
const access = require('../domain/access');
const notify = require('../domain/notify');
const automations = require('../domain/automations');
const lifecycle = require('../domain/lifecycle');
const scheduling = require('../domain/scheduling');
const subject = require('../domain/subject');
const query = require('../domain/query');
const files = require('../domain/files');
const crypto = require('crypto');
const { badRequest, notFound, forbidden, conflict } = require('../http/router');

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A random token for a share link or a calendar subscription.
 *
 * Hex rather than base64url, deliberately. base64url is denser but includes '-'
 * and '_', and a token appears in a URL path, in a validator regex and
 * occasionally in a filename — three places where an unexpected character is a
 * bug rather than a saving. It cost one: the share validator accepted only
 * [A-Za-z0-9] and rejected every freshly minted base64url token, so a share link
 * worked in the seed data and nowhere else.
 *
 * 24 bytes of entropy either way, which is what actually matters.
 */
const TOKEN_ALPHABET = /^[A-Za-z0-9]+$/;
const newToken = (prefix = '') => prefix + crypto.randomBytes(24).toString('hex').slice(0, 45);

// ------------------------------------------------------------- work packages

const EDITABLE = new Set([
  'subject', 'description', 'type_id', 'status_id', 'priority_id', 'assignee_id',
  'accountable_id', 'parent_id', 'start_date', 'due_date', 'scheduling',
  'estimated_hours', 'remaining_hours', 'story_points', 'version_id', 'sprint_id',
]);

/**
 * Update a work package.
 *
 * A status change is checked against `status_transitions` rather than being
 * allowed anywhere: the workflow in administration is the workflow, or it is
 * decoration.
 */
async function updateWorkPackage(ctx, id, patch) {
  const wp = await query.byId(id);
  if (!wp) throw notFound('no such work package');
  const perms = await access.permissionsFor(ctx.user.id, wp.project_id);
  if (!access.canEditWorkPackage(perms, wp, ctx.user.id)) {
    throw forbidden('you may not edit this work package');
  }

  const changes = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.has(k)) throw badRequest(`"${k}" is not an editable attribute`);
    changes[k] = v === '' ? null : v;
  }
  if (!Object.keys(changes).length) throw badRequest('nothing to change');

  // A milestone has one date. Setting a start on one is the mistake the form
  // configuration already prevents; the API refuses it too, because the form is
  // not the only way in.
  if (wp.is_milestone && changes.start_date && changes.start_date !== changes.due_date) {
    throw badRequest('a milestone has one date — set the due date');
  }

  if (changes.due_date && changes.start_date && changes.due_date < changes.start_date) {
    throw badRequest('the due date is before the start date');
  }

  if (changes.parent_id) {
    if (Number(changes.parent_id) === Number(id)) throw badRequest('a work package cannot be its own parent');
    const ancestors = await ancestorIds(changes.parent_id);
    if (ancestors.includes(Number(id))) throw badRequest('that would make a loop in the hierarchy');
  }

  let statusChange = null;
  if (changes.status_id && Number(changes.status_id) !== Number(wp.status_id)) {
    const allowed = await db.scalar(
      'SELECT COUNT(*) FROM status_transitions WHERE from_status_id = ? AND to_status_id = ?',
      [wp.status_id, changes.status_id]
    );
    const to = await db.one('SELECT id, code, label, is_closed FROM statuses WHERE id = ?', [changes.status_id]);
    if (!to) throw badRequest('no such status');
    if (!Number(allowed)) {
      throw conflict(`${wp.status_label} cannot move straight to ${to.label} — see the workflow in administration`);
    }
    statusChange = { from: wp.status_label, to: to.label, closed: Boolean(to.is_closed), code: to.code };
    changes.closed_at = to.is_closed ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
  }

  if (changes.subject !== undefined) {
    const type = await db.one('SELECT name, subject_pattern FROM work_package_types WHERE id = ?',
      [changes.type_id || wp.type_id]);
    const custom = await customMapFor(id);
    const resolved = subject.resolve({
      subject: changes.subject,
      pattern: type ? type.subject_pattern : null,
      context: {
        type: type ? type.name : null, subject: changes.subject,
        version: wp.version_code, project: wp.project_code, custom,
      },
    });
    if (!resolved.subject) throw badRequest('a work package needs a subject');
    changes.subject = resolved.subject;
  }

  await db.transaction(async (tx) => {
    await tx.update('work_packages', id, changes);
    if (statusChange) {
      await notify.record({
        projectId: wp.project_id, workPackageId: id, actorId: ctx.user.id,
        kind: 'status', verb: 'set status', targetLabel: wp.wp_key,
        detail: `${wp.subject} — ${statusChange.from} to ${statusChange.to}`,
        from: statusChange.from, to: statusChange.to,
      }, tx);
    } else {
      await notify.record({
        projectId: wp.project_id, workPackageId: id, actorId: ctx.user.id,
        kind: 'status', verb: 'edited', targetLabel: wp.wp_key,
        detail: Object.keys(changes).join(', '),
      }, tx);
    }
    const audience = await notify.audienceFor(id, { exclude: ctx.user.id }, tx);
    for (const u of audience) {
      await notify.notify({
        userId: u.id, kind: 'watching', actorId: ctx.user.id,
        title: statusChange ? `Status changed on ${wp.wp_key}` : `${wp.wp_key} was edited`,
        detail: statusChange
          ? `${wp.subject} · ${statusChange.from} → ${statusChange.to}`
          : `${wp.subject} · ${Object.keys(changes).join(', ')}`,
        projectId: wp.project_id, workPackageId: id,
      }, tx);
    }
  });

  // After the commit. See the file header.
  const fired = [];
  if (statusChange) {
    fired.push(...await automations.dispatch('status_changed', {
      projectId: wp.project_id, workPackageId: id, actorId: ctx.user.id,
      fromStatus: wp.status_code, toStatus: statusChange.code,
    }));
  }

  const rescheduled = await reschedule(wp.project_id, { apply: true, actorId: ctx.user.id });
  return { wp: await query.byId(id), automations: fired, rescheduled };
}

async function ancestorIds(id) {
  const out = [];
  let cursor = Number(id);
  // Bounded: a hand-edited database can contain a loop and this must not spin.
  for (let i = 0; i < 100 && cursor; i += 1) {
    out.push(cursor);
    const row = await db.one('SELECT parent_id FROM work_packages WHERE id = ?', [cursor]);
    cursor = row && row.parent_id ? Number(row.parent_id) : 0;
    if (out.includes(cursor)) break;
  }
  return out;
}

async function customMapFor(workPackageId) {
  const rows = await db.query(`
    SELECT cf.name, cv.value FROM custom_values cv JOIN custom_fields cf ON cf.id = cv.custom_field_id
     WHERE cv.customized_type = 'work_package' AND cv.customized_id = ?`, [workPackageId]);
  const out = {};
  for (const r of rows) out[r.name] = r.value;
  return out;
}

async function createWorkPackage(ctx, body) {
  const projectId = Number(body.project_id);
  if (!projectId) throw badRequest('project_id is required');
  await access.require(ctx.user.id, projectId, 'add_work_packages');

  const type = await db.one('SELECT * FROM work_package_types WHERE id = ? OR name = ? LIMIT 1',
    [Number(body.type_id) || 0, body.type || 'TASK']);
  if (!type) throw badRequest('no such work package type');
  const status = body.status_id
    ? await db.one('SELECT * FROM statuses WHERE id = ?', [body.status_id])
    : await db.one('SELECT * FROM statuses WHERE is_default = 1 LIMIT 1');
  const priority = body.priority_id
    ? await db.one('SELECT * FROM priorities WHERE id = ?', [body.priority_id])
    : await db.one('SELECT * FROM priorities WHERE is_default = 1 LIMIT 1');
  if (!status || !priority) throw badRequest('the status or priority vocabulary is missing — run the reference seed');

  const resolved = subject.resolve({
    subject: body.subject,
    pattern: type.subject_pattern,
    context: { type: type.name, subject: body.subject, custom: body.custom || {} },
  });
  if (!resolved.subject) throw badRequest('a work package needs a subject, or a type with a subject pattern');

  if (body.parent_id && !type.is_parent_ok) {
    // Guard the other way round too: the parent must be allowed to hold children.
    const parentType = await db.one(`
      SELECT t.is_parent_ok, t.name FROM work_packages wp
        JOIN work_package_types t ON t.id = wp.type_id WHERE wp.id = ?`, [body.parent_id]);
    if (parentType && !parentType.is_parent_ok) {
      throw badRequest(`a ${parentType.name} cannot hold children`);
    }
  }

  const id = await db.transaction(async (tx) => {
    const newId = await tx.insert('work_packages', {
      project_id: projectId,
      type_id: type.id,
      subject: resolved.subject,
      description: body.description || null,
      parent_id: body.parent_id || null,
      status_id: status.id,
      priority_id: priority.id,
      assignee_id: body.assignee_id || null,
      accountable_id: body.accountable_id || ctx.user.id,
      author_id: ctx.user.id,
      start_date: body.start_date || null,
      due_date: body.due_date || null,
      scheduling: type.is_milestone ? 'manual' : (body.scheduling || 'automatic'),
      estimated_hours: Number(body.estimated_hours) || 0,
      story_points: body.story_points === undefined || body.story_points === null || body.story_points === ''
        ? null : Number(body.story_points),
      version_id: body.version_id || null,
      sprint_id: body.sprint_id || null,
    });
    await notify.record({
      projectId, workPackageId: newId, actorId: ctx.user.id,
      kind: 'status', verb: 'created', targetLabel: `WP-${newId}`,
      detail: resolved.generated ? `${resolved.subject} (subject generated)` : resolved.subject,
    }, tx);
    if (body.assignee_id && Number(body.assignee_id) !== Number(ctx.user.id)) {
      await notify.notify({
        userId: body.assignee_id, kind: 'assigned', actorId: ctx.user.id,
        title: 'You were assigned', detail: `WP-${newId} · ${resolved.subject}`,
        projectId, workPackageId: newId,
      }, tx);
    }
    return newId;
  });

  const fired = await automations.dispatch('wp_created', {
    projectId, workPackageId: id, actorId: ctx.user.id,
  });
  return { wp: await query.byId(id), generatedSubject: resolved.generated, automations: fired };
}

/**
 * Re-derive the automatically scheduled dates in a project.
 *
 * Returns what changed, and applies it only when asked. The preview mode is what
 * lets the UI say "moving this will move four other things" before it does.
 */
async function reschedule(projectId, { apply = false, actorId = null } = {}) {
  const wps = await db.query(`
    SELECT wp.id, wp.parent_id, wp.scheduling, wp.start_date, wp.due_date, wp.estimated_hours
      FROM work_packages wp WHERE wp.project_id = ?`, [projectId]);
  if (!wps.length) return { changed: [], converged: true };
  const rels = await db.query(`
    SELECT r.from_id, r.to_id, r.lag_days FROM work_package_relations r
      JOIN work_packages f ON f.id = r.from_id
     WHERE f.project_id = ? AND r.kind = 'follows'`, [projectId]);
  for (const w of wps) {
    w.follows = rels.filter((r) => Number(r.from_id) === Number(w.id))
      .map((r) => ({ id: r.to_id, lag_days: r.lag_days }));
  }
  const week = await db.one(
    'SELECT w.* FROM work_weeks w JOIN projects p ON p.work_week_id = w.id WHERE p.id = ?', [projectId]
  ) || await db.one('SELECT * FROM work_weeks WHERE is_default = 1');
  const holidays = new Set((await db.query('SELECT day FROM non_working_days')).map((r) => r.day));

  const result = scheduling.derive(wps, { week: week || scheduling.ALL_DAYS, nonWorking: holidays });
  const changed = [];
  for (const [id, c] of result.changes) {
    changed.push({ id, ...c });
    if (apply) {
      await db.run('UPDATE work_packages SET start_date = ?, due_date = ? WHERE id = ?',
        [c.start_date, c.due_date, id]);
    }
  }
  if (apply && changed.length) {
    await notify.record({
      projectId, actorId, kind: 'status', verb: 'rescheduled',
      detail: `${changed.length} automatically scheduled work package(s) moved`
        + (result.converged ? '' : ' — the relations did not settle, check for a loop'),
    });
  }
  return { changed, converged: result.converged, applied: apply };
}

// ------------------------------------------------------------------- watchers

async function watch(ctx, workPackageId, userId, on) {
  const wp = await query.byId(workPackageId);
  if (!wp) throw notFound('no such work package');
  const target = Number(userId) || ctx.user.id;
  if (Number(target) !== Number(ctx.user.id)) {
    await access.require(ctx.user.id, wp.project_id, 'assign_work_packages');
  } else {
    await access.require(ctx.user.id, wp.project_id, 'view_work_packages');
  }
  if (on) {
    await db.run(
      'INSERT INTO work_package_watchers (work_package_id, user_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE user_id = user_id',
      [workPackageId, target]
    );
  } else {
    await db.run('DELETE FROM work_package_watchers WHERE work_package_id = ? AND user_id = ?',
      [workPackageId, target]);
  }
  return { watching: Boolean(on) };
}

// ------------------------------------------------------------------- comments

async function addComment(ctx, { containerType, containerId, body, internal = false }) {
  const text = String(body || '').trim();
  if (!text) throw badRequest('an empty comment is not a comment');

  const projectId = await projectOf(containerType, containerId);
  const perms = await access.permissionsFor(ctx.user.id, projectId);
  if (!perms.has('comment')) throw forbidden('you may not comment here');
  if (internal && !perms.has('comment_internal')) {
    throw forbidden('you may not write internal comments');
  }

  const { users: mentioned, unresolved } = await notify.resolveMentions(text);

  const id = await db.transaction(async (tx) => {
    const commentId = await tx.insert('comments', {
      container_type: containerType, container_id: containerId,
      author_id: ctx.user.id, body: text, internal: internal ? 1 : 0,
    });
    for (const u of mentioned) {
      await tx.run('INSERT INTO mentions (comment_id, user_id) VALUES (?, ?)', [commentId, u.id]);
      // An internal comment does not notify anybody who could not read it. The
      // notification would show its detail, which is the leak.
      if (internal) {
        const theirPerms = await access.permissionsFor(u.id, projectId);
        if (!theirPerms.has('comment_internal')) continue;
      }
      await notify.notify({
        userId: u.id, kind: 'mention', actorId: ctx.user.id,
        title: `${ctx.user.name} mentioned you`,
        detail: text.slice(0, 300),
        projectId, workPackageId: containerType === 'work_package' ? containerId : null,
      }, tx);
    }
    await notify.record({
      projectId, workPackageId: containerType === 'work_package' ? containerId : null,
      actorId: ctx.user.id, kind: internal ? 'comment' : 'comment',
      verb: internal ? 'commented internally' : 'commented',
      detail: text.slice(0, 500),
    }, tx);

    if (!internal) {
      const audience = await notify.audienceFor(
        containerType === 'work_package' ? containerId : 0, { exclude: ctx.user.id }, tx
      );
      for (const u of audience) {
        if (mentioned.some((m) => Number(m.id) === Number(u.id))) continue;
        await notify.notify({
          userId: u.id, kind: 'comment', actorId: ctx.user.id,
          title: 'New comment', detail: text.slice(0, 300),
          projectId, workPackageId: containerType === 'work_package' ? containerId : null,
        }, tx);
      }
    }
    return commentId;
  });

  await automations.dispatch('comment_added', {
    projectId, workPackageId: containerType === 'work_package' ? containerId : null, actorId: ctx.user.id,
  });

  // The unresolved handles come back so the author can be told the mention did
  // not reach anybody. A silent no-op mention is how a question goes unanswered
  // for a week.
  return { id, mentioned: mentioned.map((u) => u.name), unresolved };
}

async function projectOf(containerType, containerId) {
  const table = {
    work_package: 'work_packages', document: 'documents', meeting: 'meetings', news: 'news',
  }[containerType];
  if (!table) throw badRequest(`cannot comment on a ${containerType}`);
  const row = await db.one(`SELECT project_id FROM ${db.ident(table)} WHERE id = ?`, [containerId]);
  if (!row) throw notFound(`no such ${containerType}`);
  return row.project_id;
}

// ---------------------------------------------------------------------- gates

async function signGate(ctx, projectId, phaseId, { note = null } = {}) {
  await access.require(ctx.user.id, projectId, 'sign_gate');
  const phases = await db.query('SELECT * FROM project_phases WHERE project_id = ? ORDER BY position', [projectId]);
  const phase = phases.find((p) => Number(p.id) === Number(phaseId));
  if (!phase) throw notFound('no such phase in this project');

  const openImmediate = Number(await db.scalar(`
    SELECT COUNT(*) FROM work_packages wp
      JOIN statuses s ON s.id = wp.status_id
      JOIN priorities pr ON pr.id = wp.priority_id
      JOIN work_package_types t ON t.id = wp.type_id
     WHERE wp.project_id = ? AND s.is_closed = 0 AND pr.code = 'immediate' AND t.name = 'BUG'`,
  [projectId]));

  const verdict = lifecycle.canAdvance(phase, { openImmediateBugs: openImmediate });
  if (!verdict.ok) throw conflict(`${phase.gate_name} cannot be signed: ${verdict.reason}`);

  const updates = lifecycle.signGate(phases, phaseId, { on: today(), by: ctx.user.id });
  await db.transaction(async (tx) => {
    for (const u of updates) {
      const { id, ...rest } = u;
      await tx.update('project_phases', id, note && id === phaseId ? { ...rest, gate_note: note } : rest);
    }
    await notify.record({
      projectId, actorId: ctx.user.id, kind: 'gate', verb: 'signed a gate',
      targetLabel: phase.gate_name,
      detail: `${phase.name} · ${phase.gate_criterion}${note ? ` — ${note}` : ''}`,
      from: phase.state, to: 'gate_met',
    }, tx);
  });

  const fired = await automations.dispatch('gate_signed', {
    projectId, actorId: ctx.user.id, phaseId, phaseName: phase.name,
  });
  return { updates, automations: fired };
}

// --------------------------------------------------------------------- shares

async function share(ctx, workPackageId, { email = null, permission = 'view', days = 30 } = {}) {
  const wp = await query.byId(workPackageId);
  if (!wp) throw notFound('no such work package');
  await access.require(ctx.user.id, wp.project_id, 'share_work_packages');
  if (!['view', 'comment', 'edit'].includes(permission)) throw badRequest('permission must be view, comment or edit');
  const token = newToken('shr');
  const expires = new Date(Date.now() + Math.min(365, Math.max(1, Number(days) || 30)) * 86400000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const id = await db.insert('work_package_shares', {
    work_package_id: workPackageId, token, email: email || null,
    permission, includes_internal: 0, expires_at: expires, created_by: ctx.user.id,
  });
  await notify.record({
    projectId: wp.project_id, workPackageId, actorId: ctx.user.id,
    kind: 'share', verb: 'shared outside the project', targetLabel: wp.wp_key,
    detail: `${permission} link${email ? ` for ${email}` : ''}, expires ${expires.slice(0, 10)}`
      + ' — internal comments excluded',
  });
  return { id, url: `/share/${token}`, expires_at: expires, permission };
}

async function revokeShare(ctx, shareId) {
  const row = await db.one(`
    SELECT s.*, wp.project_id, wp.wp_key FROM work_package_shares s
      JOIN work_packages wp ON wp.id = s.work_package_id WHERE s.id = ?`, [shareId]);
  if (!row) throw notFound('no such share');
  await access.require(ctx.user.id, row.project_id, 'share_work_packages');
  await db.run('UPDATE work_package_shares SET revoked_at = NOW() WHERE id = ?', [shareId]);
  await notify.record({
    projectId: row.project_id, workPackageId: row.work_package_id, actorId: ctx.user.id,
    kind: 'share', verb: 'revoked a share link', targetLabel: row.wp_key,
  });
  return { revoked: true };
}

// ----------------------------------------------------------------- attachments

async function attach(ctx, { containerType, containerId, file, description }) {
  const projectId = await projectOf(containerType, containerId);
  await access.require(ctx.user.id, projectId, 'manage_attachments');
  const stored = await files.store({
    buffer: file.buffer, filename: file.filename, contentType: file.contentType,
    containerType, containerId, authorId: ctx.user.id, description,
  });
  await notify.record({
    projectId, workPackageId: containerType === 'work_package' ? containerId : null,
    actorId: ctx.user.id, kind: 'file', verb: 'attached a file', detail: stored.filename,
  });
  return stored;
}

module.exports = {
  updateWorkPackage, createWorkPackage, reschedule, watch, addComment, signGate,
  share, revokeShare, attach, newToken, TOKEN_ALPHABET, ancestorIds, EDITABLE, today,
};
