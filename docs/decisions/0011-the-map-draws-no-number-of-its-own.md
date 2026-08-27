# 0011 — The map draws no number of its own

**Date:** 2026-08-27
**Status:** accepted

## Context

Sixteen screens each answer one question well. None of them answers "what shape
is this project" — the tables show rows in an order, the Gantt shows the same
rows stretched along a time axis, and `#/decisions` shows one decision at a time
with its links listed as prose. Somebody holding the whole project in their head
has to build the picture themselves, every time, from four screens.

So: `#/map`, one project drawn three ways — the work breakdown as a tree, what
comes before what as a graph, and which decisions gate which as a second graph.

A new screen over data that already exists is cheap. What is not cheap is the
four ways a picture of a project quietly becomes a lie, and the four decisions
below are each one of them.

## Decision 1: every figure comes from `rollup.js`, and the pair is never split

`src/api/views7.js` computes no percentage. `pair()` calls `rollup.readiness`
and `rollup.completion` together and returns both, and every level of the
payload that carries one carries the other — the project, each group, each
branch of the tree. The client draws them side by side with `BASIS: WEIGHTED —
THIS IS NOT COMPLETION` under the bar.

This is not caution. A bar is the most persuasive thing on a screen, and a lone
bar reading 60% is read as "sixty per cent finished" by everybody who has not
read `docs/decisions/0002`. The SeedFall tracker reported a milestone as 49/49
with four features unfinished by adding two counts that were not the same
thing; a single bar here would be that mistake with better typography.

Excluded work is reported beside both figures and folded into neither, in
words — `EXCLUDED FROM THE DENOMINATOR, NOT SCORED ZERO` — because a blank cell
and a `0` look similar in a picture and mean opposite things.

## Decision 2: one layering walk, shared

`src/domain/decisions.js` already had a depth-first longest-path walk for the
gating chain. The relations graph needs the same walk. A second copy would be a
second answer to how deep a node sits, and the two would eventually disagree
about a graph they were both looking at — the argument `rollup.js` makes for a
percentage and `gitdeck.js` makes for the forge's graph, one layer out.

So the walk moved to `src/domain/graph.js` — `rank`, `cycles`, `columns` — and
`decisions.layer` delegates to it. `graph.js` requires nothing and reads no
field that carries progress, which is what keeps a rank a position in a picture
rather than something that could be averaged in with the figures that mean
something.

`cycles` reports the edges that close a loop rather than the nodes in it. A loop
is cut by removing one line, and naming the five work packages leaves the reader
to work out which. `decision_dependencies` refuses a cycle where it is written;
`work_package_relations` permits one, so on the relations graph the guard is
load-bearing rather than a belt.

## Decision 3: it is read-only

Every node links out — a work package to the drawer, a decision to
`#/decisions`. Nothing on the map writes.

Drag-to-re-parent and draw-a-line-to-relate are the obvious next features and
were deliberately not built. Each would make the map a new call site for
`mutations.updateWorkPackage` and the decision link writes, and every rule
those enforce — the status workflow, the cycle refusal, a removed link that a
matcher may not revive — would need re-checking at a call site that exists to
draw a picture. Shipping the picture first costs nothing later; un-shipping a
wrong write costs the trail.

## Decision 4: colour comes from `statuses.colour`, and rust is still reserved

The map reuses the status colours the boards and the Gantt already use. A
palette of its own would be a second visual progress model, and a reader moving
between two screens would have to learn which one they were looking at.

Rust is earned twice here and nowhere else. An open decision blocking live work
draws in it — the rule `#/decisions` already uses, exported from
`public/views/decisions.js` as `decisionColour` rather than restated, so the two
screens cannot drift. And a relation that closes a loop draws in it, because
`scheduling.derive` cannot converge through one: it is not decoration and not
lateness, it is a person having to decide which link to cut.

## Consequences

- A fourth screen shows a project's figures, and it cannot disagree with the
  other three, because it computes none of them.
- `graph.js` is now the only layering walk in the product. A third graph goes
  through it or it is a second answer.
- `public/lib/dom.js` gained `svgEl`, with `h()`'s discipline: `textContent` for
  text, `setAttribute` for everything else, no HTML-string path. A diagonal line
  is the one thing a positioned div cannot be, and without this the two graphs
  would have reached for `innerHTML` to get one.
- The relations graph refuses to draw over 150 nodes and says so. A refusal that
  names its reason beats a hairball, and it matches how the rest of the app
  behaves when it cannot do what was asked.
- The graphs are in the markup twice — as SVG and as a nested list — with CSS
  choosing at 860px. A node graph you drag around on a phone is not a picture;
  the eleven-column work table becomes cards at 560px on the same reasoning.
- The map is per project. `#/portfolio` and `#/roadmap` already answer the
  cross-project question and both work; a third cross-project picture would
  compete with two that do.
- There is no CLI or MCP form of it. The rule is that a *number* is computed
  once, and it is — in `rollup.js`. A picture is not a number, and an indented
  ASCII tree would be a second renderer to keep in step for very little.
