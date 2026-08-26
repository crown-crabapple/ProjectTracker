#!/usr/bin/env node
/**
 * Import a SeedFall tracker state file into a project.
 *
 *   node db/import-state.js <state.json> [--project SF] [--as LOGIN] [--dry-run]
 *
 * The file is the SeedFall tracker's own state: a feature ledger, a decision
 * log, the answers it got to the questions it asked, and a rolling activity
 * trail. Its status vocabulary is this app's vocabulary — not a coincidence,
 * since the progress model here came from that tracker — so a feature's status
 * imports as itself rather than through a mapping table. A status in the file
 * that this database does not have stops the import rather than being coerced
 * into the nearest one.
 *
 * WHAT MAPS TO WHAT
 *
 *   features   one work package each, type FEATURE, subject = the feature id,
 *              the note as the description, and the area (LOAD, UI, ENG …) in a
 *              custom field.
 *   questions  a comment on the feature they name. The file keeps the answer and
 *              not the question, and the comment says so rather than presenting
 *              half a conversation as a whole one.
 *   decisions  one wiki page each, numbered D25 and titled from its answer, plus
 *              an index page that puts the unsettled ones first.
 *   activity   the activity trail, with the original timestamps and the original
 *              actor labels ('claude', 'browser'). Neither is an account here,
 *              so both stay labels: an imported change is never attributed to a
 *              person who did not make it.
 *   build      the project's description.
 *
 * TWO DECISIONS WORTH THE WORDS
 *
 * 1. NO AREA EPICS. Grouping 379 features under 25 EPIC parents would read well
 *    and would move the numbers: `rollup.readiness` weights every work package
 *    in the list, containers included, so 25 invented parents sitting at
 *    not_started would report somebody else's project as several points less
 *    ready than it is. The area is a custom field instead, and the counts this
 *    produces are the counts in the file — which is the last thing it checks and
 *    prints.
 *
 * 2. IT MERGES, IT DOES NOT REPLACE. Run it again with a newer file and it moves
 *    the statuses that changed, appends the activity it has not seen, and adds
 *    the new decisions. It never deletes: a feature that has left the file keeps
 *    its work package, and the summary counts those rather than quietly tidying
 *    them away.
 *
 * The work packages carry no dates, because the file has none. The history is
 * not lost with them — it is in the activity trail, at the timestamps it
 * actually happened at.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const rollup = require('../src/domain/rollup');

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

/** Thrown to unwind a --dry-run. See runImport. */
class Rollback extends Error {}

const SCHEMA_VERSION = 1;
const ISO_TO_SQL = (iso) => new Date(Date.parse(iso)).toISOString().slice(0, 19).replace('T', ' ');

// The trail's detail column is 800 characters, deliberately: it is a summary and
// not a second copy of the content. Some of these notes are longer, so they are
// cut and counted, and the summary says how many — a silent truncation is a
// record that lies about being complete.
const DETAIL_MAX = 800;
const cut = (text, max) => {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

/** The area a feature id belongs to: F-LOAD-001 -> LOAD. */
const areaOf = (featureId) => String(featureId).split('-')[1] || 'OTHER';

/**
 * A health note this script wrote, as opposed to one a person wrote. See where
 * it is used: the import maintains its own note and never overwrites somebody
 * else's reading of the project.
 */
const MINE = /^(\d+ decision\(s\) waiting on a person:|No unsettled decisions in the imported state)/;

/**
 * A one-line title from a paragraph.
 *
 * First sentence, or the first 110 characters if the first sentence is longer
 * than a title should be. A decision's answer opens with what was decided, so
 * this reads as a heading rather than as a truncation.
 */
function titleFrom(text, fallback) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return fallback;
  const stop = s.search(/[.;:](\s|$)/);
  const first = stop > 0 && stop <= 110 ? s.slice(0, stop) : s;
  return first.length <= 110 ? first : `${first.slice(0, 109)}…`;
}

const measure = (text) => {
  const s = String(text || '');
  return {
    word_count: s.trim() ? s.trim().split(/\s+/).length : 0,
    section_count: (s.match(/^#{1,6} /gm) || []).length,
  };
};

// ------------------------------------------------------------------ the file

function readState(file) {
  if (!file) throw new Error('which file? node db/import-state.js <state.json>');
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not JSON: ${e.message}`);
  }
  if (Number(state.schemaVersion) !== SCHEMA_VERSION) {
    throw new Error(
      `this reads schemaVersion ${SCHEMA_VERSION} and that file is ${JSON.stringify(state.schemaVersion)}. `
      + 'A different shape needs a different importer, not a guess.'
    );
  }
  for (const key of ['project', 'features']) {
    if (!state[key]) throw new Error(`that file has no "${key}" — it is not a tracker state file`);
  }
  return {
    project: String(state.project),
    updated: state.updated || null,
    build: state.build || null,
    features: state.features || {},
    decisions: state.decisions || {},
    questions: state.questions || {},
    activity: Array.isArray(state.activity) ? state.activity : [],
  };
}

// ------------------------------------------------------------- the vocabulary

/**
 * Everything the import needs from reference data, resolved once and checked.
 *
 * A missing status is fatal and names itself. Coercing an unknown status to the
 * nearest one would produce a portfolio figure computed from a status somebody
 * never chose.
 */
async function reference(state) {
  const statuses = new Map(
    (await db.query('SELECT id, code, label, is_closed FROM statuses')).map((s) => [s.code, s])
  );
  const used = new Set(Object.values(state.features).map((f) => f.status));
  const unknown = [...used].filter((code) => !statuses.has(code));
  if (unknown.length) {
    throw new Error(
      `that file uses ${unknown.map((u) => `"${u}"`).join(', ')}, which this database has no status for. `
      + `It has ${[...statuses.keys()].join(', ')}. Add the status in administration, or run `
      + '`node db/seed.js --reference`, before importing.'
    );
  }
  const type = await db.one("SELECT id FROM work_package_types WHERE name = 'FEATURE'");
  const priority = await db.one('SELECT id FROM priorities WHERE is_default = 1 LIMIT 1');
  const week = await db.scalar('SELECT id FROM work_weeks WHERE is_default = 1');
  if (!type || !priority) {
    throw new Error('the work package type or priority vocabulary is missing — run `node db/seed.js --reference`');
  }
  return { statuses, typeId: type.id, priorityId: priority.id, weekId: week };
}

/**
 * Who owns the imported project.
 *
 * Named rather than guessed when there is a choice, the way the CLI does it: a
 * project with no owner is a project nobody can sign a gate on, and picking one
 * of two administrators silently is the kind of guess that is discovered later.
 */
async function ownerFor(login) {
  if (login) {
    const u = await db.one(
      "SELECT id, login, name FROM users WHERE login = ? AND active = 1 AND kind = 'user'", [login]
    );
    if (!u) throw new Error(`no active account "${login}" to own the import`);
    return u;
  }
  const admins = await db.query(
    "SELECT id, login, name FROM users WHERE is_admin = 1 AND active = 1 AND kind = 'user' ORDER BY id"
  );
  if (!admins.length) throw new Error('no administrator to own the import — pass --as LOGIN');
  if (admins.length > 1) {
    throw new Error(
      `${admins.length} administrators exist (${admins.map((a) => a.login).join(', ')}), so this will not `
      + 'guess which one owns the import. Pass --as LOGIN.'
    );
  }
  return admins[0];
}

// ---------------------------------------------------------------- the import

async function importInto(tx, { state, ref, owner, code, actorLabel }) {
  const report = {
    project: null, projectCreated: false, healthLeftAlone: null,
    features: { created: 0, statusChanged: [], noteChanged: 0, unchanged: 0, notInFile: 0 },
    questions: { created: 0, skipped: 0, orphans: [] },
    decisions: { created: 0, updated: 0, unchanged: 0 },
    activity: { created: 0, alreadyThere: 0, truncated: 0 },
  };

  // ------------------------------------------------------------------ project
  const buildLine = state.build
    ? `${state.build.label}${state.build.note ? ` — ${state.build.note}` : ''}`
    : null;
  // A project's health is recorded, never derived (docs/decisions/0003), so the
  // import records what the file supports: rust means a decision is waiting on a
  // person, and an unsettled decision is exactly that. Nothing else here may use
  // rust, which is what makes it worth reading.
  const openDecisions = Object.entries(state.decisions).filter(([, d]) => d.state !== 'settled');
  const health = openDecisions.length ? 'rust' : 'green';
  const healthNote = openDecisions.length
    ? `${openDecisions.length} decision(s) waiting on a person: ${openDecisions.map(([id]) => id).join(', ')}`
    : 'No unsettled decisions in the imported state';

  let project = await tx.one('SELECT id, code, name FROM projects WHERE code = ?', [code]);
  if (!project) {
    const clash = await tx.one('SELECT code FROM projects WHERE identifier = ?', [code.toLowerCase()]);
    if (clash) {
      throw new Error(
        `${clash.code} already uses the identifier "${code.toLowerCase()}", which is the URL this project `
        + 'would live at. Pass a different --project code.'
      );
    }
  }
  if (project) {
    // Health is recorded and not derived (docs/decisions/0003), so this keeps
    // maintaining the note it wrote and stands aside the moment somebody writes
    // their own. Overwriting a person's reading of a project every time a file
    // is merged would make the field theirs in name only.
    const current = await tx.one('SELECT health, health_note FROM projects WHERE id = ?', [project.id]);
    const ours = MINE.test(String(current.health_note || ''));
    await tx.update('projects', project.id, {
      description: cut(buildLine, 500),
      ...(ours ? { health, health_note: cut(healthNote, 300) } : {}),
    });
    if (!ours) report.healthLeftAlone = String(current.health_note || '').slice(0, 120);
  } else {
    const id = await tx.insert('projects', {
      code,
      identifier: code.toLowerCase(),
      name: state.project,
      description: cut(buildLine, 500),
      health,
      health_note: cut(healthNote, 300),
      work_week_id: ref.weekId,
    });
    const ownerRole = await tx.scalar("SELECT id FROM roles WHERE name = 'Owner'");
    const membership = await tx.insert('memberships', { project_id: id, user_id: owner.id });
    await tx.run('INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)',
      [membership, ownerRole]);
    project = { id, code, name: state.project };
    report.projectCreated = true;
  }
  report.project = project;

  // ------------------------------------------------------------- the area field
  const areas = [...new Set(Object.keys(state.features).map(areaOf))].sort();
  await tx.run(`
    INSERT INTO custom_fields (name, field_format, customized_type, possible_values, help_text,
                               is_for_all, is_filterable, position)
    VALUES ('Area', 'list', 'work_package', ?, ?, 0, 1, 0)
    ON DUPLICATE KEY UPDATE possible_values = VALUES(possible_values), help_text = VALUES(help_text)`,
  [JSON.stringify(areas), cut(`The part of ${state.project} a feature belongs to, from its id: `
    + `F-LOAD-001 is LOAD. Imported with the feature, not chosen here.`, 600)]);
  const areaFieldId = await tx.scalar(
    "SELECT id FROM custom_fields WHERE customized_type = 'work_package' AND name = 'Area'"
  );
  await tx.run(`
    INSERT IGNORE INTO custom_field_projects (custom_field_id, project_id) VALUES (?, ?)`,
  [areaFieldId, project.id]);

  // ----------------------------------------------------------------- features
  const existing = new Map(
    (await tx.query('SELECT id, subject, status_id, description FROM work_packages WHERE project_id = ?',
      [project.id])).map((w) => [w.subject, w])
  );
  const wpIdOf = new Map();

  for (const [featureId, feature] of Object.entries(state.features)) {
    const status = ref.statuses.get(feature.status);
    const note = feature.note || null;
    const known = existing.get(featureId);

    if (!known) {
      const id = await tx.insert('work_packages', {
        project_id: project.id,
        type_id: ref.typeId,
        subject: featureId,
        description: note,
        status_id: status.id,
        priority_id: ref.priorityId,
        // The author is whoever ran the import, because somebody did. Nobody is
        // made accountable or assigned: the file does not say who is, and
        // putting 379 features on the importer's My page would be an answer
        // invented by this script rather than one the source tracker gave.
        author_id: owner.id,
        accountable_id: null,
        // A done work package everywhere else in this database has a closed
        // date, and the file's best evidence for it is when the feature last
        // moved. Leaving it null would make imported work the only closed work
        // with no closing date.
        closed_at: status.is_closed && feature.updated ? ISO_TO_SQL(feature.updated) : null,
      });
      wpIdOf.set(featureId, id);
      report.features.created += 1;
      await tx.insert('activities', {
        project_id: project.id, work_package_id: id, actor_label: actorLabel,
        kind: 'status', verb: 'imported', target_label: featureId,
        detail: cut(`${featureId} at ${status.label}${note ? ` — ${note}` : ''}`, DETAIL_MAX),
        to_value: status.label,
      });
    } else {
      wpIdOf.set(featureId, known.id);
      const changes = {};
      if (Number(known.status_id) !== Number(status.id)) {
        changes.status_id = status.id;
        // Set on the way in to a closed status and cleared on the way out, which
        // is what `updateWorkPackage` does when a person makes the same move.
        changes.closed_at = status.is_closed && feature.updated ? ISO_TO_SQL(feature.updated) : null;
      }
      if ((known.description || null) !== note) changes.description = note;
      if (Object.keys(changes).length) {
        const was = await tx.one('SELECT label FROM statuses WHERE id = ?', [known.status_id]);
        await tx.update('work_packages', known.id, changes);
        if (changes.status_id) {
          report.features.statusChanged.push(`${featureId} ${was.label} → ${status.label}`);
          // The same shape a status change gets anywhere else in this app, so it
          // reads in the feed as what it is rather than as a bulk edit.
          await tx.insert('activities', {
            project_id: project.id, work_package_id: known.id, actor_label: actorLabel,
            kind: 'status', verb: 'set status', target_label: featureId,
            from_value: was.label, to_value: status.label,
            detail: cut(note || `${featureId} moved in the imported state`, DETAIL_MAX),
          });
        } else {
          report.features.noteChanged += 1;
        }
      } else {
        report.features.unchanged += 1;
      }
    }

    const wpId = wpIdOf.get(featureId);
    await tx.run(`
      INSERT INTO custom_values (custom_field_id, customized_type, customized_id, value)
      VALUES (?, 'work_package', ?, ?)
      ON DUPLICATE KEY UPDATE value = VALUES(value)`,
    [areaFieldId, wpId, areaOf(featureId)]);
  }

  // Never deleted, only counted. A feature that has left the file may have been
  // renamed, or the file may be older than the tracker; both are somebody's
  // decision to make and neither is this script's.
  report.features.notInFile = [...existing.keys()].filter((s) => !state.features[s]).length;

  // ---------------------------------------------------------------- questions
  for (const [questionId, question] of Object.entries(state.questions)) {
    const match = /^Q-(F-[A-Z]+-\d+)-/.exec(questionId);
    const featureId = match ? match[1] : null;
    if (!featureId || !wpIdOf.has(featureId)) {
      report.questions.orphans.push(questionId);
      continue;
    }
    const body = `${question.answer}\n\n— answered in the ${state.project} state file `
      + `(${questionId}). The file keeps the answer and not the question.`;
    const already = await tx.scalar(
      "SELECT COUNT(*) FROM comments WHERE container_type = 'work_package' AND container_id = ? AND body = ?",
      [wpIdOf.get(featureId), body]
    );
    if (Number(already)) { report.questions.skipped += 1; continue; }
    await tx.insert('comments', {
      container_type: 'work_package', container_id: wpIdOf.get(featureId),
      // No author: the file records who answered nowhere, and naming somebody
      // would be an invention. The body says where it came from instead, which
      // is what the email intake does with a sender it cannot resolve.
      author_id: null, internal: 0, body,
      // Omitted rather than sent as NULL when the file has no timestamp: the
      // column is NOT NULL with a default, and the default is the honest answer
      // to "when did this arrive here".
      ...(question.updated ? { created_at: ISO_TO_SQL(question.updated) } : {}),
    });
    report.questions.created += 1;
  }

  // ---------------------------------------------------------------- decisions
  const decisionIds = Object.keys(state.decisions).sort(
    (a, b) => (Number(a.replace(/\D/g, '')) || 0) - (Number(b.replace(/\D/g, '')) || 0)
  );
  for (const decisionId of decisionIds) {
    const decision = state.decisions[decisionId];
    const slug = decisionId.toLowerCase();
    const title = titleFrom(decision.answer || decision.note, decisionId);
    const body = [
      `# ${decisionId} — ${title}`,
      '',
      `**State:** ${decision.state}${decision.updated ? ` · updated ${decision.updated.slice(0, 10)}` : ''}`,
      '',
      decision.answer ? '## What was decided\n' : '## No answer recorded\n',
      decision.answer || 'The state file carries this decision with a note and no answer.',
      '',
      ...(decision.note ? ['## Why', '', decision.note, ''] : []),
      `Imported from the ${state.project} state file.`,
    ].join('\n');
    const known = await tx.one('SELECT id, body FROM documents WHERE project_id = ? AND slug = ?',
      [project.id, slug]);
    const counts = measure(body);
    if (!known) {
      await tx.insert('documents', {
        project_id: project.id, number: decisionId, slug, title,
        body, status: String(decision.state).toUpperCase(), ...counts,
        position: Number(decisionId.replace(/\D/g, '')) || 0,
        created_by: owner.id, updated_by: owner.id,
      });
      report.decisions.created += 1;
    } else if (known.body !== body) {
      await tx.update('documents', known.id, {
        title, body, status: String(decision.state).toUpperCase(), ...counts, updated_by: owner.id,
      });
      // A revision row, so the page has the history the wiki's own save path
      // gives it — and so wiki.update over MCP has a base revision to refuse
      // against rather than a page that looks untouched.
      const revision = Number(await tx.scalar(
        'SELECT COALESCE(MAX(revision), 0) FROM document_versions WHERE document_id = ?', [known.id]
      )) + 1;
      await tx.insert('document_versions', {
        document_id: known.id, revision, body, author_id: null,
        note: `imported from the ${state.project} state file`,
      });
      report.decisions.updated += 1;
    } else {
      report.decisions.unchanged += 1;
    }
  }

  if (decisionIds.length) {
    const unsettled = decisionIds.filter((id) => state.decisions[id].state !== 'settled');
    const indexBody = [
      '# Decisions',
      '',
      `${decisionIds.length} decisions imported from the ${state.project} state file, one page each, `
      + 'numbered as they are numbered there.',
      '',
      '## Waiting on a person',
      '',
      ...(unsettled.length
        ? unsettled.map((id) => `- **${id}** (${state.decisions[id].state}) — `
          + `${titleFrom(state.decisions[id].answer || state.decisions[id].note, 'no answer recorded')}`)
        : ['None. Every imported decision is settled.']),
      '',
      '## Settled',
      '',
      `${decisionIds.length - unsettled.length} of them. They are the numbered pages in this wiki; `
      + 'this page lists only the ones that are not finished, because a list of everything is a list '
      + 'nobody reads twice.',
    ].join('\n');
    const known = await tx.one("SELECT id, body FROM documents WHERE project_id = ? AND slug = 'decisions'",
      [project.id]);
    const counts = measure(indexBody);
    if (!known) {
      await tx.insert('documents', {
        project_id: project.id, number: '00', slug: 'decisions', title: 'Decisions',
        body: indexBody, status: 'INDEX', ...counts, position: 0,
        created_by: owner.id, updated_by: owner.id,
      });
      report.decisions.created += 1;
    } else if (known.body !== indexBody) {
      await tx.update('documents', known.id, { body: indexBody, ...counts, updated_by: owner.id });
      report.decisions.updated += 1;
    } else {
      report.decisions.unchanged += 1;
    }
  }

  // ----------------------------------------------------------------- activity
  //
  // The file's trail is a rolling window, so a re-import overlaps the last one.
  // Deduplicated on the timestamp and the thing it happened to, which is exactly
  // as unique as the source makes it.
  const seen = new Set(
    (await tx.query(
      'SELECT created_at, kind, target_label FROM activities WHERE project_id = ?', [project.id]
    )).map((a) => `${a.created_at}|${a.kind}|${a.target_label}`)
  );

  const oldestFirst = [...state.activity].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const entry of oldestFirst) {
    const at = ISO_TO_SQL(entry.ts);
    const isFeature = entry.kind === 'feature' || entry.kind === 'feature_note';
    const kind = isFeature ? 'status' : 'project';
    if (seen.has(`${at}|${kind}|${entry.id}`)) { report.activity.alreadyThere += 1; continue; }

    const note = entry.note || '';
    if (note.length > DETAIL_MAX) report.activity.truncated += 1;

    let verb;
    if (entry.kind === 'feature') verb = 'set status';
    else if (entry.kind === 'feature_note') verb = 'noted';
    else if (entry.kind === 'decision') verb = `${entry.to === 'settled' ? 'settled' : entry.to} a decision`;
    else verb = 'recorded a build';

    await tx.insert('activities', {
      project_id: project.id,
      work_package_id: isFeature ? (wpIdOf.get(entry.id) || null) : null,
      // 'claude' and 'browser' are the source tracker's actors and are not
      // accounts here. They stay labels rather than being mapped onto whoever
      // happens to share the name.
      actor_label: cut(entry.by || actorLabel, 120),
      kind,
      verb,
      target_label: cut(entry.id, 190),
      detail: cut(note, DETAIL_MAX) || null,
      from_value: entry.from ? cut(entry.from, 190) : null,
      to_value: entry.to ? cut(entry.to, 190) : null,
      created_at: at,
    });
    seen.add(`${at}|${kind}|${entry.id}`);
    report.activity.created += 1;
  }

  // One entry for the run itself, saying what it changed. A merge that changed
  // nothing says that too: "the tracker last agreed with the file on Tuesday" is
  // a fact somebody will want, and it cannot be read off a feed of no entries.
  const changed = report.features.created + report.features.statusChanged.length
    + report.features.noteChanged + report.questions.created
    + report.decisions.created + report.decisions.updated + report.activity.created;
  await tx.insert('activities', {
    project_id: project.id, actor_label: actorLabel, kind: 'project',
    verb: report.projectCreated ? 'imported a state file' : 'merged a state file',
    target_label: code,
    detail: cut(changed
      ? `${report.features.created} feature(s) added, ${report.features.statusChanged.length} moved status, `
        + `${report.decisions.created + report.decisions.updated} decision page(s) written, `
        + `${report.activity.created} trail entr(ies) added`
        + `${state.updated ? ` · state of ${state.updated.slice(0, 10)}` : ''}`
      : `nothing changed — the tracker already matched the file${state.updated ? ` of ${state.updated.slice(0, 10)}` : ''}`,
    DETAIL_MAX),
  });

  return report;
}

// ------------------------------------------------------------------ the check

/**
 * The counts in the database against the counts in the file.
 *
 * This is the point of the whole script: if the tracker's completion figures do
 * not reproduce the file's, the import has changed somebody's project on the way
 * in, and a figure that is wrong by a little is worse than one that is missing.
 */
async function verify(state, projectId) {
  // Read straight from the tables rather than through `query.select`, whose
  // limit is capped at 1000: a check that quietly stops counting at a thousand
  // rows is a check that passes when it should not. The figures themselves still
  // come from `rollup`, which is the only place a percentage is computed.
  const rows = await db.query(`
    SELECT s.code AS status_code, s.progress_weight, t.name AS type_name, wp.story_points
      FROM work_packages wp
      JOIN statuses s ON s.id = wp.status_id
      JOIN work_package_types t ON t.id = wp.type_id
     WHERE wp.project_id = ?`, [projectId]);
  const fromDb = rollup.completion(rows);
  const fromFile = { total: 0, done: 0, partial: 0, notStarted: 0, deferred: 0, rejected: 0 };
  for (const f of Object.values(state.features)) {
    fromFile.total += 1;
    if (f.status === 'done') fromFile.done += 1;
    else if (f.status === 'in_build' || f.status === 'speccing') fromFile.partial += 1;
    else if (f.status === 'not_started') fromFile.notStarted += 1;
    else if (f.status === 'deferred') fromFile.deferred += 1;
    else if (f.status === 'rejected') fromFile.rejected += 1;
  }
  const same = ['total', 'done', 'partial', 'notStarted', 'deferred', 'rejected']
    .every((k) => fromDb[k] === fromFile[k]);
  return { same, fromDb, fromFile, readiness: rollup.readiness(rows) };
}

// ------------------------------------------------------------------- the run

async function runImport({ file, code, asLogin, dryRun }) {
  const state = readState(file);
  const ref = await reference(state);
  const owner = await ownerFor(asLogin);
  const actorLabel = `import · ${path.basename(file)}`;

  let report = null;
  try {
    await db.transaction(async (tx) => {
      report = await importInto(tx, { state, ref, owner, code, actorLabel });
      // A dry run takes the same path and then unwinds it. A second, read-only
      // code path would be a second implementation, and the one nobody runs is
      // the one that stops matching.
      if (dryRun) throw new Rollback('dry run');
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return { state, owner, report, dryRun };
}

/** The one positional argument, with the values of --project and --as removed. */
function positionalFile() {
  const takesValue = new Set(['--project', '--as']);
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      if (takesValue.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) i += 1;
      continue;
    }
    out.push(args[i]);
  }
  if (out.length > 1) throw new Error(`one file at a time — got ${out.map((o) => `"${o}"`).join(', ')}`);
  return out[0];
}

async function main() {
  const file = positionalFile();
  const code = String(flag('project', 'SF')).toUpperCase();
  if (!/^[A-Z0-9]{2,16}$/.test(code)) throw new Error('--project is 2–16 letters or digits');

  const { state, owner, report, dryRun } = await runImport({
    file, code, asLogin: flag('as'), dryRun: has('--dry-run'),
  });

  const f = report.features;
  console.log(`${dryRun ? 'would import' : 'imported'} ${state.project} into ${report.project.code}`
    + `${report.projectCreated ? ' (created)' : ' (merged into the existing project)'}`
    + `, owned by ${owner.login}`);
  console.log(`  features    ${f.created} created · ${f.statusChanged.length} moved status · `
    + `${f.noteChanged} note changed · ${f.unchanged} unchanged`);
  for (const line of f.statusChanged.slice(0, 12)) console.log(`              ${line}`);
  if (f.statusChanged.length > 12) console.log(`              … and ${f.statusChanged.length - 12} more`);
  if (f.notInFile) {
    console.log(`              ${f.notInFile} work package(s) in this project are not in the file. `
      + 'Nothing was deleted.');
  }
  if (report.healthLeftAlone) {
    console.log(`  health      left as somebody set it: "${report.healthLeftAlone}". `
      + 'Clear it in the app to have the import maintain it again.');
  }
  console.log(`  questions   ${report.questions.created} added as comments · `
    + `${report.questions.skipped} already there`);
  if (report.questions.orphans.length) {
    console.log(`              ${report.questions.orphans.length} answered question(s) name a feature the `
      + `file does not carry, and were skipped: ${report.questions.orphans.join(', ')}`);
  }
  console.log(`  decisions   ${report.decisions.created} pages created · ${report.decisions.updated} updated · `
    + `${report.decisions.unchanged} unchanged`);
  console.log(`  activity    ${report.activity.created} entries written · `
    + `${report.activity.alreadyThere} already there`);
  if (report.activity.truncated) {
    console.log(`              ${report.activity.truncated} note(s) were longer than the ${DETAIL_MAX} `
      + 'characters the trail holds and are recorded cut. The trail is a summary by design; the current '
      + 'note is on the work package in full.');
  }

  if (dryRun) {
    console.log('\n  --dry-run: the transaction was rolled back and nothing was written.');
    await db.close();
    return;
  }

  const check = await verify(state, report.project.id);
  console.log('\n  the file says      '
    + `${check.fromFile.done} done · ${check.fromFile.partial} partial · ${check.fromFile.notStarted} not started `
    + `· ${check.fromFile.deferred} deferred · ${check.fromFile.rejected} rejected · ${check.fromFile.total} total`);
  console.log('  the tracker says   '
    + `${check.fromDb.done} done · ${check.fromDb.partial} partial · ${check.fromDb.notStarted} not started `
    + `· ${check.fromDb.deferred} deferred · ${check.fromDb.rejected} rejected · ${check.fromDb.total} total`);
  console.log(`  weighted readiness ${check.readiness.pct}% of ${check.readiness.scored} scored, `
    + `${check.readiness.excluded} excluded — weighted, not completion`);
  if (!check.same) {
    console.log('\n! the two do not agree. The import has changed the project on the way in; do not '
      + 'plan from these figures until it does.');
    await db.close();
    process.exit(1);
  }
  console.log('  they agree.');
  await db.close();
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(`import failed: ${e.message}`);
    await db.close();
    process.exit(1);
  });
}

module.exports = { runImport, readState, verify, titleFrom, areaOf };
