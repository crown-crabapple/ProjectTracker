# 0007 — The state import adds no structure of its own, and merges rather than replaces

**Date:** 2026-08-26
**Status:** accepted

## Context

`db/import-state.js` brings a SeedFall tracker state file into a project: 379
features, 221 decisions, the answers to 45 questions, and a 400-entry activity
trail. Two things about how it does that will be re-argued by anybody who reads
the result, so they are written down here.

## Decision 1: no area epics

The feature ids carry an area — `F-LOAD-001` is LOAD, `F-UI-041` is UI — and
there are 25 of them. Grouping the features under 25 `EPIC` parents is the
obvious move: it gives the work list a hierarchy, the Gantt something to collapse
and the roadmap something to group by.

**It also moves the numbers.** `rollup.readiness` weights *every* work package in
the list; only `points` and `hours` exclude containers, and they do it because a
parent's points are its children's. Twenty-five parents sitting at `not_started`
would add twenty-five zero-weight rows to a denominator of 379 and report a
project that is 62% ready as roughly 58% ready — a figure computed from rows that
this importer invented, in somebody else's project.

So the area is a **custom field**, `Area`, scoped to the imported project, with
the 25 codes as its possible values. It is the same idiom the demo portfolio uses
for `Domain` and `Slice tag`, it filters, and it adds nothing to any count.

The alternative fix — parents with a status whose weight is NULL, so they leave
the denominator — was rejected. `deferred` and `rejected` are the excluded
statuses and they mean something; labelling a structural row "deferred" to keep
it out of a sum is the kind of trick that is invisible six months later.

The import checks this rather than asserting it. The last thing it prints is the
tracker's completion counts beside the file's, and it exits non-zero if they
differ.

## Decision 2: it merges, and it never deletes

The file is a *state*, not an event log — it is rewritten as the project moves —
so the useful operation is "make the tracker agree with this file", run again
whenever a newer one arrives.

- A feature already there whose status has changed is **moved**, and the move is
  written to the activity trail as a status change, so the feed reads as what
  happened rather than as a bulk edit.
- The file's trail is a rolling window, so a re-import overlaps the last one.
  Entries are deduplicated on their timestamp and their subject, which is exactly
  as unique as the source makes it.
- A feature that has **left** the file keeps its work package. It may have been
  renamed; the file may be older than the tracker. Both are somebody's decision,
  and neither is a script's. The summary counts them so the discrepancy is
  visible rather than silent.

`--dry-run` runs the whole import and rolls the transaction back, rather than
taking a separate read-only path: two implementations of "what would happen" is
one implementation nobody runs and one that stops matching.

## What the import does not carry

- **Dates.** The file has none, so the work packages have none. The history is
  not lost with them: the trail imports at the timestamps things actually
  happened at.
- **A person.** Nobody is made assignee or accountable, because the file does not
  say who. The author is whoever ran the import, because somebody did.
- **Phases and gates.** The file has no lifecycle, and inventing six phases to
  fill the panel would be inventing. The overview says "no phases recorded" in
  words instead.
- **The question text.** The file keeps answers, not questions. The comment each
  answer becomes says so, rather than presenting half a conversation as a whole
  one.

## Consequences

- An unsettled decision sets the project's health to **rust** and names the
  decisions in the health note. Rust is reserved for work waiting on a person,
  and a decision nobody has made is exactly that. Health is recorded rather than
  derived (`0003`), and this is a recording.
- Activity notes longer than 800 characters are cut to fit `activities.detail`
  and **counted**, and the summary says how many. The trail is a summary by
  design; a silent truncation is a record that lies about being complete.
- The actor labels in the imported trail are the source tracker's own —
  `claude`, `browser`. Neither is an account here and neither is mapped onto one.
