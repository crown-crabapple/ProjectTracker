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
| `wiki.read` | read | One document by number or slug, or the list |
| `activity.recent` | read | The activity trail, newest first |
| `summary.write` | **write** | Post a generated summary to a person's My page |

A read-scoped token is **not offered** `summary.write` in `tools/list`. Not
listing it is the more useful half of the refusal: a tool that is listed and
always refuses teaches an assistant to keep trying it.

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
4. **The write tool is separately scoped.** A read token cannot be talked into
   writing, and the refusal is audited like any other call.

`docs/decisions/0005` has the reasoning, including what it settles from the
design canvas's open question `D-19`.

## Reading the audit

```sql
SELECT created_at, token_hint, tool, mode, outcome, row_count, duration_ms, arguments
  FROM mcp_audit ORDER BY id DESC LIMIT 50;
```

Or in the app: **Repositories & MCP** shows the last twenty calls and the total.
"Is this being recorded" is answerable from the UI rather than from a shell.
