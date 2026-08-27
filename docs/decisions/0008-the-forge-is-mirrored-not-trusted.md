# 0008 — The forge is mirrored, not trusted, and the mapping is per type

**Date:** 2026-08-27
**Status:** accepted

## Context

The tracker had `repositories`, `repository_revisions` and `integrations` since
the first version, and `docs/features.md` said in as many words that nothing
polled anything: the rows were real, the network half was not. The ask was to
integrate [gitdeck](https://github.com/debba/gitdeck) — a local dashboard over
GitHub, GitLab and Forgejo — and to be able to map the six work package types
back to a repository and pull, so that `F-LOAD-012` finds pull request #978.

Gitdeck is MIT-licensed React and TypeScript over a Node server with an on-disk
cache and OAuth device flow. Four things about bringing it here needed deciding
rather than discovering.

## Decision 1: port the model, do not vendor the app

Gitdeck as it stands is nineteen runtime and dev dependencies, a Vite build and a
second HTTP server. `docs/decisions/0001` sets the bar for a second dependency —
say what it replaces and why forty lines will not do — and a whole second
application clears no bar at all.

What was worth having is the *model*: the repository grid with its health score,
cross-repository pull requests and issues, CI health, the security summary, the
daily digest. That is arithmetic over a normalised item shape, and it is now
`src/domain/gitdeck.js` (pure), `src/gitdeck/client.js` (three forges over the
platform `fetch`) and `src/gitdeck/pull.js` (the writer). The health score is
gitdeck's, kept number for number so a repository reads the same in both; the
selftest pins it.

Three things did not come:

- **The token store.** Gitdeck keeps device-flow tokens under `~/.gitdeck`. This
  app's rule is that no credential is in the database *or* in a file it owns: a
  repository records the NAME of an environment variable and the token is read
  from `process.env` at the moment of the call. Device flow exists to obtain and
  store a token, so it has nothing to store into here, and a personal access
  token in the environment is the only way in.
- **The disk cache.** The mirror in MariaDB *is* the cache. A cache in front of it
  would be a second answer to "what is the state of PR 978".
- **The AI digest.** Gitdeck can hand the digest counts to OpenAI for a paragraph.
  That is a second dependency and a third party reading a private repository's
  titles. The counts are here; the paragraph is not, and the payload says so.

## Decision 2: a pull mirrors, it does not decide

The obvious feature is "merge the pull request, close the feature". It is also
the feature that makes people turn integrations off, because the first time it
closes something that was not finished, nobody trusts the status column again.

So: **every status rule ships NULL.** Out of the box a pull writes items, links
and an activity entry, and changes no work package's status at all. A repository
whose conventions have earned it can name a status in `git_type_rules`
(`merged_status_id`, `closed_status_id`), and even then:

- the move goes through `mutations.updateWorkPackage`, so `status_transitions`
  refuses an illegal one exactly as it would refuse a person's — `not_started`
  cannot jump to `done` because a pull request merged;
- it runs as the person who ran the pull and can do nothing they could not;
- the trail records `gitdeck` **instead of** them, so a status that moved because
  CI went green never reads as somebody having sat down and moved it.

The pull writes the mirror, the links and the trail in one transaction, and
applies the status moves *after* it commits — the rule automations already
follow, for the same two reasons.

## Decision 3: a link says why it exists, and a person outranks the matcher

A link is a claim about somebody's work, so every row carries how it came to be:
`origin` (key, branch or manual), `matched_key` (the literal `F-LOAD-012`) and
`matched_in` (title, body or branch). The UI never paints a link a regex made and
a link a person made the same.

Two rules keep the matcher honest:

- **Where the key was written decides whether it is a claim.** A key in the title
  or the branch is what the change *is*; nobody names a branch after work it
  merely refers to. A key in the body is a *mention* unless a closing verb claims
  it, because `blocked on WP-112` and `closes WP-112` are opposite sentences and
  the only difference between them is the verb.
- **A link a person removed is never re-made.** Removing one sets `removed_at`
  and keeps the row, like a revoked share; the puller then holds that pair back
  for ever and counts it. An integration that overturned a person's decision
  every fifteen minutes would be one nobody leaves switched on.

A key that resolves to nothing is kept in `git_unmatched_keys` with a count.
A branch named for work the tracker has never heard of is the most useful thing a
pull reports, and a counter cannot say which key it was.

## Decision 4: the mapping belongs to the type, and the key is a column

The six types mean different things in a repository, so the mapping is three
columns on `work_package_types` — seeded, overridable per repository:

| Type | Maps to | As | Key |
|---|---|---|---|
| PHASE | milestone | tracks | `PH-` |
| EPIC | issue | tracks | `E-` |
| FEATURE | **pull request** | implements | `F-` |
| TASK | issue | implements | `T-` |
| BUG | issue | fixes | `B-` |
| MILESTONE | release | releases | `M-` |

`wp_key` is `CONCAT('WP-', id)` and cannot be chosen, so a project whose history
calls a feature `F-LOAD-012` needs somewhere to say so: `work_packages.ref_key`,
unique per project, validated against the shape the matcher can actually find. It
is a column rather than a search over subjects because a subject is free text
somebody will improve — `F-LOAD-012 parse decisions` is a better subject, and
would silently stop every branch matching. `db/import-state.js` fills it from the
SeedFall feature id on the way in, which is where most of these keys come from.

Two projects legitimately both have an `F-LOAD-012`, so the key is unique per
project and a match against a work package in another project is refused and
reported rather than linked across.

## Decision 5: a health score is not readiness

The deck reports a health score, a CI success rate and a mapping coverage
percentage. None of them is progress, and this codebase has already paid for
mixing two measurements once — the SeedFall tracker's *built* figure. So they
live in `src/domain/gitdeck.js` rather than `rollup.js`, they never enter a
denominator on the portfolio page, and the payload, the screen, the CLI and the
MCP tool description all say which is which in words.

Where a signal could not be read, the score says so in `basis` instead of scoring
it as bad: a self-hosted Forgejo has no traffic endpoint, and a token without the
security scope cannot see alerts. Nought open alerts and no permission to look
are opposite facts — the same argument as *excluded is not zero*.

## Consequences

- One outbound client now exists, in one file, reached from one route and one CLI
  command. `docs/features.md` no longer says nothing polls anything, and says
  exactly what does.
- A pull is bounded: two pages per endpoint, and it reports that it stopped
  rather than implying it saw everything.
- Anything that needs pulling on a schedule is still somebody's cron calling
  `node src/cli/tracker.js pull`. There is no scheduler here, and pretending
  otherwise is the thing this file exists to prevent.
