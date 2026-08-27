# The MCP server

```bash
node src/mcp/server.js
```

stdio, JSON-RPC 2.0, protocol `2024-11-05`. There is no listening port and no
tunnel: the client launches this as a child process, so nothing is exposed to the
network.

## Client configuration

```json
{
  "mcpServers": {
    "projecttracker": {
      "command": "node",
      "args": ["/path/to/ProjectTracker/src/mcp/server.js"],
      "env": {
        "PT_DB_HOST": "127.0.0.1",
        "PT_DB_USER": "projecttracker",
        "PT_DB_PASSWORD": "…",
        "PT_DB_NAME": "projecttracker",
        "PT_MCP_TOKEN": "pt_mcp_…"
      }
    }
  }
}
```

Issue the token in the app under **Repositories & MCP**, or:

```bash
node -e "require('./src/api/mutations2').issueMcpToken({user:{id:1,is_admin:true}},{name:'assistant',scope:'read'}).then(t=>console.log(t.secret))"
```

The secret is shown once. Only its sha256 and its last four characters are
stored, so it is not recoverable from the database.

### The `env` block is optional, and better left out

`src/config.js` loads the project's `.env` before the first query, so putting
`PT_MCP_TOKEN` and the database settings there instead leaves the client entry as
a command and a path — and leaves the token in the one gitignored file rather
than in a second one. On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File ops\register-mcp.ps1 show          # print the entry, check .env has a token
powershell -ExecutionPolicy Bypass -File ops\register-mcp.ps1 desktop-add   # write it into Claude Desktop's config
```

### It is not a service, and cannot be one

There is no port, so there is nothing for a background copy to listen on. Started
without a client attached it reads EOF on stdin and exits. "Run it as a service"
for a stdio server means registering it with the client, which starts it on
demand and kills it on close. `ops/README.md` has the long version.

## Without a token

The server starts, answers `initialize`, and refuses every tool call with a
message saying `PT_MCP_TOKEN` is not set. That is deliberate: a client's error
surface for "the process died" is usually nothing at all, and a refusal that
explains itself is findable.

## The tools

| Tool | Mode | What it does |
|---|---|---|
| `portfolio.status` | read | Weighted readiness, gate state and health per project, plus completion as three counts |
| `work_packages.query` | read | Filter by project, status, type, priority, version, sprint, assignee, overdue, free text |
| `wiki.read` | read | One document by number or slug, or the list. Returns the **revision** a save must be made against |
| `activity.recent` | read | The activity trail, newest first |
| `project.create` | **write** | A project, optionally from a template blueprint — its phases, versions, wiki skeleton, boards and seed work packages |
| `work_package.create` | **write** | A work package, resolving type, status, priority, assignee, version and sprint by their codes |
| `work_package.update` | **write** | Change one, through the status workflow, re-deriving the dates that follow it |
| `version.create` | **write** | A version. No due date is UNSCHEDULED, which is a state and not an omission |
| `wiki.create` | **write** | A wiki page, at revision 0 |
| `wiki.update` | **write** | Replace a page body. `base_revision` is required |
| `comment.add` | **write** | A comment on a work package or a wiki page. Never internal |
| `summary.write` | **write** | Post a generated summary to a person's My page |
| `git.links` | read | What a work package is in the repository, asked by `WP-112` **or** by the key the repository knows it by (`F-LOAD-012`). `unmapped: true` answers the other direction: work with no forge object, and forge objects with no work package |
| `git.deck` | read | Repositories: pull requests, issues, CI, the health score, the mapping table, the webhook state and how much work is connected |
| `git.pull` | **write** | Pull a repository now and re-match its keys. A write because it reaches the network on the tracker's behalf and, where a repository is configured for it, can move a status. `dry_run` writes nothing |

`git.deck` and `git.links` return a health score and a CI success rate. **Neither
is progress**, and both tool descriptions say so in words an assistant reads
before it calls them: repository hygiene and pipeline health are not readiness,
and adding them to a completion figure is the arithmetic this tracker exists to
avoid.

A read-scoped token is **not offered** any of the write tools in `tools/list`.
Not listing them is the more useful half of the refusal: a tool that is listed
and always refuses teaches an assistant to keep trying it.

`mcp_tools` is what that listing filters against — a row that is disabled is not
offered — and the Repositories & MCP screen shows the table.

### Arguments are checked against the tool's own schema

An argument no tool declares is **refused**, not ignored, and the refusal lists
the arguments the tool does take. A caller that writes `assigned_to` where the
tool wanted `assignee` has otherwise created a work package with no assignee and
no way to find out why. It is the rule `src/domain/query.js` applies to an
unknown filter, for the same reason.

## What a write runs as

A token is not a person, and every permission here is answered per person. So a
write **runs as whoever issued the token** — `mcp_tokens.created_by` — and calls
the same functions in `src/api/mutations*.js` that the web app and the CLI call.

- A token can do no more than its issuer. One issued in the name of a Reader is
  refused `add_work_packages`, naming the permission.
- The status workflow, the milestone's single date, the subject pattern and the
  automations that fire after the commit are not reimplemented here, so they
  cannot drift.
- The **activity trail records the machine**, not the issuer:
  `actor_label = 'mcp · <hint>'` and `actor_id = NULL`. A comment is signed in
  its body as well, because the drawer, a share and an export show the body and
  none of them read the trail.
- A token whose `created_by` is empty may read and may not write.

The token's scope narrows it further: a project-scoped token may not create a
project, because a project it created would be outside its own scope.

`docs/decisions/0006` has the argument, including the two options rejected — a
system account with `is_admin = 1`, and a second write path inside this server.

## What the server tells the assistant about itself

The `initialize` response carries instructions, because the numbers here are
easy to misread:

> Readiness figures are WEIGHTED (speccing 0.35, in build 0.7, done 1) and are
> not completion percentages — completion is the separate done/partial/not-started
> counts. Deferred and rejected work is excluded from the denominator rather than
> scored zero. Story points are summed over leaf work only, so a parent never
> counts its children. Internal comments are never returned by any tool. Every
> call you make is recorded in an audit table, reads included.

## The four rules

1. **Every call is audited, reads included.** `mcp_audit` carries the tool, the
   mode, the arguments verbatim, the outcome, a note, the row count, the project
   scope in force and the duration. "What did the assistant look at" is the
   question an audit is actually asked. The response *body* is not recorded — an
   audit that grows faster than the data it audits gets truncated, and a
   truncated audit is worse than a narrow one.
2. **Internal comments are never returned**, at any scope. Excluded in the SQL,
   not filtered in a wrapper.
3. **A token is required and is scoped** — read or write, and optionally to a
   list of projects.
4. **The write tools are separately scoped.** A read token cannot be talked into
   writing, and the refusal is audited like any other call.
5. **A write borrows its issuer's authority and is recorded as a machine.** See
   above, and `docs/decisions/0006`.

`docs/decisions/0005` has the reasoning, including what it settles from the
design canvas's open question `D-19`.

## Reading the audit

```sql
SELECT created_at, token_hint, tool, mode, outcome, row_count, duration_ms, arguments
  FROM mcp_audit ORDER BY id DESC LIMIT 50;
```

Or in the app: **Repositories & MCP** shows the last twenty calls and the total.
"Is this being recorded" is answerable from the UI rather than from a shell.
