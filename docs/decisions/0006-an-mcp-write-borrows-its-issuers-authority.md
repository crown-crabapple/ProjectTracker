# 0006 — An MCP write borrows its issuer's authority, and the trail records the machine

**Date:** 2026-08-26
**Status:** accepted

Extends `0005`, which settled the audit format and allowed one write tool. This
settles what happens when there are eight.

## Context

`summary.write` could avoid the question. A generated summary has no author in
the tracker's sense: it writes one row in `generated_summaries`, checks no
project permission, and records itself in the activity trail with an
`actorLabel` and no `actorId`.

Creating a project, a work package, a version or a wiki page cannot avoid it.
Each of those checks a permission — `add_work_packages`, `manage_versions`,
`edit_wiki` — and every permission in this tracker is answered per *person*:
`access.permissionsFor(userId, projectId)`. There is no membership, and no role,
for "the assistant". Each of them also fills a foreign key that names a person:
`work_packages.author_id`, `documents.created_by`, the Owner membership a new
project must have.

Three ways out were available.

1. **A system user.** `users.kind` already has a `system` value, and the demo
   dataset seeds one. Writes would run as it. But it holds no membership, so
   `access.require` refuses everything, and the only way to make it work is
   `is_admin = 1` — an account with every permission in the database, in every
   project, that nobody can sign in as and nobody granted.
2. **The MCP server does its own permission checks** against the token's scope
   and writes its own SQL. That is a second write model beside
   `src/api/mutations*.js`: a second place that knows a milestone has one date,
   that a status change goes through `status_transitions`, that automations fire
   after the commit. Two of them drift, and the drift is invisible until the two
   disagree in front of somebody.
3. **Borrow the issuer's authority.**

## Decision

**A write tool runs as the person who issued the token, and the activity trail
records the machine instead of them.**

`mcp_tokens.created_by` is that person. The MCP server builds the same `ctx` the
web app and the CLI build — `{ user, actorLabel }` — and calls the same mutation
functions. So:

- **A token can never do what its issuer cannot.** A token issued in the name of
  a Reader is refused `add_work_packages`, and the refusal names the permission.
  This is a stronger bound than the token's own scope, and it is checked by the
  same code that checks it for a browser request.
- **There is one write model.** The status workflow, the milestone's single date,
  the subject pattern, the parent-type rule, the automations that fire after the
  commit, the optimistic-concurrency refusal on a wiki save — the MCP server
  knows none of them, and cannot get them wrong.
- **The trail names the machine.** `notify.record` and `notify.notify` write
  `actor_id = NULL` whenever an `actorLabel` is given. Not at each call site: at
  the choke point, because a call site that forgets is a call site that lies.

The label is `mcp · <the token's four-character hint>`, so the trail identifies
*which* token, not merely that a machine was involved.

A token with no `created_by` — one inserted by hand — can read and cannot write,
and the refusal says why.

## What the token's own scope still decides

The issuer's permissions are the ceiling; the token's scope narrows it further.

- A project-scoped token may not create a project. A project it created would be
  outside its own scope, which is the scope escaping rather than being enforced.
- Every write names its target by code or key, and a target outside the scope is
  "no project X in this token's scope" — the same answer a read gets.

## Where the machine is still not visible

Named, rather than left to be discovered:

- **`documents.created_by` and `documents.updated_by` are the issuer.** The wiki
  screen shows "updated by" and there is no label column beside it, so a page
  written through this server shows the issuer's name there. The activity trail
  and the revision note both say the machine wrote it. Closing this properly
  means a column, its reader in two views, and a check — worth doing when
  somebody is editing that screen anyway.
- **`comments.author_id` is the issuer** for the same reason. The tool signs the
  comment body instead, the way the email intake signs a comment it received
  ("— received by email from …"), so the drawer, a share, an export and the CLI
  all show who wrote it without any of them reading the trail.

## Consequences

- An argument no tool declares is refused rather than ignored, in
  `checkArguments`, against the tool's own schema. Silently dropping `internal`
  from a comment, or `assigned_to` from a work package, does something other than
  what was asked — the same reason `src/domain/query.js` throws on an unknown
  filter.
- `wiki.update` **requires** `base_revision`, and `wiki.read` returns the
  revision to pass. Decision `0004` refuses to merge two edits; a machine writer
  with no base revision would simply overwrite, which is the failure `0004`
  exists to prevent.
- The audit now records a wiki body verbatim, because `0005` records arguments
  verbatim and for a write the argument *is* the change. That is the audit
  growing at the rate of the content, and it is accepted for writes and still
  refused for read *responses*.
- `mcp_tools` gained seven rows, in `db/migrations/0001`. A database seeded
  before the write tools existed would otherwise filter them out of `tools/list`
  and make them unreachable.
