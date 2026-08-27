# The HTTP API

Every route is in `src/http/server.js`, in the order the browser calls them. A
route nothing calls is not there: a second write path that no client uses is one
more way for two paths to disagree.

Authentication is a session cookie (`pt_session`, httpOnly, SameSite=Lax) except
on the three routes that exist for callers with no account — a share link, a
calendar client and a mail transport.

Every response carries a strict `Content-Security-Policy` with no external
origins, `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`.

## Errors

Failures answer with `{ "error": "a sentence a person can act on" }` and a status
that means what it says:

| Status | Meaning |
|---|---|
| 400 | the request is wrong — an unknown filter, an unknown sort, a bad date |
| 401 | not signed in, or a share link that is invalid, revoked or expired |
| 403 | signed in and not allowed; the message names the permission |
| 404 | no such thing, or no such thing *you can see* — the two are deliberately indistinguishable |
| 405 | the path exists with a different method; `Allow` says which |
| 409 | a conflict — an illegal status transition, a stale document revision |
| 500 | a bug. Logged with a stack; the client is told nothing about it |

A 409 on a document save carries `currentBody` and `currentRevision` so the
client can show both versions rather than just refusing.

An unknown path under `/api/` is a JSON 404, never the SPA shell — handing a
client HTML where it expected JSON produces a parse error that names the wrong
problem.

## Session

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/session` | `{ user }` or `{ user: null }`. Never returns the token: it is in an httpOnly cookie, and handing it to page script would give up what that buys. |
| `POST` | `/api/session` | `{ login, password }`. One message for every failure, so accounts cannot be enumerated. |
| `DELETE` | `/api/session` | Deletes the row, not just the cookie. |

## Read — one endpoint per screen

Each returns exactly what one view draws, already rolled up. The alternative — a
generic resource API the browser assembles a screen from — was rejected because
every number on these screens is a derivation with a rule attached, and a client
that assembles them itself will eventually get one of those rules wrong.

| Path | Returns |
|---|---|
| `GET /api/bootstrap` | user, visible projects with their life-cycle summary, statuses, priorities, types, programs, theme tokens, nav counts |
| `GET /api/my` | KPIs, my work, date alerts, six weeks of availability, the latest generated summary |
| `GET /api/portfolio?favourites=1` | KPIs scoped to what is shown, programs → projects, templates, life-cycle rollup, lists |
| `GET /api/projects/:id/overview` | project, phases with criteria, KPIs, status bar and rows, type chips, versions, members, activity, widget layout |
| `GET /api/work?project&q&status&type&priority&version&sprint&open&closed&overdue&unassigned&involves&sort&flat` | rows with depth and highlight, shown/total, filter chip counts, any parent cycles |
| `GET /api/gantt?project&baseline` | timeline bounds, month and week rulers, today, rows with bar and baseline positions, relations |
| `GET /api/boards?project&type=status\|version\|subproject\|wbs\|sprint` | derived columns with cards, and the note explaining what dragging means |
| `GET /api/backlogs?project` | sprint columns with burn, the product backlog, velocity |
| `GET /api/roadmap` | every version in scope on one timeline, with progress |
| `GET /api/calendar?project&month=YYYY-MM` | whole weeks of cells with due dates, meetings and sprint starts |
| `GET /api/planner?weeks&from` | people × weeks of booked-against-capacity |
| `GET /api/activity` | the inbox (with read state) and the feed (without) |
| `GET /api/wiki?project&doc` | the document list, the current document, revisions, live editors, news, forum topics |
| `GET /api/decisions?project&decision` | every decision in scope with its state, layer in the gating chain and what it blocks; the selected one in full — question, answer, rationale, the work linked to it by relation, what it depends on and what depends on it, and whether it can settle; KPIs (open, settled, superseded, work blocked, oldest open, chained); the whole gating graph by layer |
| `GET /api/map?project&group=none\|version\|type\|assignee` | one project drawn three ways: the work-breakdown tree (collapsed by the client, every branch carrying the readiness and completion of its whole subtree), the relations graph laid out in columns with the edges that close a loop named, and the decision graph with what each decision holds up and where every link came from. Readiness and completion are separate keys at every level and are never added. `project` is required; an unknown `group` is refused. Over 150 connected work packages the relations graph reports its count and is not drawn. |
| `GET /api/meetings?project&meeting` | the schedule and one meeting's agenda, minutes and outcomes |
| `GET /api/connect` | integrations, repositories, revisions, the MCP surface and its audit, the email intake. **Administrator only.** |
| `GET /api/admin?tab=fields\|workflow\|auto\|roles\|theme\|initiation` | **Administrator only.** |
| `GET /api/deck?project&repo` | the git deck: repositories with their health score, CI summary and mapping coverage, the mirrored pull requests, issues, milestones, releases, CI runs and alerts with the work packages each is linked to, the keys that matched nothing, recent pulls, and the type → forge-object mapping table |
| `GET /api/wp/:id/git` | what one work package is in the repository: what its type maps to, the keys it is addressable by, its links (removed ones included, marked), and its linked commits |
| `GET /api/wp/:id` | the drawer: every attribute, relations, watchers, files, time entries, comments, shares, custom values, baseline, progress with its basis named |

## Write

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/wp` | Create. A blank subject is generated from the type's pattern if it has one. |
| `PATCH` | `/api/wp/:id` | Only the attributes in `mutations.EDITABLE`; anything else is a 400. A status change is checked against `status_transitions`. |
| `POST` | `/api/wp/:id/watch` | `{ on, user_id }` |
| `POST` | `/api/wp/:id/comments` | `{ body, internal }`. Returns who was mentioned **and who could not be resolved**. |
| `POST` | `/api/wp/:id/attachments` | multipart. Content-addressed; the filename is a label. |
| `POST` | `/api/wp/:id/share` | `{ email, permission, days }` → a URL. Internal comments are excluded at any permission. |
| `DELETE` | `/api/shares/:id` | Sets `revoked_at`; the row stays, so "who could see this in September" is answerable. |
| `POST` | `/api/projects` | From a template, in one transaction. |
| `POST` | `/api/projects/:id/favourite` | |
| `POST` | `/api/projects/:id/health` | `{ health, note }`. A judgement, recorded with its reason — see `decisions/0003`. |
| `POST` | `/api/projects/:id/gates/:phaseId` | Signs a gate. Refused if the criterion is undecided, or if the criterion mentions immediate bugs and one is open. |
| `POST` | `/api/projects/:id/baseline` | `{ name, note }`. A copy of every date, status and point total. |
| `POST` | `/api/projects/:id/reschedule` | `{ apply }`. With `apply: false` it reports what *would* move — which is what lets the UI say "this will move four other things" before it does. |
| `POST` | `/api/sprints/:id/close` | Fires the carry-forward automation if it is on. |
| `POST` | `/api/boards/move` | `{ work_package_id, board_type, column }`. Writes what the column means, through the same validation as the drawer. |
| `POST` | `/api/backlog/reorder` | `{ project_id, ids }` |
| `PATCH` | `/api/documents/:id` | `{ body, base_revision, note }`. A stale revision is a 409 carrying the other version. |
| `POST` | `/api/documents/:id/presence` | A heartbeat. Returns who else is live. |
| `POST` | `/api/meetings/:id/agenda` | 409 once the meeting has opened — the agenda freezes and edits go to the minutes. |
| `POST` | `/api/meetings/:id/minutes` | `{ body, outcomes }`. Notifies every participant. |
| `POST` | `/api/notifications/read` | `{ all }` or `{ ids }` |
| `PATCH` | `/api/preferences` | `highlight_mode`, `start_screen`, `show_ai_summaries`, `theme_id`, `timezone` |
| `POST` | `/api/allocations` | `{ user_id, week_start, hours }`. Zero removes the booking. |
| `POST` | `/api/alerts/run` | Evaluates the date alert rules now. |

### Administration — administrator only

| Method | Path | Notes |
|---|---|---|
| `PATCH` | `/api/admin/statuses/:id` | `{ weight }`. A number 0–1, or `null` / `"excluded"`. **This moves every percentage in the portfolio**, and the change is written to the activity trail with the old and new values. |
| `PATCH` | `/api/admin/automations/:id` | `{ enabled, note }`. Turning one off requires a note. |
| `POST` | `/api/admin/custom-fields` | |
| `POST` | `/api/custom-values` | Validated against the field's possible values, pattern and required flag. |
| `POST` | `/api/admin/mcp-tokens` | Returns the secret **once**. Only its sha256 is stored. |
| `DELETE` | `/api/admin/mcp-tokens/:id` | |
| `POST` | `/api/admin/initiation/:id` | `{ approve, note, code }` |

## The git deck

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/repositories` | Connect one. `token_env` is the NAME of an environment variable and a value shaped like a token is refused with the reason. Needs `manage_repositories`. |
| `PATCH` | `/api/repositories/:id` | Change where it is, or which variable its token comes from. |
| `POST` | `/api/repositories/:id/pull` | **The only route that reaches the network.** Fetches, mirrors, matches, and — where the repository is configured to — moves a status through the ordinary workflow. `{ "dry_run": true }` does everything except write and is still recorded. Returns what it saw, what it linked, what it held back and every key that matched nothing. |
| `POST` | `/api/repositories/:id/mapping` | Override what one type maps to in this repository, and optionally what a merge or a close does to it. Both status fields default to nothing. |
| `POST` | `/api/wp/:id/ref-key` | Set the key the repository knows this work package by — `F-LOAD-012`. Unique per project; a shape no branch could carry is refused. |
| `POST` | `/api/wp/:id/git-links` | Link by `item_id`, or by `kind` and `ref` ("PR 978"). The item must already be in the mirror: nothing here invents a forge object it has not seen. |
| `DELETE` | `/api/git-links/:id` | Remove a link. **The row is kept** and no pull will ever re-make that link — see `docs/decisions/0008`. |
| `POST` | `/api/hooks/git/:id` | **No session.** A forge delivery. See below. |

### The webhook endpoint

`POST /api/hooks/git/:id` is what a forge is pointed at. It takes no session —
the caller is a machine elsewhere — and the signature stands in for one:

- **An unsigned delivery is never accepted.** GitHub and Forgejo sign the body
  (`X-Hub-Signature-256`, `X-Forgejo-Signature`); GitLab sends the secret back in
  `X-Gitlab-Token`. The HMAC is computed over the **raw bytes**, before the body
  is parsed, and compared in constant time.
- The secret is read from the environment variable named by
  `repositories.hook_secret_env`. A repository that names none has **no open
  endpoint**, and says so in the refusal.
- Both `application/json` and GitHub's `application/x-www-form-urlencoded`
  (`payload=…`) are read; the signature is over the form body either way.
- Bodies are bounded at 2 MB. An oversized one is refused and recorded.
- 200 for applied and for ignored (a `ping`, a retry, an event nothing is
  mirrored from — each with a `reason`), 401 for anything that does not verify,
  404 for a repository that does not exist. **Every one of those is recorded** in
  `git_hook_deliveries` with its reason, refusals included.
- A delivery moves a work package's status only where `repositories.hook_actor_id`
  names somebody for it to act as, and then only as far as that person's
  permissions and the status workflow allow. With nobody named it mirrors and
  links, and the response says a status change was implied and not made.

## Decisions

A decision is a record, not a wiki page — `docs/decisions/0010`. All six writes
need `record_decisions` on the decision's project and are otherwise a 403
`you do not have "record_decisions" on this project`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/decisions` | `{ project_id, ref, title, question, answer, rationale, owner_id, due_on, document_id, position }`. `ref` must match `/^[A-Za-z][A-Za-z0-9-]{0,23}$/` or it is a 400 `"${ref}" is not a decision ref - one letter to start, then letters, digits or dashes, up to 24 characters - D-14`. A blank title is a 400 `a decision needs a title, phrased as a question`. `ref` clashing with one already in the project is a 409 `${ref} is already used in this project`. A portfolio-wide decision (`project_id` NULL) is not created here — the same restriction `mutations2.createDocument` puts on a portfolio-wide wiki page — so a missing or non-positive `project_id` is a 400 `a decision needs a project - a portfolio-wide decision is not raised here`. Returns `{ id, ref, title, state: 'open' }`. |
| `PATCH` | `/api/decisions/:id` | Any of `title, question, answer, rationale, state, owner_id, due_on, position, document_id, superseded_by`; any other key is a 400 naming it, `"${key}" is not an editable attribute`. An empty patch is a 400 `nothing to change`. An invalid `state` is a 400 `state must be one of open, settled, superseded`. Moving `state` to `settled` while a live dependency is still open is a 409 carrying `decisions.canSettle`'s reason, `"${ref} waits on ${refs}, which is/are still open"`. Settling records `decided_by` and `decided_at`; moving away from `settled` or `superseded` back to `open` clears both. |
| `POST` | `/api/decisions/:id/work` | Link work to a decision, or revive a link this same endpoint removed. `{ work_package_id, relation, origin, matched_in, note }`. `relation` is one of `blocks`, `informs`, `arose_from` (default `blocks`); `origin` one of `person`, `import`, `matcher` (default `person`) and only carries `matched_in` when it is not `person`. The work package must be visible to the caller or it is a 403 `that work package is not visible to you`. Already linked is a 409 `${wp_key} is already linked to ${ref}`; a link a person removed is refused for anything but an `origin: 'person'` call, 409 `${wp_key} was unlinked from ${ref} by hand, so it is not re-linked automatically`. |
| `DELETE` | `/api/decisions/:id/work/:wpId` | Sets `removed_at`; the row stays and is never revived by anything but a later `origin: 'person'` link. 409 `that link is already removed`. |
| `POST` | `/api/decisions/:id/depends` | Gate `:id` on another decision. `{ depends_on_id, note }`. A decision cannot depend on itself, 400 `${ref} cannot depend on itself`. An existing live edge is a 409 `${ref} already waits on ${dependsOnRef}`. An edge that would close a loop is a 400 naming the loop by ref, checked with `decisions.wouldCycle` against every live edge in the database, not just the caller's project. |
| `DELETE` | `/api/decisions/:id/depends/:otherId` | Sets `removed_at`; the row stays. 409 `that dependency is already removed`. |

## No account needed

These three exist because their callers cannot hold a cookie.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/share/:token` · `/share/:token` | One work package. Never any internal comment. Revoked and expired links are 401. A malformed token is refused before any lookup. |
| `GET` | `/api/list-share/:token` · `/share/list/:token` | A project list, re-evaluated as its owner. |
| `GET` | `/ical/:token.ics` | The calendar feed. Token in the path, because a calendar client cannot send a header. |
| `POST` | `/api/intake/email` | Requires `X-Intake-Secret: $PT_SECRET`. Without `PT_SECRET` set the endpoint refuses everything rather than accepting everything. |

## Exports

`GET /api/export/work/{csv,xlsx,pdf}` with the same query parameters as
`/api/work`, so what you export is what is on screen.

CSV carries a UTF-8 BOM (so Excel reads it as UTF-8) and neutralises a cell that
starts with `=`, `+`, `-` or `@` (so an exported subject cannot execute).

`GET /api/attachments/:id` serves one file, with `Content-Disposition: inline`
only for the allow-listed types and `attachment` for everything else.
