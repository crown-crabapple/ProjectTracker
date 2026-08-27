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
