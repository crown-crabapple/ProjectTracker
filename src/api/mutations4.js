/**
 * The write side of decisions: raise one, answer it, link the work that waits
 * on it, and gate one decision on another.
 *
 * Same four steps as `mutations.js` and `mutations3.js`, in the same order —
 * check the permission, validate, write, append to the trail, all in one
 * transaction. `decision_work_packages` and `decision_dependencies` have no
 * surrogate id (their primary key is the pair of foreign keys), so every
 * write to them below goes by hand through `tx.run` rather than through
 * `db.update`, which assumes one.
 *
 * A LINK AND A DEPENDENCY ARE NEVER DELETED. Removing one sets `removed_at`
 * and keeps the row, exactly like a git link: a person deciding a feature no
 * longer waits on a decision is a decision of its own, and worth keeping.
 */

'use strict';

const db = require('../db');
const access = require('../domain/access');
const notify = require('../domain/notify');
const decisions = require('../domain/decisions');
const { badRequest, notFound, forbidden, conflict } = require('../http/router');

/** Who to record as having done this. See `mutations.js` for the argument. */
const actor = (ctx) => ({ actorId: ctx.user.id, actorLabel: ctx.actorLabel || null });

/** `created_by` for a row: null for a machine caller, the person otherwise. */
const excluding = (ctx) => (ctx.actorLabel ? null : ctx.user.id);

const REF_PATTERN = /^[A-Za-z][A-Za-z0-9-]{0,23}$/;

/**
 * Raise a decision.
 *
 * A portfolio-wide one (`project_id` NULL) is not created here, the same
 * restriction `mutations2.createDocument` puts on a portfolio-wide wiki page:
 * there is no project to check `record_decisions` against, so the row is
 * created by insert — `db/demo-data.js`, `db/import-state.js` — where an
 * administrator is doing the inserting directly.
 */
async function createDecision(ctx, input) {
  const projectId = Number(input.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw badRequest('a decision needs a project - a portfolio-wide decision is not raised here');
  }
  await access.require(ctx.user.id, projectId, 'record_decisions');

  const ref = String(input.ref || '').trim();
  if (!REF_PATTERN.test(ref)) {
    throw badRequest(
      `"${ref}" is not a decision ref - one letter to start, then letters, digits or dashes, `
      + 'up to 24 characters - D-14'
    );
  }
  const title = String(input.title || '').trim();
  if (!title) throw badRequest('a decision needs a title, phrased as a question');

  const clash = await db.one('SELECT id FROM decisions WHERE project_id = ? AND ref = ?', [projectId, ref]);
  if (clash) throw conflict(`${ref} is already used in this project`);

  const id = await db.transaction(async (tx) => {
    const newId = await tx.insert('decisions', {
      project_id: projectId,
      ref,
      title,
      question: input.question || null,
      answer: input.answer || null,
      rationale: input.rationale || null,
      owner_id: input.owner_id || null,
      due_on: input.due_on || null,
      document_id: input.document_id || null,
      position: Number(input.position) || 0,
      created_by: excluding(ctx),
      updated_by: excluding(ctx),
    });
    await notify.record({
      projectId, ...actor(ctx), kind: 'decision', verb: 'raised a decision',
      targetLabel: ref, detail: title,
    }, tx);
    return newId;
  });
  return { id, ref, title, state: 'open' };
}

const EDITABLE = new Set([
  'title', 'question', 'answer', 'rationale', 'state', 'owner_id', 'due_on',
  'position', 'document_id', 'superseded_by',
]);

/**
 * Edit a decision, including moving its state.
 *
 * Settling checks `decisions.canSettle` against its live open dependencies
 * first and refuses with the reason it gives; moving to 'settled' records who
 * decided and when, and moving away from 'settled' or 'superseded' back to
 * 'open' clears both, because a reopened decision has not been decided by
 * anybody yet.
 */
async function updateDecision(ctx, id, patch) {
  const decision = await db.one('SELECT * FROM decisions WHERE id = ?', [id]);
  if (!decision) throw notFound('no such decision');
  await access.require(ctx.user.id, decision.project_id, 'record_decisions');

  const changes = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.has(k)) throw badRequest(`"${k}" is not an editable attribute`);
    changes[k] = v === '' ? null : v;
  }
  if (!Object.keys(changes).length) throw badRequest('nothing to change');
  if (changes.state !== undefined && !decisions.STATES.includes(changes.state)) {
    throw badRequest(`state must be one of ${decisions.STATES.join(', ')}`);
  }

  const settling = changes.state === 'settled';
  const reopening = changes.state === 'open' && decision.state !== 'open';

  if (settling) {
    const openDependencies = await db.query(`
      SELECT b.id, b.ref, b.title, b.state
        FROM decision_dependencies dd JOIN decisions b ON b.id = dd.depends_on_id
       WHERE dd.decision_id = ? AND dd.removed_at IS NULL AND b.state = 'open'`, [id]);
    const outcome = decisions.canSettle(decision, openDependencies);
    if (!outcome.ok) throw conflict(outcome.reason);
  }

  await db.transaction(async (tx) => {
    await tx.update('decisions', id, { ...changes, updated_by: excluding(ctx) });
    if (settling) {
      await tx.run('UPDATE decisions SET decided_by = ?, decided_at = NOW() WHERE id = ?', [ctx.user.id, id]);
    } else if (reopening) {
      await tx.run('UPDATE decisions SET decided_by = NULL, decided_at = NULL WHERE id = ?', [id]);
    }
    const verb = settling ? 'settled a decision'
      : reopening ? 're-opened a decision'
        : changes.state === 'superseded' ? 'superseded a decision'
          : 'edited a decision';
    await notify.record({
      projectId: decision.project_id, ...actor(ctx), kind: 'decision', verb,
      targetLabel: decision.ref, detail: Object.keys(changes).join(', '),
    }, tx);
  });

  return { id: Number(id), ...changes };
}

/**
 * Link work to a decision, or revive a link this endpoint itself removed.
 *
 * Every call through here is a person acting — from the browser, or from an
 * MCP write tool running as one — because nothing automated calls it: a
 * matcher, were one ever built, would write through its own path the way the
 * git deck's puller writes through `mirror.js` rather than through
 * `mutations3.linkWorkPackage`. `origin` defaults to 'person' and a link a
 * person removed is only ever revived when the caller is still one; the
 * refusal below is what keeps that true rather than merely documented.
 */
async function linkWork(ctx, decisionId, input = {}) {
  const decision = await db.one('SELECT id, project_id, ref FROM decisions WHERE id = ?', [decisionId]);
  if (!decision) throw notFound('no such decision');
  await access.require(ctx.user.id, decision.project_id, 'record_decisions');

  const workPackageId = Number(input.work_package_id);
  const wp = await db.one('SELECT id, project_id, wp_key FROM work_packages WHERE id = ?', [workPackageId]);
  if (!wp) throw notFound('no such work package');
  if (!ctx.visibleProjectIds.includes(Number(wp.project_id))) {
    throw forbidden('that work package is not visible to you');
  }

  const relation = String(input.relation || 'blocks');
  if (!decisions.RELATIONS.includes(relation)) {
    throw badRequest(`relation must be one of ${decisions.RELATIONS.join(', ')}`);
  }
  const origin = input.origin ? String(input.origin) : 'person';
  if (!decisions.ORIGINS.includes(origin)) {
    throw badRequest(`origin must be one of ${decisions.ORIGINS.join(', ')}`);
  }
  const matchedIn = origin === 'person' ? null : (input.matched_in ? String(input.matched_in) : null);

  const existing = await db.one(
    'SELECT removed_at FROM decision_work_packages WHERE decision_id = ? AND work_package_id = ?',
    [decisionId, workPackageId]
  );
  if (existing && !existing.removed_at) throw conflict(`${wp.wp_key} is already linked to ${decision.ref}`);
  if (existing && existing.removed_at && origin !== 'person') {
    throw conflict(`${wp.wp_key} was unlinked from ${decision.ref} by hand, so it is not re-linked automatically`);
  }

  await db.transaction(async (tx) => {
    if (existing) {
      await tx.run(`
        UPDATE decision_work_packages
           SET removed_at = NULL, removed_by = NULL, relation = ?, origin = ?, matched_in = ?,
               note = ?, created_by = ?
         WHERE decision_id = ? AND work_package_id = ?`,
      [relation, origin, matchedIn, input.note || null, excluding(ctx), decisionId, workPackageId]);
    } else {
      await tx.insert('decision_work_packages', {
        decision_id: decisionId, work_package_id: workPackageId, relation,
        origin, matched_in: matchedIn, note: input.note || null, created_by: excluding(ctx),
      });
    }
    await notify.record({
      projectId: decision.project_id, workPackageId, ...actor(ctx), kind: 'decision',
      verb: 'linked work to a decision', targetLabel: decision.ref, detail: `${relation} ${wp.wp_key}`,
    }, tx);
  });
  return { decision_id: Number(decisionId), work_package_id: workPackageId, relation, origin };
}

/** Remove a link. The row stays, and never re-links itself. */
async function unlinkWork(ctx, decisionId, workPackageId) {
  const link = await db.one(`
    SELECT dwp.relation, dwp.removed_at, d.project_id, d.ref, wp.wp_key
      FROM decision_work_packages dwp
      JOIN decisions d ON d.id = dwp.decision_id
      JOIN work_packages wp ON wp.id = dwp.work_package_id
     WHERE dwp.decision_id = ? AND dwp.work_package_id = ?`, [decisionId, workPackageId]);
  if (!link) throw notFound('no such link');
  await access.require(ctx.user.id, link.project_id, 'record_decisions');
  if (link.removed_at) throw conflict('that link is already removed');

  await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE decision_work_packages SET removed_at = NOW(), removed_by = ? WHERE decision_id = ? AND work_package_id = ?',
      [ctx.user.id, decisionId, workPackageId]
    );
    await notify.record({
      projectId: link.project_id, workPackageId: Number(workPackageId), ...actor(ctx), kind: 'decision',
      verb: 'unlinked work from a decision', targetLabel: link.ref,
      detail: `${link.relation} ${link.wp_key}`,
    }, tx);
  });
  return { decision_id: Number(decisionId), work_package_id: Number(workPackageId), removed: true };
}

/** Which decisions, by ref, sit on the path a new dependency would close. */
async function refsFor(ids) {
  if (!ids.length) return [];
  const clause = db.inClause(ids);
  const rows = await db.query(`SELECT id, ref FROM decisions WHERE id IN ${clause.sql}`, clause.params);
  const byId = new Map(rows.map((r) => [Number(r.id), r.ref]));
  return ids.map((id) => byId.get(id) || `#${id}`);
}

/**
 * Gate `decisionId` on `dependsOnId`: the first cannot settle until the
 * second does.
 *
 * `decisions.wouldCycle` is checked against every live edge in the whole
 * database, not just the ones in whatever project scope the caller happens to
 * be looking at — a loop that crosses two projects is still a loop.
 */
async function addDependency(ctx, decisionId, input) {
  const decision = await db.one('SELECT id, project_id, ref FROM decisions WHERE id = ?', [decisionId]);
  if (!decision) throw notFound('no such decision');
  await access.require(ctx.user.id, decision.project_id, 'record_decisions');

  const dependsOnId = Number(input.depends_on_id);
  if (Number(decisionId) === dependsOnId) throw badRequest(`${decision.ref} cannot depend on itself`);
  const dependsOn = await db.one('SELECT id, project_id, ref FROM decisions WHERE id = ?', [dependsOnId]);
  if (!dependsOn) throw notFound('no such decision to depend on');

  const existing = await db.one(
    'SELECT removed_at FROM decision_dependencies WHERE decision_id = ? AND depends_on_id = ?',
    [decisionId, dependsOnId]
  );
  if (existing && !existing.removed_at) throw conflict(`${decision.ref} already waits on ${dependsOn.ref}`);

  const edgeRows = await db.query('SELECT decision_id, depends_on_id FROM decision_dependencies WHERE removed_at IS NULL');
  const edges = edgeRows.map((e) => ({ decision_id: Number(e.decision_id), depends_on_id: Number(e.depends_on_id) }));

  if (decisions.wouldCycle(edges, decisionId, dependsOnId)) {
    const loop = decisions.pathBetween(edges, dependsOnId, Number(decisionId)) || [dependsOnId, Number(decisionId)];
    const refs = await refsFor(loop);
    throw badRequest(
      `${decision.ref} cannot wait on ${dependsOn.ref} - that closes a loop: `
      + `${refs.join(' waits on ')} waits on ${dependsOn.ref}`
    );
  }

  await db.transaction(async (tx) => {
    if (existing) {
      await tx.run(
        'UPDATE decision_dependencies SET removed_at = NULL, removed_by = NULL, note = ?, created_by = ? '
        + 'WHERE decision_id = ? AND depends_on_id = ?',
        [input.note || null, excluding(ctx), decisionId, dependsOnId]
      );
    } else {
      await tx.insert('decision_dependencies', {
        decision_id: decisionId, depends_on_id: dependsOnId, note: input.note || null, created_by: excluding(ctx),
      });
    }
    await notify.record({
      projectId: decision.project_id, ...actor(ctx), kind: 'decision', verb: 'added a decision dependency',
      targetLabel: decision.ref, detail: `now waits on ${dependsOn.ref}`,
    }, tx);
  });
  return { decision_id: Number(decisionId), depends_on_id: dependsOnId };
}

/** Remove a dependency. The row stays, and never re-gates itself. */
async function removeDependency(ctx, decisionId, dependsOnId) {
  const dep = await db.one(`
    SELECT dd.removed_at, d.project_id, d.ref AS decision_ref, b.ref AS depends_on_ref
      FROM decision_dependencies dd
      JOIN decisions d ON d.id = dd.decision_id
      JOIN decisions b ON b.id = dd.depends_on_id
     WHERE dd.decision_id = ? AND dd.depends_on_id = ?`, [decisionId, dependsOnId]);
  if (!dep) throw notFound('no such dependency');
  await access.require(ctx.user.id, dep.project_id, 'record_decisions');
  if (dep.removed_at) throw conflict('that dependency is already removed');

  await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE decision_dependencies SET removed_at = NOW(), removed_by = ? WHERE decision_id = ? AND depends_on_id = ?',
      [ctx.user.id, decisionId, dependsOnId]
    );
    await notify.record({
      projectId: dep.project_id, ...actor(ctx), kind: 'decision', verb: 'removed a decision dependency',
      targetLabel: dep.decision_ref, detail: `no longer waits on ${dep.depends_on_ref}`,
    }, tx);
  });
  return { decision_id: Number(decisionId), depends_on_id: Number(dependsOnId), removed: true };
}

module.exports = { createDecision, updateDecision, linkWork, unlinkWork, addDependency, removeDependency };
