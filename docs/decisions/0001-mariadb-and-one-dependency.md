# 0001 — MariaDB, and one npm dependency

**Date:** 2026-08-26
**Status:** accepted

## Context

The brief asks for a tracker "based on the tracker in the SeedFall repo" that
"should use MariaDB as the database". The SeedFall tracker is a zero-dependency
Node app over a single hand-editable `state.json`, and its zero-dependency
property is something the repository is deliberate about.

MariaDB cannot be reached without a driver, so the dependency count cannot stay
at zero. The question is where it stops.

## Decision

**One runtime dependency: `mysql2`.** Everything else the app needs is written
here: the HTTP router, the multipart parser, password hashing, the markdown
renderer, the CSV / XLSX / PDF / iCal writers, and the MCP protocol handler.

`mysql2` rather than the `mariadb` connector: prepared-statement support with a
stable placeholder syntax, and it is the driver every MariaDB deployment guide
already assumes. Either would work; this one has the larger body of published
answers when something goes wrong at 11pm.

## Why each of the four "written here instead" is written here

- **The router.** The app needs path parameters, a JSON body, a cookie, a static
  handler and a file upload. That is the whole list, and it is smaller than the
  configuration surface of anything that would provide it. What a framework
  would genuinely buy — a middleware ecosystem — is not something a
  single-purpose tracker draws on.
- **The multipart parser.** This is the one place a package would have earned its
  keep and the trade did not come out that way: forty lines of buffer scanning
  against a package with its own temp-file handling, its own limits, and its own
  history of path-traversal advisories. The version here writes nothing to disk;
  it hands the caller buffers and lets `src/domain/files.js` decide where bytes
  go, which is the part worth controlling.
- **The export writers.** CSV is nine lines of quoting. XLSX is a store-only zip
  of five XML parts — no deflate implementation to get wrong, and Excel and
  LibreOffice both accept it. The PDF is a single text stream, and it is
  deliberately plain: a report that *looked* designed but was assembled by string
  concatenation would invite a restyle request there is no layout engine to
  answer. iCal is a text format whose only trap is the folding rule.
- **The MCP handler.** The whole surface is `initialize`, `tools/list` and
  `tools/call`. A dependency that moves underneath a security boundary is a
  dependency to audit on every upgrade, and this boundary is "what may an
  assistant read".

## What would reverse this

A second data store, a real templating need, or a requirement for
character-level collaborative editing. The last one is the most likely: the wiki
currently does presence plus optimistic concurrency and refuses a conflicting
save (see `0004`). Doing better than that needs a CRDT, and a CRDT is not
something to write.

## Cost accepted

Four small implementations to maintain, and a PDF export that will look plain to
anybody expecting a designed report. The PDF says so in its own footer.
