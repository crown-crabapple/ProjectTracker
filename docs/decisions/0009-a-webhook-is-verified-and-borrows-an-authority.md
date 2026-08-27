# 0009 — A webhook is verified, recorded, and borrows an authority

**Date:** 2026-08-27
**Status:** accepted

## Context

`docs/decisions/0008` left the git deck pull-only: somebody presses PULL, or cron
runs `pt pull`, and the mirror catches up. The obvious next step is for the forge
to tell us instead — a merged pull request should reach the tracker in the second
it merges, not at the top of the next hour.

A webhook endpoint is the first thing in this codebase that takes instructions
from the public internet. The email intake is close, but it is fed by a mail
transport somebody configured on the same host and it can only ever create a task
or a comment; a git webhook can, if configured to, move a work package's status.
Four decisions follow from that.

## Decision 1: an unsigned delivery is never accepted

Not accepted with a warning, not accepted because the body parses, not accepted
because the URL is hard to guess. **The URL is not a secret** — it is in a
settings page on the forge, on the deck screen, and in `pt hooks` output — so
the signature is the only thing between the internet and somebody's plan.

So the endpoint is *closed by default*: a repository with no `hook_secret_env`
has no working webhook at all, and a delivery to it is refused with a message
saying exactly that. A repository that names a variable which is unset in this
process is refused too, and the refusal names the variable, because "401" with no
reason is how somebody spends an afternoon on a typo.

The secret is the NAME of an environment variable, like every other credential
here. Verification reads `process.env` at the moment of the delivery.

Two mechanics that are easy to get wrong and are therefore pinned by checks:

- **The HMAC is over the raw bytes, before anything is parsed.** Re-serialising
  the parsed JSON and hashing that is the classic way to build a check that
  passes for a body other than the one that was signed.
- **The comparison is constant time**, and a length mismatch answers false rather
  than throwing.

GitHub and Forgejo sign the body; GitLab sends the secret back verbatim in a
header, which is weaker and is GitLab's decision rather than this app's. It is
still only ever compared against the secret the repository names, in constant
time.

## Decision 2: every delivery is recorded, refusals included, with the reason

`git_hook_deliveries` keeps a row for every delivery: the event, the action, the
forge's delivery id, whether the signature verified, what it changed, the reason,
and the body (truncated). Refusals keep their row like a rejected email in
`email_intake` and a revoked share.

The question this exists to answer is "the forge says it delivered and the
tracker shows nothing". Without the row, the only answer is a log file, and by
then it has rotated.

A retry is a fact: a redelivery of an id already applied is recorded as its own
row saying it was ignored, rather than replacing the first row or being applied
twice.

## Decision 3: it writes through the pull's own path

`src/gitdeck/mirror.js` was extracted from the puller for this: match, write the
mirror in the caller's transaction, apply status moves after it commits. A
receiver with its own writer would eventually disagree with the puller about
which relation to record, whether a removed link comes back, or what an unmatched
key means — and the two would drift silently, because nobody diffs a webhook
against a pull.

The consequence worth stating: a pull request that arrives by webhook and the
same pull request fetched an hour later produce **the same row**, because both
go through the same normaliser in `src/gitdeck/client.js` and the same matcher in
`src/domain/gitdeck.js`.

## Decision 4: a delivery borrows an authority, or moves nothing

A pull runs as the person who started it and can do no more than they can. Nobody
starts a webhook. So either a delivery moves no work package at all, or somebody
has to be answerable for the moves it makes.

`repositories.hook_actor_id` names that person — the same argument as an MCP
token's issuer in `docs/decisions/0006`. It is NULL by default. With nobody
named, a delivery mirrors and links and **says in its own record that a status
change was implied and not made**, because "nothing happened" and "nothing could
have happened" are different facts and only one of them is a misconfiguration.

Where an actor is named:

- the change can do no more than that person could do by hand — the same
  permission check, the same `status_transitions` workflow;
- the activity trail records `gitdeck · webhook` **instead of** them;
- and the actor is validated when it is set, not when it fires: naming somebody
  without `edit_work_packages` in that project is refused with the reason, rather
  than producing a webhook that silently refuses every status change it implies,
  at three in the morning, into a table nobody is watching.

## Consequences

- The mirror can now be live. The scheduler is still not here and still is not
  pretended to be: a webhook covers what changes, and `pt pull` remains how a
  repository is reconciled after downtime — a delivery missed while the server
  was restarting is missed for ever, and the deck's "pulled 3 days ago" is what
  makes that visible.
- The endpoint is bounded: 2 MB per delivery, and an oversized body is refused
  and recorded rather than buffered.
- An event the receiver does not map is recorded as ignored with the event named,
  not refused. A 400 on `star` teaches whoever configured it to narrow the
  subscription until something useful is missing too.
