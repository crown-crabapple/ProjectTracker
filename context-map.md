# context-map.md — where everything lives

A landmark map, not a file listing. It answers "where would that be?" without
searching blind.

## The three layers, and what each one owns

| Layer | Owns | Never does |
|---|---|---|
| `db/` | the shape of the data, and the demo dataset | compute a rollup |
| `src/domain/` | every rule and every derived number | HTTP, or build SQL from a value |
| `src/api/` + `src/http/` | requests, permissions, transport | arithmetic |
| `public/` | drawing what the API sends | deciding what a number means |

The rule that keeps them apart: **a percentage is computed in exactly one
place.** `src/domain/rollup.js` is that place, and the web app, the CLI and the
MCP server all call it. Anything that computes its own is a second progress
model.

## Landmarks

### Data
- `db/schema.sql` — 85 tables, sectioned by domain, with the derivation for
  every non-obvious column. The base; applied only to an empty schema.
- `db/migrations/NNNN_*.sql` — changes after that. Empty today.
- `db/migrate.js` — creates the database, applies the base then the migrations,
  records what ran in `schema_migrations`, and leaves **one account that can sign
  in** so the demo portfolio is optional. It only ever adds that account when
  nothing in the database can sign in.
- `db/seed-reference.js` — the vocabulary the app cannot run without: statuses
  and their **progress weights**, priorities, work package types, roles,
  permissions, the work week, the theme, the form configurations, help texts.
  Upserted, so re-running it after an upgrade is how a new status arrives.
- `db/demo-data.js` — the design canvas's dataset, as data.
- `db/seed.js` — loads both. Refuses to seed a portfolio twice.

### Rules
- `src/domain/rollup.js` — **weighted readiness, completion as three counts,
  leaf-only points, velocity, the load cell, hierarchy flattening.** Read the
  header before changing a number anywhere.
- `src/domain/scheduling.js` — work weeks, automatic date derivation, baseline
  comparison, timeline positions. Every date is an ISO string and every step
  goes through `Date.UTC`.
- `src/domain/lifecycle.js` — phases, gates, and the rule that a project cannot
  leave a phase until its gate criterion is *recorded* as met.
- `src/domain/access.js` — permissions as the **union** of direct and group
  roles. `seesInternal()` is the internal-comment gate.
- `src/domain/query.js` — the one work package query. Every list, board, chart,
  export and MCP call goes through `select()`. An unknown filter throws.
- `src/domain/automations.js` — custom actions, one action per kind, never
  recursing.
- `src/domain/notify.js` — the activity trail and the notification fan-out,
  including the date alert sweep.
- `src/domain/subject.js` — automatic subject generation.
- `src/domain/files.js` — content-addressed attachments.
- `src/domain/passwords.js` — scrypt.

### Transport
- `src/http/server.js` — every route, in one file, in the order the browser calls
  them. A route nothing calls is not here.
- `src/http/router.js` — the router and the `HttpError` shapes.
- `src/http/body.js` — JSON, form and multipart parsing.
- `src/http/auth.js` — sessions, cookies, share tokens.

### Read and write
- `src/api/views.js` — bootstrap, My page, and the shared row shape.
- `src/api/views2.js` — portfolio, project overview, work list, Gantt, activity feed.
- `src/api/views3.js` — boards, backlogs, roadmap, calendar, planner, activity page.
- `src/api/views4.js` — wiki, meetings, connections, administration, the drawer.
- `src/api/mutations.js` — work packages, comments, gates, shares, attachments.
- `src/api/mutations2.js` — projects, baselines, sprints, boards, wiki, meetings,
  preferences, allocations, administration, MCP tokens, the email intake.
- `src/api/exports.js` — CSV, XLSX, PDF and iCal, each written by hand with the
  reason stated in the header.

### Surfaces
- `public/index.html` — the shell and the script order.
- `public/app.css` — the token set and the class vocabulary. **The colour rule is
  at the top and is load-bearing: rust is reserved.**
- `public/app.js` — state, routing (**the URL is the state**), the render loop.
- `public/lib/dom.js` — `h()`. No `innerHTML` anywhere, which is why a work
  package subject containing a script tag is text in all sixteen views.
- `public/lib/api.js` — fetch, error surfacing, superseded-request cancellation.
- `public/lib/md.js` — a markdown renderer that builds nodes, not a string.
- `public/views/*.js` — one file per screen, matching the API endpoint.
- `src/cli/tracker.js` — the command line.
- `src/mcp/server.js` — the MCP server: five tools, a scoped token, a full audit.

### Checks and records
- `test/selftest.js` — 200 checks against a throwaway database.
- `docs/decisions/` — the decisions that would otherwise be re-derived.
- `docs/features.md` — the brief's feature list mapped to code, with the gaps
  named.
- `docs/api.md`, `docs/schema.md`, `docs/mcp.md`.

## Things that look editable and are not

- `db/schema.sql` once a database exists. Add a migration.
- `tracker` row counts, percentages, velocity — all derived on read. There is
  nowhere to write them.
- `var/files/` — content-addressed by digest. Delete an `attachments` row
  instead; the bytes go when the last row referencing them does.
- The status **weights**: they are data, and changing one moves every percentage
  in the portfolio. The administration screen says so before it lets you.

## Where a number comes from

| On screen | Computed by |
|---|---|
| any `%` readiness | `rollup.readiness()` |
| done / partial / not started | `rollup.completion()` |
| story points, velocity | `rollup.points()`, `rollup.closedPoints()` — leaf work only |
| booked vs capacity | `rollup.loadCell()` |
| the Gantt's bar positions | `scheduling.timelinePosition()` |
| slip | `scheduling.compareToBaseline()` — against a stored copy, never recomputed |
| gates met, next gate | `lifecycle.summarise()` |
| a drawer's progress bar | `views4.drawer()`, and it names its own basis |
