/**
 * The read side of decisions: one screen, drawing two graphs — which work
 * waits on a decision, and which decisions gate which.
 *
 * The graph maths (depth in the chain, what an open decision blocks) is never
 * done here: it comes from `src/domain/decisions.js` for the same reason a
 * percentage comes from `rollup.js` — a graph walked twice is a graph that
 * will eventually disagree with itself.
 */

'use strict';

const db = require('../db');
const decisions = require('../domain/decisions');

/**
 * Every decision in scope, the selected one in full, and the whole gating
 * graph for drawing.
 *
 * Scoped the way `views4.wiki` scopes documents: a project narrows to it,
 * and no project shows every visible project's decisions plus the
 * portfolio-wide ones (`project_id IS NULL`).
 */
async function decisionsView(ctx, { projectId = null, ref = null } = {}) {
  const clause = db.inClause(ctx.visibleProjectIds.length ? ctx.visibleProjectIds : [0]);
  const where = projectId ? 'd.project_id = ?' : `(d.project_id IS NULL OR d.project_id IN ${clause.sql})`;
  const params = projectId ? [projectId] : clause.params;

  const rows = await db.query(`
    SELECT d.id, d.project_id, d.ref, d.title, d.question, d.answer, d.rationale, d.state,
           d.owner_id, d.due_on, d.decided_by, d.decided_at, d.superseded_by, d.document_id,
           d.position, d.created_at,
           p.code AS project_code,
           u.name AS owner, u.initials AS owner_initials, u.colour AS owner_colour,
           du.name AS decided_by_name,
           sup.ref AS superseded_by_ref
      FROM decisions d
      LEFT JOIN projects p ON p.id = d.project_id
      LEFT JOIN users u ON u.id = d.owner_id
      LEFT JOIN users du ON du.id = d.decided_by
      LEFT JOIN decisions sup ON sup.id = d.superseded_by
     WHERE ${where}
     ORDER BY FIELD(d.state, 'open', 'settled', 'superseded'), d.position, d.ref`, params);

  const ids = rows.map((d) => Number(d.id));
  const idClause = db.inClause(ids.length ? ids : [0]);

  // Only the live dependency edges among decisions in scope: one that reached
  // outside scope would draw a chain nobody on this screen could follow.
  const edgeRows = ids.length ? await db.query(`
    SELECT dd.decision_id, dd.depends_on_id, dd.note
      FROM decision_dependencies dd
     WHERE dd.removed_at IS NULL
       AND dd.decision_id IN ${idClause.sql} AND dd.depends_on_id IN ${idClause.sql}`,
  [...idClause.params, ...idClause.params]) : [];
  const edges = edgeRows.map((e) => ({
    decision_id: Number(e.decision_id), depends_on_id: Number(e.depends_on_id), note: e.note,
  }));

  const linkRows = ids.length ? await db.query(`
    SELECT dwp.decision_id, dwp.work_package_id, dwp.relation, dwp.origin, dwp.matched_in, dwp.note,
           wp.subject, wp.wp_key, t.name AS type_name,
           s.code AS status_code, s.label AS status_label, s.colour AS status_colour,
           au.name AS assignee
      FROM decision_work_packages dwp
      JOIN work_packages wp ON wp.id = dwp.work_package_id
      JOIN statuses s ON s.id = wp.status_id
      JOIN work_package_types t ON t.id = wp.type_id
      LEFT JOIN users au ON au.id = wp.assignee_id
     WHERE dwp.removed_at IS NULL AND dwp.decision_id IN ${idClause.sql}`, idClause.params) : [];
  const links = linkRows.map((l) => ({
    decision_id: Number(l.decision_id), work_package_id: Number(l.work_package_id),
    relation: l.relation, origin: l.origin, matched_in: l.matched_in, note: l.note,
    subject: l.subject, wp_key: l.wp_key, type_name: l.type_name,
    status_code: l.status_code, status_label: l.status_label, status_colour: l.status_colour,
    assignee: l.assignee,
  }));

  const byId = new Map(rows.map((d) => [Number(d.id), d]));
  const layerMap = decisions.layer(rows, edges);
  const blockingMap = decisions.blocking(rows, links);

  const dependsOfDecision = new Map();  // decision_id -> [depends_on_id, ...]
  const gatesOfDependsOn = new Map();   // depends_on_id -> [decision_id, ...] (who waits on it)
  for (const e of edges) {
    if (!dependsOfDecision.has(e.decision_id)) dependsOfDecision.set(e.decision_id, []);
    dependsOfDecision.get(e.decision_id).push(e.depends_on_id);
    if (!gatesOfDependsOn.has(e.depends_on_id)) gatesOfDependsOn.set(e.depends_on_id, []);
    gatesOfDependsOn.get(e.depends_on_id).push(e.decision_id);
  }

  const linksByDecision = new Map();
  for (const l of links) {
    if (!linksByDecision.has(l.decision_id)) linksByDecision.set(l.decision_id, []);
    linksByDecision.get(l.decision_id).push(l);
  }

  const list = rows.map((d) => {
    const id = Number(d.id);
    const deps = dependsOfDecision.get(id) || [];
    const waitingOn = deps
      .filter((depId) => byId.has(depId) && byId.get(depId).state === 'open')
      .map((depId) => byId.get(depId).ref);
    const gates = (gatesOfDependsOn.get(id) || []).map((gid) => byId.get(gid).ref);
    const own = linksByDecision.get(id) || [];
    return {
      id,
      ref: d.ref,
      title: d.title,
      state: d.state,
      project_id: d.project_id === null ? null : Number(d.project_id),
      project_code: d.project_code,
      owner: d.owner,
      owner_initials: d.owner_initials,
      owner_colour: d.owner_colour,
      due_on: d.due_on,
      decided_at: d.decided_at,
      decided_by_name: d.decided_by_name,
      layer: layerMap.get(id) || 0,
      blocksCount: own.filter((l) => l.relation === 'blocks').length,
      informsCount: own.filter((l) => l.relation === 'informs').length,
      waitingOn,
      gates,
    };
  });

  const currentRow = ref
    ? list.find((d) => d.ref === ref) || null
    : list.find((d) => d.state === 'open') || null;

  let current = null;
  if (currentRow) {
    const id = currentRow.id;
    const raw = byId.get(id);
    const own = linksByDecision.get(id) || [];
    const shapeLink = (l) => ({
      id: l.work_package_id, subject: l.subject, wp_key: l.wp_key, type: l.type_name,
      status: l.status_code, status_label: l.status_label, status_colour: l.status_colour,
      assignee: l.assignee, origin: l.origin, matched_in: l.matched_in, note: l.note,
    });

    const dependsOn = (dependsOfDecision.get(id) || []).map((depId) => {
      const edge = edges.find((e) => e.decision_id === id && e.depends_on_id === depId);
      const dep = byId.get(depId);
      return { id: depId, ref: dep.ref, title: dep.title, state: dep.state, note: edge ? edge.note : null };
    });
    const gates = (gatesOfDependsOn.get(id) || []).map((gid) => {
      const edge = edges.find((e) => e.decision_id === gid && e.depends_on_id === id);
      const gate = byId.get(gid);
      return { id: gid, ref: gate.ref, title: gate.title, state: gate.state, note: edge ? edge.note : null };
    });

    const openDependencies = (dependsOfDecision.get(id) || [])
      .map((depId) => byId.get(depId))
      .filter((dep) => dep.state === 'open');

    const document = raw.document_id
      ? await db.one('SELECT id, number, title, slug FROM documents WHERE id = ?', [raw.document_id])
      : null;

    current = {
      ...currentRow,
      question: raw.question,
      answer: raw.answer,
      rationale: raw.rationale,
      superseded_by_ref: raw.superseded_by_ref,
      document: document
        ? { id: Number(document.id), number: document.number, title: document.title, slug: document.slug }
        : null,
      canSettle: decisions.canSettle(raw, openDependencies),
      work: {
        blocks: own.filter((l) => l.relation === 'blocks').map(shapeLink),
        informs: own.filter((l) => l.relation === 'informs').map(shapeLink),
        arose_from: own.filter((l) => l.relation === 'arose_from').map(shapeLink),
      },
      dependsOn,
      gates,
    };
  }

  const openDecisions = rows.filter((d) => d.state === 'open');
  const blockedWork = new Set();
  for (const wpIds of blockingMap.values()) for (const wpId of wpIds) blockedWork.add(wpId);

  let oldestOpenDays = null;
  if (openDecisions.length) {
    const todayMs = Date.parse(`${ctx.today}T00:00:00Z`);
    oldestOpenDays = Math.max(...openDecisions.map((d) => {
      const createdMs = Date.parse(`${String(d.created_at).replace(' ', 'T')}Z`);
      return Math.max(0, Math.round((todayMs - createdMs) / 86400000));
    }));
  }

  return {
    decisions: list,
    current,
    kpis: {
      open: openDecisions.length,
      settled: rows.filter((d) => d.state === 'settled').length,
      superseded: rows.filter((d) => d.state === 'superseded').length,
      blockedWork: blockedWork.size,
      oldestOpenDays,
      chained: list.filter((d) => d.state === 'open' && d.waitingOn.length > 0).length,
    },
    chain: rows.map((d) => {
      const id = Number(d.id);
      return {
        ref: d.ref, id, title: d.title, state: d.state, layer: layerMap.get(id) || 0,
        dependsOn: (dependsOfDecision.get(id) || []).map((depId) => byId.get(depId).ref),
      };
    }),
  };
}

module.exports = { decisions: decisionsView };
