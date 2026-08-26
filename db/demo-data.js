/**
 * The demo portfolio dataset. `db/seed.js` loads it; nothing else reads it.
 *
 * It is the dataset from the design canvas the app was built to, carried over
 * row for row so that the running app and the mockup can be compared side by
 * side. Two things are deliberately NOT carried over:
 *
 *   * the per-project completion percentages. The mockup hard-coded them; here
 *     they are derived from the work packages by the same weighted rollup the
 *     rest of the app uses, so a number on screen may differ from the mockup's
 *     and the derived one is the correct one.
 *   * the watcher counts. The mockup stored a number; a number cannot be
 *     notified, so this seeds real watcher rows and the count follows from them.
 */

'use strict';


const TODAY = '2026-08-26';

// ---------------------------------------------------------------- demo dataset
// [key, name, role label, weekly capacity, initials, kind, colour, login]
const PEOPLE = [
  ['stephen', 'Stephen', 'Owner', 32, 'ST', 'user', '#e8a94b', 'stephen'],
  ['odell', 'M. Odell', 'Contributor · contract', 16, 'MO', 'user', '#5fb8c8', 'modell'],
  ['kessler', 'R. Kessler', 'Editor', 8, 'RK', 'user', '#7cc08a', 'rkessler'],
  ['lin', 'J. Lin', 'Design · reader', 12, 'JL', 'user', '#5fb8c8', 'jlin'],
  ['copyeditor', 'Copyeditor — TBD', 'Placeholder user', 0, '??', 'placeholder', 'rgba(230,228,223,.3)', null],
];
// A non-human actor, so an automated change is attributable without pretending
// to be a person.
const MCP_ACTOR = ['mcp', 'MCP · seedfall', 'Assistant', 0, 'AI', 'system', '#5fb8c8', null];

const PROGRAMS = [
  ['plat', 'PLAT', 'SeedFall Platform', 'four projects · one shared sprint · V1 slice locked', 1],
  ['fic', 'FIC', 'SeedFall Fiction', 'two projects · draft two in flight', 2],
  ['gtm', 'GTM', 'Go to market', 'one project · not started', 3],
];

const PHASES = ['Idea', 'Discovery', 'Spec', 'Build', 'Harden', 'Release'];
const GATES = [
  'A one-paragraph premise exists',
  'The problem is written down and bounded',
  'Every V1 feature has a spec section',
  'Scope locked — no V1 features added after this',
  'Selftest green, no immediate-priority bugs',
  'Ship note written, rollback path known',
];

// [key, code, name, program, current phase index, health, health note, favourite of stephen]
const PROJECTS = [
  ['vw', 'VW', 'Viability Window', 'plat', 3, 'amber', 'Build · on plan, 9 days of slip', 1],
  ['trk', 'TRK', 'Tracker', 'plat', 3, 'green', 'Healthy', 1],
  ['ing', 'ING', 'Ingest pipeline', 'plat', 3, 'green', 'Healthy', 0],
  ['mcp', 'MCP', 'MCP server', 'plat', 1, 'amber', 'Gate 2 unscheduled', 1],
  ['cdx', 'CDX', 'Codex engine', 'fic', 2, 'rust', 'Gate blocked — promotion rules undecided', 0],
  ['ms1', 'MS1', 'Manuscript · book one', 'fic', 3, 'green', 'Healthy', 1],
  ['site', 'SITE', 'Public site', 'gtm', 0, 'off', 'Not started', 0],
];

const TEMPLATES = [
  ['SPEC', 'Spec-first software project', 'six phases · wiki skeleton · V1/V2/V3 versions · selftest task', {
    phases: PHASES.map((name, i) => ({ name, gate: `G${i + 1}`, criterion: GATES[i] })),
    versions: [{ code: 'V1', name: 'V1 slice' }, { code: 'V2', name: 'V2 — after the slice' }, { code: 'V3', name: 'V3 — someday' }],
    roles: ['Owner', 'Maintainer', 'Contributor', 'Reader'],
    wiki: [{ number: '01', title: 'Premise' }, { number: '05', title: 'Feature inventory' }, { number: '06', title: 'Build plan' }, { number: '27', title: 'Open decisions' }],
    work_packages: [{ type: 'TASK', subject: 'Selftest — every V1 feature in exactly one milestone' }],
  }],
  ['BOOK', 'Manuscript project', 'draft phases · beat sheet wiki · codex link · beta-reader gate', {
    phases: [
      { name: 'Premise', gate: 'G1', criterion: 'A one-paragraph premise exists' },
      { name: 'Outline', gate: 'G2', criterion: 'Beat sheet complete to the act breaks' },
      { name: 'Draft one', gate: 'G3', criterion: 'Every scene drafted, however badly' },
      { name: 'Draft two', gate: 'G4', criterion: 'Continuity run passes with no contradictions' },
      { name: 'Beta', gate: 'G5', criterion: 'Three beta reads returned' },
      { name: 'Delivery', gate: 'G6', criterion: 'Copyedit accepted, front matter final' },
    ],
    versions: [{ code: 'D1', name: 'Draft one' }, { code: 'D2', name: 'Draft two' }],
    roles: ['Owner', 'Contributor', 'Reader'],
    wiki: [{ number: '01', title: 'Beat sheet' }, { number: '02', title: 'Codex link' }],
    work_packages: [],
  }],
  ['SPIKE', 'Two-week spike', 'discovery only · one gate · auto-archives on exit', {
    phases: [
      { name: 'Discovery', gate: 'G1', criterion: 'The question is written down' },
      { name: 'Report', gate: 'G2', criterion: 'An answer with its evidence, or a reason there is none' },
    ],
    versions: [],
    roles: ['Owner', 'Contributor'],
    wiki: [{ number: '01', title: 'The question' }],
    work_packages: [],
    on_exit: 'archive',
  }],
  ['INTEG', 'Integration project', 'repository connection · token scoping task · audit gate', {
    phases: [
      { name: 'Scope', gate: 'G1', criterion: 'The read surface is enumerated' },
      { name: 'Build', gate: 'G2', criterion: 'Every tool has a test against a fixture' },
      { name: 'Audit', gate: 'G3', criterion: 'An audit format exists and is written to' },
      { name: 'Release', gate: 'G4', criterion: 'Token rotation documented' },
    ],
    versions: [{ code: 'V1', name: 'V1 slice' }, { code: 'V2', name: 'V2 — after the slice' }],
    roles: ['Owner', 'Maintainer', 'Reader'],
    wiki: [{ number: '31', title: 'MCP surface' }],
    work_packages: [{ type: 'TASK', subject: 'Token scoping & audit log' }],
  }],
];

// [code, name, project, due, state, sharing]
const VERSIONS = [
  ['V1', 'V1 slice', 'vw', '2026-10-16', 'open', 'none'],
  ['V2', 'V2 — after the slice', 'vw', '2026-12-11', 'open', 'none'],
  ['V3', 'V3 — someday', 'vw', null, 'open', 'none'],
  ['T12', 'Tracker 1.2', 'trk', '2026-09-18', 'open', 'none'],
  ['T13', 'Tracker 1.3', 'trk', '2026-11-20', 'open', 'none'],
  ['I11', 'Ingest 1.1', 'ing', '2026-09-11', 'open', 'none'],
  ['D2', 'Draft two', 'ms1', '2026-11-06', 'open', 'none'],
];

// [key, code, start, end, state, sharing, projects drawing from it]
const SPRINTS = [
  ['s14', 'S-14', '2026-08-24', '2026-09-04', 'active', 'project', ['vw']],
  ['s15', 'S-15', '2026-09-07', '2026-09-18', 'active', 'system', ['vw', 'mcp', 'cdx']],
  ['s16', 'S-16', '2026-09-21', '2026-10-02', 'planned', 'project', ['vw']],
];

// The work packages, keyed by the display number so WP-124 in the mockup is
// WP-124 here. AUTO_INCREMENT is seeded to match, which is why the ids look
// hand-picked: they are the same ids the design used.
//
// [num, project, type, subject, parent, status, priority, assignee, accountable,
//  start, due, est, spent, points, version, sprint, relation, watchers]
const WPS = [
  [100, 'vw', 'PHASE', 'V1 slice — build', null, 'in_build', 'high', 'stephen', 'stephen', '2026-08-03', '2026-10-16', 0, 0, null, 'V1', null, null, ['odell', 'lin']],
  [101, 'vw', 'EPIC', 'Ingest & projection', 100, 'in_build', 'high', 'stephen', 'stephen', '2026-08-03', '2026-09-11', 48, 31, 13, 'V1', 's14', null, ['odell']],
  [102, 'vw', 'FEATURE', 'Markdown ingest — features', 101, 'done', 'normal', 'stephen', 'stephen', '2026-08-03', '2026-08-14', 16, 15, 5, 'V1', 's14', null, []],
  [103, 'vw', 'FEATURE', 'Markdown ingest — decisions', 101, 'in_build', 'high', 'stephen', 'stephen', '2026-08-17', '2026-08-25', 14, 9, 5, 'V1', 's14', 'follows:102', ['odell']],
  [104, 'vw', 'TASK', 'Selftest — every V1 feature in exactly one milestone', 101, 'done', 'normal', 'stephen', 'stephen', '2026-08-10', '2026-08-21', 8, 7, 3, 'V1', 's14', null, []],
  [110, 'vw', 'EPIC', 'Instrument panel', 100, 'in_build', 'normal', 'stephen', 'stephen', '2026-08-24', '2026-09-25', 40, 12, 13, 'V1', 's15', null, ['odell', 'lin']],
  [111, 'vw', 'FEATURE', 'KPI strip', 110, 'done', 'normal', 'stephen', 'stephen', '2026-08-24', '2026-08-28', 10, 10, 3, 'V1', 's14', null, []],
  [112, 'vw', 'FEATURE', 'Weighted domain rollup', 110, 'in_build', 'high', 'stephen', 'stephen', '2026-08-31', '2026-09-11', 12, 4, 5, 'V1', 's15', 'blocks:130', ['odell']],
  [113, 'vw', 'FEATURE', 'Blocking-decision list', 110, 'speccing', 'normal', 'odell', 'stephen', '2026-09-14', '2026-09-25', 10, 0, 5, 'V1', 's16', null, ['stephen']],
  [120, 'vw', 'EPIC', 'Work package core', 100, 'speccing', 'high', 'stephen', 'stephen', '2026-09-07', '2026-10-09', 56, 3, 21, 'V1', 's15', null, ['odell', 'lin', 'kessler']],
  [121, 'vw', 'FEATURE', 'Filterable task list', 120, 'in_build', 'high', 'stephen', 'stephen', '2026-09-07', '2026-09-18', 16, 3, 8, 'V1', 's15', null, ['odell', 'lin']],
  [122, 'vw', 'FEATURE', 'Assignee / accountable / watcher roles', 120, 'speccing', 'normal', 'stephen', 'stephen', '2026-09-21', '2026-10-02', 12, 0, 5, 'V1', 's16', 'follows:121', ['odell']],
  [123, 'vw', 'FEATURE', 'Automatic subject generation', 120, 'not_started', 'low', null, 'stephen', '2026-10-05', '2026-10-09', 8, 0, 3, 'V2', null, null, []],
  [124, 'vw', 'BUG', 'Drawer keeps a stale note after a route change', 120, 'in_build', 'immediate', 'stephen', 'stephen', '2026-08-25', '2026-08-28', 3, 2, 1, 'V1', 's14', null, ['odell']],
  [130, 'vw', 'MILESTONE', 'V1 slice ready', 100, 'not_started', 'high', 'stephen', 'stephen', '2026-10-16', '2026-10-16', 0, 0, null, 'V1', null, 'follows:112', ['odell', 'lin', 'kessler', 'copyeditor']],
  [201, 'trk', 'EPIC', 'Tracker hardening', null, 'in_build', 'normal', 'stephen', 'stephen', '2026-08-10', '2026-09-18', 32, 24, 13, 'T12', 's14', null, ['odell']],
  [202, 'trk', 'FEATURE', 'Re-ingest without losing tracked status', 201, 'done', 'high', 'stephen', 'stephen', '2026-08-10', '2026-08-21', 12, 12, 5, 'T12', 's14', null, []],
  [203, 'trk', 'FEATURE', 'Activity log persistence', 201, 'in_build', 'normal', 'stephen', 'stephen', '2026-08-24', '2026-09-04', 10, 7, 3, 'T12', 's14', null, ['odell']],
  [204, 'trk', 'TASK', 'Print stylesheet for the build plan', 201, 'not_started', 'low', null, 'stephen', '2026-09-07', '2026-09-11', 6, 0, 2, 'T13', null, null, []],
  [205, 'trk', 'BUG', 'Word count double-counts front matter', 201, 'done', 'normal', 'stephen', 'stephen', '2026-08-19', '2026-08-20', 2, 2, 1, 'T12', 's14', null, []],
  [301, 'mcp', 'EPIC', 'MCP server — read-only surface', null, 'speccing', 'high', 'stephen', 'stephen', '2026-09-01', '2026-10-30', 40, 2, 21, null, 's15', null, ['odell', 'lin']],
  [302, 'mcp', 'FEATURE', 'Tool: portfolio.status', 301, 'speccing', 'high', 'stephen', 'stephen', '2026-09-01', '2026-09-18', 12, 2, 8, null, 's15', null, ['odell']],
  [303, 'mcp', 'FEATURE', 'Tool: work_packages.query', 301, 'not_started', 'normal', null, 'stephen', '2026-09-21', '2026-10-09', 14, 0, 8, null, null, 'follows:302', []],
  [304, 'mcp', 'TASK', 'Token scoping & audit log', 301, 'not_started', 'high', null, 'stephen', '2026-10-12', '2026-10-30', 14, 0, 5, null, null, null, ['odell']],
  [401, 'cdx', 'EPIC', 'Codex data model', null, 'speccing', 'high', 'stephen', 'stephen', '2026-08-17', '2026-10-02', 44, 9, 21, null, 's15', null, ['kessler']],
  [402, 'cdx', 'FEATURE', 'Entry status promotion rules', 401, 'speccing', 'normal', 'stephen', 'stephen', '2026-08-17', '2026-09-11', 16, 9, 8, null, 's14', null, ['kessler']],
  [403, 'cdx', 'FEATURE', 'Backlink integrity check', 401, 'not_started', 'normal', null, 'stephen', '2026-09-14', '2026-10-02', 14, 0, 8, null, null, null, []],
  [404, 'cdx', 'FEATURE', 'Continuity contradiction report', 401, 'deferred', 'low', null, 'stephen', '2026-10-05', '2026-10-23', 14, 0, 5, null, null, null, []],
  [501, 'ms1', 'PHASE', 'Draft two', null, 'in_build', 'high', 'stephen', 'stephen', '2026-07-27', '2026-11-06', 0, 0, null, 'D2', null, null, ['kessler']],
  [502, 'ms1', 'TASK', 'Act one revision pass', 501, 'done', 'high', 'stephen', 'stephen', '2026-07-27', '2026-08-21', 40, 42, null, 'D2', 's14', null, []],
  [503, 'ms1', 'TASK', 'Act two — the viability window', 501, 'in_build', 'high', 'stephen', 'stephen', '2026-08-24', '2026-09-25', 60, 14, null, 'D2', 's15', null, ['kessler']],
  [504, 'ms1', 'TASK', 'Beat sheet reconciliation with the codex', 501, 'speccing', 'normal', 'stephen', 'stephen', '2026-09-28', '2026-10-16', 20, 0, null, 'D2', null, 'follows:503', ['kessler']],
  [505, 'ms1', 'MILESTONE', 'Draft two to beta readers', 501, 'not_started', 'normal', 'copyeditor', 'stephen', '2026-11-06', '2026-11-06', 0, 0, null, 'D2', null, null, ['kessler', 'lin', 'odell']],
  [601, 'ing', 'FEATURE', 'Watcher: re-ingest on file change', null, 'done', 'normal', 'stephen', 'stephen', '2026-08-03', '2026-08-14', 12, 11, 5, 'I11', 's14', null, []],
  [602, 'ing', 'FEATURE', 'Front-matter schema validation', null, 'in_build', 'normal', 'stephen', 'stephen', '2026-08-24', '2026-09-11', 14, 6, 5, 'I11', 's15', null, ['odell']],
  [701, 'site', 'TASK', 'Landing page copy', null, 'not_started', 'low', null, null, '2026-10-19', '2026-10-30', 8, 0, null, null, null, null, []],
];

// Baseline offsets in days: [start offset, due offset] applied to the *current*
// dates to recover what the plan was signed off against. A negative due offset
// is a slip.
const BASELINE_OFFSETS = {
  103: [-7, -10], 110: [0, -9], 112: [0, -9], 120: [-14, -14], 301: [-10, -21], 503: [0, -7],
};

const WEEK_STARTS = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'];
const LOAD = {
  stephen: [34, 31, 28, 38, 30, 26],
  odell: [0, 4, 12, 16, 16, 8],
  kessler: [6, 6, 8, 4, 8, 8],
  lin: [8, 10, 6, 12, 4, 0],
  copyeditor: [0, 0, 0, 0, 0, 12],
};

// [actor key or label, verb, kind, project, wp number, detail, minutes ago]
const ACTIVITY = [
  ['stephen', 'set status', 'status', 'vw', 111, 'KPI strip → DONE', 41],
  ['mcp', 'wrote a status summary', 'ai', 'vw', null, 'Portfolio summary regenerated for My page', 60],
  ['kessler', 'commented', 'mention', 'ms1', 503, '@stephen act two still opens on the wrong beat — the window has to close before she decides', 180],
  ['stephen', 'moved', 'status', 'vw', 124, 'Backlog → S-14, priority IMMEDIATE', 300],
  ['stephen', 'reopened', 'status', 'vw', 112, 'Weighted domain rollup — domain weighting changed', 1440],
  ['odell', 'accepted', 'status', 'vw', 113, 'Assigned from the S-16 backlog', 1500],
  ['stephen', 'settled a gate', 'gate', 'vw', null, 'Gate 3 · scope locked — no V1 features after this', 2880],
  [':github', 'linked a commit', 'repo', 'vw', 103, '4f1c8ad — parse decision blocks, 214 insertions', 2900],
  ['stephen', 'edited the wiki', 'wiki', 'vw', null, '06-build-plan — milestone M4 split in two', 4320],
  ['lin', 'attached a file', 'file', 'vw', 121, 'filter-bar-states.png', 5760],
];

// [user, kind, title, detail, minutes ago, wp number]
const NOTIFICATIONS = [
  ['stephen', 'mention', 'R. Kessler mentioned you', 'WP-503 · act two still opens on the wrong beat', 180, 503],
  ['stephen', 'date_alert', 'Date alert — due in 2 days', 'WP-124 · drawer keeps a stale note', 300, 124],
  ['stephen', 'date_alert', 'Date alert — overdue', 'WP-103 · markdown ingest, decisions', 1440, 103],
  ['stephen', 'assigned', 'M. Odell accepted an assignment', 'WP-113 · blocking-decision list', 1500, 113],
  ['stephen', 'watching', 'Status changed on something you watch', 'WP-112 · in build → reopened', 1500, 112],
  ['stephen', 'internal', 'Internal comment on WP-120', 'Not visible to placeholder users', 2880, 120],
];

const MEETINGS = [
  {
    key: 'm1', project: 'vw', title: 'Weekly build review', on: '2026-08-26', at: '09:30', mins: 45,
    state: 'minutes', who: ['stephen', 'odell'],
    agenda: [
      [5, 'Slip on the instrument panel — accept or recover', null],
      [15, 'WP-124 — is an immediate-priority bug allowed to hold the sprint', 124],
      [15, 'D-19 — can the MCP server write to My page', 304],
      [10, 'S-16 shape', null],
    ],
    minutes: 'The nine-day slip is accepted rather than recovered. The V1 date holds because work package core was already split, and the second half has float.\n\nWP-124 stays in S-14 and blocks nothing else. D-19 was not settled — it needs an audit format before it can be answered, so it moves to the gate review on 10 September with a named owner.',
    outcomes: [['action', 'WP-304 — token scoping & audit log', 'stephen', 304, null],
      ['carried', 'D-19 — can the MCP server write', null, null, 'm2']],
  },
  {
    key: 'm2', project: 'vw', title: 'V1 gate review', on: '2026-09-10', at: '14:00', mins: 60,
    state: 'agenda', who: ['stephen', 'odell', 'lin'],
    agenda: [
      [20, 'Gate 4 criterion — selftest green, no immediate bugs', null],
      [20, 'D-19 with an audit format on the table', 304],
      [20, 'What comes out of V1 if 16 October is fixed', 130],
    ],
    minutes: null,
    outcomes: [],
  },
  {
    key: 'm3', project: 'ms1', title: 'Manuscript beat pass', on: '2026-08-28', at: '16:00', mins: 90,
    state: 'agenda', who: ['stephen', 'kessler'],
    agenda: [
      [45, 'Act two opens on the wrong beat — where does the window close', 503],
      [30, 'Codex contradictions found by the last continuity run', null],
      [15, 'Beta reader list and the copyeditor placeholder', 505],
    ],
    minutes: null,
    outcomes: [],
  },
];

const DOCS = [
  ['01', 'premise', 'Premise', 'vw', 'SPEC', `# Premise

A one-paragraph statement of what the product is for, kept at the top of the wiki
because every other document in it is downstream of this one.

The tracker exists because scope, status and the plan were living in three places
and disagreeing. One of them has to win per fact, and this wiki is where that
choice is written down.`],
  ['03', 'data-model', 'Data model', 'vw', 'SPEC', `# Data model

The entities and what owns each fact.

## Ownership

| Fact | Owned by |
|---|---|
| What the work is | this wiki |
| Status, dates, assignment | the work package |
| Progress percentages | nothing — derived on read |
| The plan | the build plan document |

A number that can be derived is never stored. The one exception is a baseline,
which is a copy on purpose: a baseline derived from history would move whenever
history was corrected, and then a slip could be edited away instead of accepted.`],
  ['05', 'feature-inventory', 'Feature inventory', 'vw', 'SPEC', `# Feature inventory

Every feature the product might have, in one list, each with a tag that says
which release it belongs to. Nothing is deleted from this document — features
that are rejected keep their entry and their reason, because the same idea comes
back every few months and the answer should not have to be re-derived.

> A feature with no tag is a bug in this document, not a decision. The selftest
> fails on untagged entries.

## Tags

- **V1** — in the first slice. Cannot be added to after gate 3.
- **V2** — after the slice ships, in priority order.
- **V3** — someday, kept for the record.
- **TRIAGE** — waiting on a decision in §27.
- **ENG** — engineering work with no user-visible surface.

## How a feature becomes a work package

Ingest reads this document, creates a work package for every tagged feature, and
never writes back. Status lives in the tracker; scope lives here. When the two
disagree the document wins and the tracker shows the drift.

\`\`\`
Tag:     V1
Source:  §12 instrument panel
What:    weighted rollup by domain
Depends: WP-102, decision D-14
Open:    does a deferred feature leave the denominator?
\`\`\``],
  ['06', 'build-plan', 'Build plan', 'vw', 'SPEC', `# Build plan

The order the V1 slice gets built in, and the entry and exit condition for each
milestone. This document owns the assignment of features to milestones. The
tracker reads it and owns nothing, which is why there is no third place for the
plan to drift to.

## M3 — instrument panel

**Entry:** ingest projects features and decisions without loss. **Exit:** the
four numbers on the panel agree with the tables they summarise, and the weighted
rollup cannot be gamed by deferring work.

This milestone slipped nine days when the domain-weighting decision was
reopened. The slip is recorded against the baseline rather than absorbed, so the
V1 date still reads honestly.

## M4 — work package core

Split in two after review: the filterable list ships first, the three-role model
second. Automatic subject generation moved to V2 because nothing in the slice
depends on it.`],
  ['27', 'open-decisions', 'Open decisions', 'vw', 'DRAFT', `# Open decisions

Questions that block work, each with the features that wait on it. A decision is
settled when the answer is written in one sentence a stranger could act on.
Reasoning goes underneath; the sentence is what gets read in six months.

### D-14 · Does a deferred feature leave the denominator?

Settled: yes. Deferred and rejected features are excluded from the denominator,
so progress cannot be manufactured by deferring the hard work. Blocks WP-112.

### D-19 · Can the MCP server write?

Open. Read-only is enough for the summary surface, but writing a summary back to
My page is a write. Scoped tokens would make it safe; nobody has written the
audit format. Blocks WP-304.`],
  ['31', 'mcp-surface', 'MCP surface', 'mcp', 'DRAFT', `# MCP surface

What an assistant is allowed to see, and what it may change.

Four tools. Three read. The fourth writes a generated summary to My page and is
held behind a separate scope until the audit format exists — that is D-19, and it
is open.`],
];

// [name, kind, target, state, detail, project, token env var]
const INTEGRATIONS = [
  ['GitHub', 'github', 'seedfall/seedfall', 'connected', '4f1c8ad · 2 days ago', 'vw', 'GITHUB_TOKEN'],
  ['Git · local', 'git', '~/code/seedfall', 'connected', 'main · clean', 'vw', null],
  ['GitLab', 'gitlab', null, 'off', 'add a project token to enable', null, 'GITLAB_TOKEN'],
  ['Subversion', 'svn', null, 'off', 'legacy manuscript archive', 'ms1', null],
  ['iCal feed', 'ical', 'calendar subscription', 'connected', 'read-only · 1 subscriber', null, null],
  ['Email to task', 'email', 'tasks@seedfall.local', 'connected', '3 work packages created this month', null, null],
  ['XWiki space', 'xwiki', 'https://xwiki.seedfall.local/bin/view/SeedFall/', 'connected', 'linked · one-way read', 'vw', 'XWIKI_TOKEN'],
];

// The write rows are in_build rather than done for the reason decision 0005
// gives: the tools work, and the policy around them - who may issue a write
// token, and for how long - is a decision for whoever deploys this.
const MCP_TOOLS = [
  ['portfolio.status', 'read', 'Weighted progress, gates, health per project', 'done'],
  ['work_packages.query', 'read', 'Filter by project, status, version, sprint, assignee', 'done'],
  ['wiki.read', 'read', 'Fetch a document by number, with the revision to save against', 'done'],
  ['activity.recent', 'read', 'The audit trail, newest first, internal comments excluded', 'done'],
  ['project.create', 'write', 'Create a project, optionally from a template blueprint', 'in_build'],
  ['work_package.create', 'write', 'Create a work package', 'in_build'],
  ['work_package.update', 'write', 'Change one, through the status workflow', 'in_build'],
  ['version.create', 'write', 'Create a version', 'in_build'],
  ['wiki.create', 'write', 'Create a wiki page', 'in_build'],
  ['wiki.update', 'write', 'Replace a page body, refusing a stale base revision', 'in_build'],
  ['comment.add', 'write', 'Comment on a work package or a wiki page, never internally', 'in_build'],
  ['summary.write', 'write', 'Post a generated status summary to My page', 'in_build'],
];

// [name, trigger, action, scope projects (null = all), enabled, note]
const AUTOMATIONS = [
  ['On gate signed — open the next phase', 'gate_signed', 'close_phase_work', ['vw', 'trk', 'cdx'], 1, null],
  ['On status → done — close a finished parent', 'status_changed', 'close_parent', null, 1, null],
  ['On repository change — re-ingest', 'repo_changed', 'reingest', ['trk', 'ing'], 1, null],
  ['On overdue > 3 days — escalate', 'overdue', 'raise_priority', null, 0,
    'Off since 2026-08-19: it fired on the manuscript, where a date is a hope rather than a commitment. Turning it back on needs a per-project opt-in first.'],
  ['On sprint close — carry the unfinished forward', 'sprint_closed', 'move_sprint', ['vw', 'mcp'], 1, null],
];

// [name, format, entity, projects (null = all), help, required]
const CUSTOM_FIELDS = [
  ['Domain', 'list', 'work_package', null, 'Which spec domain the feature belongs to', 1,
    ['engine', 'ui', 'content', 'loader', 'tooling', 'docs']],
  ['Slice tag', 'list', 'work_package', ['vw', 'mcp', 'cdx'], 'V1 / V2 / V3 / TRIAGE / ENG — mirrors the spec tag', 1,
    ['V1', 'V2', 'V3', 'TRIAGE', 'ENG']],
  ['Decision ref', 'text', 'work_package', ['vw', 'cdx'], 'The §27 decision this work waits on', 0, null],
  ['Beat', 'text', 'work_package', ['ms1'], 'Beat sheet reference, e.g. A2-07', 0, null],
  ['Gate met on', 'date', 'project', null, 'Recorded when a phase gate is signed off', 1, null],
  ['Word count', 'int', 'work_package', ['ms1'], 'Filled by the ingest watcher, read-only', 0, null],
  ['Placeholder for', 'text', 'user', null, 'Who this placeholder will become', 0, null],
];

module.exports = {
  TODAY, PEOPLE, MCP_ACTOR, PROGRAMS, PHASES, GATES, PROJECTS, TEMPLATES, VERSIONS, SPRINTS,
  WPS, BASELINE_OFFSETS, WEEK_STARTS, LOAD, ACTIVITY, NOTIFICATIONS, MEETINGS, DOCS,
  INTEGRATIONS, MCP_TOOLS, AUTOMATIONS, CUSTOM_FIELDS,
};

