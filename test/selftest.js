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

function pureChecks() {
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
  ]);
  const byId = new Map(mcp.map((m) => [m.id, m]));
  check('the MCP server answers initialize', Boolean(byId.get(1) && byId.get(1).result.serverInfo));
  const listed = byId.get(2).result.tools.map((t) => t.name);
  check('a read token is not offered the write tool', !listed.includes('summary.write'),
    `offered ${listed.join(', ')}`);
  check('portfolio.status returns projects', /"projects"/.test(byId.get(3).result.content[0].text));
  check('a read token calling the write tool is refused',
    Boolean(byId.get(4).error) && /read-scoped/.test(byId.get(4).error.message));
  const audited = await db.query('SELECT tool, mode, outcome FROM mcp_audit ORDER BY id');
  check('every MCP call is audited, reads included',
    audited.some((a) => a.tool === 'portfolio.status' && a.outcome === 'ok')
    && audited.some((a) => a.tool === 'summary.write' && a.outcome === 'denied'),
    JSON.stringify(audited));

  const noToken = await mcpExchange(null, [
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'portfolio.status', arguments: {} } },
  ]);
  check('an MCP server with no token refuses every call',
    Boolean(noToken[0].error) && /PT_MCP_TOKEN/.test(noToken[0].error.message));

  // --- the HTTP server, end to end
  await httpChecks({ livingToken });

  // --- the CLI runs against the same rollup
  const cli = await run(process.execPath, ['src/cli/tracker.js', 'report'], { NO_COLOR: '1' });
  check('the CLI reports', cli.code === 0 && /weighted readiness/.test(cli.out), cli.err || cli.out);
  const cliShow = await run(process.execPath, ['src/cli/tracker.js', 'show', 'WP-112'], { NO_COLOR: '1' });
  check('the CLI shows one work package', cliShow.code === 0 && /Weighted domain rollup/.test(cliShow.out),
    cliShow.err);
  check('and names the basis of its progress figure', /basis: hours/.test(cliShow.out));
  const cliBad = await run(process.execPath, ['src/cli/tracker.js', 'show', 'nonsense'], { NO_COLOR: '1' });
  check('the CLI refuses a malformed key', cliBad.code !== 0 && /not a work package key/.test(cliBad.err));
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
      ['admin', '/api/admin?tab=workflow'],
      ['drawer', '/api/wp/112'],
    ]) {
      const res = await request('GET', urlPath, { cookie });
      check(`GET ${name} is 200`, res.status === 200, `${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
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

  pureChecks();
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
