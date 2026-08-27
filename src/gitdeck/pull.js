/**
 * The pull: fetch a repository, mirror it, and work out what belongs to whom.
 *
 * THE SHAPE OF A PULL, AND WHY IT IS THIS SHAPE
 *
 *   1. read the forge                    outside any transaction, because a
 *                                        network call inside one holds a row
 *                                        lock for as long as GitHub feels like
 *                                        taking.
 *   2. mirror and match, in ONE          the items, the links, the unmatched
 *      transaction with the trail        keys, the repository's own state and
 *                                        the activity entry either all land or
 *                                        none of them do. A change with no
 *                                        trail is a change nobody can explain.
 *   3. move statuses AFTER the commit    through the same mutation the web app
 *                                        calls, so the status workflow, the
 *                                        notifications and the automations are
 *                                        not reimplemented here. This is the
 *                                        rule automations already follow, and
 *                                        for the same two reasons: work done
 *                                        inside would see uncommitted state,
 *                                        and a refusal would roll back the
 *                                        mirror.
 *
 * A PULL MIRRORS. IT DOES NOT DECIDE. Out of the box every status rule is NULL
 * and a pull changes no work package's status at all — it records what the
 * repository says and leaves the reading of it to a person. A repository whose
 * conventions have earned it can name a status in `git_type_rules`, and even
 * then the move goes through `status_transitions` like any other and is refused
 * if the workflow refuses it.
 *
 * WHO IT RUNS AS. A person, always: the CLI's `--as`, the signed-in user, or an
 * MCP token's issuer. It can never do what that person could not. The activity
 * trail then records the machine — `actorLabel: 'gitdeck'` — INSTEAD OF them,
 * so a status that moved because a pull request merged never reads as somebody
 * having sat down and moved it.
 */

'use strict';

const db = require('../db');
const access = require('../domain/access');
const notify = require('../domain/notify');
const gitdeck = require('../domain/gitdeck');
const clientModule = require('./client');
const mutations = require('../api/mutations');

const ACTOR = 'gitdeck';

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

/**
 * Pull one repository.
 *
 * `dryRun` does everything except write: the same fetch, the same matching, the
 * same report, and a `git_pulls` row that says `dry_run` so that "we looked and
 * decided not to" is in the history beside the pulls that did write.
 */
async function pullRepository(ctx, repositoryId, { dryRun = false, client = null, pages = 2 } = {}) {
  const repo = await db.one(`
    SELECT r.*, p.code AS project_code, p.name AS project_name
      FROM repositories r JOIN projects p ON p.id = r.project_id
     WHERE r.id = ?`, [repositoryId]);
  if (!repo) {
    const e = new Error('no such repository');
    e.status = 404;
    throw e;
  }
  await access.require(ctx.user.id, repo.project_id, 'manage_repositories');

  const forge = client || clientModule.create();
  const started = Date.now();

  let fetched;
  try {
    fetched = await forge.fetchRepository(repo, { pages });
  } catch (e) {
    // A failed pull is recorded, not swallowed and not lost. The repository's
    // own state carries the reason so the connections page can show it without
    // anybody reading a log.
    await db.insert('git_pulls', {
      repository_id: repo.id, actor_id: ctx.user.id, actor_label: ACTOR,
      state: 'error', finished_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      detail: e.message.slice(0, 500),
    });
    await db.run(
      "UPDATE repositories SET state = 'error', pull_state = 'error', pull_detail = ? WHERE id = ?",
      [e.message.slice(0, 300), repo.id]
    );
    throw e;
  }

  const rules = await rulesFor(repo.id);
  const index = await indexFor(repo.project_id, rules);
  // The same entries by id, because a link carries an id and the status rules
  // are looked up per link. Scanning the key index for each one turned a pull
  // over a large project into a nested loop over both.
  const byId = new Map([...index.values()].map((e) => [e.id, e]));

  // --- match everything before writing anything, so the report is the same in
  // --- a dry run as in a real one.
  const matched = [];
  const unmatched = [];
  for (const item of fetched.items) {
    const result = gitdeck.matchItem(item, index, { repositoryProjectId: Number(repo.project_id) });
    matched.push({ item, links: result.links });
    for (const miss of result.unmatched) unmatched.push({ item, ...miss });
  }
  // A commit carries a key as often as a pull request does, and the tracker has
  // had a table for commit-to-work-package links since the first version. The
  // same matcher fills it rather than a second one that would disagree.
  const commitLinks = [];
  for (const commit of fetched.commits) {
    const result = gitdeck.matchItem(
      { kind: 'commit', title: commit.message, body: null, head_branch: null },
      index, { repositoryProjectId: Number(repo.project_id) }
    );
    commitLinks.push({ commit, links: result.links });
    for (const miss of result.unmatched) unmatched.push({ item: { kind: 'commit', ref: commit.identifier }, ...miss });
  }

  const report = {
    repository: repo.name,
    project: repo.project_code,
    dry_run: Boolean(dryRun),
    items_seen: fetched.items.length,
    items_new: 0,
    commits_seen: fetched.commits.length,
    links_made: 0,
    commit_links: 0,
    links_held: 0,
    unmatched: [],
    moves: [],
    problems: [...fetched.problems],
    truncated: fetched.truncated,
    rate_remaining: fetched.remaining,
    anonymous: !fetched.conn.token,
  };

  const pending = [];   // status moves, applied after the commit

  if (dryRun) {
    // Counted the same way a real pull counts them, or the dry run's number and
    // the pull's number disagree and the dry run stops being worth running.
    // A commit's links land in `revision_work_packages` and are their own count.
    report.links_made = matched.reduce((n, m) => n + m.links.length, 0);
    report.commit_links = commitLinks.reduce((n, m) => n + m.links.length, 0);
    report.unmatched = summariseUnmatched(unmatched);
    await db.insert('git_pulls', {
      repository_id: repo.id, actor_id: ctx.user.id, actor_label: ACTOR, state: 'dry_run',
      finished_at: nowStamp(), items_seen: report.items_seen, links_made: report.links_made,
      unmatched: report.unmatched.length, rate_remaining: fetched.remaining,
      detail: 'dry run — nothing was written',
    });
    return report;
  }

  await db.transaction(async (tx) => {
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
        report.items_new += 1;
      }
    }

    for (const { item, links } of matched) {
      const itemId = itemIds.get(item);
      for (const link of links) {
        const held = await writeLink(tx, itemId, link);
        if (held === 'held') report.links_held += 1;
        else if (held === 'made') report.links_made += 1;
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
        if (done.affectedRows) report.commit_links += 1;
      }
    }

    for (const miss of unmatched) {
      await tx.run(`
        INSERT INTO git_unmatched_keys (repository_id, candidate, matched_in, git_item_id)
        VALUES (?, ?, ?, NULL)
        ON DUPLICATE KEY UPDATE last_seen_at = NOW(), seen_count = seen_count + 1`,
      [repo.id, miss.candidate, miss.matchedIn]);
    }

    const head = fetched.items.find((i) => i.kind === 'pull_request') || null;
    await tx.run(`
      UPDATE repositories
         SET slug = ?, state = 'connected', pull_state = 'ok', pull_detail = ?,
             last_synced_at = NOW(), detail = ?
       WHERE id = ?`,
    [
      fetched.conn.slug,
      report.problems.length ? report.problems.join('; ').slice(0, 300) : 'pulled cleanly',
      (head ? `#${head.ref} ${head.state}` : `${fetched.items.length} items`).slice(0, 300),
      repo.id,
    ]);

    await tx.insert('git_pulls', {
      repository_id: repo.id, actor_id: ctx.user.id, actor_label: ACTOR, state: 'ok',
      finished_at: nowStamp(), items_seen: report.items_seen, items_new: report.items_new,
      links_made: report.links_made, unmatched: unmatched.length,
      rate_remaining: fetched.remaining,
      detail: report.problems.length ? report.problems.join('; ').slice(0, 500) : null,
    });

    await notify.record({
      projectId: repo.project_id, actorId: ctx.user.id, actorLabel: ACTOR,
      kind: 'repo', verb: 'pulled', targetLabel: repo.name,
      detail: `${report.items_seen} item(s), ${report.items_new} new, ${report.links_made} link(s) made`
        + (unmatched.length ? `, ${unmatched.length} key(s) matched nothing` : ''),
    }, tx);
  });

  report.unmatched = summariseUnmatched(unmatched);

  // --- after the commit. See the file header.
  for (const move of dedupeMoves(pending)) {
    try {
      const wp = await db.one('SELECT status_id FROM work_packages WHERE id = ?', [move.workPackageId]);
      if (!wp || Number(wp.status_id) === Number(move.statusId)) continue;
      await mutations.updateWorkPackage(
        { user: ctx.user, actorLabel: ACTOR, today: ctx.today },
        move.workPackageId, { status_id: move.statusId }
      );
      report.moves.push({ work_package_id: move.workPackageId, status_id: move.statusId, why: move.why });
    } catch (e) {
      // A refusal is the workflow doing its job — not_started cannot jump
      // straight to done — and it is reported rather than retried or forced.
      report.problems.push(`${move.why}: ${e.message}`);
    }
  }

  report.took_ms = Date.now() - started;
  return report;
}

/**
 * Write one link, or decline to.
 *
 * A link a person removed is a decision. Re-creating it because the same regex
 * matched the same title again would overturn that decision silently on every
 * pull, for ever, which is the behaviour that makes people turn integrations
 * off. `held` is that case and it is counted and reported.
 */
async function writeLink(tx, itemId, link) {
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
    actor_label: ACTOR,
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

const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

module.exports = { pullRepository, rulesFor, indexFor, writeLink, moveFor, summariseUnmatched };
