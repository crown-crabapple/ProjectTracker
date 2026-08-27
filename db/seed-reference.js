/**
 * Reference data: the vocabulary the product is built out of.
 *
 * This is not demo content. Every row here is something the app cannot run
 * without — statuses, priorities, work package types, roles, permissions, the
 * default work week, the shipped theme, the form configurations. Running it
 * twice is safe: everything is keyed on its natural key and upserted.
 *
 * The one row that carries an argument rather than a value is the status table's
 * `progress_weight`. See db/schema.sql's header and docs/decisions/0002.
 */

'use strict';

const db = require('../src/db');

/**
 * INSERT … ON DUPLICATE KEY UPDATE over the columns given, keyed naturally, and
 * returns the row's id afterwards.
 *
 * `idColumn` is null for the tables whose primary key IS the natural key
 * (settings, attribute help texts) — asking those for an `id` is how this
 * function first failed.
 */
async function upsert(table, row, keyCols, idColumn = 'id') {
  const cols = Object.keys(row);
  const updates = cols.filter((c) => !keyCols.includes(c));
  const sql = `INSERT INTO \`${db.ident(table)}\` (${cols.map((c) => '`' + db.ident(c) + '`').join(', ')})
               VALUES (${cols.map(() => '?').join(', ')})
               ${updates.length ? 'ON DUPLICATE KEY UPDATE ' + updates.map((c) => '`' + db.ident(c) + '` = VALUES(`' + db.ident(c) + '`)') : 'ON DUPLICATE KEY UPDATE id = id'}`;
  await db.run(sql, cols.map((c) => row[c]));
  if (!idColumn) return null;
  const where = keyCols.map((c) => '`' + db.ident(c) + '` = ?').join(' AND ');
  return db.scalar(
    `SELECT \`${db.ident(idColumn)}\` FROM \`${db.ident(table)}\` WHERE ${where}`,
    keyCols.map((c) => row[c])
  );
}

const PERMISSIONS = [
  ['view_project', 'project', 'See the project at all'],
  ['edit_project', 'project', 'Edit project attributes'],
  ['archive_project', 'project', 'Archive or unarchive'],
  ['delete_project', 'project', 'Delete a project and its work'],
  ['sign_gate', 'project', 'Record a phase gate as met'],
  ['record_decisions', 'project', 'Raise a decision and record its answer'],
  ['manage_members', 'project', 'Add and remove members and roles'],
  ['view_work_packages', 'work', 'See work packages'],
  ['add_work_packages', 'work', 'Create work packages'],
  ['edit_work_packages', 'work', 'Edit any work package'],
  ['edit_own_work_packages', 'work', 'Edit work packages you author or are assigned'],
  ['delete_work_packages', 'work', 'Delete work packages'],
  ['assign_work_packages', 'work', 'Set assignee and accountable'],
  ['manage_relations', 'work', 'Create and remove relations'],
  ['set_baseline', 'work', 'Take a baseline'],
  ['manage_versions', 'work', 'Create and close versions'],
  ['manage_sprints', 'work', 'Create and close sprints'],
  ['manage_boards', 'work', 'Create and configure boards'],
  ['comment', 'collab', 'Add comments'],
  ['comment_internal', 'collab', 'Read and write internal comments'],
  ['manage_attachments', 'collab', 'Attach and remove files'],
  ['edit_wiki', 'collab', 'Edit wiki documents'],
  ['manage_meetings', 'collab', 'Create meetings and record minutes'],
  ['manage_news', 'collab', 'Post news'],
  ['post_forum', 'collab', 'Post to forums'],
  ['moderate_forum', 'collab', 'Lock, sticky and delete forum content'],
  ['log_time', 'work', 'Book time'],
  ['view_time', 'work', "See other people's booked time"],
  ['manage_allocations', 'work', 'Book capacity in the team planner'],
  ['share_work_packages', 'collab', 'Create share links outside the project'],
  ['export_data', 'work', 'Export lists and plans'],
  ['manage_repositories', 'setup', 'Connect and configure repositories'],
  ['manage_integrations', 'setup', 'Connect GitHub, GitLab, XWiki, email, iCal'],
  ['manage_mcp', 'setup', 'Issue and revoke MCP tokens'],
  ['administer', 'setup', 'Everything, including administration'],
];

// [name, builtin, position, description, permission codes | '*']
const ROLES = [
  ['Owner', 1, 1, 'Everything, including gates and deletion', '*'],
  ['Maintainer', 1, 2, 'Work packages, wiki, versions, no gates', [
    'view_project', 'edit_project', 'manage_members', 'view_work_packages', 'add_work_packages',
    'edit_work_packages', 'edit_own_work_packages', 'assign_work_packages', 'manage_relations',
    'set_baseline', 'manage_versions', 'manage_sprints', 'manage_boards', 'comment',
    'comment_internal', 'manage_attachments', 'edit_wiki', 'record_decisions', 'manage_meetings', 'manage_news',
    'post_forum', 'moderate_forum', 'log_time', 'view_time', 'manage_allocations',
    'share_work_packages', 'export_data',
  ]],
  ['Contributor', 1, 3, 'Own work packages, comment, attach files', [
    'view_project', 'view_work_packages', 'add_work_packages', 'edit_own_work_packages',
    'comment', 'manage_attachments', 'post_forum', 'log_time', 'export_data', 'edit_wiki',
    'record_decisions', 'comment_internal', 'view_time', 'manage_relations',
  ]],
  ['Reader', 1, 4, 'Read and subscribe; no internal comments', [
    'view_project', 'view_work_packages', 'export_data',
  ]],
  // A placeholder role exists so that a placeholder user has a membership like
  // anyone else. Two permissions, and neither of them is a way in.
  ['Placeholder', 1, 5, 'Assignable, cannot sign in', ['view_project', 'view_work_packages']],
];

// [code, label, colour, is_closed, is_default, weight, position]
//
// The weights are the progress model. speccing 0.35 and in_build 0.7 are not
// guesses: they are the two points where a person's answer to "how far along is
// this" stops moving. A spec that exists but is not agreed is a third of the
// way; code that runs but is not reviewed is two thirds. Deferred and rejected
// carry NULL, which excludes them from the denominator entirely.
const STATUSES = [
  ['not_started', 'NOT STARTED', 'rgba(230,228,223,.3)', 0, 1, 0.00, 1],
  ['speccing', 'SPECCING', '#5fb8c8', 0, 0, 0.35, 2],
  ['in_build', 'IN BUILD', '#e8a94b', 0, 0, 0.70, 3],
  ['done', 'DONE', '#7cc08a', 1, 0, 1.00, 4],
  ['deferred', 'DEFERRED', 'rgba(230,228,223,.3)', 0, 0, null, 5],
  ['rejected', 'REJECTED', 'rgba(210,112,95,.7)', 1, 0, null, 6],
];

// Which moves are legal, exactly as the administration screen lists them.
const TRANSITIONS = {
  not_started: ['speccing', 'deferred', 'rejected'],
  speccing: ['in_build', 'deferred', 'rejected'],
  in_build: ['done', 'speccing', 'deferred'],
  done: ['in_build'],
  deferred: ['speccing', 'rejected'],
  rejected: ['speccing'],
};

const PRIORITIES = [
  ['low', 'LOW', 'rgba(230,228,223,.4)', 1, 0],
  ['normal', 'NORMAL', 'rgba(230,228,223,.72)', 2, 1],
  ['high', 'HIGH', '#e8a94b', 3, 0],
  ['immediate', 'IMMEDIATE', '#d2705f', 4, 0],
];

// [name, colour, is_milestone, is_parent_ok, subject_pattern, position,
//  git_item_kind, git_relation, git_key_prefix]
//
// Only BUG carries a subject pattern, and it is the one type where a generated
// subject is genuinely better than a typed one: a bug's subject is almost always
// "the thing that broke, where". Everything else is typed by a person.
//
// The last three columns are what the type means in a repository, and they are
// the default for every repository — `git_type_rules` overrides them per
// repository. The choices:
//
//   PHASE      a forge milestone. It is the only grouping object a forge has
//              that spans issues and pull requests, which is what a phase is.
//   EPIC       a tracking issue. An epic is a conversation with a checklist,
//              and that is an issue, not a milestone.
//   FEATURE    a pull request. This is the case the mapping was asked for:
//              F-LOAD-012 is the feature, PR #978 is the change that implements
//              it, and neither is the other.
//   TASK       an issue it implements. BUG an issue it fixes — the same object,
//              a different claim, and 'what fixed this' is the question a bug is
//              asked.
//   MILESTONE  a release. A milestone in this tracker is a date something is
//              true by, and a release is the forge saying it now is.
//
// The prefix is the letter a key of that type starts with, which is the SeedFall
// convention this tracker inherited: F-LOAD-012 is a FEATURE in the LOAD area.
const TYPES = [
  ['PHASE', 'rgba(230,228,223,.4)', 0, 1, null, 1, 'milestone', 'tracks', 'PH'],
  ['EPIC', 'rgba(230,228,223,.4)', 0, 1, null, 2, 'issue', 'tracks', 'E'],
  ['FEATURE', 'rgba(230,228,223,.4)', 0, 1, null, 3, 'pull_request', 'implements', 'F'],
  ['TASK', 'rgba(230,228,223,.4)', 0, 1, null, 4, 'issue', 'implements', 'T'],
  ['BUG', '#d2705f', 0, 0, '{{custom.Domain}} — {{subject}}', 5, 'issue', 'fixes', 'B'],
  ['MILESTONE', '#5fb8c8', 1, 0, null, 6, 'release', 'releases', 'M'],
];

// The form configuration the theme page shows. A MILESTONE form has no
// estimates section, which is why a milestone cannot accidentally carry hours.
const FORMS = {
  PHASE: [
    ['Subject · Type · Status', ['subject', 'type_id', 'status_id']],
    ['People', ['assignee_id', 'accountable_id', 'watchers']],
    ['Dates', ['start_date', 'due_date', 'scheduling']],
  ],
  EPIC: [
    ['Subject · Type · Status', ['subject', 'type_id', 'status_id', 'priority_id']],
    ['People', ['assignee_id', 'accountable_id', 'watchers']],
    ['Estimates & time', ['story_points', 'estimated_hours', 'spent_hours']],
    ['Dates', ['start_date', 'due_date', 'scheduling']],
    ['Spec', ['custom.Domain', 'custom.Slice tag', 'custom.Decision ref']],
  ],
  FEATURE: [
    ['Subject · Type · Status', ['subject', 'type_id', 'status_id', 'priority_id']],
    ['People', ['assignee_id', 'accountable_id', 'watchers']],
    ['Estimates & time', ['story_points', 'estimated_hours', 'spent_hours']],
    ['Dates', ['start_date', 'due_date', 'scheduling']],
    ['Spec', ['custom.Domain', 'custom.Slice tag', 'custom.Decision ref']],
    ['Release', ['version_id', 'sprint_id']],
  ],
  TASK: [
    ['Subject · Type · Status', ['subject', 'type_id', 'status_id', 'priority_id']],
    ['People', ['assignee_id', 'accountable_id', 'watchers']],
    ['Estimates & time', ['story_points', 'estimated_hours', 'spent_hours']],
    ['Dates', ['start_date', 'due_date']],
    ['Release', ['version_id', 'sprint_id']],
  ],
  BUG: [
    ['Subject · Type · Status', ['subject', 'type_id', 'status_id', 'priority_id']],
    ['People', ['assignee_id', 'accountable_id', 'watchers']],
    ['Estimates & time', ['story_points', 'estimated_hours', 'spent_hours']],
    ['Dates', ['start_date', 'due_date']],
    ['Release', ['version_id', 'sprint_id']],
  ],
  MILESTONE: [
    ['Subject · Type · Status', ['subject', 'type_id', 'status_id', 'priority_id']],
    ['People', ['accountable_id', 'watchers']],
    ['Dates', ['due_date']],
    ['Release', ['version_id']],
  ],
};

const HELP_TEXTS = [
  ['work_package', 'scheduling', 'Automatic derives the dates from the children and the relations. Manual pins them — the only way to plan a slip without rewriting the parent.'],
  ['work_package', 'accountable_id', 'Who answers for this work. Not necessarily who does it: that is the assignee.'],
  ['work_package', 'story_points', 'Fibonacci only. Blank means not estimated, which is different from zero.'],
  ['work_package', 'estimated_hours', 'Work-hours, not elapsed days. The work week decides how many days that spans.'],
  ['work_package', 'sprint_id', 'A shared sprint can be drawn from by several projects. Its points count in each, but only once in velocity.'],
  ['work_package', 'version_id', 'The release this ships in. Closing a version with work left in it asks where the work goes.'],
  ['project', 'health', 'A judgement you record, not a number derived from the schedule — a blocked gate has no schedule signature.'],
  ['project', 'work_week_id', 'Scheduling arithmetic only. Weekends are shaded on the calendar, never hidden.'],
  ['version', 'sharing', 'How far down the project tree this version can be used. `system` puts it on every project.'],
  ['sprint', 'sharing', '`system` is the SAFe case: several projects drawing from one sprint.'],
  ['meeting', 'state', 'An open agenda accepts items from any maintainer. Once the meeting opens the agenda freezes and edits go to the minutes.'],
];

const THEME_TOKENS = {
  '--bg': '#08090b',
  '--panel': '#0b0c0e',
  '--panel-2': '#151719',
  '--panel-3': '#191c1f',
  '--rail': '#0a0b0d',
  '--head': '#0b0c0e',
  '--ink': '#e6e4df',
  '--ink-2': 'rgba(230,228,223,.85)',
  '--ink-3': 'rgba(230,228,223,.72)',
  '--ink-4': 'rgba(230,228,223,.55)',
  '--ink-5': 'rgba(230,228,223,.4)',
  '--ink-6': 'rgba(230,228,223,.3)',
  '--line': 'rgba(255,255,255,.07)',
  '--line-2': 'rgba(255,255,255,.045)',
  '--line-3': 'rgba(255,255,255,.12)',
  '--accent': '#e8a94b',
  '--ok': '#7cc08a',
  '--sel': '#5fb8c8',
  '--blocked': '#d2705f',
  '--font-prose': "'Instrument Sans', system-ui, -apple-system, sans-serif",
  '--font-label': "'Archivo', ui-monospace, monospace",
};

async function seedReference() {
  const ids = { permissions: {}, roles: {}, statuses: {}, priorities: {}, types: {}, workWeeks: {}, themes: {} };

  for (const [code, category, label] of PERMISSIONS) {
    ids.permissions[code] = await upsert('permissions', { code, category, label }, ['code']);
  }

  for (const [name, builtin, position, description, perms] of ROLES) {
    const id = await upsert('roles', { name, builtin, position, description }, ['name']);
    ids.roles[name] = id;
    const codes = perms === '*' ? PERMISSIONS.map((p) => p[0]) : perms;
    await db.run('DELETE FROM role_permissions WHERE role_id = ?', [id]);
    for (const code of codes) {
      await db.run('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
        [id, ids.permissions[code]]);
    }
  }

  for (const [code, label, colour, is_closed, is_default, progress_weight, position] of STATUSES) {
    ids.statuses[code] = await upsert('statuses',
      { code, label, colour, is_closed, is_default, progress_weight, position }, ['code']);
  }
  await db.run('DELETE FROM status_transitions');
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    for (const to of tos) {
      await db.run('INSERT INTO status_transitions (from_status_id, to_status_id) VALUES (?, ?)',
        [ids.statuses[from], ids.statuses[to]]);
    }
  }

  for (const [code, label, colour, position, is_default] of PRIORITIES) {
    ids.priorities[code] = await upsert('priorities', { code, label, colour, position, is_default }, ['code']);
  }

  for (const [name, colour, is_milestone, is_parent_ok, subject_pattern, position,
    git_item_kind, git_relation, git_key_prefix] of TYPES) {
    ids.types[name] = await upsert('work_package_types', {
      name, colour, is_milestone, is_parent_ok, subject_pattern, position,
      git_item_kind, git_relation, git_key_prefix,
    }, ['name']);
  }

  ids.workWeeks['Mon–Fri'] = await upsert('work_weeks', {
    name: 'Mon–Fri', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
    saturday: 0, sunday: 0, hours_per_day: 8.0, is_default: 1,
  }, ['name']);
  ids.workWeeks['Weekends included'] = await upsert('work_weeks', {
    name: 'Weekends included', monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1,
    saturday: 1, sunday: 1, hours_per_day: 4.0, is_default: 0,
  }, ['name']);

  ids.themes['Instrument amber'] = await upsert('themes', {
    name: 'Instrument amber',
    tokens: JSON.stringify(THEME_TOKENS),
    reserved_note: 'Rust (--blocked) is reserved: nothing decorative may use it, so a rust pixel anywhere in the product means a decision is waiting.',
    is_default: 1,
  }, ['name']);

  for (const [typeName, sections] of Object.entries(FORMS)) {
    const formId = await upsert('form_configurations', { type_id: ids.types[typeName], name: 'default' },
      ['type_id', 'name']);
    await db.run('DELETE FROM form_sections WHERE form_id = ?', [formId]);
    let sp = 0;
    for (const [sectionName, attrs] of sections) {
      const sectionId = await db.insert('form_sections', { form_id: formId, name: sectionName, position: sp++ });
      let fp = 0;
      for (const attribute of attrs) {
        await db.insert('form_fields', { section_id: sectionId, attribute, position: fp++ });
      }
    }
  }

  for (const [entity, attribute, help] of HELP_TEXTS) {
    await upsert('attribute_help_texts', { entity, attribute, help }, ['entity', 'attribute']);
  }

  for (const [name, value] of Object.entries({
    'app.name': 'ProjectTracker',
    'app.portfolio_name': 'SeedFall',
    'app.default_theme': 'Instrument amber',
    'app.email_intake_address': 'tasks@seedfall.local',
    // Kept as a setting rather than a constant so a deployment can move it
    // without a code change; read by src/domain/rollup.js.
    'rollup.exclude_parents_from_points': '1',
  })) {
    await upsert('settings', { name, value }, ['name'], null);
  }

  return ids;
}

module.exports = { seedReference, upsert, STATUSES, PRIORITIES, TYPES, ROLES, PERMISSIONS, THEME_TOKENS };
