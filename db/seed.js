#!/usr/bin/env node
/**
 * Seed the database.
 *
 *   node db/seed.js               reference data + the demo portfolio
 *   node db/seed.js --reference   reference data only — safe on a live database
 *
 * Reference data is the app's vocabulary (statuses, priorities, types, roles,
 * permissions, the work week, the theme, the form configurations) and is
 * upserted, so re-running it after an upgrade that adds a status is the intended
 * way to get that status. The demo portfolio is a one-shot: it refuses to run
 * against a database that already has projects, because merging two portfolios
 * on natural keys is a guess and a wrong guess here is somebody's data.
 */

'use strict';

const db = require('../src/db');
const passwords = require('../src/domain/passwords');
const { seedReference } = require('./seed-reference');
const D = require('./demo-data');

const DAY = 86400000;
const shiftDate = (iso, days) =>
  new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10);
const minutesAgo = (n) =>
  new Date(Date.parse(D.TODAY + 'T17:00:00Z') - n * 60000).toISOString().slice(0, 19).replace('T', ' ');

async function seedDemo(ref) {
  const existing = await db.scalar('SELECT COUNT(*) AS n FROM projects');
  if (Number(existing) > 0) {
    console.log(`! ${existing} project(s) already exist — the demo portfolio was not seeded.`);
    console.log('  Use `node db/migrate.js --force` first if you meant to start over.');
    return;
  }

  const user = {};   // key -> id
  const project = {};
  const version = {};
  const sprint = {};
  const wp = {};     // demo number -> real id
  const template = {};
  const doc = {};

  // ---------------------------------------------------------------- people
  for (const [key, name, roleLabel, capacity, initials, kind, colour, login] of [...D.PEOPLE, D.MCP_ACTOR]) {
    const row = {
      login, name, initials, colour, kind,
      weekly_capacity: capacity,
      email: login ? `${login}@seedfall.local` : null,
      // Every demo account shares one password and the README says so. A seeded
      // account with a guessable-but-unstated password is the worse of the two.
      ...(login ? passwords.hash('projecttracker') : { password_hash: null, password_salt: null }),
      is_admin: key === 'stephen' ? 1 : 0,
      placeholder_for: kind === 'placeholder' ? 'the copyeditor, once hired' : null,
      theme_id: ref.themes['Instrument amber'],
      timezone: 'America/Chicago',
    };
    if (row.hash) { row.password_hash = row.hash; row.password_salt = row.salt; delete row.hash; delete row.salt; }
    user[key] = await db.insert('users', row);
    user[key + ':role'] = roleLabel;
  }

  const platform = await db.insert('user_groups', { name: 'Platform', description: 'Maintainer on the four platform projects' });
  const readers = await db.insert('user_groups', { name: 'Readers', description: 'Reader everywhere' });
  for (const k of ['stephen', 'odell']) await db.run('INSERT INTO user_group_members (group_id, user_id) VALUES (?, ?)', [platform, user[k]]);
  for (const k of ['lin', 'kessler']) await db.run('INSERT INTO user_group_members (group_id, user_id) VALUES (?, ?)', [readers, user[k]]);

  const org = await db.insert('organizations', {
    name: 'Crown & Crabapple', kind: 'internal', contact: 'stephen@seedfall.local',
    notes: 'The studio the whole portfolio belongs to.',
  });

  // -------------------------------------------------------------- templates
  for (const [code, name, detail, blueprint] of D.TEMPLATES) {
    template[code] = await db.insert('project_templates', {
      code, name, detail, blueprint: JSON.stringify(blueprint),
    });
  }

  // --------------------------------------------------------------- programs
  const program = {};
  for (const [key, code, name, summary, position] of D.PROGRAMS) {
    program[key] = await db.insert('programs', { code, name, summary, position });
  }

  // --------------------------------------------------------------- projects
  const templateFor = { vw: 'SPEC', trk: 'SPEC', ing: 'SPEC', mcp: 'INTEG', cdx: 'SPEC', ms1: 'BOOK', site: 'SPIKE' };
  for (const [key, code, name, prog, phaseIndex, health, healthNote, fav] of D.PROJECTS) {
    project[key] = await db.insert('projects', {
      code, identifier: key, name, program_id: program[prog],
      template_id: template[templateFor[key]] || null,
      organization_id: org,
      health, health_note: healthNote,
      work_week_id: ref.workWeeks['Mon–Fri'],
      description: null, archived: 0, public: 0,
    });

    // Phases. A project's phases come from its template's blueprint, so a
    // manuscript gets manuscript phases rather than a software project's.
    const blueprint = db.json(
      await db.scalar('SELECT blueprint FROM project_templates WHERE id = ?', [template[templateFor[key]]]),
      { phases: [] }
    );
    const phases = blueprint.phases && blueprint.phases.length
      ? blueprint.phases
      : D.PHASES.map((n, i) => ({ name: n, gate: `G${i + 1}`, criterion: D.GATES[i] }));

    for (let i = 0; i < phases.length; i += 1) {
      const p = phases[i];
      // The current phase index from the dataset is expressed against the
      // six-phase software life cycle; clamp it into whatever this project's
      // own life cycle actually has.
      const current = Math.min(phaseIndex, phases.length - 1);
      let state = 'not_entered';
      let metOn = null;
      if (i < current) { state = 'gate_met'; metOn = shiftDate(D.TODAY, -60 + i * 12); }
      else if (i === current) state = health === 'rust' ? 'blocked' : 'current';
      await db.insert('project_phases', {
        project_id: project[key], position: i + 1, name: p.name,
        gate_name: p.gate, gate_criterion: p.criterion,
        state, gate_met_on: metOn, gate_met_by: metOn ? user.stephen : null,
        gate_note: state === 'blocked'
          ? 'The criterion is itself an open decision — see 27 · open decisions, D-19.'
          : null,
      });
    }

    if (fav) await db.run('INSERT INTO project_favorites (user_id, project_id) VALUES (?, ?)', [user.stephen, project[key]]);
  }

  // Subproject relationship: the public site hangs off the tracker, which is
  // what the subproject board draws.
  await db.run('UPDATE projects SET parent_id = ? WHERE id = ?', [project.trk, project.site]);

  // ------------------------------------------------------------ memberships
  const memberRoles = {
    stephen: 'Owner', odell: 'Contributor', kessler: 'Contributor', lin: 'Reader', copyeditor: 'Placeholder',
  };
  for (const pkey of Object.keys(project)) {
    for (const [ukey, roleName] of Object.entries(memberRoles)) {
      const m = await db.insert('memberships', { project_id: project[pkey], user_id: user[ukey] });
      await db.run('INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)', [m, ref.roles[roleName]]);
    }
  }
  // The Platform group is Maintainer on the four platform projects, which is the
  // group grant the roles page describes.
  for (const pkey of ['vw', 'trk', 'ing', 'mcp']) {
    const m = await db.insert('memberships', { project_id: project[pkey], group_id: platform });
    await db.run('INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)', [m, ref.roles.Maintainer]);
  }

  // --------------------------------------------------------------- versions
  for (const [code, name, pkey, due, state, sharing] of D.VERSIONS) {
    version[code] = await db.insert('versions', {
      project_id: project[pkey], code, name, due_date: due, state, sharing,
    });
  }

  // ---------------------------------------------------------------- sprints
  for (const [key, code, start, end, state, sharing, projects] of D.SPRINTS) {
    sprint[key] = await db.insert('sprints', {
      code, name: code, project_id: sharing === 'system' ? null : project[projects[0]],
      start_date: start, end_date: end, state, sharing,
      goal: sharing === 'system' ? 'Shared across VW, MCP and CDX — one sprint, three backlogs.' : null,
    });
    for (const pk of projects) {
      await db.run('INSERT INTO sprint_projects (sprint_id, project_id) VALUES (?, ?)', [sprint[key], project[pk]]);
    }
  }

  // ---------------------------------------------------------- work packages
  // AUTO_INCREMENT is set so that the first insert lands on the dataset's first
  // number and wp_key reads WP-100. The ids are then explicit anyway; the reset
  // is what keeps anything created later out of the demo's range.
  await db.run('ALTER TABLE work_packages AUTO_INCREMENT = 100');
  for (const r of D.WPS) {
    const [num, pkey, type, subject, parent, status, prio, assignee, accountable,
      start, due, est, spent, pts, ver, spr] = r;
    wp[num] = await db.insert('work_packages', {
      id: num,
      project_id: project[pkey],
      type_id: ref.types[type],
      subject,
      parent_id: parent ? parent : null,
      status_id: ref.statuses[status],
      priority_id: ref.priorities[prio],
      assignee_id: assignee ? user[assignee] : null,
      accountable_id: accountable ? user[accountable] : null,
      author_id: user.stephen,
      start_date: start, due_date: due,
      // A milestone and a phase hold their own dates; everything else follows
      // its children and its relations.
      scheduling: (type === 'MILESTONE' || type === 'PHASE') ? 'manual' : 'automatic',
      estimated_hours: est,
      story_points: pts,
      version_id: ver ? version[ver] : null,
      sprint_id: spr ? sprint[spr] : null,
      closed_at: status === 'done' ? minutesAgo(60 * 24 * 3) : null,
      created_at: minutesAgo(60 * 24 * 30),
    });
    // Spent hours become time entries, because "spent" is a fact about days that
    // happened and a total with no days behind it cannot be corrected.
    if (spent > 0) {
      await db.insert('time_entries', {
        work_package_id: num, project_id: project[pkey],
        user_id: assignee ? user[assignee] : user.stephen,
        spent_on: start, hours: spent, activity: 'Development',
        comment: 'Seeded from the demo dataset as one entry per work package.',
      });
    }
  }

  // Watchers, relations, baselines.
  for (const r of D.WPS) {
    const num = r[0];
    for (const ukey of r[17]) {
      await db.run('INSERT INTO work_package_watchers (work_package_id, user_id) VALUES (?, ?)', [num, user[ukey]]);
    }
    if (r[16]) {
      const [kind, target] = r[16].split(':');
      await db.insert('work_package_relations', { from_id: num, to_id: Number(target), kind });
    }
  }

  for (const pkey of ['vw', 'mcp', 'ms1']) {
    const baselineId = await db.insert('baselines', {
      project_id: project[pkey],
      name: pkey === 'vw' ? 'Gate 3 sign-off' : pkey === 'mcp' ? 'MCP scope agreed' : 'Draft two plan',
      taken_at: minutesAgo(60 * 24 * 21), taken_by: user.stephen, is_current: 1,
      note: 'What the plan was signed off against. A slip is recorded against this rather than absorbed.',
    });
    for (const r of D.WPS) {
      if (r[1] !== pkey) continue;
      const off = D.BASELINE_OFFSETS[r[0]];
      await db.insert('baseline_entries', {
        baseline_id: baselineId, work_package_id: r[0],
        start_date: off ? shiftDate(r[9], off[0]) : r[9],
        due_date: off ? shiftDate(r[10], off[1]) : r[10],
        status_id: ref.statuses.not_started,
        story_points: r[13], estimated_hours: r[11],
      });
    }
  }

  // ------------------------------------------------------- resource planning
  for (const [ukey, hoursByWeek] of Object.entries(D.LOAD)) {
    for (let i = 0; i < hoursByWeek.length; i += 1) {
      if (!hoursByWeek[i]) continue;   // a zero week is no booking, not a booking of zero
      await db.insert('resource_allocations', {
        user_id: user[ukey], project_id: null, work_package_id: null,
        week_start: D.WEEK_STARTS[i], hours: hoursByWeek[i],
        note: 'Booked against declared availability.',
      });
    }
  }

  await db.insert('date_alerts', { user_id: user.stephen, rule: 'due_soon', threshold_days: 2, only_assigned: 1 });
  await db.insert('date_alerts', { user_id: user.stephen, rule: 'overdue', threshold_days: 0, only_assigned: 1 });
  await db.insert('date_alerts', { user_id: user.stephen, rule: 'unassigned', threshold_days: 14, only_assigned: 0, only_watched: 1 });

  return { user, project, version, sprint, wp, template, program, doc, org, platform, readers };
}

async function seedDemoPartTwo(ref, ctx) {
  if (!ctx) return;
  const { user, project, wp, doc } = ctx;

  // ----------------------------------------------------------------- boards
  for (const [pkey, name, type] of [
    ['vw', 'Status board', 'status'], ['vw', 'Version board', 'version'],
    ['vw', 'Program board', 'subproject'], ['vw', 'Work breakdown', 'wbs'],
    ['mcp', 'Status board', 'status'], ['ms1', 'Draft board', 'status'],
  ]) {
    await db.insert('boards', { project_id: project[pkey], name, board_type: type });
  }

  // Velocity for sprints that closed before anything was itemised. Live sprints
  // are computed and never read this table.
  for (const [code, points] of [['S-11', 21], ['S-12', 26], ['S-13', 18]]) {
    await db.insert('sprint_velocity_history', {
      sprint_code: code, project_id: project.vw, closed_points: points,
      note: 'Recorded before the work was itemised in this tracker.',
    });
  }

  // -------------------------------------------------------------- dashboards
  const myPage = await db.insert('dashboards', { project_id: null, owner_id: user.stephen, name: 'My page' });
  const myWidgets = ['kpi_strip', 'work_table', 'ai_summary', 'alerts', 'availability'];
  for (let i = 0; i < myWidgets.length; i += 1) {
    await db.insert('dashboard_widgets', { dashboard_id: myPage, kind: myWidgets[i], position: i });
  }
  for (const pkey of Object.keys(project)) {
    const dash = await db.insert('dashboards', { project_id: project[pkey], owner_id: null, name: 'Overview' });
    const kinds = ['lifecycle', 'kpi_strip', 'status_breakdown', 'versions', 'members', 'activity'];
    for (let i = 0; i < kinds.length; i += 1) {
      await db.insert('dashboard_widgets', { dashboard_id: dash, kind: kinds[i], position: i });
    }
  }

  // -------------------------------------------------- lists and saved views
  const list = await db.insert('project_lists', {
    name: 'Platform · active', owner_id: user.stephen, starred: 1, visibility: 'shared',
    filters: JSON.stringify({ program: 'PLAT', archived: false }),
  });
  await db.insert('project_list_shares', {
    list_id: list, token: 'lst' + 'a'.repeat(45), permission: 'view',
    expires_at: '2026-09-30 23:59:59', created_by: user.stephen,
  });
  await db.insert('project_lists', {
    name: 'My favourites', owner_id: user.stephen, starred: 1, visibility: 'private',
    filters: JSON.stringify({ favourite: true }),
  });
  await db.insert('saved_views', {
    name: 'Everything immediate, all projects', owner_id: user.stephen, project_id: null,
    view_type: 'list', highlight_mode: 'priority', visibility: 'shared', starred: 1,
    filters: JSON.stringify({ priority: ['immediate', 'high'], open: true }),
  });
  await db.insert('saved_views', {
    name: 'Overdue across the portfolio', owner_id: user.stephen, project_id: null,
    view_type: 'list', highlight_mode: 'overdue', visibility: 'shared',
    filters: JSON.stringify({ overdue: true }),
  });

  // ------------------------------------------------------------------- wiki
  for (const [number, slug, title, pkey, status, body] of D.DOCS) {
    const words = body.trim().split(/\s+/).length;
    const sections = (body.match(/^#{1,6} /gm) || []).length;
    doc[slug] = await db.insert('documents', {
      project_id: project[pkey], number, slug, title, body, status,
      word_count: words, section_count: sections,
      position: Number(number), created_by: user.stephen, updated_by: user.stephen,
    });
    await db.insert('document_versions', {
      document_id: doc[slug], revision: 1, body, author_id: user.stephen, note: 'Seeded',
    });
  }
  // Two people live in the feature inventory, which is what the wiki rail reports.
  for (const ukey of ['stephen', 'odell']) {
    await db.insert('document_presence', {
      document_id: doc['feature-inventory'], user_id: user[ukey], section: 'Tags', base_revision: 1,
    });
  }

  // ----------------------------------------------------------------- forums
  const forum = await db.insert('forums', { project_id: project.vw, name: 'Design', description: 'Anything that is not yet a decision' });
  for (const [subject, replies, ukey] of [
    ['Weighting the rollup', 7, 'stephen'],
    ['Should placeholder users see internal comments?', 3, 'odell'],
  ]) {
    const topic = await db.insert('forum_topics', {
      forum_id: forum, subject, author_id: user[ukey], reply_count: replies,
      last_reply_at: minutesAgo(60 * 20),
    });
    await db.insert('forum_messages', {
      topic_id: topic, author_id: user[ukey],
      body: subject === 'Weighting the rollup'
        ? 'Opening question: are the weights per status or per domain? If per domain, the same status means two different things in two places and the number stops being comparable.'
        : 'No. A placeholder cannot sign in, so anything it can see is anything a future hire can see before they are hired. Internal stays internal.',
    });
  }

  // ------------------------------------------------------------------- news
  for (const [title, summary, mins] of [
    ['Gate 3 signed — scope locked', 'No V1 features may be added after this. The list in 05 is the list.', 60 * 48],
    ['Shared sprint S-15 opened across three projects', 'VW, MCP and CDX draw from one sprint for the first time. Velocity counts its points once.', 60 * 120],
  ]) {
    await db.insert('news', {
      project_id: project.vw, title, summary, author_id: user.stephen, created_at: minutesAgo(mins),
      body: summary,
    });
  }

  // --------------------------------------------------------------- meetings
  const meeting = {};
  for (const m of D.MEETINGS) {
    meeting[m.key] = await db.insert('meetings', {
      project_id: project[m.project], title: m.title, scheduled_on: m.on,
      start_time: m.at + ':00', duration_min: m.mins, state: m.state, created_by: user.stephen,
    });
    for (const ukey of m.who) {
      await db.run('INSERT INTO meeting_participants (meeting_id, user_id, invited, attended) VALUES (?, ?, 1, ?)',
        [meeting[m.key], user[ukey], m.state === 'minutes' ? 1 : null]);
    }
    let pos = 0;
    for (const [mins, title, wpNum] of m.agenda) {
      await db.insert('meeting_agenda_items', {
        meeting_id: meeting[m.key], position: pos++, title, duration_min: mins,
        presenter_id: user.stephen, work_package_id: wpNum ? wp[wpNum] : null,
      });
    }
    if (m.minutes) {
      await db.insert('meeting_minutes', {
        meeting_id: meeting[m.key], body: m.minutes, recorded_by: user.stephen,
      });
    }
  }
  for (const m of D.MEETINGS) {
    for (const [kind, text, ownerKey, wpNum, carriedKey] of m.outcomes) {
      await db.insert('meeting_outcomes', {
        meeting_id: meeting[m.key], kind, text,
        owner_id: ownerKey ? user[ownerKey] : null,
        work_package_id: wpNum ? wp[wpNum] : null,
        carried_to: carriedKey ? meeting[carriedKey] : null,
      });
    }
  }

  // --------------------------------------------------------------- comments
  const c1 = await db.insert('comments', {
    container_type: 'work_package', container_id: wp[112], author_id: user.stephen, internal: 1,
    created_at: minutesAgo(60 * 48),
    body: 'Reopened after the domain-weighting decision changed. Do not close this until the rollup and the milestone bar read the same number.',
  });
  await db.insert('comments', {
    container_type: 'work_package', container_id: wp[112], author_id: user.odell, internal: 0,
    created_at: minutesAgo(60 * 24),
    body: 'Picked this up. The projection already exposes the weights, so this is a display change only.',
  });
  const c3 = await db.insert('comments', {
    container_type: 'work_package', container_id: wp[503], author_id: user.kessler, internal: 0,
    created_at: minutesAgo(180),
    body: '@stephen act two still opens on the wrong beat — the window has to close before she decides.',
  });
  await db.run('INSERT INTO mentions (comment_id, user_id) VALUES (?, ?)', [c3, user.stephen]);
  await db.insert('comments', {
    container_type: 'work_package', container_id: wp[120], author_id: user.stephen, internal: 1,
    created_at: minutesAgo(60 * 48),
    body: 'Split in two after review. The three-role model is the half with the risk in it; if the date moves, it is this half that moves.',
  });
  void c1;

  // ---------------------------------------------------------- share, files
  await db.insert('work_package_shares', {
    work_package_id: wp[121], token: 'shr' + 'b'.repeat(45), email: 'reviewer@example.invalid',
    permission: 'view', includes_internal: 0, expires_at: '2026-09-30 23:59:59',
    created_by: user.stephen, view_count: 3, last_viewed_at: minutesAgo(400),
  });

  // ------------------------------------------------------------- activities
  for (const [actorKey, verb, kind, pkey, wpNum, detail, mins] of D.ACTIVITY) {
    const isLabel = actorKey.startsWith(':');
    await db.insert('activities', {
      project_id: project[pkey] || null,
      work_package_id: wpNum ? wp[wpNum] : null,
      actor_id: isLabel ? null : user[actorKey],
      actor_label: isLabel ? actorKey.slice(1) : null,
      kind, verb, detail, created_at: minutesAgo(mins),
      target_label: wpNum ? 'WP-' + wpNum : (project[pkey] ? null : null),
    });
  }

  // ---------------------------------------------------------- notifications
  for (const [ukey, kind, title, detail, mins, wpNum] of D.NOTIFICATIONS) {
    await db.insert('notifications', {
      user_id: user[ukey], kind, title, detail,
      work_package_id: wpNum ? wp[wpNum] : null,
      created_at: minutesAgo(mins),
      actor_id: kind === 'mention' ? user.kessler : kind === 'assigned' ? user.odell : null,
    });
  }

  // ------------------------------------------------------------ email intake
  for (const [from, subject, state, reason, wpNum] of [
    ['reviewer@example.invalid', 'Filter bar states look wrong at 320px', 'created', null, 121],
    ['stephen@seedfall.local', 'Re: WP-124 stale note', 'commented', null, 124],
    ['newsletter@example.invalid', 'Your weekly digest', 'rejected', 'Sender is not a member of any project and the address is not on the allow-list.', null],
  ]) {
    await db.insert('email_intake', {
      message_id: `<${Math.random().toString(36).slice(2)}@example.invalid>`,
      from_email: from, to_email: 'tasks@seedfall.local', subject,
      body: 'Seeded intake record.', state, reason,
      project_id: project.vw, work_package_id: wpNum ? wp[wpNum] : null,
      received_at: minutesAgo(60 * 30),
    });
  }

  await db.insert('calendar_subscriptions', {
    token: 'cal' + 'c'.repeat(45), user_id: user.stephen, project_id: project.vw,
    name: 'VW — due dates, meetings, sprint starts', last_fetched_at: minutesAgo(90),
  });

  // ----------------------------------------------- repositories, integrations
  const repo = await db.insert('repositories', {
    project_id: project.vw, scm: 'github', name: 'seedfall/seedfall',
    url: 'https://github.com/seedfall/seedfall', default_branch: 'main',
    token_env: 'GITHUB_TOKEN', state: 'connected', detail: '4f1c8ad · 2 days ago',
    last_synced_at: minutesAgo(60 * 48),
  });
  const rev = await db.insert('repository_revisions', {
    repository_id: repo, identifier: '4f1c8ad', author: 'Stephen',
    message: 'parse decision blocks', committed_at: minutesAgo(60 * 48),
    insertions: 214, deletions: 31, url: 'https://github.com/seedfall/seedfall/commit/4f1c8ad',
  });
  await db.run('INSERT INTO revision_work_packages (revision_id, work_package_id) VALUES (?, ?)', [rev, wp[103]]);
  await db.insert('repositories', {
    project_id: project.vw, scm: 'git', name: 'local', url: '~/code/seedfall',
    default_branch: 'main', state: 'connected', detail: 'main · clean',
  });

  // ------------------------------------------------------------- the git deck
  //
  // The repository above as it looks after one pull. Seeded rather than fetched
  // — nothing here has a token — so the deck, the mapping table and the drawer's
  // repository panel all have something true to draw. `db/demo-data.js` says why
  // one of the keys deliberately matches nothing.
  await db.run("UPDATE repositories SET slug = 'seedfall/seedfall', pull_state = 'ok', "
    + "pull_detail = 'pulled cleanly' WHERE id = ?", [repo]);

  for (const [num, refKey] of D.REF_KEYS) {
    await db.run('UPDATE work_packages SET ref_key = ? WHERE id = ?', [refKey, wp[num]]);
  }

  const gitItem = {};
  for (const r of D.GIT_ITEMS) {
    const [kind, ref2, title, state, author, head, base, bodyText, labels,
      openedDays, updatedDays, closedDays, mergedDays, conclusion, severity] = r;
    const days = (n) => (n === null || n === undefined ? null : minutesAgo(60 * 24 * n));
    gitItem[`${kind}:${ref2}`] = await db.insert('git_items', {
      repository_id: repo, kind, ref: ref2, title, state, author,
      head_branch: head, base_branch: base, body: bodyText, labels,
      url: kind === 'release'
        ? `https://github.com/seedfall/seedfall/releases/tag/${ref2}`
        : kind === 'issue'
          ? `https://github.com/seedfall/seedfall/issues/${ref2}`
          : kind === 'pull_request'
            ? `https://github.com/seedfall/seedfall/pull/${ref2}`
            : null,
      opened_at: days(openedDays), updated_at: days(updatedDays),
      closed_at: days(closedDays), merged_at: days(mergedDays),
      conclusion, severity,
      duration_sec: kind === 'workflow_run' ? 214 : null,
      comment_count: kind === 'pull_request' || kind === 'issue' ? 3 : null,
      pulled_at: minutesAgo(60),
    });
  }

  for (const [num, kind, ref2, relation, origin, matchedKey, matchedIn] of D.GIT_LINKS) {
    await db.insert('work_package_git_links', {
      work_package_id: wp[num], git_item_id: gitItem[`${kind}:${ref2}`],
      relation, origin, matched_key: matchedKey, matched_in: matchedIn,
      actor_label: 'gitdeck', created_at: minutesAgo(60),
    });
  }

  // Keys the repository used that no work package carries. Kept on purpose.
  for (const [candidate, matchedIn, seen] of [
    ['F-LOAD-207', 'branch', 3], ['B-ENG-003', 'body', 1], ['PH-2', 'body', 1],
  ]) {
    await db.insert('git_unmatched_keys', {
      repository_id: repo, candidate, matched_in: matchedIn, seen_count: seen,
      first_seen_at: minutesAgo(60 * 24 * 4), last_seen_at: minutesAgo(60),
    });
  }

  // The webhook half: the variable the shared secret is read from (never the
  // secret), the person a delivery acts as, and two deliveries — one applied and
  // one refused, because a receiver that only ever shows the happy case hides
  // the panel somebody actually needs at 3am.
  await db.run(
    "UPDATE repositories SET hook_secret_env = 'GITHUB_WEBHOOK_SECRET', hook_actor_id = ?, "
    + "hook_state = 'ok', hook_detail = '1 new, 1 link(s)', hook_last_at = ? WHERE id = ?",
    [user.stephen, minutesAgo(40), repo]
  );
  await db.insert('git_hook_deliveries', {
    repository_id: repo, delivery_id: 'e4f1c8ad-2b19-4d0a-9d6f-0a1b2c3d4e5f',
    event: 'pull_request', action: 'closed', state: 'applied', signature_ok: 1,
    items_touched: 1, links_made: 1, statuses_moved: 0,
    reason: '0 new, 1 link(s)', payload_bytes: 21874, received_at: minutesAgo(40),
  });
  await db.insert('git_hook_deliveries', {
    repository_id: repo, delivery_id: '9c2d7e10-55aa-4f3b-8c21-77d9e0f1a2b3',
    event: 'push', action: null, state: 'rejected', signature_ok: 0,
    reason: 'the signature did not match the secret this repository names',
    payload_bytes: 4120, received_at: minutesAgo(120),
  });

  await db.insert('git_pulls', {
    repository_id: repo, actor_id: user.stephen, actor_label: 'gitdeck', state: 'ok',
    started_at: minutesAgo(61), finished_at: minutesAgo(60),
    items_seen: D.GIT_ITEMS.length, items_new: D.GIT_ITEMS.length,
    links_made: D.GIT_LINKS.length, unmatched: 3, rate_remaining: 4863,
  });

  for (const [name, kind, target, state, detail, pkey, tokenEnv] of D.INTEGRATIONS) {
    await db.insert('integrations', {
      kind, name, target, state, detail,
      project_id: pkey ? project[pkey] : null, token_env: tokenEnv,
      config: JSON.stringify(kind === 'email' ? { address: 'tasks@seedfall.local', allow_list: ['seedfall.local'] } : {}),
    });
  }

  // ------------------------------------------------------------- automations
  for (const [name, trigger_kind, action_kind, scopeProjects, enabled, note] of D.AUTOMATIONS) {
    const id = await db.insert('automations', {
      name, trigger_kind, action_kind,
      scope: scopeProjects ? 'listed' : 'all',
      enabled, disabled_note: note,
      trigger_config: JSON.stringify(trigger_kind === 'overdue' ? { days: 3 } : {}),
      action_config: JSON.stringify(action_kind === 'raise_priority' ? { to: 'high', notify: 'accountable' } : {}),
      run_count: enabled ? 4 : 0, last_run_at: enabled ? minutesAgo(60 * 12) : null,
    });
    for (const pk of scopeProjects || []) {
      await db.run('INSERT INTO automation_projects (automation_id, project_id) VALUES (?, ?)', [id, project[pk]]);
    }
  }

  // ------------------------------------------------------------ custom fields
  for (const [name, field_format, customized_type, scopeProjects, help_text, is_required, values] of D.CUSTOM_FIELDS) {
    const id = await db.insert('custom_fields', {
      name, field_format, customized_type, help_text, is_required,
      is_for_all: scopeProjects ? 0 : 1,
      possible_values: values ? JSON.stringify(values) : null,
      position: 0,
    });
    for (const pk of scopeProjects || []) {
      await db.run('INSERT INTO custom_field_projects (custom_field_id, project_id) VALUES (?, ?)', [id, project[pk]]);
    }
    if (name === 'Domain') {
      for (const [num, val] of [[101, 'loader'], [102, 'loader'], [103, 'loader'], [110, 'ui'], [111, 'ui'], [112, 'ui'], [121, 'ui'], [124, 'ui']]) {
        await db.insert('custom_values', { custom_field_id: id, customized_type: 'work_package', customized_id: wp[num], value: val });
      }
    }
    if (name === 'Slice tag') {
      for (const r of D.WPS) {
        if (!['vw', 'mcp', 'cdx'].includes(r[1])) continue;
        const tag = r[14] === 'V2' ? 'V2' : r[5] === 'deferred' ? 'V3' : 'V1';
        await db.insert('custom_values', { custom_field_id: id, customized_type: 'work_package', customized_id: wp[r[0]], value: tag });
      }
    }
  }

  // --------------------------------------------------------------- MCP setup
  // Upserted, not inserted: migration 0001 puts these rows in too, so that a
  // database that was never demo-seeded still offers the tools. Inserting here
  // would collide with it on the unique tool name.
  for (let i = 0; i < D.MCP_TOOLS.length; i += 1) {
    const [name, mode, detail, status] = D.MCP_TOOLS[i];
    await db.run(`
      INSERT INTO mcp_tools (name, mode, detail, status, position, enabled) VALUES (?, ?, ?, ?, ?, 1)
      ON DUPLICATE KEY UPDATE mode = VALUES(mode), detail = VALUES(detail),
                              status = VALUES(status), position = VALUES(position), enabled = 1`,
    [name, mode, detail, status, i]);
  }
  const crypto = require('crypto');
  const secret = 'pt_mcp_' + crypto.randomBytes(24).toString('hex');
  await db.insert('mcp_tokens', {
    name: 'Local assistant · read', scope: 'read',
    token_hash: crypto.createHash('sha256').update(secret).digest('hex'),
    token_hint: secret.slice(-4), project_scope: null, includes_internal: 0,
    created_by: user.stephen, last_used_at: minutesAgo(41),
  });
  await db.insert('generated_summaries', {
    scope: 'user', user_id: user.stephen, source: 'mcp', generated_at: minutesAgo(41),
    body: 'The V1 slice is two features from feature-complete, both in the instrument panel. Ingest closed out on schedule; the panel is nine days behind its baseline because the weighted rollup was reopened after the domain-weighting decision changed.\n\nOne immediate-priority bug is open in work package core. The MCP server has not started and its gate is unscheduled, which is the only thing that would move the V1 date.',
  });

  await db.insert('project_initiation_requests', {
    name: 'Audio companion', requested_by: user.odell, template_id: ctx.template.SPIKE,
    program_id: ctx.program.gtm, state: 'submitted',
    answers: JSON.stringify({
      why: 'Test whether a narrated version is worth costing.',
      budget: 'Two weeks, one person',
      exit: 'A number, or a reason there is not one',
    }),
  });

  console.log('');
  console.log('  Demo MCP read token (shown once, not recoverable from the database):');
  console.log(`    ${secret}`);
  console.log('');
}

async function main() {
  const referenceOnly = process.argv.includes('--reference');
  const ref = await seedReference();
  console.log('reference data in place');
  if (!referenceOnly) {
    const ctx = await seedDemo(ref);
    await seedDemoPartTwo(ref, ctx);
    if (ctx) {
      const counts = await db.one(`SELECT
        (SELECT COUNT(*) FROM projects)       AS projects,
        (SELECT COUNT(*) FROM work_packages)  AS work_packages,
        (SELECT COUNT(*) FROM users)          AS users,
        (SELECT COUNT(*) FROM activities)     AS activities,
        (SELECT COUNT(*) FROM documents)      AS documents`);
      console.log(`seeded ${counts.projects} projects · ${counts.work_packages} work packages · `
        + `${counts.users} users · ${counts.documents} documents · ${counts.activities} activity entries`);
      console.log('sign in as stephen / projecttracker');
      // Migrate leaves an `admin` account behind, so after seeding the demo there
      // are usually two administrators. The CLI refuses to guess between them,
      // and finding that out from a failed command is worse than reading it here.
      const admins = await db.query(
        "SELECT login FROM users WHERE is_admin = 1 AND active = 1 AND kind = 'user' ORDER BY id"
      );
      if (admins.length > 1) {
        console.log(`${admins.length} administrators exist (${admins.map((a) => a.login).join(', ')}), `
          + 'so the CLI needs --as LOGIN or PT_CLI_USER');
      }
    }
  }
  await db.close();
}

if (require.main === module) {
  main().catch(async (e) => { console.error(e); await db.close(); process.exit(1); });
}

module.exports = { main, seedDemo };
