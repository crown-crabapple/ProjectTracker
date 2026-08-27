/**
 * The decision rules: whether one can settle, whether a new dependency would
 * close a loop, how deep each one sits in the gating chain, and which open
 * work is waiting on which open decision.
 *
 * Everything here is pure — no SQL, no HTTP — for the same reason
 * `src/domain/gitdeck.js` is: a graph walked twice, once here and once in a
 * view, is a graph that will eventually disagree with itself about whether it
 * has a cycle.
 *
 * A DECISION IS NOT PROGRESS. `blocking()` counts what is waiting, not what is
 * done, and nothing computed by this module enters `rollup.js` or moves a
 * readiness denominator. An open decision that blocks three features is a
 * fact about what cannot proceed, not about how much of the project is
 * finished — the same distinction `gitdeck.js` draws for a health score: a
 * figure that looks like readiness and is not one is worse than no figure at
 * all, because it gets averaged in with the ones that are.
 */

'use strict';

const graph = require('./graph');

/** The three kinds of thing a decision can hold up. See `db/migrations` for why. */
const RELATIONS = ['blocks', 'informs', 'arose_from'];

/** A decision's own life cycle. */
const STATES = ['open', 'settled', 'superseded'];

/** Who made a link: a person, an import, or a matcher reading a custom field. */
const ORIGINS = ['person', 'import', 'matcher'];

/**
 * Can `decision` move to 'settled'? Refused while a live dependency of it is
 * still open, and the reason names it: two decisions that gate each other can
 * never both settle, so this is checked at the moment settling is attempted
 * rather than left to be discovered later as a gate nobody can explain.
 *
 * `openDependencies` is the decision's live `depends_on` rows, already
 * narrowed by the caller to the ones whose own state is 'open' — this
 * function does not know how to fetch them, only how to read the answer.
 */
function canSettle(decision, openDependencies) {
  if (!openDependencies.length) return { ok: true, reason: null };
  const refs = openDependencies.map((d) => d.ref);
  const verb = refs.length === 1 ? 'is' : 'are';
  return {
    ok: false,
    reason: `${decision.ref} waits on ${refs.join(', ')}, which ${verb} still open`,
  };
}

/**
 * Depth-first search along `edges` (each `{ decision_id, depends_on_id }`,
 * live only) for a path from `fromId` to `toId`. Returns the path as a list
 * of decision ids, or null when there is none.
 *
 * Exported as well as used internally: `wouldCycle` only needs to know
 * whether a path exists, but a refusal that names the loop needs the path
 * itself, and a second graph walk in the caller to find it would be a second
 * place this could disagree with the first.
 */
function pathBetween(edges, fromId, toId, seen = new Set()) {
  const from = Number(fromId);
  const to = Number(toId);
  if (from === to) return [from];
  if (seen.has(from)) return null;
  seen.add(from);
  for (const e of edges) {
    if (Number(e.decision_id) === from) {
      const rest = pathBetween(edges, Number(e.depends_on_id), to, seen);
      if (rest) return [from, ...rest];
    }
  }
  return null;
}

/**
 * Would adding `decisionId depends on dependsOnId` close a loop?
 *
 * True for a self-dependency, and true whenever `dependsOnId` can already
 * reach `decisionId` by following the existing live edges — add the new edge
 * and that path becomes a cycle, which is exactly the shape neither decision
 * could ever settle out of.
 */
function wouldCycle(edges, decisionId, dependsOnId) {
  if (Number(decisionId) === Number(dependsOnId)) return true;
  return pathBetween(edges, dependsOnId, decisionId) !== null;
}

/**
 * Each decision's depth in the gating chain: 0 for one that waits on nothing,
 * otherwise one more than the deepest thing it waits on. For drawing the
 * chain in the order the answers have to arrive, not for saying how far
 * through anything is — see the header.
 *
 * Returns a `Map<id, depth>` rather than mutating `decisions`, because the
 * shape a caller wants the number attached to (a list row here, a chain row
 * there) is a view concern.
 */
function layer(decisions, edges) {
  // The walk itself is `graph.rank`, shared with the relations graph on the
  // map. Two copies of a depth-first longest path is two answers to how deep a
  // node sits, and they would eventually disagree about a graph they were both
  // looking at. The only work left here is naming the columns: this table
  // stores `decision_id depends_on depends_on_id`, which is already the
  // `{ from, to }` sense `graph` expects.
  return graph.rank(
    decisions.map((d) => Number(d.id)),
    edges.map((e) => ({ from: Number(e.decision_id), to: Number(e.depends_on_id) })),
  );
}

/**
 * For each open decision, the work packages linked to it with relation
 * 'blocks' — the ones that are therefore waiting.
 *
 * 'informs' and 'arose_from' are deliberately left out: folding them in would
 * make an open decision that merely interests six people look like it stops
 * six people, which is the same inflation the SeedFall tracker's *built*
 * figure made by adding two counts that were not the same thing.
 *
 * Returns a `Map<decisionId, workPackageId[]>`, decisions with nothing
 * blocked and decisions that are not open both simply absent from the map.
 */
function blocking(decisions, links) {
  const openIds = new Set(decisions.filter((d) => d.state === 'open').map((d) => Number(d.id)));
  const out = new Map();
  for (const l of links) {
    if (l.relation !== 'blocks') continue;
    const decisionId = Number(l.decision_id);
    if (!openIds.has(decisionId)) continue;
    if (!out.has(decisionId)) out.set(decisionId, []);
    out.get(decisionId).push(Number(l.work_package_id));
  }
  return out;
}

module.exports = { RELATIONS, STATES, ORIGINS, canSettle, wouldCycle, pathBetween, layer, blocking };
