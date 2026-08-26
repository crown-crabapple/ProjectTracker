# 0003 — Project health is recorded, not derived

**Date:** 2026-08-26
**Status:** accepted

## Context

The design shows a health chip per project — green, amber, rust, off — and the
obvious implementation is to derive it: overdue work, slip against baseline, open
immediate bugs, gates missed.

## Decision

`projects.health` is a value a person records, with `projects.health_note`
beside it saying why.

## Why deriving it was rejected

Every derivation tried made a project look healthy while its gate was blocked,
because **a blocked gate has no schedule signature**. The seeded CDX project is
the worked case: nothing is overdue, nothing has slipped, no bug is open, and the
project cannot advance because the criterion for its next gate is itself an
undecided question. Every schedule-based rule scores that green.

The reverse case is as common: a manuscript project where a date is a hope
rather than a commitment shows as amber forever under any overdue rule. The
seeded overdue-escalation automation is turned off for exactly this reason, and
the note on the row says so.

## What is derived instead, and shown next to it

- weighted readiness, and the three completion counts
- slip against the current baseline, per work package
- whether the current phase is blocked (`project_phases.state = 'blocked'`)
- open counts by status, priority and type

A reader gets the numbers and the judgement side by side, which is what lets them
disagree with the judgement.

## Consequences

- Setting health writes to the activity trail with the previous value, because a
  health change is a claim somebody made on a date.
- `health_note` is shown in the top bar rather than the enum, so the chip reads
  `BUILD · ON PLAN, 9 DAYS OF SLIP` instead of `AMBER`.
- Nothing recomputes health, so a stale one stays stale. That is the accepted
  cost, and it is visible: the note carries a claim a reader can check against
  the derived figures beside it.
