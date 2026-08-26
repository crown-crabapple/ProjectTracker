# 0002 — The progress model is data, and excluded is not zero

**Date:** 2026-08-26
**Status:** accepted

## Context

Every percentage in this product comes from one calculation: a weighted sum over
work package statuses. The SeedFall tracker's version used constants in code —
`{ not_started: 0, speccing: 0.35, in_build: 0.7, done: 1 }`, with `deferred` and
`rejected` excluded.

Two questions had to be settled: where the weights live, and what "excluded"
means.

## Decision

**The weights are a column.** `statuses.progress_weight DECIMAL(3,2) NULL`.
Adding a status is an administration action rather than a deploy, and so is
changing the model.

**NULL means excluded from the denominator. It is not the same as 0.**

## Why excluded rather than zero

Take ten features: five done, five deferred.

- **Excluded:** the figure is 100% of five scored items. That is the honest
  number, because the deferred five are no longer work this project claims to be
  doing.
- **Scored zero:** the figure is 50%, which implies five items still to build.

Scoring zero also makes the number gameable in both directions: a project looks
*worse* by deferring work and *better* by rejecting it, and neither is true. So
the API accepts `null` and the string `"excluded"` explicitly and refuses to
infer one from the other — a client cannot mean one and get the other.

## Why readiness is reported beside completion, never instead of it

Weighted readiness is not a completion figure and cannot be read as one. The
SeedFall tracker added *done* and *in build* together and called the total
"built", which reported a milestone as 49/49 with four features unfinished.

So `rollup.completion()` returns four counts — done, partial, not started,
remaining — and every screen that shows a percentage shows those beside it. The
percentage carries its denominator too (`weighted over 35 scored · 1 excluded`),
because a percentage with no denominator invites the reader to supply one.

## Why 0.35 and 0.7

They are the two points where a person's answer to "how far along is this" stops
moving. A spec that exists but is not agreed is about a third of the way; code
that runs but is not reviewed is about two thirds. They are not derived from
anything and are not claimed to be — which is the reason they are editable.

## Consequences

- `db/seed-reference.js` is the only place the shipped values appear.
- Changing a weight writes to the activity trail with the old and new values,
  because it moves every figure in the portfolio at once.
- The administration screen spells out `EXCLUDED FROM THE DENOMINATOR` rather
  than showing a blank: in a table a blank and a `0` look similar and mean
  opposite things.
- The selftest asserts that deferring work cannot raise readiness, and that a
  weight of zero and an excluded status behave differently. Those two checks are
  the guard on this decision.
