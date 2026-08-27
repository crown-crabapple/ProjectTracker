/**
 * Layering a directed graph, and finding the edges that close a loop.
 *
 * This exists because the map draws two graphs — which work waits on which
 * work, and which decisions gate which — and `src/domain/decisions.js` already
 * had a layering walk written for the second of them. A second copy for the
 * first would be a second answer to "how deep is this node", and the two would
 * eventually disagree about a graph they were both looking at. So the walk
 * lives here once and `decisions.layer` delegates to it.
 *
 * A RANK IS NOT PROGRESS. `rank` says how far down a chain a thing sits. It is
 * a position in a picture, not a measure of how much is finished, and nothing
 * here reaches `rollup.js` or a readiness denominator. This is the same line
 * `gitdeck.js` draws around a health score.
 *
 * The edge convention throughout: `{ from, to }` reads "`from` depends on
 * `to`", so `to` is the shallower of the two and `from` is drawn one layer
 * deeper. Callers whose own tables store the opposite sense flip it before
 * calling rather than passing a direction flag — a flag is a thing a call site
 * gets wrong silently.
 */

'use strict';

/**
 * Longest-path depth for every node. Returns a `Map<id, depth>`; a node with
 * no dependencies is 0.
 *
 * Returns a map rather than mutating the nodes, because the shape a caller
 * wants the number attached to is a view concern.
 *
 * Cycle-safe by construction. `decision_dependencies` refuses an edge that
 * would close a loop before it is ever written, but `work_package_relations`
 * does not — a loop there is legal, reported rather than prevented, the same
 * way `rollup.flattenHierarchy` treats a parent cycle. So the guard here is
 * load-bearing for one caller and a belt for the other: a node already on the
 * current path contributes 0 instead of recursing forever. Use `cycles` to
 * find out whether that happened.
 */
function rank(nodeIds, edges) {
  const dependsOf = new Map();
  for (const e of edges) {
    const from = Number(e.from);
    if (!dependsOf.has(from)) dependsOf.set(from, []);
    dependsOf.get(from).push(Number(e.to));
  }

  const depth = new Map();
  const inProgress = new Set();
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id);
    if (inProgress.has(id)) return 0;
    inProgress.add(id);
    const deps = dependsOf.get(id) || [];
    const d = deps.length ? 1 + Math.max(...deps.map(depthOf)) : 0;
    inProgress.delete(id);
    depth.set(id, d);
    return d;
  };

  for (const id of nodeIds) depthOf(Number(id));
  return depth;
}

/**
 * The edges that close a loop, as `[{ from, to }, ...]`.
 *
 * A three-colour depth-first search: an edge reaching a node still on the
 * current path is the one that closes the cycle. Reported as edges rather than
 * as a list of nodes because that is what a drawing needs — the picture can
 * mark the single line that makes the loop impossible, and saying "these five
 * work packages are in a cycle" leaves the reader to work out which line to
 * cut.
 *
 * Deterministic: nodes are walked in the order given, so the same graph always
 * names the same edge as the back edge. An arbitrary choice reported
 * consistently is one somebody can act on; one that moves between refreshes is
 * not.
 */
function cycles(nodeIds, edges) {
  const out = new Map();
  for (const e of edges) {
    const from = Number(e.from);
    if (!out.has(from)) out.set(from, []);
    out.get(from).push(Number(e.to));
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map();
  for (const id of nodeIds) colour.set(Number(id), WHITE);

  const found = [];
  const walk = (id) => {
    colour.set(id, GREY);
    for (const to of out.get(id) || []) {
      if (!colour.has(to)) continue;          // an edge leaving the drawn set
      if (colour.get(to) === GREY) { found.push({ from: id, to }); continue; }
      if (colour.get(to) === WHITE) walk(to);
    }
    colour.set(id, BLACK);
  };
  for (const id of nodeIds) if (colour.get(Number(id)) === WHITE) walk(Number(id));
  return found;
}

/**
 * Nodes grouped by rank, each group ordered by `orderBy`, ready to draw as
 * columns. Returns `[[id, ...], [id, ...]]` indexed by depth.
 *
 * The ordering matters more than it looks: an unordered column reshuffles
 * every time the rows come back from the database in a different order, and a
 * picture that redraws differently for the same data is one nobody trusts.
 */
function columns(nodeIds, depths, orderBy = (id) => id) {
  const out = [];
  for (const id of nodeIds) {
    const d = depths.get(Number(id)) || 0;
    while (out.length <= d) out.push([]);
    out[d].push(Number(id));
  }
  for (const col of out) {
    col.sort((a, b) => {
      const ka = orderBy(a);
      const kb = orderBy(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return a - b;
    });
  }
  return out;
}

module.exports = { rank, cycles, columns };
