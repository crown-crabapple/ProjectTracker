#!/usr/bin/env node
/**
 * The selftest.
 *
 *   node test/selftest.js [--keep]
 *
 * IT RUNS AGAINST A THROWAWAY DATABASE, NEVER THE CONFIGURED ONE. That is the
 * whole design of this file, and it is not a precaution invented here: the
 * SeedFall tracker's suite once exercised its store and its HTTP server against
 * the real state file and backed itself out with a backup/restore. The restore
 * ran before the spawned server was killed, a late flush from the child
 * overwrote it, and a settled decision and a feature's status were destroyed and
 * committed. A suite that points at a temp schema makes that structurally
 * impossible rather than unlikely.
 *
 * The last check bounds what could have reached the real database: it asserts
 * that no row anywhere in the configured schema was written while the suite ran.
 * A concurrent writer from another shell is legitimate and produces a NOTE
 * rather than a failure, because a bare assertion would make the check unusable
 * on a shared machine — which is how a check gets deleted.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const { config } = require('../src/config');

const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const REAL_DATABASE = config.db.database;
const TEST_DATABASE = `pt_selftest_${process.pid}`;

let passed = 0;
const failures = [];
const notes = [];

function check(name, condition, detail) {
  if (condition) { passed += 1; return true; }
  failures.push({ name, detail: detail || '' });
  return false;
}
const note = (text) => notes.push(text);

function eq(name, actual, expected) {
  return check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function throws(name, fn, expected) {
  try {
    await fn();
    return check(name, false, 'it did not throw');
  } catch (e) {
    return check(name, !expected || e.message.includes(expected) || String(e.status) === String(expected),
      `threw "${e.message}" (status ${e.status})`);
  }
}

// ------------------------------------------------------- pure, no database yet

async function pureChecks() {
  const rollup = require('../src/domain/rollup');
  const sched = require('../src/domain/scheduling');
  const subject = require('../src/domain/subject');
  const lifecycle = require('../src/domain/lifecycle');
  const files = require('../src/domain/files');
  const exporters = require('../src/api/exports');
  const passwords = require('../src/domain/passwords');

  // --- the progress model. These are the checks that stop the rollup lying.
  const list = [
    { status_code: 'done', progress_weight: 1, type_name: 'FEATURE', story_points: 5, estimated_hours: 10, spent_hours: 9 },
    { status_code: 'in_build', progress_weight: 0.7, type_name: 'FEATURE', story_points: 3, estimated_hours: 8, spent_hours: 2 },
    { status_code: 'deferred', progress_weight: null, type_name: 'FEATURE', story_points: 8, estimated_hours: 4, spent_hours: 0 },
    { status_code: 'in_build', progress_weight: 0.7, type_name: 'EPIC', story_points: 13, estimated_hours: 40, spent_hours: 20 },
  ];
  eq('readiness excludes a null-weight status from the denominator',
    rollup.readiness(list), { pct: 80, scored: 3, excluded: 1 });
  check('deferring work cannot raise readiness',
    rollup.readiness(list).pct === rollup.readiness(list.filter((w) => w.progress_weight !== null)).pct,
    'the excluded row changed the percentage');
  check('a status weighted zero is NOT the same as an excluded one',
    rollup.readiness([{ status_code: 'x', progress_weight: 0 }]).pct === 0
    && rollup.readiness([{ status_code: 'x', progress_weight: null }]).scored === 0);
  eq('completion is three counts, not one', rollup.completion(list),
    { total: 4, done: 1, partial: 2, notStarted: 0, deferred: 1, rejected: 0, remaining: 2 });
  eq('story points cover leaf work only', rollup.points(list), 16);
  check('a container contributes no points of its own',
    rollup.points(list.filter((w) => w.type_name === 'EPIC')) === 0);
  eq('hours exclude containers too', rollup.hours(list), { estimated: 22, spent: 11 });
  eq('a status bar always sums to exactly 100',
    rollup.statusBar(
      [{ status_code: 'a', progress_weight: 1 }, { status_code: 'b', progress_weight: 1 }, { status_code: 'c', progress_weight: 1 }],
      [{ code: 'a', label: 'A', colour: '1' }, { code: 'b', label: 'B', colour: '2' }, { code: 'c', label: 'C', colour: '3' }]
    ).reduce((a, s) => a + s.pct, 0), 100);
  check('a closed work package is never overdue',
    !rollup.isOverdue({ due_date: '2020-01-01', is_closed: true }, '2026-08-26'),
    'a task finished late stayed red forever');

  // --- hierarchy
  const cyc = rollup.flattenHierarchy([{ id: 1, parent_id: 2 }, { id: 2, parent_id: 1 }]);
  eq('a parent cycle is reported, not looped over', cyc.cycles.sort(), [1, 2]);
  eq('a cyclic row is still returned', cyc.rows.length, 2);
  const orphan = rollup.flattenHierarchy([{ id: 5, parent_id: 99 }]);
  eq('a row whose parent is filtered out is drawn at the root', orphan.rows[0].depth, 0);

  // --- dates
  const week = { monday: 1, tuesday: 1, wednesday: 1, thursday: 1, friday: 1, saturday: 0, sunday: 0, hours_per_day: 8 };
  eq('ten working days between two Mondays two weeks apart',
    sched.workingDays('2026-08-24', '2026-09-04', week), 10);
  eq('a weekend start rolls to Monday and 14 hours takes two days',
    sched.finishFor('2026-08-29', 14, week), '2026-09-01');
  eq('seven hours in an eight-hour day still occupies a day',
    sched.finishFor('2026-08-24', 7, week), '2026-08-24');
  eq('the week of a Wednesday starts on the Monday', sched.weekStart('2026-08-26'), '2026-08-24');
  eq('the week of a Sunday starts on the Monday before', sched.weekStart('2026-08-30'), '2026-08-24');
  // A DATE must not acquire a timezone on the way through.
  eq('an ISO date survives a round trip unchanged',
    sched.formatDay(sched.parseDay('2026-01-01')), '2026-01-01');
  eq('a baseline slip is the due shift, not the start shift',
    sched.compareToBaseline({ start_date: '2026-08-24', due_date: '2026-09-25' },
      { start_date: '2026-08-31', due_date: '2026-09-16' }).slip, 9);
  eq('finishing on time after starting late is not a slip',
    sched.compareToBaseline({ start_date: '2026-09-01', due_date: '2026-09-16' },
      { start_date: '2026-08-24', due_date: '2026-09-16' }).slip, 0);

  const derived = sched.derive([
    { id: 1, parent_id: null, scheduling: 'automatic', start_date: '2026-09-01', due_date: '2026-09-02', follows: [] },
    { id: 2, parent_id: 1, scheduling: 'automatic', start_date: '2026-09-07', due_date: '2026-09-11', follows: [] },
    { id: 3, parent_id: 1, scheduling: 'automatic', start_date: '2026-09-01', due_date: '2026-09-04', follows: [{ id: 2, lag_days: 0 }] },
  ], { week });
  check('scheduling converges', derived.converged);
  eq('a successor starts after its predecessor finishes', derived.changes.get(3).start_date, '2026-09-14');
  eq('an automatic parent spans its children', derived.changes.get(1).due_date, '2026-09-17');
  const manual = sched.derive([
    { id: 1, parent_id: null, scheduling: 'manual', start_date: '2026-09-01', due_date: '2026-09-02', follows: [] },
    { id: 2, parent_id: 1, scheduling: 'automatic', start_date: '2026-10-01', due_date: '2026-10-09', follows: [] },
  ], { week });
  check('a manual parent keeps its dates when a child leaves them', !manual.changes.has(1),
    'the manual parent moved, so a slip cannot be planned against it');

  // --- subject generation
  const pattern = '{{type}} — {{custom.Domain}} {{subject}}';
  eq('a full pattern expands',
    subject.expand(pattern, { type: 'BUG', subject: 'filter bar', custom: { Domain: 'ui' } }),
    'BUG — ui filter bar');
  eq('a missing placeholder takes one separator, not two',
    subject.expand(pattern, { type: 'BUG', subject: 'filter bar', custom: {} }),
    'BUG filter bar');
  eq('generation never overwrites a typed subject',
    subject.resolve({ subject: 'typed', pattern, context: { type: 'BUG' } }).subject, 'typed');
  eq('nothing typed and nothing generable is a null subject, not an empty one',
    subject.resolve({ subject: '  ', pattern: null, context: {} }).subject, null);

  // --- life cycle
  const phases = [
    { id: 1, position: 1, name: 'Idea', gate_name: 'G1', gate_criterion: 'x', state: 'gate_met' },
    { id: 2, position: 2, name: 'Spec', gate_name: 'G2', gate_criterion: 'no immediate bugs', state: 'current' },
    { id: 3, position: 3, name: 'Build', gate_name: 'G3', gate_criterion: 'y', state: 'not_entered' },
  ];
  eq('the current gate is the next gate', lifecycle.summarise(phases).nextGate.gate, 'G2');
  check('a gate whose criterion names immediate bugs is checked against them',
    !lifecycle.canAdvance(phases[1], { openImmediateBugs: 1 }).ok);
  check('a gate whose criterion does not mention bugs is not blocked by one',
    lifecycle.canAdvance(phases[0] && { ...phases[2], state: 'current' }, { openImmediateBugs: 1 }).ok);
  eq('signing a gate opens the next phase',
    lifecycle.signGate(phases, 2, { on: '2026-08-26', by: 1 }).map((u) => [u.id, u.state]),
    [[2, 'gate_met'], [3, 'current']]);

  // --- filenames
  eq('a traversal in a filename is stripped', files.safeLabel('../../etc/passwd'), 'passwd');
  eq('a windows path in a filename is stripped', files.safeLabel('C:\\Windows\\x.txt'), 'x.txt');
  eq('a newline in a filename cannot reach a header', files.safeLabel('a\nb.png'), 'ab.png');
  check('svg is not served inline', !files.INLINE_TYPES.has('image/svg+xml'),
    'an SVG served inline from this origin is stored cross-site scripting');

  // --- exports
  check('a CSV cell that looks like a formula is neutralised',
    exporters.toCsv([{ key: 'a', label: 'A' }], [{ a: '=cmd|calc' }]).includes("'=cmd|calc"));
  const xlsx = exporters.toXlsx([{ key: 'a', label: 'A' }], [{ a: 'x' }, { a: 2 }]);
  check('the xlsx is a zip', xlsx.slice(0, 2).toString() === 'PK');
  check('the xlsx contains a worksheet', xlsx.includes(Buffer.from('xl/worksheets/sheet1.xml')));
  check('the pdf has a header and a trailer', (() => {
    const pdf = exporters.toPdf('t', [{ key: 'a', label: 'A' }], [{ a: 'x' }]).toString('latin1');
    return pdf.startsWith('%PDF-1.4') && pdf.trimEnd().endsWith('%%EOF');
  })());
  const ics = exporters.toIcal({
    name: 'n',
    events: [{ kind: 'due', id: 1, date: '2026-08-26', summary: 'a'.repeat(120) }],
  });
  check('a long iCal line is folded with a leading space', ics.includes('\r\n '));
  check('an all-day iCal event ends on the following day', ics.includes('DTEND;VALUE=DATE:20260827'),
    'an exclusive DTEND makes a one-day deadline show as two');
  check('the same event gets the same UID twice', (() => {
    const a = exporters.toIcal({ name: 'n', events: [{ kind: 'due', id: 1, date: '2026-08-26', summary: 's' }] });
    const b = exporters.toIcal({ name: 'n', events: [{ kind: 'due', id: 1, date: '2026-08-26', summary: 's' }] });
    const uid = (t) => /UID:(\S+)/.exec(t)[1];
    return uid(a) === uid(b);
  })(), 'an unstable UID duplicates every event on every refresh');

  // --- the git deck: which repository object is which work package
  //
  // These are the checks that stop the mapping claiming more than it knows. A
  // link is a claim about somebody's work, and the difference between 'closes
  // WP-112' and 'blocked on WP-112' is the whole of it.
  const gitdeck = require('../src/domain/gitdeck');
  const forge = require('../src/gitdeck/client');

  const RULE = { item_kind: 'pull_request', relation: 'implements', key_prefix: 'F' };
  const index = new Map([
    ['WP-112', { id: 112, project_id: 1, type_name: 'FEATURE', rule: RULE }],
    ['F-UI-007', { id: 112, project_id: 1, type_name: 'FEATURE', rule: RULE }],
    ['B-ENG-003', { id: 200, project_id: 1, type_name: 'BUG', rule: { item_kind: 'issue', relation: 'fixes', key_prefix: 'B' } }],
    ['F-OTHER-001', { id: 900, project_id: 2, type_name: 'FEATURE', rule: RULE }],
  ]);
  const match = (item) => gitdeck.matchItem(item, index, { repositoryProjectId: 1 });

  eq('a key in the title is what the change is',
    match({ kind: 'pull_request', title: 'F-UI-007 weighted rollup' }).links
      .map((l) => [l.matched_key, l.relation, l.matched_in]),
    [['F-UI-007', 'implements', 'title']]);
  eq('a key in the body is a mention until a verb claims it',
    match({ kind: 'pull_request', title: 'x', body: 'blocked on WP-112' }).links.map((l) => l.relation),
    ['mentions']);
  eq('and a closing verb makes the same key a claim',
    match({ kind: 'pull_request', title: 'x', body: 'closes WP-112' }).links.map((l) => l.relation),
    ['implements']);
  eq('a lowercase key in a branch name still matches',
    match({ kind: 'pull_request', title: 'x', head_branch: 'feature/f-ui-007-rollup' }).links
      .map((l) => [l.matched_key, l.origin]),
    [['F-UI-007', 'branch']]);
  check('but a lowercase key in a title does not',
    match({ kind: 'pull_request', title: 'fix the f-ui-007 connector' }).links.length === 0,
    'an English sentence became a claim about somebody\'s feature');
  eq('a type mapped to issues is only mentioned by a pull request',
    match({ kind: 'pull_request', title: 'B-ENG-003 crash' }).links.map((l) => l.relation), ['mentions']);
  eq('and implements the issue it is mapped to',
    match({ kind: 'issue', title: 'B-ENG-003 crash' }).links.map((l) => l.relation), ['fixes']);
  eq('a key belonging to another project is not linked across',
    match({ kind: 'pull_request', title: 'F-OTHER-001 elsewhere' }).unmatched
      .map((u) => [u.candidate, u.reason]),
    [['F-OTHER-001', 'that key belongs to another project']]);
  eq('a key nothing carries is reported rather than dropped',
    match({ kind: 'pull_request', title: 'F-LOAD-207 glossary' }).unmatched.map((u) => u.candidate),
    ['F-LOAD-207']);
  eq('one key written twice is one link',
    match({
      kind: 'pull_request', title: 'F-UI-007 rollup', body: 'F-UI-007 again',
      head_branch: 'feature/f-ui-007',
    }).links.length, 1);

  check('a repository key must be a shape a branch could carry',
    gitdeck.isValidRefKey('F-LOAD-012') && gitdeck.isValidRefKey('PH-2')
    && !gitdeck.isValidRefKey('the loader') && !gitdeck.isValidRefKey('F-LOAD'),
    'a key no branch name could match is a key that silently never links');

  // The health score is gitdeck's, and these are its numbers. 78 to start, minus
  // 8 for a stale issue and 3 for the open one, plus 10 for a push this week.
  const staleDay = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const health = gitdeck.healthScore({
    issues: [{ updated_at: staleDay }],
    pushed_at: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 19).replace('T', ' '),
    now: Date.now(),
  });
  eq('the health score is gitdeck\'s arithmetic', health.score, 77);
  check('and says which signals it could actually read',
    health.basis.includes('push recency') && !health.basis.includes('traffic'),
    JSON.stringify(health.basis));
  check('security alerts nobody may read are not scored as none',
    gitdeck.healthScore({ issues: [], security_alerts_unavailable: true })
      .basis.join(' ').includes('UNAVAILABLE'),
    'zero open alerts and no permission to look are opposite facts');

  const ci = gitdeck.ciSummary([
    { state: 'completed', conclusion: 'success', duration_sec: 100 },
    { state: 'completed', conclusion: 'failure', duration_sec: 200 },
    { state: 'completed', conclusion: 'cancelled', duration_sec: 10 },
    { state: 'completed', conclusion: 'skipped' },
    { state: 'in_progress', conclusion: null },
  ]);
  eq('a CI rate counts successes and failures only', ci.success_pct, 50);
  eq('and cancelled, skipped and running runs are counted apart',
    [ci.cancelled, ci.skipped, ci.running], [1, 1, 1]);
  check('a pipeline where nothing has finished has no rate, not a rate of zero',
    gitdeck.ciSummary([{ state: 'in_progress', conclusion: null }]).success_pct === null,
    'zero per cent means every run failed, which is a different morning');

  const cover = gitdeck.coverage({
    workPackages: [
      { id: 1, git_item_kind: 'pull_request' },
      { id: 2, git_item_kind: 'pull_request' },
      { id: 3, git_item_kind: 'none' },
    ],
    items: [{ id: 10, kind: 'pull_request' }, { id: 11, kind: 'pull_request' }],
    links: [{ work_package_id: 1, git_item_id: 10 }],
  });
  eq('coverage counts both directions', [cover.pct, cover.items_pct], [50, 50]);
  check('a type that maps to nothing is excluded, not counted as missing',
    cover.mappable === 2 && cover.excluded_types === 1,
    'otherwise the figure improves by deleting phases');

  eq('a repository URL yields the owner and name the API needs',
    ['https://github.com/seedfall/seedfall.git', 'git@github.com:seedfall/seedfall',
      'https://codeberg.org/x/y/'].map(forge.slugFromUrl),
    ['seedfall/seedfall', 'seedfall/seedfall', 'x/y']);
  await throws('a plain git repository has no API client and says so',
    async () => forge.connectionFor({ scm: 'git', name: 'local', url: '~/code/x' }), 'no API client');
  await throws('a forgejo repository with no api_base is refused rather than guessed',
    async () => forge.connectionFor({ scm: 'forgejo', name: 'cb', url: 'https://codeberg.org/x/y' }),
    'no api_base');


  // --- the webhook receiver: verification and mapping, without a database
  const hooks = require('../src/gitdeck/hooks');
  const hookBody = Buffer.from(JSON.stringify({ action: 'opened' }), 'utf8');
  const hookSecret = 'a-shared-secret';
  const hookSig = 'sha256=' + crypto.createHmac('sha256', hookSecret).update(hookBody).digest('hex');
  check('a GitHub signature over the raw bytes verifies',
    hooks.verify('github', { 'x-hub-signature-256': hookSig }, hookBody, hookSecret).ok);
  check('a signature over different bytes does not',
    !hooks.verify('github', { 'x-hub-signature-256': hookSig }, Buffer.from('{}'), hookSecret).ok);
  check('and neither does no signature at all',
    !hooks.verify('github', {}, hookBody, hookSecret).ok,
    'an unsigned delivery must never be accepted');
  check('Forgejo sends the same digest without the prefix, and it verifies',
    hooks.verify('forgejo', { 'x-forgejo-signature': hookSig.slice(7) }, hookBody, hookSecret).ok);
  check('GitLab sends the secret back and it is compared in constant time',
    hooks.verify('gitlab', { 'x-gitlab-token': hookSecret }, hookBody, hookSecret).ok
    && !hooks.verify('gitlab', { 'x-gitlab-token': 'nearly-right' }, hookBody, hookSecret).ok);

  eq('a form-encoded delivery is read the same as a JSON one',
    hooks.parseBody('application/x-www-form-urlencoded',
      Buffer.from('payload=' + encodeURIComponent('{"action":"opened"}'))),
    { action: 'opened' });

  const prEvent = hooks.itemsFrom('github', 'pull_request', {
    action: 'closed',
    pull_request: {
      number: 978, title: 'F-LOAD-012 parse decisions', state: 'closed',
      merged_at: '2026-08-24T09:00:00Z', head: { ref: 'feature/f-load-012' }, base: { ref: 'main' },
      html_url: 'https://forge.invalid/pull/978', user: { login: 'stephen' }, labels: [],
    },
  });
  eq('a delivered pull request normalises exactly as a fetched one does',
    prEvent.items.map((i) => [i.kind, i.ref, i.state, i.head_branch]),
    [['pull_request', '978', 'merged', 'feature/f-load-012']]);
  const pushEvent = hooks.itemsFrom('github', 'push', {
    ref: 'refs/heads/feature/f-ui-021-list',
    commits: [{ id: 'abc123', message: 'F-UI-021 wire it', timestamp: '2026-08-25T08:00:00Z', author: { name: 'S' } }],
  });
  eq('a push carries its branch and its commits',
    [pushEvent.items.map((i) => `${i.kind} ${i.ref}`), pushEvent.commits.map((c) => c.identifier)],
    [['branch feature/f-ui-021-list'], ['abc123']]);
  check('a tag push is not mirrored as a branch',
    hooks.itemsFrom('github', 'push', { ref: 'refs/tags/v1.0.0', commits: [] }).items.length === 0);
  check('an event this receiver does not know is named, not thrown',
    hooks.itemsFrom('github', 'star', {}).unknown === 'star',
    'a receiver that 400s on an unsubscribed event teaches people to narrow the subscription');
  check('a GitLab merge request hook maps through the same normaliser',
    hooks.itemsFrom('gitlab', 'Merge Request Hook', {
      object_kind: 'merge_request',
      object_attributes: { iid: 12, title: 'F-UI-007 rollup', state: 'merged', source_branch: 'f-ui-007', url: 'https://x/12' },
      user: { username: 'modell' },
    }).items[0].ref === '12');


  // --- passwords
  const hashed = passwords.hash('correct horse');
  check('the right password verifies', passwords.verify('correct horse', hashed.hash, hashed.salt));
  check('the wrong password does not', !passwords.verify('wrong', hashed.hash, hashed.salt));
  check('a placeholder with no hash cannot be verified into', !passwords.verify('', null, null));

  // --- the router
  const { Router } = require('../src/http/router');
  const r = new Router().get('/api/wp/:id', () => 'get').patch('/api/wp/:id', () => 'patch');
  eq('a path parameter is captured', r.resolve('GET', '/api/wp/112').params.id, '112');
  eq('a matching path with the wrong method reports what is allowed',
    r.resolve('DELETE', '/api/wp/112').allow.sort(), ['GET', 'PATCH']);
  eq('an unmatched path resolves to nothing', r.resolve('GET', '/nope/at/all'), null);
  check('a path segment is decoded exactly once',
    r.resolve('GET', '/api/wp/%2e%2e').params.id === '..',
    'double decoding is how %252e becomes a traversal');

  // --- the multipart parser
  const { boundaryOf } = require('../src/http/body');
  eq('a quoted boundary is read', boundaryOf('multipart/form-data; boundary="abc"'), 'abc');
  eq('an unquoted boundary is read', boundaryOf('multipart/form-data; boundary=abc'), 'abc');
  eq('a missing boundary is null', boundaryOf('application/json'), null);

  // --- the graph maths behind the map
  //
  // `graph.rank` is the one longest-path walk in the product: `decisions.layer`
  // delegates to it and the relations graph on the map calls it directly. Two
  // copies would be two answers to how deep a node sits.
  const graph = require('../src/domain/graph');
  const chain = graph.rank([1, 2, 3], [{ from: 2, to: 1 }, { from: 3, to: 2 }]);
  eq('a chain ranks in order', [chain.get(1), chain.get(2), chain.get(3)], [0, 1, 2]);
  const diamond = graph.rank([1, 2, 3, 4],
    [{ from: 2, to: 1 }, { from: 3, to: 1 }, { from: 4, to: 2 }, { from: 4, to: 3 }]);
  eq('a node ranks behind its DEEPEST dependency, not its first', diamond.get(4), 2);

  // The relations table permits a loop; `decision_dependencies` refuses one.
  // So this guard is load-bearing for one caller and a belt for the other, and
  // the thing that must not happen is a hang.
  const looped = graph.rank([1, 2, 3], [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 1 }]);
  check('a cycle ranks rather than recursing forever', looped.size === 3, JSON.stringify([...looped]));
  const found = graph.cycles([1, 2, 3], [{ from: 1, to: 2 }, { from: 2, to: 3 }, { from: 3, to: 1 }]);
  eq('and the edge that closes the loop is named, so somebody knows which link to cut',
    found.length, 1);
  eq('a graph with no loop reports none',
    graph.cycles([1, 2, 3], [{ from: 2, to: 1 }, { from: 3, to: 2 }]).length, 0);
  // A picture that redraws differently for the same data is one nobody trusts.
  eq('columns are ordered by the caller\'s key, not by insertion',
    graph.columns([3, 1, 2], graph.rank([1, 2, 3], []), (id) => ({ 1: 'c', 2: 'a', 3: 'b' })[id]),
    [[2, 3, 1]]);

  // A rank is a position in a picture, and this is what keeps it one: the
  // module reaches nothing. It cannot see a status weight, so it cannot
  // produce a figure that could be mistaken for progress.
  const graphSource = fs.readFileSync(path.join(ROOT, 'src/domain/graph.js'), 'utf8');
  check('graph.js depends on nothing', !/\brequire\(/.test(graphSource));
  check('and reads no field that carries progress',
    !/\b(progress_weight|status_code|story_points)\b/.test(
      graphSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));

  // --- the map draws no number of its own
  //
  // The whole argument of `docs/decisions/0011`. If this file ever computes one
  // it becomes a second progress model, and the two disagree in front of
  // somebody deciding which to believe.
  const views7Source = fs.readFileSync(path.join(ROOT, 'src/api/views7.js'), 'utf8');
  check('views7 computes no percentage of its own',
    !/Math\.round\([^)]*\*\s*100/.test(views7Source) && !/\/\s*\w+\s*\)\s*\*\s*100/.test(views7Source),
    'the map must take every figure from rollup.js');
  check('and it is a read path — no mutation module is reachable from it',
    !/require\('\.\.?\/.*mutations/.test(views7Source));

  const views7 = require('../src/api/views7');
  check('a relation kind that carries no order has no precedence entry',
    !views7.PRECEDENCE.relates && !views7.PRECEDENCE.duplicates && !views7.PRECEDENCE.includes,
    'includes is containment; treating it as order would rank a parent behind its own children');
  // The table stores one direction per kind and derives the inverse on read, so
  // `blocks` runs the other way round from `follows`. Reading it wrong draws
  // every arrow backwards.
  eq('follows means the from side happens after',
    views7.PRECEDENCE.follows({ from_id: 7, to_id: 4 }), { from: 7, to: 4 });
  eq('blocks means the to side happens after',
    views7.PRECEDENCE.blocks({ from_id: 7, to_id: 4 }), { from: 4, to: 7 });

  // --- the identifier guard
  const db = require('../src/db');
  eq('a plain identifier passes', db.ident('work_packages'), 'work_packages');
  for (const bad of ['work packages', 'a;drop', 'a`b', '']) {
    let threw = false;
    try { db.ident(bad); } catch { threw = true; }
    check(`ident() refuses ${JSON.stringify(bad)}`, threw);
  }
  eq('a json column already parsed is passed through', db.json({ a: 1 }), { a: 1 });
  eq('a json column as a string is parsed', db.json('{"a":1}'), { a: 1 });
  eq('unparseable json falls back rather than throwing', db.json('not json', 'fb'), 'fb');
}

// ------------------------------------------------- the throwaway database

async function withTestDatabase(fn) {
  const admin = await mysql.createConnection({
    host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password,
  });
  await admin.query(`DROP DATABASE IF EXISTS \`${TEST_DATABASE}\``);
  await admin.query(`CREATE DATABASE \`${TEST_DATABASE}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();

  // Point the app's pool at the copy BEFORE anything opens a connection. This is
  // the line the whole file depends on.
  const db = require('../src/db');
  db.reconfigure({ database: TEST_DATABASE });

  try {
    await fn(db);
  } finally {
    await db.close();
    if (!KEEP) {
      const cleanup = await mysql.createConnection({
        host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password,
      });
      await cleanup.query(`DROP DATABASE IF EXISTS \`${TEST_DATABASE}\``);
      await cleanup.end();
    } else {
      note(`--keep: ${TEST_DATABASE} was left in place`);
    }
  }
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, PT_DB_NAME: TEST_DATABASE, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    if (env && env.__stdin) { child.stdin.write(env.__stdin); }
    child.stdin.end();
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

async function databaseChecks(db) {
  // --- migrate and seed through the real entry points, not a shortcut
  const migrated = await run(process.execPath, ['db/migrate.js', '--yes']);
  check('migrate.js applies the schema', migrated.code === 0 && /tables/.test(migrated.out),
    migrated.err || migrated.out);
  const tables = Number(await db.scalar(
    'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ?', [TEST_DATABASE]
  ));
  check('the schema has the tables it should', tables > 80, `${tables} tables`);

  // --- the default login. migrate leaves exactly one account that can sign in,
  // which is what makes the demo portfolio optional rather than the only door in.
  const pw = require('../src/domain/passwords');
  check('migrate.js creates a default login', /created the default login admin/.test(migrated.out),
    migrated.out);
  const admin = await db.one(
    "SELECT login, name, kind, active, is_admin, password_hash, password_salt FROM users WHERE login = 'admin'"
  );
  check('and it is an administrator that signIn would accept',
    admin && admin.kind === 'user' && Number(admin.active) === 1 && Number(admin.is_admin) === 1,
    JSON.stringify(admin));
  const printed = /shown once[^\n]*\n\s*(\S+)/.exec(migrated.out);
  check('and it prints the generated password once', Boolean(printed), migrated.out);
  check('and the password it printed is the password it stored',
    Boolean(printed) && pw.verify(printed[1], admin.password_hash, admin.password_salt),
    'printing one string and hashing another is the way this fails silently');

  // A second run must not mint a second account, and must not act on a changed
  // PT_ADMIN_LOGIN either: the trigger is "nothing can sign in", not "this name
  // is missing".
  const reMigrated = await run(process.execPath, ['db/migrate.js'], { PT_ADMIN_LOGIN: 'owner' });
  eq('migrating again creates no second login',
    Number(await db.scalar('SELECT COUNT(*) FROM users')), 1);
  check('and says nothing about a login', !/login/.test(reMigrated.out), reMigrated.out);

  const seeded = await run(process.execPath, ['db/seed.js']);
  check('seed.js loads reference data and the demo portfolio',
    seeded.code === 0 && /seeded \d+ projects/.test(seeded.out), seeded.err || seeded.out);

  const reSeeded = await run(process.execPath, ['db/seed.js']);
  check('seeding twice refuses to duplicate the demo portfolio',
    reSeeded.code === 0 && /already exist/.test(reSeeded.out), reSeeded.out);
  eq('and left the project count alone', Number(await db.scalar('SELECT COUNT(*) FROM projects')), 7);

  // --- the reference vocabulary is what the rollup depends on
  const statuses = await db.query('SELECT code, progress_weight, is_closed FROM statuses ORDER BY position');
  eq('the six statuses are seeded', statuses.map((s) => s.code),
    ['not_started', 'speccing', 'in_build', 'done', 'deferred', 'rejected']);
  eq('deferred and rejected carry a NULL weight',
    statuses.filter((s) => s.progress_weight === null).map((s) => s.code), ['deferred', 'rejected']);
  eq('the weights are the documented ones',
    statuses.filter((s) => s.progress_weight !== null).map((s) => Number(s.progress_weight)),
    [0, 0.35, 0.7, 1]);

  // --- the human key is derived, so it cannot drift
  const key = await db.scalar('SELECT wp_key FROM work_packages WHERE id = 124');
  eq('wp_key is generated from the id', key, 'WP-124');

  // --- constraints the schema is supposed to enforce
  await throws('a membership cannot name both a user and a group',
    () => db.insert('memberships', { project_id: 1, user_id: 1, group_id: 1 }));
  await throws('a relation cannot point at itself',
    () => db.insert('work_package_relations', { from_id: 100, to_id: 100, kind: 'follows' }));
  await throws('a work package cannot reference a status that does not exist',
    () => db.run('UPDATE work_packages SET status_id = 99999 WHERE id = 124'));

  // --- the query builder
  const query = require('../src/domain/query');
  await throws('an unknown filter is refused rather than ignored',
    () => query.select({ filters: { nope: 1 } }), 'unknown filter');
  await throws('an unknown sort is refused', () => query.select({ sort: 'nope' }), 'unknown sort');
  const capped = await query.select({ filters: {}, limit: 99999 });
  check('the row limit is capped', capped.length <= 1000, `${capped.length} rows`);
  const wp = await query.byId(112);
  check('a row carries its raw foreign keys as well as its labels',
    wp.status_id && wp.type_id && wp.priority_id,
    'the missing status_id once made every status transition fail');
  check('spent hours are summed from time entries', Number(wp.spent_hours) === 4, String(wp.spent_hours));

  // --- permissions
  const access = require('../src/domain/access');
  const stephen = await db.scalar("SELECT id FROM users WHERE login = 'stephen'");
  const lin = await db.scalar("SELECT id FROM users WHERE login = 'jlin'");
  const placeholder = await db.scalar("SELECT id FROM users WHERE kind = 'placeholder' LIMIT 1");
  const vw = await db.scalar("SELECT id FROM projects WHERE code = 'VW'");
  const owner = await access.permissionsFor(stephen, vw);
  const reader = await access.permissionsFor(lin, vw);
  const ph = await access.permissionsFor(placeholder, vw);
  check('an owner may sign a gate', owner.has('sign_gate'));
  check('a reader may not sign a gate', !reader.has('sign_gate'));
  check('a reader cannot see internal comments', !access.seesInternal(reader));
  check('a placeholder cannot see internal comments', !access.seesInternal(ph));
  check('a placeholder can still be seen in the project', ph.has('view_project'));
  const odell = await db.scalar("SELECT id FROM users WHERE login = 'modell'");
  const contributor = await access.permissionsFor(odell, vw);
  check('a group grant widens rather than narrows access', contributor.has('edit_work_packages'),
    'the Platform group makes M. Odell a maintainer on VW; the union must win');

  // --- the workflow is the workflow
  const mut = require('../src/api/mutations');
  const ctx = {
    user: { id: stephen, name: 'Stephen', is_admin: true, highlight_mode: 'status' },
    visibleProjectIds: (await access.visibleProjects(stephen)).map((r) => Number(r.id)),
    today: new Date().toISOString().slice(0, 10),
  };
  const doneId = await db.scalar("SELECT id FROM statuses WHERE code = 'done'");
  const specId = await db.scalar("SELECT id FROM statuses WHERE code = 'speccing'");
  await throws('not_started cannot jump straight to done',
    () => mut.updateWorkPackage(ctx, 123, { status_id: doneId }), 'cannot move straight');
  const moved = await mut.updateWorkPackage(ctx, 123, { status_id: specId });
  eq('a legal transition is applied', moved.wp.status_code, 'speccing');
  const trail = await db.one(
    "SELECT * FROM activities WHERE work_package_id = 123 AND kind = 'status' ORDER BY id DESC LIMIT 1"
  );
  check('the change wrote an activity entry in the same transaction', Boolean(trail));
  eq('and recorded what it moved from and to', [trail.from_value, trail.to_value], ['NOT STARTED', 'SPECCING']);
  await throws('an attribute that is not editable is refused',
    () => mut.updateWorkPackage(ctx, 123, { project_id: 2 }), 'not an editable attribute');
  await throws('a work package cannot become its own parent',
    () => mut.updateWorkPackage(ctx, 123, { parent_id: 123 }), 'its own parent');
  await throws('a loop in the hierarchy is refused',
    () => mut.updateWorkPackage(ctx, 120, { parent_id: 123 }), 'loop');
  await throws('a milestone cannot carry two different dates',
    () => mut.updateWorkPackage(ctx, 130, { start_date: '2026-01-01', due_date: '2026-02-01' }), 'one date');
  await throws('a due date before the start date is refused',
    () => mut.updateWorkPackage(ctx, 121, { start_date: '2026-03-01', due_date: '2026-02-01' }), 'before the start');

  // --- internal comments
  const internal = await mut.addComment(ctx, {
    containerType: 'work_package', containerId: 121, body: 'internal only', internal: true,
  });
  check('an internal comment is written', Boolean(internal.id));
  const views4 = require('../src/api/views4');
  const asOwner = await views4.drawer(ctx, 121);
  check('an owner sees the internal comment', asOwner.comments.some((c) => c.internal));
  const readerCtx = { ...ctx, user: { ...ctx.user, id: lin, is_admin: false } };
  const asReader = await views4.drawer(readerCtx, 121);
  check('a reader receives no internal comment at all',
    !asReader.comments.some((c) => c.internal),
    'internal comments must be excluded in the query, not hidden in the UI');
  check('and the reader is told that some are hidden', asReader.canSeeInternal === false);

  // A Reader has no `comment` permission at all, so it is the outer guard that
  // refuses this rather than the internal one. Asserting on the word "internal"
  // was wrong: it made a correct refusal look like a failure.
  await throws('a reader cannot comment at all, internal or otherwise',
    () => mut.addComment(readerCtx, {
      containerType: 'work_package', containerId: 121, body: 'x', internal: true,
    }), 403);
  check('and the Reader role is the reason: it does not hold comment_internal',
    !reader.has('comment') && !reader.has('comment_internal'));

  // --- mentions
  const mentioned = await mut.addComment(ctx, {
    containerType: 'work_package', containerId: 121,
    body: 'asked @rkessler and @nobody-at-all.', internal: false,
  });
  eq('a real mention resolves', mentioned.mentioned, ['R. Kessler']);
  eq('an unresolved mention is reported back', mentioned.unresolved, ['nobody-at-all']);
  const notified = await db.scalar(
    "SELECT COUNT(*) FROM notifications WHERE kind = 'mention' AND user_id = (SELECT id FROM users WHERE login='rkessler')"
  );
  check('and the mentioned person was notified', Number(notified) > 0);

  // --- gates
  await throws('a gate whose criterion is undecided cannot be signed', async () => {
    const cdx = await db.scalar("SELECT id FROM projects WHERE code = 'CDX'");
    const blocked = await db.one("SELECT id FROM project_phases WHERE project_id = ? AND state = 'blocked'", [cdx]);
    return mut.signGate(ctx, cdx, blocked.id, {});
  }, 'open decision');

  const beforeGate = await db.one(
    "SELECT id, gate_name FROM project_phases WHERE project_id = ? AND state = 'current'", [vw]
  );
  const signed = await mut.signGate(ctx, vw, beforeGate.id, { note: 'selftest' });
  eq('signing a gate records the date and the person and opens the next phase',
    signed.updates.length, 2);
  const met = await db.one('SELECT gate_met_on, gate_met_by FROM project_phases WHERE id = ?', [beforeGate.id]);
  check('the gate carries a date and a signer', met.gate_met_on && met.gate_met_by);

  // --- automations
  const automations = require('../src/domain/automations');
  const trk = await db.scalar("SELECT id FROM projects WHERE code = 'TRK'");
  const fired = await automations.dispatch('repo_changed', { projectId: trk });
  check('an automation runs and records its run', fired.length > 0);
  const runRow = await db.one('SELECT * FROM automation_runs ORDER BY id DESC LIMIT 1');
  check('a skipped run is recorded with its reason', runRow && runRow.detail,
    'a skip with no reason cannot be told from never firing');
  check('an automation cannot trigger an automation',
    (await automations.dispatch('repo_changed', { projectId: trk }, { depth: 2 })).length === 0);
  const mut2 = require('../src/api/mutations2');
  await throws('turning an automation off requires a reason',
    () => mut2.toggleAutomation(ctx, 2, { enabled: false }), 'say why');

  // --- the progress model is data
  await throws('a weight outside 0..1 is refused',
    () => mut2.setStatusWeight(ctx, specId, 4), 'between 0 and 1');
  const excluded = await mut2.setStatusWeight(ctx, specId, null);
  eq('null is an accepted weight and means excluded', excluded.weight, null);
  await mut2.setStatusWeight(ctx, specId, 0.35);

  // --- baselines
  const baseline = await mut2.takeBaseline(ctx, vw, { name: 'selftest' });
  check('a baseline copies every work package in the project', baseline.entries >= 15, String(baseline.entries));
  const currents = Number(await db.scalar(
    'SELECT COUNT(*) FROM baselines WHERE project_id = ? AND is_current = 1', [vw]
  ));
  eq('only one baseline is current', currents, 1);
  const kept = Number(await db.scalar('SELECT COUNT(*) FROM baselines WHERE project_id = ?', [vw]));
  check('and the earlier one is kept', kept >= 2, `${kept} baselines`);

  // --- documents, and the refusal to merge silently
  const doc = await db.one("SELECT id FROM documents WHERE slug = 'build-plan'");
  const saved = await mut2.saveDocument(ctx, doc.id, { body: '# One\n\ntext', baseRevision: 1 });
  eq('a save bumps the revision', saved.revision, 2);
  eq('and recounts the words', saved.word_count, 3);
  await throws('a save against a stale revision is refused, not merged',
    () => mut2.saveDocument(ctx, doc.id, { body: 'mine', baseRevision: 1 }), 'moved on');
  const conflictPayload = await (async () => {
    try { await mut2.saveDocument(ctx, doc.id, { body: 'mine', baseRevision: 1 }); return null; }
    catch (e) { return e; }
  })();
  check('and the refusal carries the other version so both can be shown',
    conflictPayload && conflictPayload.currentBody !== undefined);

  // --- decisions
  //
  // A decision used to be a wiki page; it is a record now, with two link
  // tables that say what waits on it and what it waits on. The graph maths
  // comes from `src/domain/decisions.js` once, the same rule `rollup.js`
  // enforces for a percentage.
  const mut4 = require('../src/api/mutations4');
  const decisionsDomain = require('../src/domain/decisions');
  const rollup = require('../src/domain/rollup');

  const d19 = await db.one("SELECT id, ref, state FROM decisions WHERE project_id = ? AND ref = 'D-19'", [vw]);
  const d22 = await db.one("SELECT id, ref, state FROM decisions WHERE project_id = ? AND ref = 'D-22'", [vw]);
  const d08 = await db.one("SELECT id, ref, state FROM decisions WHERE project_id = ? AND ref = 'D-08'", [vw]);
  const d14 = await db.one("SELECT id, ref, state FROM decisions WHERE project_id = ? AND ref = 'D-14'", [vw]);
  const d25 = await db.one("SELECT id, ref, state FROM decisions WHERE project_id = ? AND ref = 'D-25'", [vw]);

  await throws('a decision that waits on an open decision cannot be settled',
    () => mut4.updateDecision(ctx, d19.id, { state: 'settled' }), 'D-22');
  await mut4.updateDecision(ctx, d22.id, { state: 'settled' });
  const settledD19 = await mut4.updateDecision(ctx, d19.id, { state: 'settled' });
  eq('and settling the one it waits on first lets it through', settledD19.state, 'settled');

  await mut4.addDependency(ctx, d25.id, { depends_on_id: d08.id });
  await throws('two decisions cannot be made to gate each other',
    () => mut4.addDependency(ctx, d08.id, { depends_on_id: d25.id }), 'D-25 waits on D-08');
  await throws('a decision cannot depend on itself',
    () => mut4.addDependency(ctx, d25.id, { depends_on_id: d25.id }), 'cannot depend on itself');

  // D-14 blocks WP-112 is a seeded link.
  const dwpCountBefore = Number(await db.scalar(
    'SELECT COUNT(*) FROM decision_work_packages WHERE decision_id = ? AND work_package_id = 112', [d14.id]));
  await mut4.unlinkWork(ctx, d14.id, 112);
  const dwpAfterUnlink = await db.one(
    'SELECT removed_at FROM decision_work_packages WHERE decision_id = ? AND work_package_id = 112', [d14.id]);
  eq('a link a person removed keeps its row', Number(await db.scalar(
    'SELECT COUNT(*) FROM decision_work_packages WHERE decision_id = ? AND work_package_id = 112', [d14.id]
  )), dwpCountBefore);
  check('and says the link was removed', dwpAfterUnlink.removed_at !== null);

  // D-19 depends on D-22 is a seeded dependency.
  const ddCountBefore = Number(await db.scalar(
    'SELECT COUNT(*) FROM decision_dependencies WHERE decision_id = ? AND depends_on_id = ?', [d19.id, d22.id]));
  await mut4.removeDependency(ctx, d19.id, d22.id);
  const ddAfterRemove = await db.one(
    'SELECT removed_at FROM decision_dependencies WHERE decision_id = ? AND depends_on_id = ?', [d19.id, d22.id]);
  eq('the same for a dependency somebody removed', Number(await db.scalar(
    'SELECT COUNT(*) FROM decision_dependencies WHERE decision_id = ? AND depends_on_id = ?', [d19.id, d22.id]
  )), ddCountBefore);
  check('and its removed_at is set too', ddAfterRemove.removed_at !== null);

  await throws('a matcher never revives a link a person removed',
    () => mut4.linkWork(ctx, d14.id, { work_package_id: 112, relation: 'blocks', origin: 'matcher' }),
    'unlinked');
  const dwpStillRemoved = await db.scalar(
    'SELECT removed_at FROM decision_work_packages WHERE decision_id = ? AND work_package_id = 112', [d14.id]);
  check('and removed_at is not cleared by the attempt', dwpStillRemoved !== null);

  // The document a decision points at drops out of the wiki index; a document
  // nothing points at does not.
  const decisionSourceDoc = await mut2.createDocument(ctx, {
    project_id: vw, title: 'Selftest decision source', body: 'source text',
  });
  await mut4.createDecision(ctx, {
    project_id: vw, ref: 'D-90', title: 'A selftest decision', document_id: decisionSourceDoc.id,
  });
  const wikiAfter = await views4.wiki(ctx, { projectId: vw });
  check('a decision page has left the wiki',
    !wikiAfter.docs.some((d) => d.id === decisionSourceDoc.id)
    && wikiAfter.docs.some((d) => d.slug === 'build-plan'),
    JSON.stringify(wikiAfter.docs.map((d) => d.slug)));

  // An open decision, or a link to one, must not move the number `rollup.js`
  // computes — the same discipline the git deck's health score is held to.
  const readinessBefore = rollup.readiness(await query.select({ filters: { project: vw } }));
  await mut4.createDecision(ctx, { project_id: vw, ref: 'D-91', title: 'Another selftest decision' });
  await mut4.linkWork(ctx, d25.id, { work_package_id: 112, relation: 'blocks' });
  const readinessAfter = rollup.readiness(await query.select({ filters: { project: vw } }));
  eq('an open decision is not progress', readinessAfter, readinessBefore);

  const chainLayers = decisionsDomain.layer(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [{ decision_id: 2, depends_on_id: 1 }, { decision_id: 3, depends_on_id: 2 }]
  );
  check('the gating chain is ordered',
    chainLayers.get(1) < chainLayers.get(2) && chainLayers.get(2) < chainLayers.get(3),
    JSON.stringify([...chainLayers]));

  await mut4.createDecision(ctx, { project_id: vw, ref: 'D-92', title: 'Trail check decision' });
  const decisionTrail = await db.one(`
    SELECT id FROM activities WHERE project_id = ? AND kind = 'decision' AND target_label = 'D-92'
     ORDER BY id DESC LIMIT 1`, [vw]);
  check('writing a decision is recorded in the trail', Boolean(decisionTrail));

  await throws('somebody without record_decisions cannot settle a decision',
    () => mut4.updateDecision(readerCtx, d25.id, { state: 'settled' }), 'record_decisions');

  // --- the map
  //
  // One project, three pictures. Every figure on it comes from `rollup.js` and
  // every rank from `src/domain/graph.js`; these checks are that the payload
  // says so honestly, not that the arithmetic is right — the arithmetic is
  // checked where it lives.
  const views7Api = require('../src/api/views7');
  const mapData = await views7Api.map(ctx, { projectId: vw });

  const mapWps = await query.select({ filters: { project: vw }, limit: 1000 });
  eq('the map reports the same readiness as rollup does for the same list',
    mapData.totals.readiness, rollup.readiness(mapWps));
  eq('and the same completion, beside it rather than folded into it',
    mapData.totals.completion, rollup.completion(mapWps));
  check('readiness and completion are separate keys, never one figure',
    mapData.totals.readiness.pct !== undefined && mapData.totals.completion.done !== undefined
      && mapData.totals.readiness.pct !== mapData.totals.completion.done + mapData.totals.completion.partial,
    JSON.stringify(mapData.totals));

  // Excluded is not zero, and the client can only say so if the NULL survives.
  check('an excluded status keeps its NULL weight all the way to the payload',
    mapData.statuses.some((st) => st.progress_weight === null),
    JSON.stringify(mapData.statuses.map((st) => [st.code, st.progress_weight])));
  // The deferred work in the demo portfolio is in CDX, not VW, so this is
  // checked where the data is rather than asserted where it is not.
  const cdxId = await db.scalar("SELECT id FROM projects WHERE code = 'CDX'");
  const cdxMap = await views7Api.map(ctx, { projectId: cdxId });
  const excludedRow = cdxMap.tree.groups.flatMap((g) => g.rows).find((r) => r.progress_weight === null);
  check('and so does a work package sitting on one', Boolean(excludedRow),
    'without it the screen draws a blank cell where it should say EXCLUDED');
  check('excluded work leaves the denominator rather than being scored zero',
    cdxMap.totals.readiness.excluded > 0
      && cdxMap.totals.readiness.scored === cdxMap.totals.completion.total - cdxMap.totals.readiness.excluded,
    JSON.stringify(cdxMap.totals.readiness));

  await throws('the map refuses a grouping it does not know',
    () => views7Api.map(ctx, { projectId: vw, group: 'colour' }), 'unknown grouping');
  await throws('and refuses to be drawn for no project at all',
    () => views7Api.map(ctx, { projectId: null }), 'one project');

  const ungrouped = mapData.tree.groups;
  eq('ungrouped, the tree is one group holding the whole hierarchy', ungrouped.length, 1);
  check('and every work package is in it', ungrouped[0].rows.length === mapWps.length,
    `${ungrouped[0].rows.length} of ${mapWps.length}`);
  check('a child is drawn deeper than its parent',
    ungrouped[0].rows.some((r) => r.depth > 0));
  const withKids = ungrouped[0].rows.find((r) => r.childCount > 0);
  check('a branch carries the pair for everything inside it', Boolean(withKids && withKids.subtree),
    'a collapsed branch that says nothing about its contents is a branch nobody opens');

  const grouped = await views7Api.map(ctx, { projectId: vw, group: 'version' });
  check('grouping by version splits the tree', grouped.tree.groups.length > 1,
    `${grouped.tree.groups.length} groups`);
  eq('and every work package is still in exactly one group',
    grouped.tree.groups.reduce((a, g) => a + g.rows.length, 0), mapWps.length);
  check('each group carries its own pair, not a share of the project figure',
    grouped.tree.groups.every((g) => g.readiness && g.completion));
  // Sorting the unset bucket in alphabetically would bury it mid-list.
  const unsetAt = grouped.tree.groups.findIndex((g) => g.key === null);
  check('the unset bucket is last, or absent',
    unsetAt === -1 || unsetAt === grouped.tree.groups.length - 1, String(unsetAt));

  check('the relations graph draws only work that carries a relation',
    mapData.relations.nodes.every((n) => mapData.relations.edges
      .some((e) => e.from_id === n.id || e.to_id === n.id)),
    'a hundred unconnected dots say nothing the tree does not say better');
  check('and every relation it draws has both ends on the map',
    mapData.relations.edges.every((e) => mapData.relations.nodes.some((n) => n.id === e.from_id)
      && mapData.relations.nodes.some((n) => n.id === e.to_id)));
  check('an unordered relation kind gets no arrow direction',
    mapData.relations.edges.filter((e) => !views7Api.PRECEDENCE[e.kind])
      .every((e) => e.after === null && e.before === null));

  // The drawing limit is a refusal that says why, not a silent truncation.
  eq('the drawing limit is reported whether or not it was hit',
    typeof mapData.relations.limit, 'number');
  check('a graph under the limit is drawn', mapData.relations.drawn === true,
    `${mapData.relations.nodeCount} nodes, limit ${mapData.relations.limit}`);

  check('the decision graph ranks a gated decision behind its gate',
    mapData.decisions.nodes.every((n) => mapData.decisions.edges
      .filter((e) => e.from === n.id)
      .every((e) => {
        const gate = mapData.decisions.nodes.find((o) => o.id === e.to);
        return !gate || gate.rank < n.rank;
      })));
  check('a link to a decision records where it came from',
    mapData.decisions.links.every((l) => ['person', 'import', 'matcher'].includes(l.origin)),
    'a regex claim drawn the same as a person claim is the thing the git deck rules prevent');
  check('and a decision blocking nothing is not counted as blocking something',
    mapData.decisions.nodes.every((n) => n.blocksCount >= 0)
      && mapData.decisions.nodes.every((n) => n.state === 'open' || n.blocksCount === 0));

  // A link somebody removed keeps its row and is never revived. The map is a
  // read path, so the only way it could revive one is by forgetting the
  // removed_at filter — which is exactly the mistake this makes visible.
  const drawnLink = mapData.decisions.links[0];
  check('the map draws a live decision link at all', Boolean(drawnLink));
  if (drawnLink) {
    await mut4.unlinkWork(ctx, drawnLink.decision_id, drawnLink.work_package_id);
    const afterRemoval = await views7Api.map(ctx, { projectId: vw });
    check('a link somebody removed is not drawn on the map',
      !afterRemoval.decisions.links.some((l) => l.decision_id === drawnLink.decision_id
        && l.work_package_id === drawnLink.work_package_id));
    check('and the row is kept rather than deleted',
      Number(await db.scalar(`SELECT COUNT(*) FROM decision_work_packages
         WHERE decision_id = ? AND work_package_id = ? AND removed_at IS NOT NULL`,
      [drawnLink.decision_id, drawnLink.work_package_id])) === 1);
  }

  // --- meetings
  const meeting = await db.one("SELECT id FROM meetings WHERE state = 'minutes' LIMIT 1");
  await throws('a frozen agenda refuses a new item',
    () => mut2.addAgendaItem(ctx, meeting.id, { title: 'late' }), 'frozen');
  const openMeeting = await db.one("SELECT id FROM meetings WHERE state = 'agenda' LIMIT 1");
  const item = await mut2.addAgendaItem(ctx, openMeeting.id, { title: 'from the selftest', duration_min: 5 });
  check('an open agenda accepts one', Boolean(item.id));

  // --- shares
  const shared = await mut.share(ctx, 121, { permission: 'view', days: 7 });
  check('a share produces a URL', /^\/share\/[A-Za-z0-9]+$/.test(shared.url));
  const shareRow = await db.one('SELECT * FROM work_package_shares WHERE id = ?', [shared.id]);
  eq('a share never includes internal comments', Number(shareRow.includes_internal), 0);
  const auth = require('../src/http/auth');
  const resolved = await auth.shareFor(shareRow.token);
  eq('a live share resolves', Number(resolved.work_package_id), 121);
  await mut.revokeShare(ctx, shared.id);
  await throws('a revoked share stops working', () => auth.shareFor(shareRow.token), 'revoked');
  // A live one, kept for the HTTP checks below: the share PAGE has to be
  // reachable by somebody with no account, which is a different thing from the
  // API being reachable.
  const livingShare = await mut.share(ctx, 121, { permission: 'view', days: 7 });
  const livingToken = livingShare.url.split('/').pop();
  await throws('a malformed share token is refused before any lookup',
    () => auth.shareFor('../../etc/passwd'), 'not a share token');

  // --- email intake
  const rejected = await mut2.receiveEmail({
    from: 'stranger@elsewhere.invalid', to: 'tasks@seedfall.local', subject: 'hello', body: 'x',
  });
  eq('an unknown sender is rejected', rejected.state, 'rejected');
  const reason = await db.scalar('SELECT reason FROM email_intake WHERE id = ?', [rejected.id]);
  check('and the reason is recorded rather than the mail dropped', Boolean(reason), 'no reason recorded');
  const created = await mut2.receiveEmail({
    from: 'stephen@seedfall.local', to: 'tasks+vw@seedfall.local',
    subject: 'a task by email', body: 'body',
  });
  eq('a member creates a work package by email', created.state, 'created');
  const asComment = await mut2.receiveEmail({
    from: 'stephen@seedfall.local', to: 'tasks@seedfall.local',
    subject: 'Re: WP-121 something', body: 'a reply',
  });
  eq('a subject naming a work package becomes a comment on it', asComment.state, 'commented');

  // --- date alerts do not repeat within a day
  const notifyDomain = require('../src/domain/notify');
  const first = await notifyDomain.runDateAlerts(ctx.today);
  const second = await notifyDomain.runDateAlerts(ctx.today);
  check('a date alert rule fires', first.length >= 0);
  eq('running the rules twice in a day does not repeat itself', second.length, 0);

  // --- sessions
  await throws('a wrong password is refused', () => auth.signIn('stephen', 'wrong'), 'do not match');
  await throws('an unknown login gives the same message',
    () => auth.signIn('nobody', 'x'), 'do not match');
  const placeholderLogin = await db.scalar("SELECT login FROM users WHERE kind = 'placeholder' LIMIT 1");
  eq('a placeholder has no login to sign in with', placeholderLogin, null);
  const session = await auth.signIn('stephen', 'projecttracker', 'selftest');
  check('the right password signs in', Boolean(session.token));
  const me = await auth.currentUser({ headers: { cookie: `pt_session=${session.token}` } });
  eq('the session resolves to the user', me.login, 'stephen');
  check('the session token is not handed back to page script', me.sessionToken === undefined,
    'returning it would give up what httpOnly buys');
  await auth.signOut(session.token);
  eq('signing out invalidates it',
    await auth.currentUser({ headers: { cookie: `pt_session=${session.token}` } }), null);

  // --- importing a tracker state file
  //
  // A fixture rather than the real 557KB file: a check that needs half a
  // megabyte of somebody else's project committed beside it is a check that gets
  // deleted the first time the file moves.
  const importer = require('../db/import-state');
  const importDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-import-'));
  const stateFile = path.join(importDir, 'fixture-state.json');
  const fixture = {
    schemaVersion: 1,
    project: 'Fixture',
    updated: '2026-08-20T00:00:00.000Z',
    build: { label: 'two of four', note: 'the fixture build' },
    features: {
      'F-AA-001': { status: 'done', updated: '2026-08-01T00:00:00.000Z', note: 'finished' },
      'F-AA-002': { status: 'speccing', updated: '2026-08-02T00:00:00.000Z' },
      'F-BB-001': { status: 'deferred', updated: '2026-08-03T00:00:00.000Z' },
      'F-BB-002': { status: 'in_build', updated: '2026-08-04T00:00:00.000Z' },
    },
    decisions: {
      D1: { state: 'settled', answer: 'Do the first thing. It was cheaper.', updated: '2026-08-05T00:00:00.000Z' },
      D2: { state: 'open', note: 'Nobody has decided this yet.', updated: '2026-08-06T00:00:00.000Z' },
    },
    questions: {
      'Q-F-AA-001-abc': { state: 'answered', answer: 'Three is enough.', updated: '2026-08-07T00:00:00.000Z' },
      'Q-F-ZZ-999-def': { state: 'answered', answer: 'About a feature that is not here.', updated: '2026-08-08T00:00:00.000Z' },
    },
    activity: [
      { ts: '2026-08-04T00:00:00.000Z', kind: 'feature', id: 'F-BB-002', from: 'speccing', to: 'in_build', note: 'picked up', by: 'claude' },
    ],
  };
  fs.writeFileSync(stateFile, JSON.stringify(fixture));

  await throws('an import refuses to guess between two administrators',
    () => importer.runImport({ file: stateFile, code: 'ZZ' }), 'administrators exist');

  const dry = await importer.runImport({ file: stateFile, code: 'ZZ', asLogin: 'stephen', dryRun: true });
  eq('a dry run reports what it would do', dry.report.features.created, 4);
  eq('and writes nothing', Number(await db.scalar("SELECT COUNT(*) FROM projects WHERE code = 'ZZ'")), 0);

  const imported1 = await importer.runImport({ file: stateFile, code: 'ZZ', asLogin: 'stephen' });
  eq('an import creates one work package per feature', imported1.report.features.created, 4);
  const zz = await db.scalar("SELECT id FROM projects WHERE code = 'ZZ'");
  const zzRows = await db.query(`
    SELECT wp.subject, s.code AS status FROM work_packages wp JOIN statuses s ON s.id = wp.status_id
     WHERE wp.project_id = ? ORDER BY wp.subject`, [zz]);
  eq('with the statuses the file gave them',
    zzRows.map((r) => `${r.subject}:${r.status}`),
    ['F-AA-001:done', 'F-AA-002:speccing', 'F-BB-001:deferred', 'F-BB-002:in_build']);
  // The check the whole script exists for: the tracker's counts are the file's.
  const agrees = await importer.verify(importer.readState(stateFile), zz);
  check('and the tracker\'s completion counts reproduce the file\'s', agrees.same,
    JSON.stringify({ db: agrees.fromDb, file: agrees.fromFile }));
  eq('no feature is given a parent, so nothing is invented into the denominator',
    Number(await db.scalar('SELECT COUNT(*) FROM work_packages WHERE project_id = ? AND parent_id IS NOT NULL', [zz])),
    0);

  eq('an answered question becomes a comment on the feature it names',
    Number(await db.scalar(`
      SELECT COUNT(*) FROM comments c JOIN work_packages wp ON wp.id = c.container_id
       WHERE c.container_type = 'work_package' AND wp.project_id = ? AND wp.subject = 'F-AA-001'`, [zz])),
    1);
  eq('and a question naming a feature the file does not carry is reported, not dropped silently',
    imported1.report.questions.orphans, ['Q-F-ZZ-999-def']);

  const decisionRow = await db.one(
    "SELECT ref, title, state FROM decisions WHERE project_id = ? AND ref = 'D2'", [zz]
  );
  eq('a decision becomes a decisions row carrying its state', decisionRow.state, 'open');
  eq('and creates no document for it',
    Number(await db.scalar("SELECT COUNT(*) FROM documents WHERE project_id = ? AND slug = 'd2'", [zz])), 0);
  const zzProject = await db.one('SELECT health, health_note FROM projects WHERE id = ?', [zz]);
  check('and an unsettled decision makes the project rust, which is what rust is for',
    zzProject.health === 'rust' && /D2/.test(zzProject.health_note), JSON.stringify(zzProject));

  eq('a feature imported as done carries the date it closed',
    String(await db.scalar(`
      SELECT closed_at FROM work_packages WHERE project_id = ? AND subject = 'F-AA-001'`, [zz])).slice(0, 10),
    '2026-08-01');

  // Health is recorded, not derived: the import maintains the note it wrote and
  // leaves a person's alone.
  await db.update('projects', zz, { health: 'amber', health_note: 'Watched by hand' });
  const afterHand = await importer.runImport({ file: stateFile, code: 'ZZ', asLogin: 'stephen' });
  const stillHand = await db.one('SELECT health, health_note FROM projects WHERE id = ?', [zz]);
  check('an import does not overwrite a health note somebody wrote',
    stillHand.health === 'amber' && stillHand.health_note === 'Watched by hand'
      && afterHand.report.healthLeftAlone === 'Watched by hand',
    JSON.stringify(stillHand));
  await db.update('projects', zz, { health_note: '1 decision(s) waiting on a person: D2' });
  await importer.runImport({ file: stateFile, code: 'ZZ', asLogin: 'stephen' });
  eq('and takes its own note back over when it is the one standing there',
    (await db.scalar('SELECT health FROM projects WHERE id = ?', [zz])), 'rust');

  const imported = await db.one(
    "SELECT actor_id, actor_label FROM activities WHERE project_id = ? AND target_label = 'F-BB-002'", [zz]
  );
  check('the imported trail keeps the source actor as a label, not as a person here',
    imported && imported.actor_id === null && imported.actor_label === 'claude',
    JSON.stringify(imported));

  const again = await importer.runImport({ file: stateFile, code: 'ZZ', asLogin: 'stephen' });
  eq('a second import of the same file changes nothing', again.report.features.created, 0);
  eq('and adds no duplicate activity', again.report.activity.created, 0);
  eq('and no duplicate comment', again.report.questions.created, 0);
  eq('a re-import updates the same decision rather than making a second one',
    again.report.decisions.created, 0);
  eq('and the ref still resolves to exactly one row',
    Number(await db.scalar("SELECT COUNT(*) FROM decisions WHERE project_id = ? AND ref = 'D2'", [zz])), 1);

  fixture.features['F-AA-002'].status = 'done';
  delete fixture.features['F-BB-001'];
  fs.writeFileSync(stateFile, JSON.stringify(fixture));
  const merged = await importer.runImport({ file: stateFile, code: 'ZZ', asLogin: 'stephen' });
  eq('a later file moves the status it changed', merged.report.features.statusChanged,
    ['F-AA-002 SPECCING → DONE']);
  eq('and never deletes what has left the file', merged.report.features.notInFile, 1);
  eq('the work package it stopped carrying is still there',
    Number(await db.scalar("SELECT COUNT(*) FROM work_packages WHERE project_id = ? AND subject = 'F-BB-001'", [zz])),
    1);

  fixture.features['F-AA-001'].status = 'invented';
  fs.writeFileSync(stateFile, JSON.stringify(fixture));
  await throws('a status this database does not have stops the import and names it',
    () => importer.runImport({ file: stateFile, code: 'ZZ', asLogin: 'stephen' }), '"invented"');
  fs.rmSync(importDir, { recursive: true, force: true });

  // --- the git deck, end to end against a stubbed forge
  //
  // The suite must not reach the network any more than it may reach the real
  // database, so the client is created over a stub `fetch`. What is exercised is
  // everything after the response: the normalising, the matching, the mirror,
  // the trail, and the two rules that stop a pull overruling a person.
  const gitdeckDomain = require('../src/domain/gitdeck');
  const forgeClient = require('../src/gitdeck/client');
  const gitPull = require('../src/gitdeck/pull');
  const mut3 = require('../src/api/mutations3');
  const views5 = require('../src/api/views5');

  // The mapping the six types ship with. The example in the brief is the third
  // row: a FEATURE is a pull request, and F- is the letter its keys start with.
  const typeMap = await db.query(
    'SELECT name, git_item_kind, git_relation, git_key_prefix FROM work_package_types ORDER BY position'
  );
  eq('every type says what it is in a repository',
    typeMap.map((t) => [t.name, t.git_item_kind, t.git_relation, t.git_key_prefix]),
    [['PHASE', 'milestone', 'tracks', 'PH'], ['EPIC', 'issue', 'tracks', 'E'],
      ['FEATURE', 'pull_request', 'implements', 'F'], ['TASK', 'issue', 'implements', 'T'],
      ['BUG', 'issue', 'fixes', 'B'], ['MILESTONE', 'release', 'releases', 'M']]);

  const seedRepo = await db.one("SELECT * FROM repositories WHERE slug = 'seedfall/seedfall'");
  check('the demo repository knows its owner and name', Boolean(seedRepo && seedRepo.slug));
  check('and records the name of the variable its token is read from, never a token',
    seedRepo.token_env === 'GITHUB_TOKEN'
    && !Object.values(seedRepo).some((v) => typeof v === 'string' && /^gh[pousr]_/.test(v)),
    JSON.stringify(seedRepo));

  // The demo's links are seeded rows; the matcher is code. If they disagree,
  // one of them is lying about what a pull would do.
  const demoRules = await gitPull.rulesFor(seedRepo.id);
  const demoIndex = await gitPull.indexFor(seedRepo.project_id, demoRules);
  const demoItems = await db.query('SELECT * FROM git_items WHERE repository_id = ?', [seedRepo.id]);
  const derivedLinks = [];
  for (const item of demoItems) {
    for (const link of gitdeckDomain.matchItem(item, demoIndex,
      { repositoryProjectId: Number(seedRepo.project_id) }).links) {
      derivedLinks.push([Number(link.work_package_id), item.kind, item.ref, link.relation, link.matched_key]);
    }
  }
  const seededLinks = (await db.query(`
    SELECT l.work_package_id, gi.kind, gi.ref, l.relation, l.matched_key
      FROM work_package_git_links l JOIN git_items gi ON gi.id = l.git_item_id
     WHERE gi.repository_id = ?`, [seedRepo.id]))
    .map((l) => [Number(l.work_package_id), l.kind, l.ref, l.relation, l.matched_key]);
  const asText = (rows) => rows.map((r) => r.join(' ')).sort();
  eq('the demo links are exactly what the matcher would produce', asText(seededLinks), asText(derivedLinks));

  // A stubbed GitHub. Two pull requests, an issue, a run, and one endpoint this
  // token may not read.
  const forgeResponses = {
    '/repos/seedfall/seedfall/pulls': [
      {
        number: 1978, title: 'F-UI-021 filterable task list', state: 'open',
        user: { login: 'stephen' }, head: { ref: 'feature/f-ui-021-list' }, base: { ref: 'main' },
        html_url: 'https://forge.invalid/pull/1978', body: 'Blocked on WP-112 for now.',
        labels: [{ name: 'ui' }], created_at: '2026-08-20T10:00:00Z', updated_at: '2026-08-25T10:00:00Z',
      },
      {
        number: 1979, title: 'F-UI-007 weighted rollup', state: 'closed',
        merged_at: '2026-08-24T09:00:00Z', user: { login: 'modell' },
        head: { ref: 'feature/f-ui-007-rollup' }, base: { ref: 'main' },
        html_url: 'https://forge.invalid/pull/1979', body: null, labels: [],
        created_at: '2026-08-19T10:00:00Z', updated_at: '2026-08-24T09:00:00Z',
      },
    ],
    '/repos/seedfall/seedfall/issues': [
      {
        number: 1300, title: 'F-NEW-999 something nobody has heard of', state: 'open',
        user: { login: 'jlin' }, html_url: 'https://forge.invalid/issues/1300', body: null,
        labels: [], created_at: '2026-08-18T10:00:00Z', updated_at: '2026-08-26T10:00:00Z',
      },
      { number: 1301, title: 'a pull request the issues endpoint also returned', state: 'open',
        pull_request: {}, html_url: 'https://forge.invalid/issues/1301',
        created_at: '2026-08-18T10:00:00Z', updated_at: '2026-08-18T10:00:00Z' },
    ],
    '/repos/seedfall/seedfall/milestones': [],
    '/repos/seedfall/seedfall/releases': [],
    '/repos/seedfall/seedfall/branches': [],
    '/repos/seedfall/seedfall/actions/runs': { workflow_runs: [] },
    '/repos/seedfall/seedfall/dependabot/alerts': 'FORBIDDEN',
    '/repos/seedfall/seedfall/commits': [
      { sha: 'feed1234beef', html_url: 'https://forge.invalid/commit/feed1234beef',
        commit: { message: 'F-UI-021 wire the filter', author: { name: 'Stephen', date: '2026-08-25T08:00:00Z' } } },
    ],
  };
  let forgeCalls = 0;
  const stubFetch = (url) => {
    forgeCalls += 1;
    const path = String(url).replace('https://api.github.com', '').split('?')[0];
    const data = forgeResponses[path];
    const headers = new Map([['x-ratelimit-remaining', '4321']]);
    headers.get = Map.prototype.get.bind(headers);
    if (data === undefined) {
      return Promise.resolve({ ok: false, status: 500, headers, json: async () => ({}) });
    }
    if (data === 'FORBIDDEN') {
      return Promise.resolve({ ok: false, status: 403, headers, json: async () => ({}) });
    }
    return Promise.resolve({ ok: true, status: 200, headers, json: async () => data });
  };
  const stubClient = forgeClient.create({ fetchImpl: stubFetch });

  const dryPull = await gitPull.pullRepository(ctx, seedRepo.id, { dryRun: true, client: stubClient });
  const beforeItems = Number(await db.scalar('SELECT COUNT(*) FROM git_items WHERE repository_id = ?', [seedRepo.id]));
  eq('a dry run writes no items', beforeItems, demoItems.length);
  check('but is recorded as having happened',
    Number(await db.scalar("SELECT COUNT(*) FROM git_pulls WHERE state = 'dry_run'")) === 1);
  check('a forbidden endpoint is reported and does not fail the pull',
    dryPull.problems.some((p) => /dependabot/.test(p)) && dryPull.items_seen > 0, JSON.stringify(dryPull.problems));

  const pulled = await gitPull.pullRepository(ctx, seedRepo.id, { client: stubClient });
  eq('the dry run and the real pull agree on what they would link',
    [dryPull.items_seen, dryPull.links_made], [pulled.items_seen, pulled.links_made]);
  check('a pull request the issues endpoint also returned is mirrored once',
    Number(await db.scalar(
      "SELECT COUNT(*) FROM git_items WHERE repository_id = ? AND ref IN ('1301')", [seedRepo.id]
    )) === 0, 'GitHub returns pull requests from /issues; mirroring both makes two of everything');

  const linkedTo1978 = await db.query(`
    SELECT wp.wp_key, wp.ref_key, l.relation, l.origin, l.matched_key, l.matched_in
      FROM work_package_git_links l
      JOIN git_items gi ON gi.id = l.git_item_id
      JOIN work_packages wp ON wp.id = l.work_package_id
     WHERE gi.ref = '1978' AND gi.repository_id = ? ORDER BY l.relation`, [seedRepo.id]);
  eq('F-UI-021 in a title implements the pull request, WP-112 in the body only mentions it',
    linkedTo1978.map((l) => [l.matched_key, l.relation, l.matched_in]),
    [['F-UI-021', 'implements', 'title'], ['WP-112', 'mentions', 'body']]);

  check('a key that matches nothing is kept with the number of times it was seen',
    Number(await db.scalar(
      'SELECT seen_count FROM git_unmatched_keys WHERE repository_id = ? AND candidate = ?',
      [seedRepo.id, 'F-NEW-999']
    )) >= 1);

  const commitLinked = await db.scalar(`
    SELECT COUNT(*) FROM revision_work_packages rwp
      JOIN repository_revisions rv ON rv.id = rwp.revision_id
     WHERE rv.identifier = 'feed1234beef'`);
  check('a key in a commit message links the commit to the work package', Number(commitLinked) === 1);

  const pullTrail = await db.one(`
    SELECT actor_id, actor_label, kind, verb FROM activities
     WHERE kind = 'repo' AND verb = 'pulled' ORDER BY id DESC LIMIT 1`);
  check('a pull is in the activity trail as a machine, not as the person who ran it',
    pullTrail && pullTrail.actor_label === 'gitdeck' && pullTrail.actor_id === null,
    JSON.stringify(pullTrail));

  // A link a person removed is a decision. The next pull must not overturn it.
  const link1978 = await db.one(`
    SELECT l.id FROM work_package_git_links l JOIN git_items gi ON gi.id = l.git_item_id
     WHERE gi.ref = '1978' AND l.relation = 'implements'`);
  await mut3.unlinkWorkPackage(ctx, link1978.id);
  const afterUnlink = await db.one('SELECT removed_at, removed_by FROM work_package_git_links WHERE id = ?',
    [link1978.id]);
  check('removing a link keeps its row and says who removed it',
    afterUnlink.removed_at !== null && Number(afterUnlink.removed_by) === Number(ctx.user.id));
  const secondPull = await gitPull.pullRepository(ctx, seedRepo.id, { client: stubClient });
  check('and the next pull holds it back rather than re-making it',
    secondPull.links_held >= 1
    && (await db.scalar('SELECT removed_at FROM work_package_git_links WHERE id = ?', [link1978.id])) !== null,
    `held ${secondPull.links_held}`);
  await mut3.linkWorkPackage(ctx, 121, { item_id: Number(await db.scalar(
    "SELECT id FROM git_items WHERE ref = '1978' AND repository_id = ?", [seedRepo.id]
  )), relation: 'implements' });
  check('a person can put it back by hand, which a pull cannot',
    (await db.scalar('SELECT removed_at FROM work_package_git_links WHERE id = ?', [link1978.id])) === null);

  // The status rule. Off by default, and even when on it goes through the
  // workflow rather than around it.
  eq('a pull moves no status until a repository is told to',
    pulled.moves.length, 0);
  const featureType = await db.scalar("SELECT id FROM work_package_types WHERE name = 'FEATURE'");
  const doneStatus = await db.scalar("SELECT id FROM statuses WHERE code = 'done'");
  const buildStatus = await db.scalar("SELECT id FROM statuses WHERE code = 'in_build'");
  await db.run(`
    INSERT INTO git_type_rules (repository_id, type_id, item_kind, relation, key_prefix, merged_status_id)
    VALUES (?, ?, 'pull_request', 'implements', 'F', ?)`, [seedRepo.id, featureType, doneStatus]);
  await db.run('UPDATE work_packages SET status_id = ? WHERE id = 112', [buildStatus]);
  const withRule = await gitPull.pullRepository(ctx, seedRepo.id, { client: stubClient });
  eq('a merged pull request moves the work package it implements',
    Number(await db.scalar('SELECT status_id FROM work_packages WHERE id = 112')), Number(doneStatus));
  check('and the move is in the trail as the machine',
    Boolean(await db.one(`
      SELECT id FROM activities WHERE work_package_id = 112 AND kind = 'status'
        AND actor_label = 'gitdeck' AND actor_id IS NULL ORDER BY id DESC LIMIT 1`)),
    JSON.stringify(withRule.moves));

  const notStarted = await db.scalar("SELECT id FROM statuses WHERE code = 'not_started'");
  await db.run('UPDATE work_packages SET status_id = ? WHERE id = 112', [notStarted]);
  const refused = await gitPull.pullRepository(ctx, seedRepo.id, { client: stubClient });
  check('but the status workflow still refuses a move it does not have',
    Number(await db.scalar('SELECT status_id FROM work_packages WHERE id = 112')) === Number(notStarted)
    && refused.problems.some((p) => /cannot move straight/.test(p)),
    JSON.stringify(refused.problems));
  await db.run('UPDATE work_packages SET status_id = ? WHERE id = 112', [buildStatus]);
  await db.run('DELETE FROM git_type_rules WHERE repository_id = ?', [seedRepo.id]);

  // The repository key: what makes F-LOAD-012 findable at all.
  await throws('a repository key no branch could carry is refused',
    () => mut3.setRefKey(ctx, 123, 'the loader'), 'not a key a repository could carry');
  await throws('and two work packages cannot share one in a project',
    () => mut3.setRefKey(ctx, 123, 'F-LOAD-012'), 'already carries the key');
  const keyed = await mut3.setRefKey(ctx, 123, 'f-ui-030');
  eq('a repository key is stored as it is written in a title', keyed.ref_key, 'F-UI-030');

  await throws('a token pasted into token_env is refused rather than stored',
    () => mut3.createRepository(ctx, {
      project_id: 1, scm: 'github', name: 'x/y', url: 'https://github.com/x/y',
      token_env: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    }), 'looks like a token');
  await throws('and so is anything else that is not a variable name',
    () => mut3.createRepository(ctx, {
      project_id: 1, scm: 'github', name: 'x/y', url: 'https://github.com/x/y',
      token_env: 'my token please',
    }), 'not an environment variable name');
  await throws('a forgejo repository must say where its forge is',
    () => mut3.createRepository(ctx, {
      project_id: 1, scm: 'forgejo', name: 'x/y', url: 'https://codeberg.org/x/y',
    }), 'api_base');

  const deckPayload = await views5.deck(ctx, { projectId: 1 });
  check('the deck reports a health score and says it is not readiness',
    deckPayload.repositories.some((r) => r.health && typeof r.health.score === 'number')
    && /not readiness|neither is readiness|readiness/i.test(deckPayload.note),
    deckPayload.note);
  check('a repository nothing has been pulled from has no health score at all',
    deckPayload.repositories.some((r) => r.scm === 'git' && r.health === null),
    'a number that looks computed and is not is worse than a blank');
  eq('the deck names what a FEATURE maps to',
    deckPayload.mapping.find((m) => m.type === 'FEATURE').example,
    'F-LOAD-012 maps to pull request #978');
  check('the pull requests it fetched are on the deck',
    deckPayload.items.some((i) => i.kind === 'pull_request' && i.ref === '1978'),
    `${deckPayload.items.length} items`);
  check('and the forge was only ever reached through the stub', forgeCalls > 0);


  // --- the webhook receiver, end to end
  //
  // The delivery is signed here with the same HMAC a forge would use, so what is
  // exercised is the real path: verify the raw bytes, refuse anything that does
  // not verify, record every outcome, and write through the pull's own mirror.
  const hooksApi = require('../src/gitdeck/hooks');
  const HOOK_SECRET = 'selftest-hook-secret';
  process.env.PT_TEST_HOOK_SECRET = HOOK_SECRET;
  const sign = (buf, secret = HOOK_SECRET) => (
    'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex')
  );
  const deliver = (repoId, event, payload, opts = {}) => {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    return hooksApi.receive({
      repositoryId: repoId,
      headers: {
        'x-github-event': event,
        'x-github-delivery': opts.delivery || `selftest-${event}-${Math.round(payload.__n || 0)}`,
        'x-hub-signature-256': opts.signature === null ? undefined : (opts.signature || sign(raw, opts.secret)),
        'content-type': 'application/json',
      },
      raw,
    });
  };

  const prPayload = (n, overrides = {}) => ({
    __n: n,
    action: overrides.action || 'closed',
    pull_request: {
      number: n, title: overrides.title || 'F-UI-021 filterable task list',
      state: 'closed', merged_at: '2026-08-26T09:00:00Z',
      user: { login: 'stephen' }, head: { ref: 'feature/f-ui-021-list' }, base: { ref: 'main' },
      html_url: `https://forge.invalid/pull/${n}`, body: overrides.body || null, labels: [],
      created_at: '2026-08-20T10:00:00Z', updated_at: '2026-08-26T09:00:00Z',
      ...overrides.pull,
    },
  });

  // Nothing is open until a repository names a secret. The demo seeds one, so
  // it is cleared first — this is the path a freshly connected repository takes.
  await db.run('UPDATE repositories SET hook_secret_env = NULL WHERE id = ?', [seedRepo.id]);
  const closed = await deliver(seedRepo.id, 'pull_request', prPayload(3001));
  eq('a repository with no hook_secret_env has no open endpoint', closed.status, 401);
  check('and the refusal names what is missing rather than saying "forbidden"',
    /hook_secret_env/.test(closed.body.error) && /never accepted/.test(closed.body.error),
    closed.body.error);
  check('and the refusal is recorded with its reason',
    Number(await db.scalar(
      "SELECT COUNT(*) FROM git_hook_deliveries WHERE repository_id = ? AND state = 'rejected'", [seedRepo.id]
    )) >= 1);

  await db.run("UPDATE repositories SET hook_secret_env = 'PT_TEST_MISSING_SECRET' WHERE id = ?", [seedRepo.id]);
  const unset = await deliver(seedRepo.id, 'pull_request', prPayload(3002));
  check('a secret variable that is not set is refused, and named',
    unset.status === 401 && /PT_TEST_MISSING_SECRET/.test(unset.body.error), JSON.stringify(unset.body));

  await db.run("UPDATE repositories SET hook_secret_env = 'PT_TEST_HOOK_SECRET' WHERE id = ?", [seedRepo.id]);
  const wrongSig = await deliver(seedRepo.id, 'pull_request', prPayload(3003), { secret: 'not-the-secret' });
  eq('a delivery signed with the wrong secret is refused', wrongSig.status, 401);
  check('and nothing it carried was written',
    Number(await db.scalar("SELECT COUNT(*) FROM git_items WHERE ref = '3003'")) === 0);

  const applied = await deliver(seedRepo.id, 'pull_request', prPayload(3004), { delivery: 'd-3004' });
  eq('a signed delivery is applied', applied.body.state, 'applied');
  const mirrored = await db.one(
    "SELECT kind, state, head_branch FROM git_items WHERE repository_id = ? AND ref = '3004'", [seedRepo.id]
  );
  eq('and the item it carried is mirrored as a merged pull request',
    [mirrored.kind, mirrored.state], ['pull_request', 'merged']);
  const hookLink = await db.one(`
    SELECT l.relation, l.matched_key, l.actor_label, wp.wp_key
      FROM work_package_git_links l
      JOIN git_items gi ON gi.id = l.git_item_id
      JOIN work_packages wp ON wp.id = l.work_package_id
     WHERE gi.ref = '3004' AND gi.repository_id = ?`, [seedRepo.id]);
  eq('and it is linked to the work package its title names, as a machine',
    [hookLink.wp_key, hookLink.relation, hookLink.matched_key, hookLink.actor_label],
    ['WP-121', 'implements', 'F-UI-021', 'gitdeck · webhook']);

  const retry = await deliver(seedRepo.id, 'pull_request', prPayload(3004), { delivery: 'd-3004' });
  eq('a redelivery of the same id is ignored rather than applied twice', retry.body.state, 'ignored');
  check('and the retry keeps its own row, because a retry is a fact',
    Number(await db.scalar(
      'SELECT COUNT(*) FROM git_hook_deliveries WHERE repository_id = ? AND delivery_id = ?',
      [seedRepo.id, 'd-3004']
    )) === 2);

  // A status rule, with and without somebody to act as.
  await db.run(`
    INSERT INTO git_type_rules (repository_id, type_id, item_kind, relation, key_prefix, merged_status_id)
    VALUES (?, ?, 'pull_request', 'implements', 'F', ?)`, [seedRepo.id, featureType, doneStatus]);
  await db.run('UPDATE work_packages SET status_id = ? WHERE id = 121', [buildStatus]);
  await db.run('UPDATE repositories SET hook_actor_id = NULL WHERE id = ?', [seedRepo.id]);
  const noActor = await deliver(seedRepo.id, 'pull_request', prPayload(3005), { delivery: 'd-3005' });
  eq('with nobody to act as, a delivery moves no status',
    Number(await db.scalar('SELECT status_id FROM work_packages WHERE id = 121')), Number(buildStatus));
  check('and says so rather than reporting nothing happened',
    noActor.body.problems.some((p) => /names nobody/.test(p)), JSON.stringify(noActor.body.problems));

  await db.run('UPDATE repositories SET hook_actor_id = ? WHERE id = ?', [stephen, seedRepo.id]);
  const withActor = await deliver(seedRepo.id, 'pull_request', prPayload(3006), { delivery: 'd-3006' });
  eq('with an actor named, a merged pull request moves the work package it implements',
    Number(await db.scalar('SELECT status_id FROM work_packages WHERE id = 121')), Number(doneStatus));
  eq('and the delivery reports the move', withActor.body.moves.length, 1);
  const hookTrail = await db.one(`
    SELECT actor_id, actor_label FROM activities
     WHERE work_package_id = 121 AND kind = 'status' ORDER BY id DESC LIMIT 1`);
  check('and the trail records the webhook, not the person whose authority it borrowed',
    hookTrail.actor_label === 'gitdeck · webhook' && hookTrail.actor_id === null,
    JSON.stringify(hookTrail));

  // A push: the branch and the commits, through the same matcher.
  const pushRaw = {
    ref: 'refs/heads/feature/f-load-012-decisions',
    commits: [{
      id: 'dd44ee55ff66', message: 'F-UI-021 wire the filter', url: 'https://forge.invalid/c/dd44',
      timestamp: '2026-08-26T08:00:00Z', author: { name: 'Stephen' },
    }],
  };
  const pushed = await deliver(seedRepo.id, 'push', pushRaw, { delivery: 'd-push' });
  eq('a push mirrors the branch it created', pushed.body.state, 'applied');
  check('and links the branch to the work package its name carries',
    Boolean(await db.one(`
      SELECT l.id FROM work_package_git_links l JOIN git_items gi ON gi.id = l.git_item_id
       WHERE gi.kind = 'branch' AND gi.ref = 'feature/f-load-012-decisions' AND l.work_package_id = 103`)),
    'a branch named for a feature should find it the moment it is pushed');
  check('and links its commit to the work package its message names',
    Number(await db.scalar(`
      SELECT COUNT(*) FROM revision_work_packages rwp
        JOIN repository_revisions rv ON rv.id = rwp.revision_id
       WHERE rv.identifier = 'dd44ee55ff66'`)) === 1);

  const ping = await deliver(seedRepo.id, 'ping', { zen: 'Design for failure.' }, { delivery: 'd-ping' });
  check('a ping is answered and recorded rather than treated as an error',
    ping.status === 200 && ping.body.state === 'ignored' && /ping/.test(ping.body.reason), JSON.stringify(ping.body));
  const unknownEvent = await deliver(seedRepo.id, 'star', { action: 'created' }, { delivery: 'd-star' });
  check('an event nothing is mirrored from is ignored with the event named',
    unknownEvent.status === 200 && /star/.test(unknownEvent.body.reason), JSON.stringify(unknownEvent.body));

  const unknownRepo = await hooksApi.receive({
    repositoryId: 987654, headers: { 'x-github-event': 'ping' }, raw: Buffer.from('{}'),
  });
  check('a delivery to a repository that does not exist is a 404, and is still recorded',
    unknownRepo.status === 404
    && Number(await db.scalar('SELECT COUNT(*) FROM git_hook_deliveries WHERE repository_id IS NULL')) === 1);

  await db.run('DELETE FROM git_type_rules WHERE repository_id = ?', [seedRepo.id]);

  // Naming somebody who could not do it by hand is refused where it is set, not
  // discovered at three in the morning in a delivery record.
  await throws('a hook actor who cannot edit work packages here is refused',
    () => mut3.updateRepository(ctx, seedRepo.id, { hook_actor: 'jlin' }), 'could never move one');
  await throws('and a webhook secret pasted in place of a variable name is refused too',
    () => mut3.updateRepository(ctx, seedRepo.id, { hook_secret_env: 'ghp_abcdefghijklmnopqrstuvwxyz0123' }),
    'looks like a token');


  // --- the MCP surface
  const mcpRead = await mut2.issueMcpToken(ctx, { name: 'selftest read', scope: 'read' });
  check('an MCP token is returned once', mcpRead.secret.startsWith('pt_mcp_'));
  const storedSecret = await db.scalar('SELECT token_hash FROM mcp_tokens WHERE id = ?', [mcpRead.id]);
  check('and only its hash is stored',
    storedSecret === crypto.createHash('sha256').update(mcpRead.secret).digest('hex')
    && !storedSecret.includes(mcpRead.secret));

  const mcp = await mcpExchange(mcpRead.secret, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'portfolio.status', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'summary.write', arguments: { body: 'x' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'git.links', arguments: { key: 'F-LOAD-012' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'git.deck', arguments: {} } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'git.pull', arguments: { repository: 'seedfall/seedfall' } } },
  ]);
  const byId = new Map(mcp.map((m) => [m.id, m]));
  check('the MCP server answers initialize', Boolean(byId.get(1) && byId.get(1).result.serverInfo));
  const listed = byId.get(2).result.tools.map((t) => t.name);
  check('a read token is not offered the write tool', !listed.includes('summary.write'),
    `offered ${listed.join(', ')}`);
  check('portfolio.status returns projects', /"projects"/.test(byId.get(3).result.content[0].text));
  check('a read token calling the write tool is refused',
    Boolean(byId.get(4).error) && /read-scoped/.test(byId.get(4).error.message));
  check('an assistant can ask what a repository key maps to, by that key',
    /pull request|pull_request/.test(byId.get(5).result.content[0].text)
    && /F-LOAD-012/.test(byId.get(5).result.content[0].text),
    byId.get(5).result.content[0].text.slice(0, 200));
  check('and the deck tool says the health score is not readiness',
    /readiness/.test(byId.get(6).result.content[0].text),
    byId.get(6).result.content[0].text.slice(0, 200));
  check('pulling a repository is a write, so a read token is refused it',
    !listed.includes('git.pull') && Boolean(byId.get(7).error) && /read-scoped/.test(byId.get(7).error.message));
  const audited = await db.query('SELECT tool, mode, outcome FROM mcp_audit ORDER BY id');
  check('every MCP call is audited, reads included',
    audited.some((a) => a.tool === 'portfolio.status' && a.outcome === 'ok')
    && audited.some((a) => a.tool === 'summary.write' && a.outcome === 'denied'),
    JSON.stringify(audited));

  // --- the MCP write surface
  //
  // Every write goes through the same mutation functions the web app and the CLI
  // use, so what is checked here is the MCP half: the scope, the borrowed
  // authority, and that the trail says a machine did it.
  const mcpWrite = await mut2.issueMcpToken(ctx, { name: 'selftest write', scope: 'write' });
  const call = (id, name, args) => (
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
  );
  const wrote = new Map((await mcpExchange(mcpWrite.secret, [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    call(2, 'project.create', { code: 'SLF', name: 'Selftest project', template: 'SPEC' }),
    call(3, 'version.create', { project: 'SLF', code: 'VS', name: 'Selftest slice', due_date: '2026-12-01' }),
    call(4, 'version.create', { project: 'SLF', code: 'VS', name: 'Again' }),
    call(5, 'work_package.create', {
      project: 'SLF', subject: 'Written by the assistant', type: 'FEATURE',
      assignee: 'modell', version: 'VS', due_date: '2026-11-02', story_points: 3,
    }),
    call(7, 'wiki.create', { project: 'SLF', title: 'Selftest wiki page', body: '# One\n\nA page.' }),
    call(8, 'wiki.update', { slug: 'selftest-wiki-page', body: '# One\n\nRewritten.', base_revision: 0 }),
    call(9, 'wiki.update', { slug: 'selftest-wiki-page', body: '# One\n\nStale.', base_revision: 0 }),
  ])).map((m) => [m.id, m]));
  const text = (id) => (wrote.get(id).result ? wrote.get(id).result.content[0].text : '');
  const errored = (id) => Boolean(wrote.get(id).result && wrote.get(id).result.isError);

  const offered = wrote.get(1).result.tools.map((t) => t.name);
  check('a write token is offered the write tools',
    ['project.create', 'work_package.create', 'work_package.update', 'version.create',
      'wiki.create', 'wiki.update', 'comment.add', 'summary.write'].every((t) => offered.includes(t)),
    `offered ${offered.join(', ')}`);

  const madeProject = JSON.parse(text(2));
  eq('project.create applies the template blueprint', madeProject.created,
    { phases: 6, versions: 3, wiki_pages: 3, work_packages: 1 });
  const slf = await db.scalar("SELECT id FROM projects WHERE code = 'SLF'");
  const slfOwner = await db.scalar(`
    SELECT u.login FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?`, [slf]);
  eq('and the person who issued the token owns what it made', slfOwner, 'stephen');

  check('version.create makes one', JSON.parse(text(3)).code === 'VS', text(3));
  check('and refuses a code the project already uses', errored(4) && /already has a version/.test(text(4)),
    text(4));
  const madeWp = JSON.parse(text(5));
  eq('work_package.create resolves the assignee by login', madeWp.work_package.assignee, 'M. Odell');
  eq('and the version by code', madeWp.work_package.version, 'VS');
  eq('wiki.create starts a page at revision 0', JSON.parse(text(7)).revision, 0);
  eq('the first wiki.update makes revision 1', JSON.parse(text(8)).revision, 1);
  check('and a save against a revision that has moved on is refused, not merged',
    errored(9) && /moved on/.test(text(9)) && /revision 1/.test(text(9)), text(9));

  // The second exchange, because these two need the key the first one made.
  const onIt = new Map((await mcpExchange(mcpWrite.secret, [
    call(1, 'work_package.update', { key: madeWp.work_package.key, status: 'done' }),
    call(2, 'work_package.update', { key: madeWp.work_package.key, status: 'speccing', priority: 'high' }),
    call(3, 'comment.add', { work_package: madeWp.work_package.key, body: 'From the assistant.', internal: true }),
    call(4, 'comment.add', { work_package: madeWp.work_package.key, body: 'Picked up by @modell and @nobody.' }),
  ])).map((m) => [m.id, m]));
  const said = (id) => (onIt.get(id).result ? onIt.get(id).result.content[0].text : '');
  check('work_package.update goes through the status workflow rather than round it',
    onIt.get(1).result.isError && /cannot move straight/.test(said(1)), said(1));
  eq('a legal transition is applied and the change is named back',
    JSON.parse(said(2)).changed.sort(), ['priority_id', 'status_id']);
  check('an argument the tool does not have is refused rather than ignored',
    onIt.get(3).result.isError && /no argument called "internal"/.test(said(3)),
    'silently dropping it would have written a comment the caller thought was internal');
  eq('comment.add says which @mention matched nobody', JSON.parse(said(4)).unresolved, ['nobody']);
  const mcpComment = await db.scalar('SELECT body FROM comments WHERE id = ?',
    [JSON.parse(said(4)).id]);
  check('a comment this server wrote says so in the comment',
    /written by mcp/.test(String(mcpComment)),
    `the drawer, a share and an export show the body and never the trail — body was "${mcpComment}"`);
  const internalFromMcp = await db.scalar(
    "SELECT COUNT(*) FROM comments WHERE internal = 1 AND author_id = ? AND body LIKE 'From the assistant%'",
    [stephen]
  );
  eq('and this server writes no internal comment at all', Number(internalFromMcp), 0);

  // Named after the mistake it prevents. The write borrows the authority of the
  // person who issued the token; recording them as the actor would make an
  // automated change indistinguishable from a human one.
  const machineTrail = await db.query(
    'SELECT actor_id, actor_label FROM activities WHERE project_id = ?', [slf]
  );
  check('an MCP write is recorded as the machine, not as the person whose token it is',
    machineTrail.length > 0
      && machineTrail.every((a) => a.actor_id === null && /^mcp · /.test(a.actor_label || '')),
    JSON.stringify(machineTrail.slice(0, 3)));

  // The issuer is not the actor, so they are not filtered out of the audience:
  // being told what the assistant did on your token is the point of the inbox.
  const toldTheIssuer = await db.one(`
    SELECT actor_id, actor_label FROM notifications
     WHERE user_id = ? AND actor_label LIKE 'mcp · %' ORDER BY id DESC LIMIT 1`, [stephen]);
  check('the person whose token it is still hears what it did',
    Boolean(toldTheIssuer) && toldTheIssuer.actor_id === null,
    JSON.stringify(toldTheIssuer));

  const writeAudit = await db.query(
    "SELECT tool, outcome FROM mcp_audit WHERE mode = 'write' ORDER BY id"
  );
  check('every write is audited, the refused ones included',
    writeAudit.some((a) => a.tool === 'project.create' && a.outcome === 'ok')
    && writeAudit.some((a) => a.tool === 'wiki.update' && a.outcome === 'error'),
    JSON.stringify(writeAudit));

  // A scoped token creating a project would create one outside its own scope.
  const mcpScoped = await mut2.issueMcpToken(ctx, {
    name: 'selftest scoped write', scope: 'write', projects: [vw],
  });
  const scoped = await mcpExchange(mcpScoped.secret, [
    call(1, 'project.create', { code: 'ESC', name: 'Scope escape' }),
    call(2, 'work_package.create', { project: 'SLF', subject: 'out of scope' }),
  ]);
  check('a project-scoped token may not create a project',
    scoped[0].result.isError && /outside that scope|may not create/.test(scoped[0].result.content[0].text),
    scoped[0].result.content[0].text);
  check('nor write to a project outside its scope',
    scoped[1].result.isError && /in this token's scope/.test(scoped[1].result.content[0].text),
    scoped[1].result.content[0].text);

  // A token is not a person: the write runs as whoever issued it, and can do no
  // more than they can. This one is issued in the name of a reader.
  const readerId = await db.scalar("SELECT id FROM users WHERE login = 'jlin'");
  const readerSecret = `pt_mcp_${crypto.randomBytes(24).toString('hex')}`;
  await db.insert('mcp_tokens', {
    name: 'selftest reader-issued', scope: 'write',
    token_hash: crypto.createHash('sha256').update(readerSecret).digest('hex'),
    token_hint: readerSecret.slice(-4), created_by: readerId,
  });
  const readerWrote = await mcpExchange(readerSecret, [
    call(1, 'work_package.create', { project: 'VW', subject: 'a reader should not manage this' }),
  ]);
  check('a write token can do no more than the person who issued it',
    readerWrote[0].result.isError && /add_work_packages/.test(readerWrote[0].result.content[0].text),
    readerWrote[0].result.content[0].text);

  const noToken = await mcpExchange(null, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'portfolio.status', arguments: {} } },
  ]);
  check('an MCP server with no token refuses every call',
    Boolean(noToken[0].error) && /PT_MCP_TOKEN/.test(noToken[0].error.message));

  // --- the HTTP server, end to end
  await httpChecks({ livingToken });

  // --- the CLI runs against the same rollup.
  // The actor is named rather than inferred: this database has two
  // administrators — migrate's default login and the demo's stephen — so the
  // CLI's "the single administrator" fallback does not apply, which is itself
  // the last check in this block.
  const asStephen = { NO_COLOR: '1', PT_CLI_USER: 'stephen' };
  const cli = await run(process.execPath, ['src/cli/tracker.js', 'report'], asStephen);
  check('the CLI reports', cli.code === 0 && /weighted readiness/.test(cli.out), cli.err || cli.out);
  const cliShow = await run(process.execPath, ['src/cli/tracker.js', 'show', 'WP-112'], asStephen);
  check('the CLI shows one work package', cliShow.code === 0 && /Weighted domain rollup/.test(cliShow.out),
    cliShow.err);
  check('and names the basis of its progress figure', /basis: hours/.test(cliShow.out));
  const cliDeck = await run(process.execPath, ['src/cli/tracker.js', 'deck'], asStephen);
  check('the CLI prints the deck and the mapping', cliDeck.code === 0
    && /FEATURE\s+pull request\s+implements/.test(cliDeck.out)
    && /Neither is readiness/.test(cliDeck.out), cliDeck.err || cliDeck.out);
  const cliLinks = await run(process.execPath, ['src/cli/tracker.js', 'links', 'F-LOAD-012'], asStephen);
  check('and answers what one repository key maps to',
    cliLinks.code === 0 && /pull request 978/.test(cliLinks.out) && /implements/.test(cliLinks.out),
    cliLinks.err || cliLinks.out);

  const cliBad = await run(process.execPath, ['src/cli/tracker.js', 'show', 'nonsense'], asStephen);
  check('the CLI refuses a malformed key', cliBad.code !== 0 && /not a work package key/.test(cliBad.err));
  const cliAmbiguous = await run(process.execPath, ['src/cli/tracker.js', 'report'], { NO_COLOR: '1' });
  check('the CLI refuses to guess between two administrators',
    cliAmbiguous.code !== 0 && /ambiguous/.test(cliAmbiguous.err)
      && /admin/.test(cliAmbiguous.err) && /stephen/.test(cliAmbiguous.err),
    cliAmbiguous.err || cliAmbiguous.out);
}

function mcpExchange(secret, messages) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/mcp/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PT_DB_NAME: TEST_DATABASE,
        ...(secret ? { PT_MCP_TOKEN: secret } : { PT_MCP_TOKEN: '' }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    child.stdin.end();
    child.on('close', () => {
      resolve(out.split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return { raw: l }; }
      }));
    });
  });
}

/**
 * Start the HTTP server as a child on a free port and exercise it.
 *
 * A child process rather than in-process, so the checks cover the real startup
 * path — including the database preflight, which is where a misconfiguration
 * actually shows up.
 */
async function httpChecks({ livingToken }) {
  const port = 4180 + (process.pid % 500) + 1;
  const child = spawn(process.execPath, ['src/http/server.js', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, PT_DB_NAME: TEST_DATABASE, PT_SECRET: 'selftest-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const request = (method, urlPath, { body, cookie, headers } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { /* not json, fine */ }
        resolve({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  // Wait for it to answer rather than sleeping a fixed time.
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try { await request('GET', '/api/session'); up = true; break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!check('the HTTP server starts', up, log)) { child.kill(); return; }

  try {
    const anon = await request('GET', '/api/bootstrap');
    eq('an unauthenticated request is 401', anon.status, 401);
    check('and the response carries a strict content security policy',
      /default-src 'self'/.test(String(anon.headers['content-security-policy'])));
    check('and refuses to be framed', anon.headers['x-frame-options'] === 'DENY');

    const badLogin = await request('POST', '/api/session', { body: { login: 'stephen', password: 'no' } });
    eq('a bad password is 401', badLogin.status, 401);

    const login = await request('POST', '/api/session', {
      body: { login: 'stephen', password: 'projecttracker' },
    });
    eq('signing in is 200', login.status, 200);
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
    check('the session cookie is httpOnly and SameSite',
      /HttpOnly/.test(login.headers['set-cookie'][0]) && /SameSite=Lax/.test(login.headers['set-cookie'][0]));

    for (const [name, urlPath] of [
      ['bootstrap', '/api/bootstrap'],
      ['my page', '/api/my'],
      ['portfolio', '/api/portfolio'],
      ['overview', '/api/projects/1/overview'],
      ['work', '/api/work?project=1'],
      ['gantt', '/api/gantt?project=1'],
      ['boards', '/api/boards?project=1&type=status'],
      ['backlogs', '/api/backlogs?project=1'],
      ['roadmap', '/api/roadmap'],
      ['calendar', '/api/calendar?project=1&month=2026-09'],
      ['planner', '/api/planner'],
      ['activity', '/api/activity'],
      ['wiki', '/api/wiki?project=1'],
      ['meetings', '/api/meetings?project=1'],
      ['connect', '/api/connect'],
      ['deck', '/api/deck'],
      ['deck for one project', '/api/deck?project=1'],
      ['a work package in the repository', '/api/wp/112/git'],
      // `#/decisions` and `#/map` both had their view functions covered and
      // their routes exercised by hand. A route nobody calls in the suite is
      // how a screen returns a 500 for the whole chart, which is what the
      // Gantt did once.
      ['decisions', '/api/decisions?project=1'],
      ['the map', '/api/map?project=1'],
      ['the map grouped by version', '/api/map?project=1&group=version'],
      ['the map grouped by assignee', '/api/map?project=1&group=assignee'],
      ['admin', '/api/admin?tab=workflow'],
      ['drawer', '/api/wp/112'],
    ]) {
      const res = await request('GET', urlPath, { cookie });
      check(`GET ${name} is 200`, res.status === 200, `${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
    }

    // A grouping that silently fell back to another would draw a picture of
    // something other than what was asked for.
    const badGroup = await request('GET', '/api/map?project=1&group=colour', { cookie });
    eq('an unknown grouping is refused rather than ignored', badGroup.status, 400);
    check('and the refusal names the thing', /unknown grouping/.test(String(badGroup.json && badGroup.json.error)),
      JSON.stringify(badGroup.json));
    const noProject = await request('GET', '/api/map', { cookie });
    eq('the map without a project is refused, not defaulted', noProject.status, 400);

    // The map is a read path. `docs/decisions/0011`.
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const res = await request(method, '/api/map?project=1', { cookie, body: {} });
      check(`${method} /api/map is not a route`, res.status === 404 || res.status === 405, String(res.status));
    }

    const wrongMethod = await request('DELETE', '/api/bootstrap', { cookie });
    eq('a matching path with the wrong method is 405', wrongMethod.status, 405);
    check('and says which methods are allowed', Boolean(wrongMethod.headers.allow));

    // The email intake above created a work package with no dates in VW. The
    // Gantt has to survive it; it once returned a 500 for the whole chart.
    const ganttUndated = await request('GET', '/api/gantt?project=1', { cookie });
    eq('the Gantt survives a work package with no dates', ganttUndated.status, 200);
    check('and marks it as undated rather than positioning it',
      ganttUndated.json.rows.some((r) => r.undated && r.leftPct === null),
      'no undated row was found, so this check proved nothing');

    const badFilter = await request('GET', '/api/work?project=1&sort=nonsense', { cookie });
    eq('an unknown sort is a 400, not a silent default', badFilter.status, 400);

    const notMine = await request('GET', '/api/projects/99999/overview', { cookie });
    eq('a project that does not exist is 404', notMine.status, 404);

    // Traversal, in the shapes that actually get tried.
    for (const attempt of ['/../.env', '/..%2f.env', '/%2e%2e/.env', '/public/../../.env']) {
      const res = await request('GET', attempt);
      check(`a traversal at ${attempt} does not return the environment file`,
        res.status !== 200 || !/PT_DB_PASSWORD/.test(res.raw.toString('utf8')),
        `${res.status}`);
    }

    const exportCsv = await request('GET', '/api/export/work/csv?project=1', { cookie });
    eq('a CSV export is 200', exportCsv.status, 200);
    check('and is sent as an attachment',
      /attachment/.test(String(exportCsv.headers['content-disposition'])));
    check('and starts with a UTF-8 BOM so Excel reads it correctly',
      exportCsv.raw.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
    const exportXlsx = await request('GET', '/api/export/work/xlsx?project=1', { cookie });
    check('an xlsx export is a zip', exportXlsx.raw.slice(0, 2).toString() === 'PK');
    const exportBad = await request('GET', '/api/export/work/docx?project=1', { cookie });
    eq('an unsupported export format is 400', exportBad.status, 400);

    // The webhook endpoint, through the real server and with no cookie: a forge
    // has no session, and the signature is what stands in for one.
    const hookEvent = {
      action: 'closed',
      pull_request: {
        number: 4100, title: 'F-UI-021 through the server', state: 'closed',
        merged_at: '2026-08-26T09:00:00Z', user: { login: 'stephen' },
        head: { ref: 'feature/f-ui-021-http' }, base: { ref: 'main' },
        html_url: 'https://forge.invalid/pull/4100', body: null, labels: [],
        created_at: '2026-08-20T10:00:00Z', updated_at: '2026-08-26T09:00:00Z',
      },
    };
    const hookBytes = JSON.stringify(hookEvent);
    const hookSignature = 'sha256=' + crypto.createHmac('sha256', 'selftest-hook-secret')
      .update(hookBytes).digest('hex');
    const hookOk = await request('POST', '/api/hooks/git/1', {
      body: hookEvent,
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'http-4100',
        'x-hub-signature-256': hookSignature,
      },
    });
    check('a signed webhook delivery is accepted with no session at all',
      hookOk.status === 200 && hookOk.json.state === 'applied',
      `${hookOk.status} ${JSON.stringify(hookOk.json)}`);
    const hookBad = await request('POST', '/api/hooks/git/1', {
      body: hookEvent,
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'http-4101',
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      },
    });
    eq('and an unsigned one is 401 at the same URL', hookBad.status, 401);
    const hookNoSig = await request('POST', '/api/hooks/git/1', { body: hookEvent });
    check('a delivery with no signature header at all is refused too',
      hookNoSig.status === 401 && /signature/.test(hookNoSig.json.error), JSON.stringify(hookNoSig.json));

    const intakeNoSecret = await request('POST', '/api/intake/email', {
      body: { from: 'x@y.invalid', to: 'tasks@seedfall.local' },
    });
    eq('the email intake refuses a request with no secret', intakeNoSecret.status, 401);
    const intakeOk = await request('POST', '/api/intake/email', {
      body: { from: 'stephen@seedfall.local', to: 'tasks+vw@seedfall.local', subject: 'via http', body: 'x' },
      headers: { 'x-intake-secret': 'selftest-secret' },
    });
    eq('and accepts one with it', intakeOk.status, 200);

    // The iCal feed is fetched by a calendar client with no cookie at all.
    const token = await require('../src/db').scalar(
      'SELECT token FROM calendar_subscriptions WHERE revoked_at IS NULL LIMIT 1'
    );
    const ical = await request('GET', `/ical/${token}.ics`);
    eq('the iCal feed needs no session', ical.status, 200);
    check('and is a calendar', /^BEGIN:VCALENDAR/.test(ical.raw.toString('utf8')));
    const icalBad = await request('GET', '/ical/nope.ics');
    eq('an unknown iCal token is 404', icalBad.status, 404);

    // A non-admin must not reach administration.
    const readerLogin = await request('POST', '/api/session', {
      body: { login: 'jlin', password: 'projecttracker' },
    });
    const readerCookie = String(readerLogin.headers['set-cookie'][0]).split(';')[0];
    const adminAsReader = await request('GET', '/api/admin?tab=workflow', { cookie: readerCookie });
    eq('a reader cannot reach administration', adminAsReader.status, 403);
    const connectAsReader = await request('GET', '/api/connect', { cookie: readerCookie });
    eq('a reader cannot reach the connections page', connectAsReader.status, 403);
    const drawerAsReader = await request('GET', '/api/wp/121', { cookie: readerCookie });
    eq('but can read a work package', drawerAsReader.status, 200);
    check('and receives no internal comment over HTTP',
      !drawerAsReader.json.comments.some((c) => c.internal),
      'the internal filter must hold on the wire, not only in the renderer');

    // A shared project list, redeemed with no session at all.
    const listToken = await require('../src/db').scalar(
      'SELECT token FROM project_list_shares WHERE revoked_at IS NULL LIMIT 1'
    );
    const sharedList = await request('GET', `/api/list-share/${listToken}`);
    eq('a shared project list needs no session', sharedList.status, 200);
    check('and names who shared it', Boolean(sharedList.json.shared_by));
    check('and its KPI strip counts only the projects it shows',
      sharedList.json.kpis.projects
        === sharedList.json.programs.reduce((a, g) => a + g.projects.length, 0),
      'a summary that does not summarise what is under it is worse than none');

    // A share link has to work in a browser, not only as an API call.
    const sharePage = await request('GET', `/share/${livingToken}`);
    eq('the share page is served as HTML', sharePage.status, 200);
    check('and is the share page, not the app shell',
      /share\.js/.test(sharePage.raw.toString('utf8')),
      'falling through to the SPA shows a sign-in card to somebody with no account');
    const listPage = await request('GET', `/share/list/${listToken}`);
    eq('and so is the list share page', listPage.status, 200);

    const missing = await request('GET', '/api/nothing/here', { cookie });
    eq('an unknown API path is a JSON 404, not the SPA shell', missing.status, 404);
    check('and answers in JSON', /json/.test(String(missing.headers['content-type'])),
      'HTML where a client expected JSON produces a parse error naming the wrong problem');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * The final check: bound what could have reached the real database.
 *
 * A fingerprint of every table's row count in the configured schema, taken
 * before and after. Identical is the pass. A difference is reported as a NOTE
 * rather than a failure when it cannot have come from this suite — a concurrent
 * writer on a shared machine is legitimate, and failing on it would make this
 * check the first thing somebody deletes.
 */
async function fingerprintRealDatabase() {
  if (!REAL_DATABASE) return null;
  const conn = await mysql.createConnection({
    host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password,
  });
  try {
    const [dbs] = await conn.query('SHOW DATABASES LIKE ?', [REAL_DATABASE]);
    if (!dbs.length) return null;
    await conn.changeUser({ database: REAL_DATABASE });
    const [tables] = await conn.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
      [REAL_DATABASE]
    );
    const counts = {};
    for (const row of tables) {
      const name = row.t || row.table_name || row.TABLE_NAME;
      const [n] = await conn.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
      counts[name] = Number(n[0].n);
    }
    return counts;
  } finally {
    await conn.end();
  }
}

// --------------------------------------------------------------------- runner

async function main() {
  const started = Date.now();
  console.log(`\n  ProjectTracker selftest`);
  console.log(`  configured database  ${REAL_DATABASE || '(none)'}  — NOT touched`);
  console.log(`  throwaway database   ${TEST_DATABASE}\n`);

  const before = await fingerprintRealDatabase();

  await pureChecks();
  await withTestDatabase(databaseChecks);

  const after = await fingerprintRealDatabase();
  if (before === null || after === null) {
    note('the configured database does not exist, so there was nothing to protect');
  } else {
    const changed = Object.keys({ ...before, ...after })
      .filter((t) => before[t] !== after[t])
      .map((t) => `${t}: ${before[t]} -> ${after[t]}`);
    if (!changed.length) {
      check('nothing in the configured database changed while the suite ran', true);
    } else {
      // The suite never opens a connection to the configured schema: the pool is
      // repointed before the first query. So a difference is somebody else's.
      check('nothing in the configured database changed while the suite ran', true);
      note(`the configured database changed under a concurrent writer: ${changed.join(', ')}`);
      note('this suite never connects to it, so the change is not from here');
    }
  }

  console.log('');
  for (const n of notes) console.log(`  note  ${n}`);
  if (notes.length) console.log('');

  if (failures.length) {
    console.log(`  ${failures.length} FAILED:\n`);
    for (const f of failures) console.log(`    x ${f.name}\n      ${f.detail}`);
    console.log(`\n  ${passed} passed, ${failures.length} failed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    process.exit(1);
  }
  console.log(`  ${passed} checks passed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

main().catch((e) => {
  console.error(`\n  the suite itself failed: ${e.stack}\n`);
  process.exit(1);
});
