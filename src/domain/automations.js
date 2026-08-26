/**
 * Custom actions.
 *
 * An automation is a trigger plus an action, both stored as rows, and it runs on
 * the server. Three properties are non-negotiable and each has a cost attached:
 *
 *  1. IT WRITES TO THE ACTIVITY FEED LIKE A PERSON WOULD, tagged with the
 *     automation's name as the actor. An automated change indistinguishable from
 *     a human one is a change nobody can explain a week later.
 *
 *  2. EVERY RUN IS RECORDED, including the ones that did nothing. `skipped` with
 *     a reason is the useful outcome: "the automation is on and chose not to
 *     act" and "the automation never fired" look identical without it.
 *
 *  3. AN AUTOMATION NEVER TRIGGERS AN AUTOMATION. `dispatch` takes a depth and
 *     refuses to recurse. Two automations that each close the other's parent
 *     would otherwise run until the connection pool ran out, and the failure
 *     would look like a database problem.
 */

'use strict';

const db = require('../db');
const notify = require('./notify');

const MAX_DEPTH = 1;

/** Automations enabled for a project and listening for `triggerKind`. */
async function listening(triggerKind, projectId) {
  return db.query(`
    SELECT a.* FROM automations a
     WHERE a.enabled = 1 AND a.trigger_kind = ?
       AND (a.scope = 'all'
            OR EXISTS (SELECT 1 FROM automation_projects ap
                        WHERE ap.automation_id = a.id AND ap.project_id = ?))
     ORDER BY a.id`, [triggerKind, projectId]);
}

/**
 * Fire every automation listening for `triggerKind`.
 *
 * `event` carries whatever the action needs: { projectId, workPackageId,
 * actorId, fromStatus, toStatus, phaseId, sprintId }. Returns the run records.
 */
async function dispatch(triggerKind, event, { depth = 0 } = {}) {
  if (depth > MAX_DEPTH) return [];
  const automations = await listening(triggerKind, event.projectId);
  const runs = [];
  for (const a of automations) {
    let outcome = 'skipped';
    let detail = 'no matching work';
    try {
      const result = await ACTIONS[a.action_kind](a, event, { depth });
      outcome = result.changed ? 'applied' : 'skipped';
      detail = result.detail;
      if (result.changed) {
        await notify.record({
          projectId: event.projectId,
          workPackageId: event.workPackageId || null,
          actorLabel: `automation · ${a.name}`,
          kind: 'automation',
          verb: 'ran',
          detail: result.detail,
        });
      }
    } catch (e) {
      outcome = 'failed';
      detail = e.message.slice(0, 500);
    }
    const runId = await db.insert('automation_runs', {
      automation_id: a.id,
      work_package_id: event.workPackageId || null,
      project_id: event.projectId || null,
      outcome,
      detail,
    });
    await db.run(
      'UPDATE automations SET run_count = run_count + 1, last_run_at = NOW() WHERE id = ?', [a.id]
    );
    runs.push({ id: runId, automation: a.name, outcome, detail });
  }
  return runs;
}

const ACTIONS = {
  /**
   * A gate was signed: close the work packages belonging to the phase that just
   * closed, and nothing else. It does not open the next phase's work, because
   * "open" is not a state a work package has — its status is somebody's call.
   */
  close_phase_work: async (a, event) => {
    if (!event.phaseName) return { changed: false, detail: 'no phase named in the event' };
    const done = await db.scalar("SELECT id FROM statuses WHERE code = 'done'");
    const rows = await db.query(`
      SELECT wp.id, wp.wp_key FROM work_packages wp
        JOIN work_package_types t ON t.id = wp.type_id
        JOIN statuses s ON s.id = wp.status_id
       WHERE wp.project_id = ? AND t.name = 'PHASE' AND s.is_closed = 0 AND wp.subject LIKE ?`,
    [event.projectId, `%${event.phaseName}%`]);
    if (!rows.length) return { changed: false, detail: `no open PHASE work matching "${event.phaseName}"` };
    for (const r of rows) {
      await db.run('UPDATE work_packages SET status_id = ?, closed_at = NOW() WHERE id = ?', [done, r.id]);
    }
    return { changed: true, detail: `closed ${rows.map((r) => r.wp_key).join(', ')} on the gate` };
  },

  /**
   * Something closed: if its parent now has no open children, close the parent.
   *
   * Only one level. A cascade all the way to the phase would close a phase
   * because its last epic finished, and a phase closes when its gate is signed,
   * not when its work runs out.
   */
  close_parent: async (a, event) => {
    if (!event.workPackageId) return { changed: false, detail: 'no work package in the event' };
    const wp = await db.one('SELECT parent_id, project_id FROM work_packages WHERE id = ?', [event.workPackageId]);
    if (!wp || !wp.parent_id) return { changed: false, detail: 'no parent' };
    const openKids = Number(await db.scalar(`
      SELECT COUNT(*) FROM work_packages wp JOIN statuses s ON s.id = wp.status_id
       WHERE wp.parent_id = ? AND s.is_closed = 0`, [wp.parent_id]));
    if (openKids > 0) return { changed: false, detail: `${openKids} sibling(s) still open` };
    const parent = await db.one(`
      SELECT wp.id, wp.wp_key, s.is_closed FROM work_packages wp
        JOIN statuses s ON s.id = wp.status_id WHERE wp.id = ?`, [wp.parent_id]);
    if (!parent || parent.is_closed) return { changed: false, detail: 'parent already closed' };
    const done = await db.scalar("SELECT id FROM statuses WHERE code = 'done'");
    await db.run('UPDATE work_packages SET status_id = ?, closed_at = NOW() WHERE id = ?', [done, parent.id]);
    return { changed: true, detail: `closed ${parent.wp_key}: no open children left` };
  },

  /** Overdue escalation: raise the priority and tell whoever is accountable. */
  raise_priority: async (a, event) => {
    const cfg = db.json(a.trigger_config, {}) || {};
    const action = db.json(a.action_config, {}) || {};
    const days = Number(cfg.days) || 3;
    const to = action.to || 'high';
    const target = await db.scalar('SELECT id FROM priorities WHERE code = ?', [to]);
    if (!target) return { changed: false, detail: `no priority "${to}"` };
    const rows = await db.query(`
      SELECT wp.id, wp.wp_key, wp.subject, wp.accountable_id, wp.project_id, pr.position
        FROM work_packages wp
        JOIN statuses s ON s.id = wp.status_id
        JOIN priorities pr ON pr.id = wp.priority_id
       WHERE s.is_closed = 0 AND wp.due_date < DATE_SUB(CURDATE(), INTERVAL ? DAY)
         AND wp.priority_id <> ?
         AND pr.position < (SELECT position FROM priorities WHERE id = ?)
         ${event.projectId ? 'AND wp.project_id = ?' : ''}
       LIMIT 100`, event.projectId ? [days, target, target, event.projectId] : [days, target, target]);
    if (!rows.length) return { changed: false, detail: `nothing overdue by more than ${days} days` };
    for (const r of rows) {
      await db.run('UPDATE work_packages SET priority_id = ? WHERE id = ?', [target, r.id]);
      await notify.notify({
        userId: r.accountable_id, kind: 'automation',
        title: `Priority raised to ${to.toUpperCase()}`,
        detail: `${r.wp_key} · ${r.subject} — overdue by more than ${days} days`,
        actorLabel: a.name, projectId: r.project_id, workPackageId: r.id,
      });
    }
    return { changed: true, detail: `raised ${rows.length} work package(s) to ${to}` };
  },

  /** Sprint closed: carry the unfinished work into the next sprint. */
  move_sprint: async (a, event) => {
    if (!event.sprintId) return { changed: false, detail: 'no sprint in the event' };
    const closing = await db.one('SELECT * FROM sprints WHERE id = ?', [event.sprintId]);
    if (!closing) return { changed: false, detail: 'sprint not found' };
    const next = await db.one(`
      SELECT id, code FROM sprints
       WHERE start_date > ? AND state <> 'closed'
       ORDER BY start_date LIMIT 1`, [closing.end_date]);
    if (!next) return { changed: false, detail: 'no later sprint to carry into' };
    const rows = await db.query(`
      SELECT wp.id, wp.wp_key FROM work_packages wp JOIN statuses s ON s.id = wp.status_id
       WHERE wp.sprint_id = ? AND s.is_closed = 0`, [event.sprintId]);
    if (!rows.length) return { changed: false, detail: 'everything in the sprint is closed' };
    for (const r of rows) await db.run('UPDATE work_packages SET sprint_id = ? WHERE id = ?', [next.id, r.id]);
    return { changed: true, detail: `carried ${rows.length} work package(s) into ${next.code}` };
  },

  /**
   * Re-read the repository and refresh what is derived from it.
   *
   * The SeedFall tracker's re-ingest is a markdown parse; here the equivalent
   * honest action is to recount the documents, which is the only thing this app
   * derives from text. It does not pretend to have pulled a repository it has no
   * credential for.
   */
  reingest: async (a, event) => {
    const docs = await db.query('SELECT id, body FROM documents WHERE project_id = ?', [event.projectId]);
    if (!docs.length) return { changed: false, detail: 'no documents in this project' };
    let changed = 0;
    for (const d of docs) {
      const body = String(d.body || '');
      const words = body.trim() ? body.trim().split(/\s+/).length : 0;
      const sections = (body.match(/^#{1,6} /gm) || []).length;
      const affected = await db.run(
        'UPDATE documents SET word_count = ?, section_count = ? WHERE id = ? AND (word_count <> ? OR section_count <> ?)',
        [words, sections, d.id, words, sections]
      );
      changed += affected.affectedRows;
    }
    return changed
      ? { changed: true, detail: `refreshed counts on ${changed} document(s)` }
      : { changed: false, detail: 'every document count was already correct' };
  },

  set_status: async (a, event) => {
    const cfg = db.json(a.action_config, {}) || {};
    if (!event.workPackageId || !cfg.status) return { changed: false, detail: 'nothing to set' };
    const to = await db.scalar('SELECT id FROM statuses WHERE code = ?', [cfg.status]);
    if (!to) return { changed: false, detail: `no status "${cfg.status}"` };
    const r = await db.run('UPDATE work_packages SET status_id = ? WHERE id = ? AND status_id <> ?',
      [to, event.workPackageId, to]);
    return r.affectedRows
      ? { changed: true, detail: `set status to ${cfg.status}` }
      : { changed: false, detail: 'already at that status' };
  },

  set_version: async (a, event) => {
    const cfg = db.json(a.action_config, {}) || {};
    if (!event.workPackageId || !cfg.version) return { changed: false, detail: 'nothing to set' };
    const v = await db.scalar('SELECT id FROM versions WHERE code = ? AND project_id = ?',
      [cfg.version, event.projectId]);
    if (!v) return { changed: false, detail: `no version "${cfg.version}" in this project` };
    const r = await db.run('UPDATE work_packages SET version_id = ? WHERE id = ? AND (version_id IS NULL OR version_id <> ?)',
      [v, event.workPackageId, v]);
    return r.affectedRows ? { changed: true, detail: `set version ${cfg.version}` } : { changed: false, detail: 'already set' };
  },

  add_comment: async (a, event) => {
    const cfg = db.json(a.action_config, {}) || {};
    if (!event.workPackageId || !cfg.body) return { changed: false, detail: 'nothing to say' };
    await db.insert('comments', {
      container_type: 'work_package', container_id: event.workPackageId,
      author_id: null, internal: cfg.internal ? 1 : 0, body: cfg.body,
    });
    return { changed: true, detail: 'added a comment' };
  },

  notify: async (a, event) => {
    const cfg = db.json(a.action_config, {}) || {};
    const audience = event.workPackageId ? await notify.audienceFor(event.workPackageId) : [];
    if (!audience.length) return { changed: false, detail: 'nobody to tell' };
    for (const u of audience) {
      await notify.notify({
        userId: u.id, kind: 'automation',
        title: cfg.title || a.name, detail: cfg.detail || null,
        actorLabel: a.name, projectId: event.projectId, workPackageId: event.workPackageId,
      });
    }
    return { changed: true, detail: `notified ${audience.length} person(s)` };
  },
};

module.exports = { dispatch, listening, ACTIONS, MAX_DEPTH };
