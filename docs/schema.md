# The schema

85 tables in `db/schema.sql` plus five added by migration `0002`, sectioned by
domain, with the derivation for every non-obvious column written next to it. This
is the map, not a repeat of the DDL.

## Conventions

- InnoDB, `utf8mb4_unicode_ci`. Every foreign key is declared, and `ON DELETE` is
  chosen per table — `RESTRICT` wherever losing the row would lose history.
- `BIGINT UNSIGNED` surrogate keys. Where the product shows a human key it is a
  **VIRTUAL generated column** over the surrogate (`work_packages.wp_key` is
  `CONCAT('WP-', id)`), so there is exactly one source of truth for it and
  nothing to keep in step on insert.
- Hours are `DECIMAL`, never `FLOAT`. A rounding error in booked time is a
  rounding error in somebody's invoice.
- Timestamps are UTC `DATETIME`. Dates a person types — start, due, gate met on,
  spent on — are `DATE`, because they carry no time and must not acquire one by
  passing through a timezone. The driver is configured with
  `dateStrings: ['DATE','DATETIME']` for the same reason.
- Nothing is deleted where the fact matters. A revoked share, a rejected email,
  a superseded summary and a skipped automation run all keep their row.

## The columns that carry an argument

These are the ones worth knowing before changing anything.

| Column | Why it is like that |
|---|---|
| `statuses.progress_weight DECIMAL(3,2) NULL` | The entire progress model, as data. **NULL means excluded from the denominator**, which is not the same as `0`. `docs/decisions/0002`. |
| `work_packages.scheduling` | `automatic` derives dates from children and predecessors; `manual` pins them. A child cannot leave the dates of an automatic parent; against a manual one it can, and that is the only way to plan a slip without rewriting the parent. |
| `work_packages.story_points INT NULL` | NULL is *not estimated*. Zero is *estimated at zero*. |
| `users.kind` | `user` / `placeholder` / `system`. A placeholder has no login and no password hash, so there is nothing for `signIn` to check — that is the whole mechanism behind "assignable, cannot sign in". `system` is the tracker and the MCP client, so an automated change is never indistinguishable from a human one. |
| `comments.internal` | A column rather than a table: a thread reads in one order, and splitting it would mean merging two sequences on every render. |
| `project_phases.gate_met_on` + `gate_met_by` | A date and a person, not a flag. A boolean gate tells you it was signed and nothing about when or by whom, which is exactly the question asked six months later. |
| `project_phases.state = 'blocked'` | The criterion is itself an open decision. It does not mean the work is late — late work is a schedule fact and shows on the Gantt. This is the only state allowed to draw in the reserved colour. |
| `projects.health` | Recorded, not derived. `docs/decisions/0003`. |
| `baselines` / `baseline_entries` | A copy, deliberately. A baseline derived from history would move whenever history was corrected, and then a slip could be edited away instead of accepted. |
| `sprints.sharing = 'system'` + `sprint_projects` | The SAFe case. An explicit membership table rather than a column, so a shared sprint's points can count in every project drawing on it and once in velocity. |
| `repositories.token_env`, `integrations.token_env` | The **name** of the environment variable, never the value. A credential is not in this database and so cannot be in a dump. The API refuses a value shaped like a token, and refuses a name that is not upper case — which is what makes a pasted `ghp_…` fail. |
| `work_packages.ref_key` | The key the *repository* knows this work package by — `F-LOAD-012`. `wp_key` is generated from the id and cannot be chosen, so this is where a project's own convention lives. Unique per project, because two projects legitimately both have an F-LOAD-012. |
| `work_package_types.git_item_kind` / `git_relation` / `git_key_prefix` | What each of the six types *is* in a repository: a FEATURE is a pull request it implements, a BUG is an issue it fixes. Data rather than code, so changing it is an administration action; `git_type_rules` overrides it per repository. |
| `git_items` | The living forge objects — pull requests, issues, milestones, releases, branches, CI runs, alerts. Commits are **not** here: they are immutable and already have `repository_revisions`, and mirroring something whose state moves into a table of final rows makes "when did this change" unanswerable. |
| `git_items.state` | The forge's own word (`open`, `draft`, `merged`, `failure`). Mapping it into this tracker's status vocabulary here would be the second progress model this codebase exists to avoid. |
| `work_package_git_links.origin` / `matched_key` / `matched_in` | How the link came to exist and the literal text that produced it. A link a regex made and a link a person made are different claims, and the UI never paints them the same. |
| `work_package_git_links.removed_at` + `removed_by` | A removed link keeps its row, and a pull will never re-make that pair. Overturning a person's decision every quarter of an hour is how an integration gets switched off. |
| `git_type_rules.merged_status_id` / `closed_status_id` | Both NULL by default, which is the decision: a pull mirrors, it does not decide. When set, the move goes through `status_transitions` like any other and is refused if the workflow refuses it. |
| `git_unmatched_keys` | A key found in a repository that matches no work package, kept with a count. A branch named for work the tracker has never heard of is the most useful thing a pull reports. |
| `mcp_tokens.token_hash` + `token_hint` | sha256 and the last four characters. The secret is shown once at creation. |
| `mcp_audit` | Every call, reads included. `docs/decisions/0005`. |
| `mcp_tokens.created_by` | Who issued it, and — for a write-scoped token — whose permissions its writes run with. A token can do no more than its issuer, and one with nobody here may read and may not write. `docs/decisions/0006`. |
| `activities.actor_label` | Set instead of `actor_id`, never beside it: `notify.record` nulls the id whenever a label is given, so a change an automation or the MCP server made can never read as one a person made. |
| `attachments.digest` | Content addressing. Two identical uploads share one file and keep two rows, so deleting one attachment can never take the other's bytes. |
| `activities` | Never deleted, never capped. The SeedFall tracker capped its log at 400 entries, and the cost showed up the first time nine routine entries pushed a real decision out of the window. |
| `project_lists.filters` | The filter, never the resulting ids. A list that froze its members would go stale silently, and a stale shared link is worse than no link. |
| `automations.disabled_note` | Why it is off matters more than that it is. Without the note, somebody turns it back on in six months and rediscovers the reason. The API refuses to disable one without it. |
| `resource_allocations` vs `time_entries` | Booked and spent are different contracts: booked is a plan for a week that has not happened, spent is a fact about one that has. The planner compares the first against capacity. |
| `board_columns` | Only a `free` board needs stored columns. Status, version, subproject and WBS boards derive theirs, which is what stops a status board going stale when a status is added. |
| `sprint_velocity_history` | Sprints that closed before the work was itemised. Live sprints are always computed — a stored figure that could be computed is a figure that will one day disagree with the cards. |

## Sections

| Section | Tables |
|---|---|
| identity & access | `users`, `user_groups`, `user_group_members`, `organizations`, `organization_users`, `permissions`, `roles`, `role_permissions`, `sessions` |
| portfolio | `programs`, `project_templates`, `themes`, `projects`, `project_phases`, `memberships`, `membership_roles`, `project_favorites`, `project_lists`, `project_list_shares`, `dashboards`, `dashboard_widgets`, `saved_views` |
| work & planning | `work_package_types`, `statuses`, `status_transitions`, `priorities`, `work_weeks`, `non_working_days`, `versions`, `sprints`, `sprint_projects`, `work_packages`, `work_package_watchers`, `work_package_relations`, `baselines`, `baseline_entries`, `time_entries`, `resource_allocations`, `date_alerts` |
| agile | `boards`, `board_columns`, `board_cards`, `sprint_velocity_history` |
| collaboration | `comments`, `mentions`, `documents`, `document_versions`, `document_presence`, `meetings`, `meeting_participants`, `meeting_agenda_items`, `meeting_minutes`, `meeting_outcomes`, `news`, `forums`, `forum_topics`, `forum_messages`, `attachments` |
| sharing & notification | `work_package_shares`, `notifications`, `activities`, `email_intake`, `calendar_subscriptions` |
| repositories | `repositories`, `repository_revisions`, `revision_work_packages`, `integrations` |
| the git deck (`0002`) | `git_items`, `work_package_git_links`, `git_type_rules`, `git_unmatched_keys`, `git_pulls` |
| workflow & customisation | `custom_fields`, `custom_field_projects`, `custom_field_types`, `custom_values`, `form_configurations`, `form_sections`, `form_fields`, `attribute_help_texts`, `automations`, `automation_projects`, `automation_runs`, `project_initiation_requests`, `settings` |
| MCP | `mcp_tools`, `mcp_tokens`, `mcp_audit`, `generated_summaries`, `exports` |
| migrations | `schema_migrations` (created by `db/migrate.js`, not by `schema.sql`) |

## What is never stored

Every number the UI shows. Readiness, completion counts, story point totals,
velocity, spent hours, watcher counts, slip, load percentages — all derived on
read by `src/domain/rollup.js` and `src/domain/scheduling.js`. There is nowhere
to write them, which is the point: a cached total is a total that will one day
disagree with the rows under it.

The single exceptions are documented as such: `documents.word_count` and
`section_count` (the wiki index shows them for every document at once, and the
writer that sets `body` is the only thing allowed to set them), and the baseline
tables (a copy on purpose).

## Constraints worth knowing

```sql
-- exactly one principal per membership: without this the permission resolver
-- has to guess which of a user and a group wins
CONSTRAINT ck_mem_one_principal CHECK ((user_id IS NULL) <> (group_id IS NULL))

-- a relation cannot point at itself
CONSTRAINT ck_rel_not_self CHECK (from_id <> to_id)
```

A cycle in `work_packages.parent_id` is *not* prevented by the schema — a plain
self-reference cannot express it. It is prevented in `mutations.updateWorkPackage`
(which walks the ancestors before allowing a re-parent) and tolerated on read:
`rollup.flattenHierarchy` reports a cycle and returns the rows flat rather than
recursing forever or dropping them. A row that vanishes from a list is worse than
one out of order.

## Changing it

`schema.sql` is the base and is applied only to an empty schema. After that,
add `db/migrations/0001_something.sql` and run `node db/migrate.js`. Editing
`schema.sql` to change a live table is the mistake that split exists to make
impossible.

`db/migrate.js` splits statements itself and deliberately does not handle
`DELIMITER`, so triggers and stored procedures are out — logic in the database is
logic the tests cannot reach.
