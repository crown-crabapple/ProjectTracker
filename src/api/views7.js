/**
 * The map: one project drawn three ways — the work breakdown as a tree, what
 * blocks what as a graph, and which decisions gate which as a second graph.
 *
 * THE MAP DRAWS NO NUMBER OF ITS OWN. Every figure on it comes from
 * `rollup.js`, every layering from `src/domain/graph.js`, every decision rule
 * from `src/domain/decisions.js`. A picture that computed its own percentage
 * would be a second progress model wearing a different coat, and the two would
 * disagree in front of somebody deciding which to believe. `docs/decisions/0011`.
 *
 * READINESS AND COMPLETION TRAVEL TOGETHER. Every level of this payload that
 * carries one carries the other — the project, each group, each branch of the
 * tree. They are never added, and excluded work is reported beside them rather
 * than folded into either. Drawing a single bar here would be the SeedFall
 * 49/49 mistake with better typography.
 *
 * IT IS A READ PATH. Nothing here writes, and the screen it feeds links out to
 * the drawer and to `#/decisions` for every change. A map that could re-parent
 * a work package would be a fifth way into `mutations.updateWorkPackage`, and
 * every workflow, cycle and origin rule would need re-checking at a new call
 * site to no one's benefit.
 */

'use strict';

const db = require('../db');
const rollup = require('../domain/rollup');
const query = require('../domain/query');
const graph = require('../domain/graph');
const decisions = require('../domain/decisions');
const { badRequest, notFound } = require('../http/router');
const { row } = require('./views');

/**
 * Above this many nodes a relations graph is a hairball, and a hairball is a
 * picture that costs the reader more than it tells them. The screen says so
 * and asks for a filter rather than drawing it.
 *
 * 150 is where a layered graph stops fitting a laptop screen at a legible node
 * size — roughly fifteen columns of ten. It is a drawing limit, not a data
 * limit: the count is always reported, and the tree still shows every row.
 */
const RELATION_LIMIT = 150;

/** How the tree may be grouped above the hierarchy. Anything else is refused —
 *  a grouping silently falling back to another returns a picture of something
 *  other than what was asked for. */
const GROUPINGS = {
  none: null,
  version: {
    label: 'VERSION',
    keyOf: (w) => (w.version_code === null || w.version_code === undefined ? null : String(w.version_code)),
    labelOf: (w) => w.version_name || w.version_code,
    empty: 'NO VERSION',
  },
  type: {
    label: 'TYPE',
    keyOf: (w) => String(w.type_name),
    labelOf: (w) => w.type_name,
    empty: 'NO TYPE',
  },
  assignee: {
    label: 'ASSIGNEE',
    keyOf: (w) => (w.assignee_id === null || w.assignee_id === undefined ? null : String(w.assignee_id)),
    labelOf: (w) => w.assignee_name,
    empty: 'UNASSIGNED',
  },
};

/**
 * Which relation kinds say one thing must come before another, and which way
 * round. The table stores one direction per kind and derives the inverse on
 * read (see `db/schema.sql`), so the sense differs per kind and reading it
 * wrong would draw the arrows backwards:
 *
 *   follows   — from happens after to
 *   requires  — from cannot proceed until to
 *   blocks    — to happens after from, which is the other way round
 *
 * `relates`, `duplicates` and `includes` are drawn but carry no order.
 * `includes` is containment, which the tree already shows; treating it as
 * precedence would rank a parent behind its own children.
 */
const PRECEDENCE = {
  follows: (r) => ({ from: r.from_id, to: r.to_id }),
  requires: (r) => ({ from: r.from_id, to: r.to_id }),
  blocks: (r) => ({ from: r.to_id, to: r.from_id }),
};

/** Readiness and completion for a list, always as a pair, never as one number. */
function pair(list) {
  return {
    readiness: rollup.readiness(list),
    completion: rollup.completion(list),
    points: rollup.points(list),
  };
}

async function mapView(ctx, { projectId = null, group = 'none' } = {}) {
  if (!projectId) throw badRequest('the map is drawn for one project; name one with ?project=');
  if (!Object.prototype.hasOwnProperty.call(GROUPINGS, group)) {
    throw badRequest(`unknown grouping "${group}" — one of ${Object.keys(GROUPINGS).join(', ')}`);
  }

  const project = await db.one(
    // Deliberately not the health column. Health is recorded, not derived
    // (`docs/decisions/0003`), and it is not progress — putting it beside a
    // readiness bar is how the two get read as the same kind of figure.
    'SELECT id, code, name FROM projects WHERE id = ?', [projectId]
  );
  if (!project) throw notFound('project');

  // Capped at the same 1000 `query.select` caps every other list at. A project
  // over that is reported rather than silently truncated: a tree missing rows
  // nobody was told about is worse than a tree that says it is missing rows.
  const total = await query.count({ filters: { project: projectId }, today: ctx.today });
  const wps = await query.select({
    filters: { project: projectId }, sort: 'key', limit: 1000, today: ctx.today,
  });
  const truncated = total > wps.length;

  const statuses = await db.query(
    'SELECT code, label, colour, progress_weight, is_closed FROM statuses ORDER BY position, id'
  );

  return {
    project: { id: Number(project.id), code: project.code, name: project.name },
    group,
    groupings: Object.keys(GROUPINGS),
    truncated,
    total,
    shown: wps.length,
    statuses: statuses.map((s) => ({
      code: s.code,
      label: s.label,
      colour: s.colour,
      // NULL is the whole point of this column and JSON keeps it, so the client
      // can say EXCLUDED FROM THE DENOMINATOR rather than drawing a zero.
      progress_weight: s.progress_weight === null ? null : Number(s.progress_weight),
      is_closed: Boolean(s.is_closed),
    })),
    totals: pair(wps),
    tree: buildTree(ctx, wps, group),
    relations: await buildRelations(ctx, wps),
    decisions: await buildDecisions(ctx, projectId, wps),
  };
}

// ------------------------------------------------------------------------ tree

/**
 * The work breakdown, optionally grouped above the hierarchy.
 *
 * Grouping does not flatten: each group holds its own hierarchy, and
 * `rollup.flattenHierarchy` already treats a parent outside the list as a root,
 * so a child whose parent sits in a different version appears at the top of its
 * own group rather than vanishing behind a row that is not there.
 *
 * Every row that has children carries the pair for its whole subtree, which is
 * what makes the tree readable collapsed — a branch says what is inside it
 * without being opened.
 */
function buildTree(ctx, wps, group) {
  const spec = GROUPINGS[group];
  const groups = [];

  if (!spec) {
    groups.push({ key: null, label: null, list: wps });
  } else {
    const buckets = new Map();
    for (const w of wps) {
      const key = spec.keyOf(w);
      if (!buckets.has(key)) {
        buckets.set(key, { key, label: key === null ? spec.empty : String(spec.labelOf(w)), list: [] });
      }
      buckets.get(key).list.push(w);
    }
    // Named groups in label order, the unset bucket last. Sorting it in
    // alphabetically would bury NO VERSION in the middle of the versions.
    const named = [...buckets.values()].filter((b) => b.key !== null)
      .sort((a, b) => a.label.localeCompare(b.label));
    const unset = [...buckets.values()].filter((b) => b.key === null);
    groups.push(...named, ...unset);
  }

  const cycles = [];
  const out = groups.map((g) => {
    const flat = rollup.flattenHierarchy(g.list);
    if (flat.cycles.length) cycles.push(...flat.cycles.map(Number));

    const childrenOf = new Map();
    for (const w of g.list) {
      const parent = Number(w.parent_id) || 0;
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(w);
    }
    const subtreeOf = (id, seen) => {
      if (seen.has(id)) return [];
      seen.add(id);
      const kids = childrenOf.get(id) || [];
      return kids.flatMap((k) => [k, ...subtreeOf(Number(k.id), seen)]);
    };

    return {
      key: g.key,
      label: g.label,
      ...pair(g.list),
      rows: flat.rows.map((w) => {
        const kids = subtreeOf(Number(w.id), new Set());
        return {
          ...row(w, ctx),
          depth: w.depth,
          orphaned: Boolean(w.orphaned),
          progress_weight: w.progress_weight === null ? null : Number(w.progress_weight),
          childCount: kids.length,
          // A branch's pair covers the branch and everything under it. Leaving
          // the parent out would make a phase's readiness read lower than the
          // work inside it for no reason a reader could see.
          subtree: kids.length ? pair([w, ...kids]) : null,
        };
      }),
    };
  });

  return { groupLabel: spec ? spec.label : null, groups: out, cycles };
}

// ------------------------------------------------------------------- relations

/**
 * What blocks what, as a layered graph over the work packages that actually
 * carry a relation. Work with no relation is left out on purpose: a hundred
 * unconnected dots say nothing the tree does not already say better.
 */
async function buildRelations(ctx, wps) {
  const byId = new Map(wps.map((w) => [Number(w.id), w]));
  const ids = [...byId.keys()];
  const clause = db.inClause(ids.length ? ids : [0]);

  // Both ends inside the project. A relation reaching out of it would draw a
  // node this screen carries no data for, and a box with nothing in it reads
  // as a bug rather than as a boundary.
  const rows = ids.length ? await db.query(`
    SELECT id, from_id, to_id, kind, lag_days
      FROM work_package_relations
     WHERE from_id IN ${clause.sql} AND to_id IN ${clause.sql}
     ORDER BY id`, [...clause.params, ...clause.params]) : [];

  const rels = rows.map((r) => ({
    id: Number(r.id), from_id: Number(r.from_id), to_id: Number(r.to_id),
    kind: r.kind, lag_days: Number(r.lag_days) || 0,
  }));

  const involved = new Set();
  for (const r of rels) { involved.add(r.from_id); involved.add(r.to_id); }
  const nodeIds = ids.filter((id) => involved.has(id));

  if (nodeIds.length > RELATION_LIMIT) {
    return {
      drawn: false, limit: RELATION_LIMIT, nodeCount: nodeIds.length,
      edgeCount: rels.length, nodes: [], edges: [], columns: [], cycles: [],
    };
  }

  const ordered = rels.filter((r) => PRECEDENCE[r.kind]).map((r) => PRECEDENCE[r.kind](r));
  const depths = graph.rank(nodeIds, ordered);
  const loops = graph.cycles(nodeIds, ordered);
  const loopKeys = new Set(loops.map((e) => `${e.from}:${e.to}`));

  const cols = graph.columns(nodeIds, depths, (id) => String(byId.get(id).wp_key || ''));

  return {
    drawn: true,
    limit: RELATION_LIMIT,
    nodeCount: nodeIds.length,
    edgeCount: rels.length,
    nodes: nodeIds.map((id) => ({
      ...row(byId.get(id), ctx),
      rank: depths.get(id) || 0,
      progress_weight: byId.get(id).progress_weight === null ? null : Number(byId.get(id).progress_weight),
    })),
    columns: cols,
    edges: rels.map((r) => {
      const p = PRECEDENCE[r.kind] ? PRECEDENCE[r.kind](r) : null;
      return {
        ...r,
        // Which way the arrow points once the kind's stored sense is resolved.
        // null for a kind that carries no order, so the client draws a plain
        // line rather than inventing a direction.
        after: p ? p.from : null,
        before: p ? p.to : null,
        closesLoop: p ? loopKeys.has(`${p.from}:${p.to}`) : false,
      };
    }),
    // Reported as edges, not as a set of nodes: a loop is cut by removing one
    // line, and naming the five work packages in it leaves the reader to work
    // out which.
    cycles: loops.map((e) => ({
      from: e.from, to: e.to,
      from_key: byId.get(e.from) ? byId.get(e.from).wp_key : null,
      to_key: byId.get(e.to) ? byId.get(e.to).wp_key : null,
    })),
  };
}

// ------------------------------------------------------------------- decisions

/**
 * The decision graph for this project: what gates what, and which work each
 * decision holds up.
 *
 * The maths is `src/domain/decisions.js` — `layer` for the depth and
 * `blocking` for what is actually waiting. This function only fetches and
 * shapes. A decision's own life cycle rules are not re-stated here; the screen
 * links out to `#/decisions`, which owns them.
 *
 * A LINK CARRIES ITS ORIGIN. `origin` and `matched_in` travel with every edge
 * so the picture can mark a link a matcher made. A regex's claim and a
 * person's claim drawn identically is the thing the git deck's rules exist to
 * prevent, one layer out.
 */
async function buildDecisions(ctx, projectId, wps) {
  const byWp = new Map(wps.map((w) => [Number(w.id), w]));

  // The project's own decisions plus the portfolio-wide ones, which is how
  // `views6.decisions` scopes them. A portfolio decision gating this project's
  // work is exactly the thing somebody opens this screen to find.
  const rows = await db.query(`
    SELECT d.id, d.project_id, d.ref, d.title, d.state, d.due_on, d.owner_id,
           u.name AS owner, u.initials AS owner_initials, u.colour AS owner_colour
      FROM decisions d
      LEFT JOIN users u ON u.id = d.owner_id
     WHERE d.project_id = ? OR d.project_id IS NULL
     ORDER BY FIELD(d.state, 'open', 'settled', 'superseded'), d.position, d.ref`, [projectId]);

  const ids = rows.map((d) => Number(d.id));
  const clause = db.inClause(ids.length ? ids : [0]);

  const edgeRows = ids.length ? await db.query(`
    SELECT decision_id, depends_on_id, note
      FROM decision_dependencies
     WHERE removed_at IS NULL
       AND decision_id IN ${clause.sql} AND depends_on_id IN ${clause.sql}`,
  [...clause.params, ...clause.params]) : [];
  const edges = edgeRows.map((e) => ({
    decision_id: Number(e.decision_id), depends_on_id: Number(e.depends_on_id), note: e.note,
  }));

  const linkRows = ids.length ? await db.query(`
    SELECT dwp.decision_id, dwp.work_package_id, dwp.relation, dwp.origin, dwp.matched_in, dwp.note
      FROM decision_work_packages dwp
     WHERE dwp.removed_at IS NULL AND dwp.decision_id IN ${clause.sql}`, clause.params) : [];

  // Only links to work on this map. A link to another project's work package
  // is real and is shown on `#/decisions`; drawing it here would put a node in
  // the picture that belongs to a project this map is not of.
  const links = linkRows
    .map((l) => ({
      decision_id: Number(l.decision_id), work_package_id: Number(l.work_package_id),
      relation: l.relation, origin: l.origin, matched_in: l.matched_in, note: l.note,
    }))
    .filter((l) => byWp.has(l.work_package_id));
  const offMap = linkRows.length - links.length;

  const depths = decisions.layer(rows, edges);
  const blockingMap = decisions.blocking(rows, links);

  // A decision with no edge and no link to work on this map has nothing to say
  // in a picture of this project. It is counted, not drawn, and the screen says
  // how many were left out rather than quietly shortening the graph.
  const connected = new Set();
  for (const e of edges) { connected.add(e.decision_id); connected.add(e.depends_on_id); }
  for (const l of links) connected.add(l.decision_id);
  const nodes = rows.filter((d) => connected.has(Number(d.id)));

  const nodeIds = nodes.map((d) => Number(d.id));
  const byRef = new Map(rows.map((d) => [Number(d.id), d.ref]));
  const cols = graph.columns(nodeIds, depths, (id) => String(byRef.get(id) || ''));

  const linksOf = new Map();
  for (const l of links) {
    if (!linksOf.has(l.decision_id)) linksOf.set(l.decision_id, []);
    linksOf.get(l.decision_id).push(l);
  }

  return {
    nodeCount: nodes.length,
    unconnected: rows.length - nodes.length,
    offMapLinks: offMap,
    nodes: nodes.map((d) => {
      const id = Number(d.id);
      const own = linksOf.get(id) || [];
      return {
        id,
        ref: d.ref,
        title: d.title,
        state: d.state,
        portfolio: d.project_id === null,
        owner: d.owner,
        owner_initials: d.owner_initials,
        owner_colour: d.owner_colour,
        due_on: d.due_on,
        rank: depths.get(id) || 0,
        // What is actually held up, from `decisions.blocking` — 'blocks' only.
        // Folding in 'informs' would make a decision that merely interests six
        // people look like it stops six people.
        blocksCount: (blockingMap.get(id) || []).length,
        informsCount: own.filter((l) => l.relation === 'informs').length,
        aroseFromCount: own.filter((l) => l.relation === 'arose_from').length,
      };
    }),
    columns: cols,
    edges: edges.map((e) => ({
      from: e.decision_id, to: e.depends_on_id, note: e.note,
      from_ref: byRef.get(e.decision_id) || null, to_ref: byRef.get(e.depends_on_id) || null,
    })),
    links: links.map((l) => ({
      decision_id: l.decision_id,
      ref: byRef.get(l.decision_id) || null,
      work_package_id: l.work_package_id,
      wp_key: byWp.get(l.work_package_id).wp_key,
      subject: byWp.get(l.work_package_id).subject,
      status_colour: byWp.get(l.work_package_id).status_colour,
      relation: l.relation,
      origin: l.origin,
      matched_in: l.matched_in,
      note: l.note,
    })),
  };
}

module.exports = { map: mapView, RELATION_LIMIT, GROUPINGS, PRECEDENCE };
