# 0005 — The MCP audit records reads, not just writes

**Date:** 2026-08-26
**Status:** accepted

## Context

The design canvas leaves one decision open, as `D-19`: *can the MCP server
write?* Its note says read-only is enough for the summary surface, that writing a
summary back to My page is a write, that scoped tokens would make it safe, and
that **nobody has written the audit format**.

That is the decision this settles, because the audit format is the blocker.

## Decision

**Every MCP call is audited, reads included**, and the write tool is allowed
behind a separately scoped token.

`mcp_audit` carries: the token (id and four-character hint, kept even if the
token row is deleted), the tool, the mode, **the arguments verbatim**, the
outcome (`ok` / `denied` / `error`), a result note, the row count, the project
scope in force, and the duration.

## Why reads

"What did the assistant look at" is the question an audit is actually asked.
Logging only writes answers a different one, and the different one is easier —
which is why it is the one that usually gets built.

The concrete case: a token scoped to two projects is used to call
`work_packages.query` with no project filter. Nothing is written. Nothing goes
wrong. And the only record that the assistant saw thirty work packages across
two projects is the read log.

The arguments are recorded verbatim for the same reason: an audit that records
the tool but not what it was asked for cannot answer "did it read the thing it
should not have".

## Why the write tool is separately scoped, and listed conditionally

`summary.write` needs `mcp_tokens.scope = 'write'`. A read token is not offered
it in `tools/list` at all, and is refused with a message if it calls it anyway.

Not listing it is the more useful half: a tool that is listed and always refuses
teaches an assistant to keep trying it.

## What the audit does not do

It does not record the *response body*. A read of the whole portfolio would put a
copy of the portfolio in the audit table, and an audit that grows faster than the
data it audits gets truncated, and a truncated audit is worse than a narrow one.
The row count and the arguments bound the answer instead.

## Consequences

- Internal comments are excluded from every tool at every scope, in the SQL, so
  the audit never needs to record that they were filtered.
- `summary.write` supersedes rather than deletes the previous summary, and writes
  to the activity trail tagged as a machine.
- The connections page shows the audit and its total count, so "is this being
  recorded" is answerable from the UI rather than from the database.
- The demo `mcp_tools` row for `summary.write` is `in_build` rather than `done`,
  because the tool works and the surrounding policy — who may issue a write
  token, and for how long — is a decision for whoever deploys this.
