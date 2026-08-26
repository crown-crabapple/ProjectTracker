# ProjectTracker

A portfolio and project tracker over MariaDB, built to the shape of the tracker
in the [SeedFall](https://github.com/crown-crabapple/SeedFall) repository and to
the design canvas attached to the brief.

Two runtime dependencies: **MariaDB 10.6+** and **Node 20+**. One npm package,
`mysql2`. Nothing to build — the front end is served as it is written.

```bash
cp .env.example .env      # fill in the database details
npm install
node db/migrate.js        # create the schema, and one login that can sign in
node db/seed.js           # reference data + a worked demo portfolio
npm start                 # http://127.0.0.1:4180
```

With the demo portfolio, sign in as **stephen** / **projecttracker**. It is the
dataset from the design canvas, carried over row for row so the running app and
the mockup can be compared side by side.

**To start empty instead**, skip `seed.js` and load the vocabulary only:

```bash
node db/migrate.js              # prints the password for the `admin` account
node db/seed.js --reference     # statuses, roles, the work week — required
npm start
```

`migrate.js` creates an administrator called `admin` whenever nothing in the
database can sign in, and generates its password and prints it once. Set
`PT_ADMIN_PASSWORD` (and `PT_ADMIN_LOGIN`, `PT_ADMIN_NAME`, `PT_ADMIN_EMAIL`)
beforehand to choose them; `--no-login` skips the account. It never touches an
account that already exists, so it is safe on every re-run: there is no shipped
default password anywhere, because that would be a credential in the source tree.

---

## What it inherited from the SeedFall tracker

That tracker keeps three things apart and refuses to let them drift: **scope**
(what the work is), **tracking** (status, answers, notes, an activity trail) and
**the rollup** (every number the UI shows, computed, never stored). This one is
that state file normalised into MariaDB, and it carries the two rules that made
it worth copying.

**Weighted readiness is not completion.** Readiness is a weighted sum —
speccing 0.35, in build 0.7, done 1 — and is reported beside three separate
counts (done / partial / not started), never folded into one number. The
SeedFall tracker once added *done* and *in build* together and called the total
"built", which reported a milestone as 49/49 with four features unfinished.

**Excluded is not zero.** A status with a NULL progress weight leaves the
denominator. Scoring it zero would mean a project could be made to look worse by
deferring work and better by rejecting it, and neither is true. The
administration screen says the words `EXCLUDED FROM THE DENOMINATOR` rather than
showing a blank, because in a table a blank and a `0` look similar and mean
opposite things.

The weights are a database column, not a constant, so changing the progress
model is an administration action rather than a deploy. `docs/decisions/0002`
has the argument.

---

## The feature set

| Area | Where it lives |
|---|---|
| **Project portfolio management** — shareable project lists, favourites, programs, customisable overview dashboards, a life cycle with phases and gates, project templates, a personal My page, activity tracking, multi-project views | `#/portfolio`, `#/overview`, `#/my` · `project_lists`, `programs`, `project_phases`, `project_templates`, `dashboards`, `saved_views` |
| **Planning & scheduling** — Gantt, work packages, relations and hierarchies, automatic and manual scheduling, work-week definitions, resource management, baseline comparison, calendar, date alerts, team planner, organisations | `#/gantt`, `#/calendar`, `#/planner` · `src/domain/scheduling.js`, `baselines`, `work_weeks`, `resource_allocations`, `date_alerts`, `organizations` |
| **Task management & issue tracking** — filterable lists, assignee / accountable / watcher, automatic subject generation, real-time notifications, sharing outside a project, file management, email-to-task, attribute highlighting, export | `#/work`, the drawer · `src/domain/subject.js`, `work_package_shares`, `attachments`, `email_intake`, `src/api/exports.js` |
| **Agile, Kanban & Scrum** — status / version / subproject / work-breakdown / sprint boards, backlogs, sprints shared across projects (SAFe), story points, several active sprints | `#/boards`, `#/backlogs` · `boards`, `sprints`, `sprint_projects` |
| **Team collaboration** — activity feeds, collaborative document editing, meetings with agendas and minutes, news, @mentions, internal comments, wiki, forums, XWiki link | `#/activity`, `#/wiki`, `#/meetings` · `documents`, `document_presence`, `meetings`, `news`, `forums`, `comments.internal` |
| **Roadmap & release planning** — version progress, one product timeline, Git and Subversion repositories, GitHub and GitLab integrations | `#/roadmap`, `#/connect` · `versions`, `repositories`, `integrations` |
| **Workflows & customisation** — automated project initiation, status workflows, custom actions, custom themes, form configuration, attribute help texts, unlimited custom fields, fine-grained roles / permissions / groups, placeholder users | `#/admin` · `status_transitions`, `automations`, `themes`, `form_configurations`, `custom_fields`, `roles`, `users.kind = 'placeholder'` |
| **Other** — MCP server for AI assistants, responsive design | `src/mcp/server.js`, `public/app.css` |

`docs/features.md` maps every item in the brief to the code and the table that
implements it, and says plainly where a feature is thinner than the phrase in
the brief might suggest.

---

## Running it

```bash
node db/migrate.js              # apply what is pending, and ensure a login exists
node db/migrate.js --status     # what would run, what already has, who can sign in
node db/migrate.js --force      # drop the database first (asks)
node db/migrate.js --no-login   # apply migrations and create no login
node db/seed.js                 # reference data + demo portfolio
node db/seed.js --reference     # reference data only — safe on a live database
npm start                     # the web server
npm test                      # the selftest, against a throwaway database
node src/cli/tracker.js help  # the command line
node src/mcp/server.js        # the MCP server, on stdio
```

`schema.sql` is the base and is applied only to an empty schema. Once a database
exists, changes arrive as numbered files in `db/migrations/` — editing
`schema.sql` to change a live table is the mistake that split makes impossible.

## The command line

Same database, same rollup functions, no browser. A CLI that computed its own
percentages would be a second implementation of the progress model, and the two
would eventually disagree in front of somebody who had to decide which to
believe.

```bash
node src/cli/tracker.js report                 # where the portfolio stands
node src/cli/tracker.js next                   # what to pick up, and what is blocked
node src/cli/tracker.js plan VW                # the life cycle, rolled up
node src/cli/tracker.js list --project VW --open
node src/cli/tracker.js show WP-112
node src/cli/tracker.js status WP-112 in_build --note "picked this up"
node src/cli/tracker.js gate VW G4 --note "scope locked"
node src/cli/tracker.js export xlsx --project VW
```

Every command runs as a real user with real permissions — `--as LOGIN` or
`PT_CLI_USER` chooses who. With neither, it runs as the single administrator if
there is exactly one and refuses to guess between several: a migrated *and*
demo-seeded database has two (`admin` and `stephen`), so name one. There is no
ambient superuser, so the CLI cannot do something the web app would refuse.

## The MCP server

stdio, JSON-RPC 2.0, five tools. `docs/mcp.md` has the client configuration.

Four properties, each of which is the answer to a question somebody will ask:

- **Every call is audited, reads included.** "What did the assistant look at" is
  the question an audit is actually asked; logging only writes answers a
  different one. `mcp_audit` carries the tool, the arguments, the outcome, the
  row count and the duration.
- **Internal comments are never returned**, at any scope — excluded in the SQL,
  not filtered in a wrapper.
- **A token is required and is scoped.** Read or write, and which projects.
- **The one write tool is separately scoped.** A read token is not offered
  `summary.write` in `tools/list` and is refused if it calls it anyway.

## Testing

```bash
npm test
```

**The suite runs against a throwaway database and never the configured one.**
That is not a precaution invented here. The SeedFall tracker's suite once
exercised its store and its HTTP server against the real state file and backed
itself out with a backup/restore; the restore ran before the spawned server was
killed, a late flush from the child overwrote it, and a settled decision and a
feature's status were destroyed and committed. Pointing the connection pool at a
temp schema before the first query makes that structurally impossible rather
than unlikely. The final check fingerprints every table in the configured schema
before and after, and reports a difference as a note rather than a failure when
it cannot have come from the suite — a concurrent writer on a shared machine is
legitimate, and failing on it is how a check gets deleted.

The suite covers the progress model, scheduling arithmetic, subject generation,
the gate rules, filename handling, all four export formats, the router, the
permission union, the status workflow, internal-comment visibility on the wire,
shares, the email intake, sessions, the MCP scope boundary, and every HTTP
endpoint including traversal attempts and the 403s.

## Where things are

```
db/       schema.sql, migrate.js, seed.js, demo-data.js
src/
  config.js        environment, read once
  db.js            the pool; every identifier goes through ident()
  domain/          rollup, scheduling, lifecycle, access, notify, automations,
                   subject, query, files, passwords — no HTTP, no SQL strings
                   built from values
  api/             views (read, one function per screen), mutations (write),
                   exports
  http/            router, body/multipart, auth, server
  cli/tracker.js   the command line
  mcp/server.js    the MCP server
public/           index.html, app.css, fonts.css, fonts/, app.js, lib/, views/ —
                  no build step
test/selftest.js
docs/
```

`context-map.md` is the landmark map. `docs/decisions/` holds the decisions that
would otherwise have to be re-derived.

## Security notes

- Sessions are a random 32-byte token in an httpOnly, SameSite=Lax cookie with a
  row that can be deleted. No JWT: a token that can be revoked beats one that
  cannot.
- Passwords are scrypt with N=2^15, from `node:crypto`.
- **No credential is stored in the database.** Each repository and integration
  records the *name* of the environment variable its token is read from, so a
  database dump carries no secret. The connections page shows whether that
  variable is set, which is the useful fact.
- An MCP token is stored as a sha256 hash with a four-character hint. The secret
  is shown once and is not recoverable.
- Every response carries a strict `Content-Security-Policy` with no external
  origins. The front end has no CDN, no external font — Instrument Sans and
  Archivo are served from public/fonts/ — and no inline script, so
  the policy can be strict — and a strict policy is what makes a stored comment
  body harmless. `image/svg+xml` is deliberately not in the inline-serving
  allow-list: an SVG is a document that can carry script.
- Uploaded files are content-addressed by sha256 and the client's filename is
  never used as a path.
