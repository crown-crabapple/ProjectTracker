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
| **Team collaboration** — activity feeds, collaborative document editing, meetings with agendas and minutes, news, @mentions, internal comments, wiki, decisions as records rather than pages, forums, XWiki link | `#/activity`, `#/wiki`, `#/decisions`, `#/meetings` · `documents`, `document_presence`, `meetings`, `news`, `forums`, `comments.internal`, `decisions` |
| **Seeing the shape of a project** — the work breakdown as a tree, what comes before what, and which decisions gate which, with readiness and completion side by side at every level | `#/map` · `src/api/views7.js`, `src/domain/graph.js` |
| **Roadmap & release planning** — version progress, one product timeline, Git and Subversion repositories, GitHub, GitLab and Forgejo pulled into a git deck with the work mapped both ways | `#/roadmap`, `#/deck`, `#/connect` · `versions`, `repositories`, `git_items`, `work_package_git_links`, `src/gitdeck/` |
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
node db/import-state.js FILE    # import a SeedFall tracker state file (--dry-run first)
node src/cli/tracker.js pull    # fetch a repository and re-match its keys (--dry-run first)
node src/cli/tracker.js decisions # the open decisions, what they block, and what they wait on
npm start                     # the web server
npm test                      # the selftest, against a throwaway database
node src/cli/tracker.js help  # the command line
node src/mcp/server.js        # the MCP server, on stdio
```

`schema.sql` is the base and is applied only to an empty schema. Once a database
exists, changes arrive as numbered files in `db/migrations/` — editing
`schema.sql` to change a live table is the mistake that split makes impossible.

### Unattended, on Windows

```powershell
powershell -ExecutionPolicy Bypass -File ops\service.ps1 install       # web server, as SYSTEM, at boot
powershell -ExecutionPolicy Bypass -File ops\service.ps1 status
powershell -ExecutionPolicy Bypass -File ops\register-mcp.ps1 show     # how to register the MCP server
```

The web server runs as a **scheduled task** rather than an SCM service, because
`node.exe` implements no service control handler and the wrappers that make it
one are a new dependency. The MCP server **cannot** be a service at all: it is
stdio, so there is no port for anything to connect to, and the client launches
it. `ops/README.md` has both arguments in full.

## The git deck

`#/deck` is [gitdeck](https://github.com/debba/gitdeck)'s dashboard — a repository
grid with a health score, cross-repository pull requests and issues, CI health, a
security summary and a daily digest — ported into this app's shape, plus the
thing a tracker needs that a dashboard does not: **the mapping**.

Each of the six work package types declares what it *is* in a repository:

| Type | Maps to | As | Key |
|---|---|---|---|
| PHASE | milestone | tracks | `PH-` |
| EPIC | issue | tracks | `E-` |
| FEATURE | **pull request** | implements | `F-` |
| TASK | issue | implements | `T-` |
| BUG | issue | fixes | `B-` |
| MILESTONE | release | releases | `M-` |

So `F-LOAD-012` maps to pull request #978. A work package is addressable by its
own key (`WP-124`, generated from the id) **and** by the key its repository knows
it as (`work_packages.ref_key` — `F-LOAD-012`), which is what a branch name, a
pull request title or a commit message actually carries. A pull reads titles,
bodies and branch names, matches both forms, and records on every link the key
that matched and where it was found.

```bash
node src/cli/tracker.js deck                 # repositories, health, CI, how much is mapped
node src/cli/tracker.js pull --dry-run       # fetch and match, write nothing
node src/cli/tracker.js pull seedfall/seedfall
node src/cli/tracker.js links F-LOAD-012     # what one work package is in the repository
node src/cli/tracker.js key WP-112 F-UI-007  # the key the repository knows it by
```

Six properties are worth knowing before switching it on:

- **No credential is stored.** A repository records the *name* of an environment
  variable; the token is read from `process.env` at the moment of the call. A
  database dump carries no secret, and the deck reports whether the variable is
  set. This is also why there is no OAuth device flow: it exists to obtain and
  store a token, and there is nowhere here to store one.
- **A pull mirrors, it does not decide.** Out of the box it changes no work
  package's status. A repository can be configured so that a merge moves one, and
  even then the move goes through the same status workflow the web app uses and
  is refused if the workflow refuses it.
- **A link a person removes is never re-made.** The row is kept, and the puller
  holds that pair back for ever. An integration that overturns a decision every
  quarter of an hour is one nobody leaves on.
- **A key in a title or a branch is a claim; a key in a body is a mention** until
  a closing verb claims it. `blocked on WP-112` and `closes WP-112` are opposite
  sentences.
- **A key that matches nothing is kept and listed**, with how many times it was
  seen. A branch named for work the tracker has never heard of is the most useful
  thing a pull can tell you.
- **A health score is not readiness.** Neither is a CI success rate. They are
  repository hygiene and pipeline health, they never enter the portfolio's
  percentages, and every surface that shows them says so.

### Webhooks

A forge can also tell the tracker as things happen, rather than waiting to be
asked. Point it at `POST /api/hooks/git/<repository id>` — the deck shows the
full URL, and `pt hooks` prints the path:

```bash
node src/cli/tracker.js hooks          # the endpoints, the secret variable, what has arrived
```

- **An unsigned delivery is never accepted.** The URL is not a secret — it is in
  the forge's settings page and on the deck — so the signature is what stands
  between the internet and somebody's plan. GitHub and Forgejo sign the body,
  GitLab sends the secret back in a header; either way the HMAC is over the raw
  bytes and the comparison is constant time.
- **A repository that names no secret has no open endpoint.** Set
  `hook_secret_env` to the NAME of an environment variable holding the shared
  secret — the same rule as the API token, so nothing lands in the database.
- **A delivery moves a status only where the repository names somebody for it to
  act as** (`hook_actor_id`). Nobody starts a webhook, so a change needs somebody
  answerable for it; it can do no more than that person could by hand, and the
  trail records `gitdeck · webhook` instead of them. With nobody named, a delivery
  mirrors and links and says a status change was implied and not made.
- **Every delivery is kept with its reason, refusals included.** "The forge says
  it delivered and the tracker shows nothing" is otherwise unanswerable. A retry
  keeps its own row saying it was ignored.
- Deliveries go through the puller's own write path, so a pull request that
  arrives by webhook and the same one fetched an hour later produce the same row.

There is **still no scheduler**. A webhook covers what changes; `pt pull` is what
reconciles a repository afterwards — a delivery missed while the server was
restarting is missed for good, and the deck's "pulled 3 days ago" is what makes
that visible. Put the CLI in cron if you want it hourly.
`docs/decisions/0008` and `0009` have the argument for all of it.

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

stdio, JSON-RPC 2.0, fifteen tools — six that read and nine that write.
`docs/mcp.md` has the client configuration.

Five properties, each of which is the answer to a question somebody will ask:

- **Every call is audited, reads included.** "What did the assistant look at" is
  the question an audit is actually asked; logging only writes answers a
  different one. `mcp_audit` carries the tool, the arguments, the outcome, the
  row count and the duration.
- **Internal comments are never returned**, at any scope — excluded in the SQL,
  not filtered in a wrapper.
- **A token is required and is scoped.** Read or write, and which projects.
- **The write tools are separately scoped.** A read token is not offered any of
  them in `tools/list` and is refused if it calls one anyway.
- **A write runs as the person who issued the token** and can do no more than
  they can, calling the same mutation functions the web app calls — and the
  activity trail records the machine rather than them. `docs/decisions/0006`.

## Importing a tracker state file

```bash
node db/import-state.js state.json --project SF --as stephen --dry-run
node db/import-state.js state.json --project SF --as stephen
```

The SeedFall tracker keeps its state as one JSON document: a feature ledger, a
decision log, the answers to the questions it asked, and a rolling activity
trail. Its status vocabulary is this app's, so a feature imports as itself.

Features become work packages — carrying the feature id as their **repository
key**, so a branch called `feature/f-load-012-decisions` finds one after the
import — questions become comments on the feature they name, decisions become
one row in `decisions` each with their state carried across, and the trail
imports with its original timestamps and its original actor labels — `claude`
and `browser` are not accounts here, and stay labels.

It **merges**. Run it again with a newer file and it moves the statuses that
changed, appends the trail entries it has not seen, and writes the new decisions.
It never deletes: a feature that has left the file keeps its work package, and
the summary counts them rather than tidying them away.

The last thing it prints is the check that matters — the tracker's completion
counts beside the file's. If they disagree it says so and exits non-zero, because
an imported figure that is wrong by a little is worse than one that is missing.
`docs/decisions/0007` has the two decisions behind the mapping.

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
