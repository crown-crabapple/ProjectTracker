# The brief, mapped to the code — and what is thin

Every item the brief asked for, where it lives, and how far it actually goes.
The third column is the point of this document: a feature list that says
"implemented" against everything is a feature list nobody can plan from.

Three words are used precisely:

- **Done** — works end to end, has a screen, and is covered by the selftest.
- **Partial** — the mechanism is real and the stated part is missing. The gap is
  named, not implied.
- **Modelled** — the data model, the API and the screen exist; the outbound
  network half does not. Nothing in this repository polls GitHub.

---

## Project portfolio management

| Item | Where | State |
|---|---|---|
| Project lists — shareable | `project_lists`, `project_list_shares`, `GET /api/list-share/:token`, `public/share.js` | **Done.** A list stores its filter, never the resulting ids, and the share re-evaluates it as the owner. A frozen copy would go stale silently. |
| Project lists — favourites | `project_favorites`, the star in the portfolio table | **Done.** |
| Portfolios / programs | `programs`, `#/portfolio` grouped by program | **Done.** |
| Customisable project overview dashboards | `dashboards`, `dashboard_widgets`, `#/overview` | **Partial.** The widget list comes from the database and the page draws the six kinds it knows, skipping an unknown kind with a note rather than crashing. There is no drag-to-rearrange UI: the layout is changed by editing rows. |
| Project life cycle with phases and gates | `project_phases`, `src/domain/lifecycle.js` | **Done.** A gate is a date and a person, not a flag; a phase whose criterion is an open decision is `blocked` and is the only thing allowed to draw in the reserved colour. |
| Project templates | `project_templates.blueprint`, `mutations2.createProject` | **Done.** Applied in one transaction — phases, versions, wiki skeleton, boards, seed work packages, the Owner membership. A project half-created from a template is worse than none. |
| Personal "My page" dashboard | `#/my`, `GET /api/my` | **Done.** |
| Activity tracking | `activities`, `#/activity` | **Done.** Never deleted, never capped, and a machine actor is drawn differently from a person. |
| Multi-project views | `saved_views` with `project_id NULL`, `visible_projects` filter | **Partial.** Cross-project querying works everywhere (the roadmap, My page and the portfolio are all cross-project). Saved views are stored and seeded but have no picker in the UI yet. |

## Project planning & scheduling

| Item | Where | State |
|---|---|---|
| Gantt charts | `#/gantt`, `views2.gantt` | **Done.** Bars coloured by status so the chart reads like the tables; the week ruler is sized by days so its gridlines land on the month boundaries. |
| Work packages | `work_packages`, `src/domain/query.js` | **Done.** |
| Relations and hierarchies | `work_package_relations`, `rollup.flattenHierarchy` | **Done.** Stored one-way with the inverse derived on read; a cycle is reported rather than looped over. |
| Automatic / manual scheduling | `work_packages.scheduling`, `scheduling.derive` | **Done.** Successors then parents, deepest-first; a non-converging plan is reported as a loop rather than half-applied. Preview mode says what a reschedule would move before it moves it. |
| Work-week definitions | `work_weeks`, `non_working_days` | **Done.** Arithmetic only: weekends are shaded on the calendar, never hidden. |
| Resource management | `users.weekly_capacity`, `resource_allocations`, `#/planner` | **Done.** |
| Baseline comparison | `baselines`, `baseline_entries`, `scheduling.compareToBaseline` | **Done.** A stored copy, never recomputed, so a slip cannot be edited away. Slip is the *due* shift: starting late and finishing on time is not a slip. |
| Calendar | `#/calendar` | **Done.** |
| Date alerts | `date_alerts`, `notify.runDateAlerts` | **Done.** A rule that already fired for the same work package today does not fire again. |
| Team planner | `#/planner` | **Done.** Hours booked against no declared capacity are reported as booked, not as over capacity. |
| Organizations | `organizations`, `organization_users`, shown on the overview | **Partial.** Stored and displayed; no management screen. |

## Task management & issue tracking

| Item | Where | State |
|---|---|---|
| Filterable task lists | `#/work`, `query.FILTERS` | **Done.** An unknown filter throws rather than being ignored — a silently dropped filter returns more than the caller asked for, which on a shared link is a disclosure. |
| Assignee / accountable / watcher roles | three columns plus `work_package_watchers` | **Done.** Kept apart on purpose: collapsing any two loses the question "who do I chase". |
| Automatic work package subject generation | `work_package_types.subject_pattern`, `src/domain/subject.js` | **Done.** Fills a blank subject only, never overwrites; a missing placeholder takes one adjacent separator with it. |
| Real-time notifications | `notifications`, the inbox, the top-bar badge | **Partial.** Notifications are created inside the same transaction as the change and are correct immediately. Delivery is on the next request, not pushed: there is no websocket or SSE. The badge is refreshed after every action rather than streamed. |
| Sharing work packages outside a project | `work_package_shares`, `/share/:token`, `public/share.html` | **Done.** No account needed; internal comments are never included at any permission, and the page says so. |
| File management | `attachments`, `src/domain/files.js` | **Done.** Content-addressed by sha256; the client's filename is a label and never a path; SVG is not served inline. |
| Incoming email-to-task | `email_intake`, `POST /api/intake/email` | **Partial.** Every rule works — a subject naming a work package becomes a comment, a plus-suffix picks the project, an unknown sender is rejected *with the reason recorded*. It needs an MTA to POST parsed mail; there is no IMAP poller. |
| Attribute highlighting | `users.highlight_mode`, `rollup.highlight` | **Done.** Status, priority, overdue or none, and it is a stored preference. |
| Work plan export | `src/api/exports.js` | **Done** for CSV, XLSX and iCal. **Partial** for PDF: it is a plain paginated text listing by design, not a designed report. It says so in its own footer. |

## Agile, Kanban & Scrum

| Item | Where | State |
|---|---|---|
| Kanban / status boards | `#/boards?type=status` | **Done.** Columns are derived from the workflow statuses, so adding a status in administration adds a column with no migration. Dragging writes the status through the same workflow check as the drawer. |
| Version boards | `?type=version` | **Done.** |
| Subproject boards | `?type=subproject` | **Done.** Cards cross projects, which is how a shared sprint is planned. |
| Work-breakdown (parent-child) boards | `?type=wbs` | **Done.** |
| Backlogs | `#/backlogs`, `work_packages.backlog_position` | **Done.** |
| Sprint boards | `?type=sprint`, `#/backlogs` | **Done.** |
| Sprint sharing across projects (SAFe) | `sprints.sharing = 'system'`, `sprint_projects` | **Done.** A shared sprint's column shows every card from every project drawing on it; its points count in each project and once in velocity. |
| Story points | `work_packages.story_points`, `rollup.points` | **Done.** Leaf work only, so a parent never double-counts its children. NULL means not estimated, which is not zero. |
| Multiple active sprints | `sprints.state`, two active in the seed | **Done.** |

## Team collaboration

| Item | Where | State |
|---|---|---|
| Activity feeds | `activities`, `#/activity`, per-project on `#/overview` | **Done.** |
| Collaborative document editing | `document_presence`, optimistic concurrency on `document_versions` | **Partial, and deliberately so.** Presence plus a refusal to merge: a save against a stale revision is refused with the other version offered, and the UI asks. See `docs/decisions/0004` — a silent three-way merge on prose drops one author's sentence, and on a page recording a decision that sentence *is* the decision. |
| Meeting management (agendas / minutes) | `meetings`, `meeting_agenda_items`, `meeting_minutes`, `meeting_outcomes` | **Partial.** Agendas, minutes, outcomes and carry-forwards all work on a meeting that exists, and the agenda freezes when the meeting opens. Creating a meeting has no UI. |
| News module | `news`, shown on the wiki rail | **Partial.** Stored and displayed; no posting UI. |
| @mentions | `mentions`, `notify.resolveMentions` | **Done.** An unresolved mention is reported back to the author — a silent no-op mention is how a question goes unanswered for a week. |
| Internal comments | `comments.internal`, `access.seesInternal` | **Done.** Filtered in the SQL on every read path, including the share and every MCP tool. The selftest checks it holds on the wire, not just in the renderer. |
| Wiki | `documents`, `#/wiki`, `public/lib/md.js` | **Done.** The renderer builds DOM nodes, never an HTML string, so a page containing a script tag renders as the words. |
| Forums | `forums`, `forum_topics`, `forum_messages` | **Partial.** Stored, seeded and listed on the wiki rail; no thread view or posting UI. |
| XWiki integration | `integrations` row of kind `xwiki` | **Modelled.** The link is recorded and shown; there is no content sync. |

## Product roadmap & release planning

| Item | Where | State |
|---|---|---|
| Roadmap / version progress | `#/roadmap`, `versions` | **Done.** An unscheduled version has no marker — drawing it at the far right would read as "scheduled for later", and later and undecided are different answers. |
| Product timeline | `#/roadmap` | **Done.** Every version in the portfolio on one timeline, bounded to include today. |
| SVN / Git repositories | `repositories`, `repository_revisions`, `revision_work_packages` | **Modelled.** Revisions and their work package links are stored, shown and seeded. Nothing shells out to `git` or `svn`. |
| GitHub and GitLab integrations | `integrations`, `repositories.scm` | **Modelled.** Rows, state and detail are shown, and each records the *name* of the environment variable its token is read from — the connections page reports whether that variable is set. There is no API client and no webhook receiver. |

## Workflows & customisation

| Item | Where | State |
|---|---|---|
| Automated project initiation workflow | `project_initiation_requests`, `#/admin?tab=initiation` | **Done.** Request, answers, decision, and the project created from the template in one transaction. A project with no request was created directly, and that difference is visible. |
| Status workflows | `statuses`, `status_transitions` | **Done.** Enforced in `mutations.updateWorkPackage`, so a board is not a way round it. |
| Custom actions (automation) | `automations`, `src/domain/automations.js` | **Partial.** Nine action kinds run, every run is recorded including the skips and their reasons, and an automation cannot trigger an automation. Enabling and disabling has a UI (and disabling demands a reason); creating a new one does not. |
| Custom themes | `themes.tokens`, injected as `:root` at runtime | **Partial.** A theme is a data row and overrides the shipped tokens with no deploy. There is no theme editor; the administration screen shows the palette and the reserved-colour rule. |
| Form configuration | `form_configurations`, `form_sections`, `form_fields` | **Partial.** Stored per work package type, displayed in administration, and the MILESTONE form's missing estimates section is enforced in the API — a milestone cannot carry two dates. The drawer does not yet render itself from the configuration. |
| Attribute help texts | `attribute_help_texts`, `custom_fields.help_text` | **Done.** Shown beside the value in the drawer, which is the only place anybody reads documentation. |
| Unlimited custom fields | `custom_fields`, `custom_values`, list/int/date/bool/text/user/version | **Done.** Per-project scoping, required flag, possible values and a pattern, all validated on write. |
| Fine-grained roles / permissions / groups | `roles`, `permissions` (34), `role_permissions`, `user_groups`, `memberships` | **Done.** Permissions resolve as the **union** of direct and group roles: the intersection would mean adding somebody to a group could quietly reduce their access. |
| Placeholder users | `users.kind = 'placeholder'` | **Done.** Assignable and schedulable, no login and no password hash — so `signIn` has nothing to check rather than a check that says no. Converting one to a real account has no UI. |

## Other

| Item | Where | State |
|---|---|---|
| MCP server for AI assistants | `src/mcp/server.js`, `docs/mcp.md` | **Done.** Five tools, a scoped token, and an audit that records reads as well as writes. See `docs/decisions/0005`. |
| Responsive design | `public/app.css` | **Done.** Three breakpoints chosen from what actually breaks: 1100px (two-column dashboards), 860px (the rail becomes a drawer), 560px (the eleven-column work table becomes a card list). Verified at 390px with no horizontal overflow. There is also a print stylesheet, because a build plan goes into a meeting on paper. |

---

## The honest summary

Everything in the brief has a data model, an API and a screen. What is missing is
in two groups:

1. **Outbound network work.** Nothing here polls GitHub, GitLab, a git remote, an
   SVN server, XWiki or an IMAP mailbox. The tables, the display and the inbound
   endpoints are real; the fetchers are not written. Each connection records the
   environment variable its credential comes from, so adding a fetcher does not
   need a schema change.

2. **Editors for configuration that is currently edited as data.** Themes,
   automations, form layouts, saved views, meetings, news and forum posts are
   stored, validated and displayed, and are created by insert rather than by
   form. That is a deliberate order of work: the model and the read surface are
   the parts that are expensive to get wrong.

One thing is missing on purpose rather than for time: **real-time push**. The
notification model is correct and immediate; delivery waits for the next
request. Adding SSE is a small change and is not pretended to be there.
