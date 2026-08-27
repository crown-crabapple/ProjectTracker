/**
 * The deck: the repository read side.
 *
 * One screen answers the two questions the mapping exists for — what is
 * happening in the repository, and which of it belongs to work this tracker is
 * tracking — and one small payload answers the third, on the work package
 * drawer: what does F-LOAD-012 map to.
 *
 * Every number here comes from `src/domain/gitdeck.js` for the same reason every
 * percentage comes from `rollup.js`: a health score computed in a view is a
 * second health score. And none of them is a progress figure — the payload says
 * so in `note`, and the screen prints it, because a 78 beside a 62 with nothing
 * to say what either counts is how a portfolio review goes wrong.
 */

'use strict';

const db = require('../db');
const gitdeck = require('../domain/gitdeck');
const { notFound } = require('../http/router');
const { ago } = require('./views');

/** The item kinds a person reads, in the order the screen shows them. */
const SHOWN = ['pull_request', 'issue', 'milestone', 'release', 'workflow_run', 'security_alert', 'branch'];

/**
 * The deck for one project, or for every project the caller can see.
 *
 * `repositoryId` narrows to one repository. Every list is capped: a deck is a
 * dashboard, and a dashboard that returns four thousand rows is a report
 * somebody has to scroll instead of read.
 */
async function deck(ctx, { projectId = null, repositoryId = null } = {}) {
  const clause = db.inClause(ctx.visibleProjectIds.length ? ctx.visibleProjectIds : [0]);
  const where = projectId ? 'r.project_id = ?' : `r.project_id IN ${clause.sql}`;
  const params = projectId ? [projectId] : clause.params;

  const repositories = await db.query(`
    SELECT r.id, r.project_id, r.scm, r.name, r.url, r.slug, r.api_base, r.default_branch,
           r.token_env, r.state, r.detail, r.pull_state, r.pull_detail, r.last_synced_at,
           p.code AS project_code, p.name AS project_name
      FROM repositories r JOIN projects p ON p.id = r.project_id
     WHERE ${where}${repositoryId ? ' AND r.id = ?' : ''}
     ORDER BY r.scm, r.name`, repositoryId ? [...params, repositoryId] : params);

  if (repositoryId && !repositories.length) throw notFound('no such repository');

  const ids = repositories.map((r) => Number(r.id));
  const idClause = db.inClause(ids.length ? ids : [0]);

  const items = ids.length ? await db.query(`
    SELECT gi.*, r.name AS repository, r.project_id
      FROM git_items gi JOIN repositories r ON r.id = gi.repository_id
     WHERE gi.repository_id IN ${idClause.sql}
     ORDER BY gi.updated_at DESC, gi.id DESC
     LIMIT 600`, idClause.params) : [];

  const links = ids.length ? await db.query(`
    SELECT l.id, l.work_package_id, l.git_item_id, l.relation, l.origin, l.matched_key,
           l.matched_in, l.created_at, l.actor_label, u.name AS created_by_name,
           wp.wp_key, wp.ref_key, wp.subject, t.name AS type_name, s.colour AS status_colour,
           s.label AS status_label
      FROM work_package_git_links l
      JOIN git_items gi ON gi.id = l.git_item_id
      JOIN work_packages wp ON wp.id = l.work_package_id
      JOIN work_package_types t ON t.id = wp.type_id
      JOIN statuses s ON s.id = wp.status_id
      LEFT JOIN users u ON u.id = l.created_by
     WHERE gi.repository_id IN ${idClause.sql} AND l.removed_at IS NULL`, idClause.params) : [];

  const workPackages = await db.query(`
    SELECT wp.id, wp.wp_key, wp.ref_key, wp.project_id, wp.subject,
           t.name AS type_name, t.git_item_kind, t.git_relation, t.git_key_prefix,
           s.label AS status_label, s.colour AS status_colour, s.is_closed
      FROM work_packages wp
      JOIN work_package_types t ON t.id = wp.type_id
      JOIN statuses s ON s.id = wp.status_id
     WHERE ${projectId ? 'wp.project_id = ?' : `wp.project_id IN ${clause.sql}`}`,
  projectId ? [projectId] : clause.params);

  const unmatched = ids.length ? await db.query(`
    SELECT k.*, r.name AS repository FROM git_unmatched_keys k
      JOIN repositories r ON r.id = k.repository_id
     WHERE k.repository_id IN ${idClause.sql}
     ORDER BY k.seen_count DESC, k.last_seen_at DESC LIMIT 40`, idClause.params) : [];

  const pulls = ids.length ? await db.query(`
    SELECT gp.*, r.name AS repository, u.name AS actor_name FROM git_pulls gp
      JOIN repositories r ON r.id = gp.repository_id
      LEFT JOIN users u ON u.id = gp.actor_id
     WHERE gp.repository_id IN ${idClause.sql}
     ORDER BY gp.started_at DESC LIMIT 12`, idClause.params) : [];

  const linksByItem = new Map();
  for (const l of links) {
    const list = linksByItem.get(Number(l.git_item_id)) || [];
    list.push(l);
    linksByItem.set(Number(l.git_item_id), list);
  }

  const perRepository = repositories.map((repo) => {
    const own = items.filter((i) => Number(i.repository_id) === Number(repo.id));
    const ownIds = new Set(own.map((i) => Number(i.id)));
    const ownLinks = links.filter((l) => ownIds.has(Number(l.git_item_id)));
    const openIssues = own.filter((i) => i.kind === 'issue' && i.state === 'open');
    const releases = own.filter((i) => i.kind === 'release');
    const alerts = own.filter((i) => i.kind === 'security_alert' && i.state === 'open');
    // A repository nothing has been pulled from has no health, and 78 — the
    // score the formula starts at before it subtracts anything — is not "we do
    // not know". A number that looks computed and is not is worse than a blank.
    const health = !own.length && repo.pull_state === 'never' ? null : gitdeck.healthScore({
      issues: openIssues,
      pushed_at: own.map((i) => i.updated_at).filter(Boolean).sort().slice(-1)[0] || null,
      latest_release_at: releases.map((r) => r.updated_at).filter(Boolean).sort().slice(-1)[0] || null,
      release_count: releases.length,
      security_alerts: alerts.length,
      // Read from what the last pull recorded rather than guessed: a token
      // without the security scope is refused the alerts endpoint, the pull
      // writes that refusal into `pull_detail`, and the score then says the
      // signal was unavailable instead of scoring nought alerts as clean.
      security_alerts_unavailable: repo.pull_state === 'never'
        || /alert/i.test(repo.pull_detail || ''),
    });
    return {
      id: Number(repo.id),
      project_id: Number(repo.project_id),
      project_code: repo.project_code,
      scm: repo.scm,
      name: repo.name,
      url: repo.url,
      slug: repo.slug,
      default_branch: repo.default_branch,
      state: repo.state,
      detail: repo.detail,
      pull_state: repo.pull_state,
      pull_detail: repo.pull_detail,
      last_synced_at: repo.last_synced_at,
      last_synced: repo.last_synced_at ? ago(repo.last_synced_at) : 'never pulled',
      credential: repo.token_env,
      // The same fact the connections page reports and for the same reason: the
      // useful thing about a credential is whether the process can see it.
      credential_present: repo.token_env ? Boolean(process.env[repo.token_env]) : null,
      pullable: ['github', 'gitlab', 'forgejo'].includes(repo.scm),
      counts: countsFor(own),
      health,
      ci: gitdeck.ciSummary(own.filter((i) => i.kind === 'workflow_run').map((r) => ({
        state: r.state, conclusion: r.conclusion, duration_sec: r.duration_sec,
      }))),
      // The ITEMS half only. How much of a project's work is mapped is a fact
      // about the project, not about one of its repositories, and counting it
      // per repository would double it the moment a project connects a second
      // one. The project-level figure is `coverage` on the payload.
      coverage: gitdeck.coverage({ workPackages: [], items: own, links: ownLinks }),
      digest: gitdeck.digest(own, { since: dayAgo() }),
    };
  });

  return {
    repositories: perRepository,
    // Computed once over every work package in scope and every link, so two
    // repositories on one project cannot count the same feature twice.
    //
    // The denominator is work in projects that HAVE a repository. A project with
    // none is not badly mapped — it is not mapped at all, on purpose — and
    // counting it would mean connecting one repository made the portfolio look
    // 90% unmapped for ever, which is a figure nobody would look at twice.
    coverage: gitdeck.coverage({
      workPackages: workPackages.filter((w) => repositories.some(
        (r) => Number(r.project_id) === Number(w.project_id)
      )),
      items,
      links,
    }),
    items: items.slice(0, 200).map((i) => shapeItem(i, linksByItem.get(Number(i.id)) || [])),
    unmatched: unmatched.map((u) => ({
      candidate: u.candidate, repository: u.repository, matched_in: u.matched_in,
      seen: Number(u.seen_count), when: ago(u.last_seen_at),
    })),
    pulls: pulls.map((p) => ({
      id: Number(p.id), repository: p.repository, state: p.state,
      items_seen: Number(p.items_seen), items_new: Number(p.items_new),
      links_made: Number(p.links_made), unmatched: Number(p.unmatched),
      rate_remaining: p.rate_remaining === null ? null : Number(p.rate_remaining),
      detail: p.detail, when: ago(p.started_at),
      // A pull runs as a person and is recorded as a machine. Showing both is
      // the point of recording both.
      actor: p.actor_label || p.actor_name || 'unknown',
      on_behalf_of: p.actor_name || null,
    })),
    mapping: await mappingTable(repositoryId),
    kinds: SHOWN,
    note: 'A health score is repository hygiene and a CI rate is a pipeline. Neither is '
      + 'readiness, and neither enters any percentage on the portfolio page.',
  };
}

/** The six types and what each maps onto, with any per-repository override. */
async function mappingTable(repositoryId = null) {
  const rows = await db.query(`
    SELECT t.id, t.name, t.position, t.git_item_kind, t.git_relation, t.git_key_prefix,
           r.item_kind AS o_kind, r.relation AS o_relation, r.key_prefix AS o_prefix,
           ms.label AS merged_status, cs.label AS closed_status, r.repository_id
      FROM work_package_types t
      LEFT JOIN git_type_rules r ON r.type_id = t.id ${repositoryId ? 'AND r.repository_id = ?' : 'AND 1 = 0'}
      LEFT JOIN statuses ms ON ms.id = r.merged_status_id
      LEFT JOIN statuses cs ON cs.id = r.closed_status_id
     ORDER BY t.position`, repositoryId ? [repositoryId] : []);
  return rows.map((t) => ({
    type: t.name,
    item_kind: t.o_kind || t.git_item_kind,
    relation: t.o_relation || t.git_relation,
    key_prefix: t.o_prefix || t.git_key_prefix,
    overridden: Boolean(t.o_kind),
    // Null is the shipped state and the screen prints the sentence rather than
    // a blank: 'a merge changes nothing here' is a decision, not a gap.
    merged_status: t.merged_status || null,
    closed_status: t.closed_status || null,
    example: exampleFor(t.o_prefix || t.git_key_prefix, t.o_kind || t.git_item_kind),
  }));
}

/**
 * 'F-LOAD-012 → pull request #978', which is the whole feature in one line.
 *
 * Illustrative, not live: the numbers are made up and the column is headed
 * Example. A two-letter prefix belongs to the coarse types, whose keys are short
 * — PH-2, not PH-LOAD-012 — so the sample key follows the prefix.
 */
function exampleFor(prefix, kind) {
  if (!prefix || kind === 'none') return null;
  const shown = {
    pull_request: 'pull request #978', issue: 'issue #214', milestone: 'milestone 4',
    release: 'release v1.2.0', branch: 'a branch named for it',
  }[kind];
  const sample = prefix.length > 1 ? `${prefix}-2` : `${prefix}-LOAD-012`;
  return `${sample} maps to ${shown}`;
}

function countsFor(items) {
  const count = (kind, state) => items.filter((i) => i.kind === kind && (!state || i.state === state)).length;
  return {
    pull_requests_open: count('pull_request', 'open') + count('pull_request', 'draft'),
    pull_requests_merged: count('pull_request', 'merged'),
    issues_open: count('issue', 'open'),
    milestones: count('milestone'),
    releases: count('release'),
    branches: count('branch'),
    alerts_open: count('security_alert', 'open'),
    runs: count('workflow_run'),
  };
}

function shapeItem(item, links) {
  return {
    id: Number(item.id),
    repository: item.repository,
    repository_id: Number(item.repository_id),
    kind: item.kind,
    ref: item.ref,
    title: item.title,
    state: item.state,
    conclusion: item.conclusion,
    severity: item.severity,
    author: item.author,
    head_branch: item.head_branch,
    url: item.url,
    labels: item.labels,
    when: ago(item.updated_at || item.opened_at),
    merged: Boolean(item.merged_at),
    comment_count: item.comment_count,
    links: links.map((l) => ({
      id: Number(l.id), work_package_id: Number(l.work_package_id),
      key: l.ref_key || l.wp_key, wp_key: l.wp_key, subject: l.subject,
      relation: l.relation, origin: l.origin, matched_key: l.matched_key, matched_in: l.matched_in,
      type: l.type_name, status_label: l.status_label, status_colour: l.status_colour,
      by: l.actor_label || l.created_by_name || null,
    })),
  };
}

/**
 * What one work package maps to, for the drawer.
 *
 * Both directions in one payload: the items linked to it, and — when it has
 * none — what its type says it should have been linked to, so the panel can say
 * "a FEATURE maps to a pull request; this one has none" rather than showing an
 * empty box that could equally mean the pull has never run.
 */
async function workPackageGit(ctx, workPackageId) {
  const wp = await db.one(`
    SELECT wp.id, wp.wp_key, wp.ref_key, wp.project_id, t.name AS type_name,
           t.git_item_kind, t.git_relation, t.git_key_prefix
      FROM work_packages wp JOIN work_package_types t ON t.id = wp.type_id
     WHERE wp.id = ?`, [workPackageId]);
  if (!wp) throw notFound('no such work package');

  const links = await db.query(`
    SELECT l.id, l.relation, l.origin, l.matched_key, l.matched_in, l.created_at, l.actor_label,
           l.removed_at, u.name AS created_by_name, ru.name AS removed_by_name,
           gi.id AS item_id, gi.kind, gi.ref, gi.title, gi.state, gi.url, gi.author,
           gi.head_branch, gi.merged_at, gi.closed_at, gi.updated_at, gi.conclusion,
           r.name AS repository, r.scm
      FROM work_package_git_links l
      JOIN git_items gi ON gi.id = l.git_item_id
      JOIN repositories r ON r.id = gi.repository_id
      LEFT JOIN users u ON u.id = l.created_by
      LEFT JOIN users ru ON ru.id = l.removed_by
     WHERE l.work_package_id = ?
     ORDER BY l.removed_at IS NOT NULL, gi.updated_at DESC`, [workPackageId]);

  const revisions = await db.query(`
    SELECT rv.identifier, rv.author, rv.message, rv.committed_at, rv.url, r.name AS repository
      FROM revision_work_packages rwp
      JOIN repository_revisions rv ON rv.id = rwp.revision_id
      JOIN repositories r ON r.id = rv.repository_id
     WHERE rwp.work_package_id = ? ORDER BY rv.committed_at DESC LIMIT 10`, [workPackageId]);

  const repositories = await db.query(
    'SELECT id, name, scm, pull_state FROM repositories WHERE project_id = ? ORDER BY name', [wp.project_id]
  );

  return {
    work_package: {
      id: Number(wp.id), wp_key: wp.wp_key, ref_key: wp.ref_key, type: wp.type_name,
    },
    // What this type is supposed to map to. Shown whether or not there are
    // links, because "a FEATURE maps to a pull request" is the fact that makes
    // an empty list mean something.
    mapping: {
      item_kind: wp.git_item_kind,
      relation: wp.git_relation,
      key_prefix: wp.git_key_prefix,
      example: exampleFor(wp.git_key_prefix, wp.git_item_kind),
      addressable_as: [wp.wp_key, wp.ref_key].filter(Boolean),
    },
    links: links.map((l) => ({
      id: Number(l.id), item_id: Number(l.item_id), repository: l.repository, scm: l.scm,
      kind: l.kind, ref: l.ref, title: l.title, state: l.state, url: l.url, author: l.author,
      head_branch: l.head_branch, conclusion: l.conclusion,
      relation: l.relation, origin: l.origin, matched_key: l.matched_key, matched_in: l.matched_in,
      when: ago(l.updated_at || l.created_at),
      // A removed link keeps its row and is shown as removed rather than
      // vanishing, so "why did this stop being linked" has an answer.
      removed: Boolean(l.removed_at),
      removed_by: l.removed_by_name || null,
      by: l.actor_label || l.created_by_name || null,
    })),
    revisions: revisions.map((r) => ({
      identifier: String(r.identifier).slice(0, 7), author: r.author, message: r.message,
      url: r.url, repository: r.repository, when: ago(r.committed_at),
    })),
    repositories: repositories.map((r) => ({
      id: Number(r.id), name: r.name, scm: r.scm, pull_state: r.pull_state,
    })),
  };
}

const dayAgo = () => new Date(Date.now() - 86400000).toISOString().slice(0, 19).replace('T', ' ');

module.exports = { deck, workPackageGit, mappingTable, exampleFor };
