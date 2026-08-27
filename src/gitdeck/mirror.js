/**
 * The one write path for anything a forge tells us.
 *
 * A pull fetches everything on a schedule somebody starts; a webhook is handed
 * one object the moment it changes. They are different ways of *hearing*, and
 * they must not be two ways of *writing*: a second writer would eventually
 * disagree with the first about what a link means, which relation to record, or
 * whether a removed link comes back. So both go through the three functions
 * here, in this order:
 *
 *   match()     work out which work package every item belongs to. Pure, and it
 *               happens before anything is written, so a dry run reports exactly
 *               what a real write would do.
 *   write()     the mirror, the links, the commits and the unmatched keys, in
 *               the caller's transaction — the caller adds its own record of
 *               having heard (a `git_pulls` row, a `git_hook_deliveries` row)
 *               and the activity entry to the same one.
 *   applyMoves()the status changes, AFTER that transaction has committed,
 *               through the same mutation the web app calls.
 *
 * That last split is the rule automations already follow. Work done inside the
 * transaction would see uncommitted state, and a refusal — the status workflow
 * saying no — would roll back the mirror that was correct.
 */

'use strict';

const db = require('../db');
const gitdeck = require('../domain/gitdeck');
const mutations = require('../api/mutations');

const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** The mapping in force for each type in this repository: default, then override. */
async function rulesFor(repositoryId) {
  const types = await db.query(`
    SELECT t.id, t.name, t.git_item_kind, t.git_relation, t.git_key_prefix,
           r.item_kind AS o_kind, r.relation AS o_relation, r.key_prefix AS o_prefix,
           r.merged_status_id, r.closed_status_id
      FROM work_package_types t
      LEFT JOIN git_type_rules r ON r.type_id = t.id AND r.repository_id = ?
     ORDER BY t.position`, [repositoryId]);
  const byType = new Map();
  for (const t of types) {
    byType.set(Number(t.id), {
      type_id: Number(t.id),
      type_name: t.name,
      item_kind: t.o_kind || t.git_item_kind,
      relation: t.o_relation || t.git_relation,
      key_prefix: t.o_prefix || t.git_key_prefix,
      merged_status_id: t.merged_status_id ? Number(t.merged_status_id) : null,
      closed_status_id: t.closed_status_id ? Number(t.closed_status_id) : null,
      overridden: Boolean(t.o_kind),
    });
  }
  return byType;
}

/** Every addressable key in the project, pointing at its work package and rule. */
async function indexFor(projectId, rules) {
  const rows = await db.query(`
    SELECT wp.id, wp.wp_key, wp.ref_key, wp.project_id, wp.type_id, wp.status_id,
           t.name AS type_name
      FROM work_packages wp JOIN work_package_types t ON t.id = wp.type_id
     WHERE wp.project_id = ?`, [projectId]);
  const index = new Map();
  for (const row of rows) {
    const entry = {
      id: Number(row.id),
      project_id: Number(row.project_id),
      type_name: row.type_name,
      type_id: Number(row.type_id),
      status_id: Number(row.status_id),
      wp_key: row.wp_key,
      ref_key: row.ref_key,
      rule: rules.get(Number(row.type_id)) || null,
    };
    for (const key of gitdeck.keysFor(row)) {
      // First writer wins, and a collision is impossible for wp_key and refused
      // by a unique index for ref_key, so this is belt and braces rather than a
      // policy.
      if (!index.has(key)) index.set(key, entry);
    }
  }
  return index;
}

/** The rules and the key index for one repository, which every caller needs. */
async function contextFor(repo) {
  const rules = await rulesFor(repo.id);
  const index = await indexFor(repo.project_id, rules);
  // The same entries by id, because a link carries an id and the status rules
  // are looked up per link. Scanning the key index for each one turned a pull
  // over a large project into a nested loop over both.
  const byId = new Map([...index.values()].map((e) => [e.id, e]));
  return { rules, index, byId };
}

/**
 * Match items and commits against the work packages that exist.
 *
 * Nothing is written here, which is what makes a dry run and a real pull report
 * the same numbers.
 */
function match({ repo, index, items = [], commits = [] }) {
  const matched = [];
  const unmatched = [];
  for (const item of items) {
    const result = gitdeck.matchItem(item, index, { repositoryProjectId: Number(repo.project_id) });
    matched.push({ item, links: result.links });
    for (const miss of result.unmatched) unmatched.push({ item, ...miss });
  }
  // A commit carries a key as often as a pull request does, and the tracker has
  // had a table for commit-to-work-package links since the first version. The
  // same matcher fills it rather than a second one that would disagree.
  const commitLinks = [];
  for (const commit of commits) {
    const result = gitdeck.matchItem(
      { kind: 'commit', title: commit.message, body: null, head_branch: null },
      index, { repositoryProjectId: Number(repo.project_id) }
    );
    commitLinks.push({ commit, links: result.links });
    for (const miss of result.unmatched) {
      unmatched.push({ item: { kind: 'commit', ref: commit.identifier }, ...miss });
    }
  }
  return { matched, commitLinks, unmatched };
}

/**
 * Write the mirror, in the caller's transaction.
 *
 * Returns the counts and the status moves the caller should apply once that
 * transaction has committed.
 */
async function write(tx, { repo, matched, commitLinks, unmatched, byId, actorLabel = 'gitdeck' }) {
  const counts = { items_new: 0, links_made: 0, links_held: 0, commit_links: 0 };
  const pending = [];

  const itemIds = new Map();
  for (const { item } of matched) {
    const existing = await tx.one(
      'SELECT id FROM git_items WHERE repository_id = ? AND kind = ? AND ref = ?',
      [repo.id, item.kind, item.ref]
    );
    const row = {
      repository_id: repo.id,
      kind: item.kind,
      ref: item.ref,
      title: item.title || null,
      state: item.state || 'unknown',
      author: item.author || null,
      head_branch: item.head_branch || null,
      base_branch: item.base_branch || null,
      url: item.url || null,
      body: item.body || null,
      labels: item.labels || null,
      opened_at: item.opened_at || null,
      updated_at: item.updated_at || null,
      closed_at: item.closed_at || null,
      merged_at: item.merged_at || null,
      additions: item.additions === undefined ? null : item.additions,
      deletions: item.deletions === undefined ? null : item.deletions,
      comment_count: item.comment_count === undefined ? null : item.comment_count,
      duration_sec: item.duration_sec === undefined ? null : item.duration_sec,
      conclusion: item.conclusion || null,
      severity: item.severity || null,
      pulled_at: nowStamp(),
    };
    if (existing) {
      await tx.update('git_items', existing.id, row);
      itemIds.set(item, Number(existing.id));
    } else {
      itemIds.set(item, Number(await tx.insert('git_items', row)));
      counts.items_new += 1;
    }
  }

  for (const { item, links } of matched) {
    const itemId = itemIds.get(item);
    for (const link of links) {
      const outcome = await writeLink(tx, itemId, link, actorLabel);
      if (outcome === 'held') counts.links_held += 1;
      else if (outcome === 'made') counts.links_made += 1;
      const move = moveFor(item, link, byId);
      if (move) pending.push(move);
    }
  }

  for (const { commit, links } of commitLinks) {
    const existing = await tx.one(
      'SELECT id FROM repository_revisions WHERE repository_id = ? AND identifier = ?',
      [repo.id, commit.identifier]
    );
    const revisionId = existing ? Number(existing.id) : Number(await tx.insert('repository_revisions', {
      repository_id: repo.id, identifier: commit.identifier, author: commit.author,
      message: commit.message, committed_at: commit.committed_at, url: commit.url,
    }));
    for (const link of links) {
      const done = await tx.run(
        'INSERT IGNORE INTO revision_work_packages (revision_id, work_package_id) VALUES (?, ?)',
        [revisionId, link.work_package_id]
      );
      if (done.affectedRows) counts.commit_links += 1;
    }
  }

  for (const miss of unmatched) {
    await tx.run(`
      INSERT INTO git_unmatched_keys (repository_id, candidate, matched_in, git_item_id)
      VALUES (?, ?, ?, NULL)
      ON DUPLICATE KEY UPDATE last_seen_at = NOW(), seen_count = seen_count + 1`,
    [repo.id, miss.candidate, miss.matchedIn]);
  }

  return { counts, pending };
}

/**
 * Write one link, or decline to.
 *
 * A link a person removed is a decision. Re-creating it because the same regex
 * matched the same title again would overturn that decision silently on every
 * pull, for ever, which is the behaviour that makes people turn integrations
 * off. `held` is that case and it is counted and reported.
 */
async function writeLink(tx, itemId, link, actorLabel = 'gitdeck') {
  const existing = await tx.one(
    'SELECT id, removed_at, removed_by FROM work_package_git_links WHERE work_package_id = ? AND git_item_id = ? AND relation = ?',
    [link.work_package_id, itemId, link.relation]
  );
  if (existing) {
    if (existing.removed_at && existing.removed_by) return 'held';
    if (existing.removed_at) {
      await tx.update('work_package_git_links', existing.id, { removed_at: null, removed_by: null });
      return 'made';
    }
    return 'kept';
  }
  await tx.insert('work_package_git_links', {
    work_package_id: link.work_package_id,
    git_item_id: itemId,
    relation: link.relation,
    origin: link.origin,
    matched_key: link.matched_key,
    matched_in: link.matched_in,
    actor_label: actorLabel,
  });
  return 'made';
}

/**
 * The status move this item and link imply, or null.
 *
 * Two ways to earn one, and a mention alone is not either of them:
 *
 *   the kinds agree — a FEATURE mapped to pull_request, on a pull request. The
 *   convention is the claim, and no verb is needed.
 *
 *   a closing verb named the key — 'fixes B-UI-7' in a pull request body moves
 *   the BUG even though BUG is mapped to issues, because somebody said so in
 *   the sentence rather than by convention.
 */
function moveFor(item, link, byId) {
  const entry = byId.get(Number(link.work_package_id));
  if (!entry || !entry.rule) return null;
  const claimed = link.relation !== 'mentions' || link.closing;
  if (!claimed) return null;
  const merged = item.merged_at || item.state === 'merged';
  const closed = !merged && (item.closed_at || item.state === 'closed');
  if (merged && entry.rule.merged_status_id) {
    return {
      workPackageId: link.work_package_id,
      statusId: entry.rule.merged_status_id,
      why: `${link.matched_key} — ${item.kind} ${item.ref} merged`,
    };
  }
  if (closed && entry.rule.closed_status_id) {
    return {
      workPackageId: link.work_package_id,
      statusId: entry.rule.closed_status_id,
      why: `${link.matched_key} — ${item.kind} ${item.ref} closed`,
    };
  }
  return null;
}

/**
 * Apply the status moves, after the caller's transaction has committed.
 *
 * `actor` is the person whose authority is borrowed and the label recorded
 * instead of them. A caller with nobody to run as — a webhook on a repository
 * that has not named one — passes null, and gets back the reason rather than a
 * silent no-op: "nothing moved" and "nothing could have moved" are different
 * facts, and the delivery record says which.
 */
async function applyMoves(moves, { actor, actorLabel }) {
  const applied = [];
  const problems = [];
  const deduped = dedupeMoves(moves);
  if (!deduped.length) return { applied, problems };
  if (!actor) {
    return {
      applied,
      problems: [
        `${deduped.length} status change(s) were implied and none was made: this repository names `
        + 'nobody for a webhook to act as, so there is no authority to move a work package with.',
      ],
    };
  }
  for (const move of deduped) {
    try {
      const wp = await db.one('SELECT status_id FROM work_packages WHERE id = ?', [move.workPackageId]);
      if (!wp || Number(wp.status_id) === Number(move.statusId)) continue;
      await mutations.updateWorkPackage(
        { user: actor, actorLabel, today: new Date().toISOString().slice(0, 10) },
        move.workPackageId, { status_id: move.statusId }
      );
      applied.push({ work_package_id: move.workPackageId, status_id: move.statusId, why: move.why });
    } catch (e) {
      // A refusal is the workflow doing its job — not_started cannot jump
      // straight to done — and it is reported rather than retried or forced.
      problems.push(`${move.why}: ${e.message}`);
    }
  }
  return { applied, problems };
}

/**
 * One move per work package. Two merged pull requests naming the same feature
 * are one transition, and applying both would put two identical entries in the
 * trail — the second of which would then be refused by the workflow anyway.
 */
function dedupeMoves(moves) {
  const seen = new Set();
  const out = [];
  for (const move of moves) {
    const key = `${move.workPackageId}:${move.statusId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(move);
  }
  return out;
}

/** The unmatched keys, counted per key rather than per sighting. */
function summariseUnmatched(list) {
  const byKey = new Map();
  for (const miss of list) {
    const row = byKey.get(miss.candidate) || {
      candidate: miss.candidate, seen: 0, matched_in: miss.matchedIn,
      example: miss.item ? `${miss.item.kind} ${miss.item.ref}` : null,
      reason: miss.reason || 'no work package has that key',
    };
    row.seen += 1;
    byKey.set(miss.candidate, row);
  }
  return [...byKey.values()].sort((a, b) => b.seen - a.seen);
}

module.exports = {
  rulesFor, indexFor, contextFor, match, write, writeLink, moveFor,
  applyMoves, dedupeMoves, summariseUnmatched, nowStamp,
};
