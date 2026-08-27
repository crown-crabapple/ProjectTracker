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
 *                                        not reimplemented here.
 *
 * Steps 2 and 3 are `src/gitdeck/mirror.js`, and they are shared with the
 * webhook receiver on purpose: hearing about a change by asking and hearing
 * about it by being told are different, but writing it down twice two ways is
 * how the two would come to disagree.
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
const clientModule = require('./client');
const mirror = require('./mirror');

const ACTOR = 'gitdeck';

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
      state: 'error', finished_at: mirror.nowStamp(),
      detail: e.message.slice(0, 500),
    });
    await db.run(
      "UPDATE repositories SET state = 'error', pull_state = 'error', pull_detail = ? WHERE id = ?",
      [e.message.slice(0, 300), repo.id]
    );
    throw e;
  }

  const { index, byId } = await mirror.contextFor(repo);
  // Match everything before writing anything, so a dry run reports exactly what
  // a real pull would do.
  const { matched, commitLinks, unmatched } = mirror.match({
    repo, index, items: fetched.items, commits: fetched.commits,
  });

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
    unmatched: mirror.summariseUnmatched(unmatched),
    moves: [],
    problems: [...fetched.problems],
    truncated: fetched.truncated,
    rate_remaining: fetched.remaining,
    anonymous: !fetched.conn.token,
  };

  if (dryRun) {
    // Counted the same way a real pull counts them, or the dry run's number and
    // the pull's number disagree and the dry run stops being worth running.
    // A commit's links land in `revision_work_packages` and are their own count.
    report.links_made = matched.reduce((n, m) => n + m.links.length, 0);
    report.commit_links = commitLinks.reduce((n, m) => n + m.links.length, 0);
    await db.insert('git_pulls', {
      repository_id: repo.id, actor_id: ctx.user.id, actor_label: ACTOR, state: 'dry_run',
      finished_at: mirror.nowStamp(), items_seen: report.items_seen, links_made: report.links_made,
      unmatched: report.unmatched.length, rate_remaining: fetched.remaining,
      detail: 'dry run — nothing was written',
    });
    return report;
  }

  const pending = await db.transaction(async (tx) => {
    const written = await mirror.write(tx, { repo, matched, commitLinks, unmatched, byId });
    Object.assign(report, written.counts);

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
      finished_at: mirror.nowStamp(), items_seen: report.items_seen, items_new: report.items_new,
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

    return written.pending;
  });

  // --- after the commit. See the file header.
  const moved = await mirror.applyMoves(pending, { actor: ctx.user, actorLabel: ACTOR });
  report.moves = moved.applied;
  report.problems.push(...moved.problems);

  report.took_ms = Date.now() - started;
  return report;
}

module.exports = {
  pullRepository,
  // Re-exported because they were here first and the CLI, the selftest and the
  // webhook receiver all name them. They live in mirror.js now.
  rulesFor: mirror.rulesFor,
  indexFor: mirror.indexFor,
  writeLink: mirror.writeLink,
  moveFor: mirror.moveFor,
  summariseUnmatched: mirror.summariseUnmatched,
};
