# 0010 — A decision is a record, not a page

**Date:** 2026-08-26
**Status:** accepted

## Context

A decision lived as a wiki page: a title, then prose — what `db/import-state.js`
wrote for every entry in a SeedFall decision log, one page per decision, and
what the design canvas's own `27 · Open decisions` page was before this change.
A page answers "what does it say" well. It does not answer the two questions
anybody actually asks about a decision: **what is stuck behind it**, and **what
does it need answered first**. Those are relations between rows, and a
relation written as a sentence inside a `LONGTEXT` column cannot be counted, cannot
be listed on another screen, and goes stale the moment the thing on the other
end of it moves.

The demo dataset has a concrete case of exactly this: decision `D-14` — does a
deferred feature leave the denominator — blocks work package 112, the weighted
domain rollup. Before this change that fact could only have been a line of
prose on D-14's page. Nothing could answer "how many decisions are blocking
live work" without somebody reading every decision page and counting by hand,
and nothing would notice if WP-112 shipped while D-14 was still open, because
the page does not know WP-112 exists.

## Decision 1: two link tables, not a prose relation

A decision becomes a row in `decisions` (`db/migrations/0004_decisions.sql`),
and the two relations get their own tables: `decision_work_packages` (what is
waiting, with a `relation` of `blocks`, `informs` or `arose_from` — kept apart
so a decision that merely interests six people does not read as one that stops
six people, the same inflation the SeedFall tracker's *built* figure made by
adding two counts that were not the same thing) and `decision_dependencies`
(which decision gates which). The graph
maths — depth in the gating chain, what an open decision blocks — is computed
once, in `src/domain/decisions.js`, and read by the screen and the CLI; a graph
walked twice is a graph that will eventually disagree with itself, the same
argument `src/domain/gitdeck.js` already makes for the forge's graph.

## Decision 2: the page is not deleted, and is not shown twice

Nothing in this database is deleted on the strength of a migration.
`decisions.document_id` records which wiki page a decision came out of — the migration
fills it for every page shaped like `D25` or `D-25` — and the page itself is
untouched: not archived, not flagged, not edited. The only change anywhere else
is in `views4.wiki`, which excludes a page a `decisions` row points at
(`AND NOT EXISTS (SELECT 1 FROM decisions x WHERE x.document_id = d.id)`).
Showing the same decision on the wiki index and on `#/decisions` is how the two
come to disagree about what a decision means, so one of them stops showing it —
the wiki index, since `#/decisions` is now the record.

## Decision 3: a link says why it exists, and a person outranks the matcher

`decision_work_packages.origin` is `person`, `import` or `matcher`, and
`decision_dependencies` carries no `origin` because nothing but a person makes
a gating edge. This is the same rule the git deck runs on for a pull request or
an issue: a key a matcher found in a custom field is a claim, and a link a
person made by hand is a decision, and the two are never drawn the same. A link
somebody removes keeps its row (`removed_at`), and `mutations4.linkWork`
refuses to revive a removed link unless the reviving call is itself
`origin: 'person'` — a matcher, were one ever built, does not get to overturn
what a person undid.

## Decision 4: a cycle is refused where the edge is written, not at settle time

`decisions.canSettle` refuses to settle a decision with a live open dependency,
named by ref, at the moment settling is attempted. That is not where a cycle is
caught. Two decisions that gate each other can never both settle — whichever
one is attempted first finds the other still open — so a graph shaped like that
should fail the moment it is created, not surface six weeks later as a gate
neither decision can ever pass. `mutations4.addDependency` walks every live
edge in the database with `decisions.wouldCycle` before the new edge is
written, and a refusal names the loop it would have closed, not just that one
exists.

## What is deliberately not done

**A decision does not yet gate a phase.** `src/domain/lifecycle.js`'s
`canAdvance` already takes an `openDecisions` count and already refuses to
advance while it is positive — that plumbing predates this change. Nothing
feeds it: `mutations.signGate` calls
`lifecycle.canAdvance(phase, { openImmediateBugs: openImmediate })` and passes
no `openDecisions` at all, so an open decision never blocks a gate today.
Wiring it needs a link from a decision
to the phase it gates, which does not exist — `decision_work_packages` links a
decision to a work package, not to a `project_phases` row — and was left out on
purpose rather than added half-finished.

**No MCP tool reads or writes a decision.** The six routes in
`src/http/server.js` (`GET /api/decisions` and the five writes under
`/api/decisions/:id/...`) are reachable from the browser and from
`src/cli/tracker.js`'s `decisions` command only. `src/mcp/server.js` still lists
the same fifteen tools it did before this change.

## Consequences

- `#/decisions` is the one screen that draws both graphs, and a person who used
  to read `27 · Open decisions` reads this instead. The SPEC template's
  blueprint dropped its `27 · Open decisions` page with this change: a blank
  wiki stub created for every new project beside a screen that holds the real
  record is the second place to write a decision down that the rest of this
  argument exists to remove.
- `db/import-state.js` writes a `decisions` row directly and no longer writes a
  page for one, because `db/migrations/0004` is the one thing that turns a page
  into a row, and writing new pages that migration would then have to move
  again is the second writer this database keeps refusing to have.
- A decision's `answer` still renders through the same markdown path as a wiki
  page, so nothing about reading one gets worse for having lost its page.
